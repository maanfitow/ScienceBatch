use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::path::Path;

use flate2::read::GzDecoder;

use crate::diagnostics::latex_parser::map_prepared_main_line;
use crate::types::{PdfSourceBox, PdfSourceMap, PdfSourcePage};

#[derive(Clone, Copy)]
struct BoxFrame {
    y: f32,
    h: f32,
}

/// Decompresses a `.synctex.gz` payload in memory and parses it into a `PdfSourceMap`.
#[allow(clippy::too_many_arguments)]
pub fn parse_synctex_gz(
    gz_bytes: &[u8],
    main_file: &str,
    tex_input_name: &str,
    project_dir: Option<&str>,
    known_files: Option<&BTreeSet<String>>,
    prepended_lines: usize,
    inserted_lines: usize,
    insertion_after_lines: Option<usize>,
) -> Option<PdfSourceMap> {
    let mut decoder = GzDecoder::new(gz_bytes);
    let mut raw = Vec::new();
    decoder.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    parse_synctex_text(
        &text,
        main_file,
        tex_input_name,
        project_dir,
        known_files,
        prepended_lines,
        inserted_lines,
        insertion_after_lines,
    )
}

/// Parses plain-text SyncTeX v1 content into a `PdfSourceMap`.
#[allow(clippy::too_many_arguments)]
pub fn parse_synctex_text(
    text: &str,
    main_file: &str,
    tex_input_name: &str,
    project_dir: Option<&str>,
    known_files: Option<&BTreeSet<String>>,
    prepended_lines: usize,
    inserted_lines: usize,
    insertion_after_lines: Option<usize>,
) -> Option<PdfSourceMap> {
    let mut unit = 1.0_f64;
    let mut magnification = 1000.0_f64;
    let mut x_off = 0.0_f64;
    let mut y_off = 0.0_f64;
    let mut raw_inputs: HashMap<u32, String> = HashMap::new();

    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("Input:") {
            if let Some((id_str, path)) = rest.split_once(':') {
                if let Ok(id) = id_str.trim().parse::<u32>() {
                    let normalized = if id == 1 && path.trim().is_empty() {
                        main_file.to_string()
                    } else {
                        normalize_synctex_input(path, main_file, tex_input_name, project_dir)
                    };
                    if !normalized.is_empty() {
                        raw_inputs.insert(id, normalized);
                    }
                }
            }
        } else if let Some(rest) = line.strip_prefix("Unit:") {
            if let Ok(val) = rest.trim().parse::<f64>() {
                unit = val;
            }
        } else if let Some(rest) = line.strip_prefix("Magnification:") {
            if let Ok(val) = rest.trim().parse::<f64>() {
                magnification = val;
            }
        } else if let Some(rest) = line.strip_prefix("X Offset:") {
            if let Ok(val) = rest.trim().parse::<f64>() {
                x_off = val;
            }
        } else if let Some(rest) = line.strip_prefix("Y Offset:") {
            if let Ok(val) = rest.trim().parse::<f64>() {
                y_off = val;
            }
        }
    }

    if unit <= 0.0 || magnification <= 0.0 || !unit.is_finite() || !magnification.is_finite() {
        return None;
    }

    let scale = (unit * 1000.0 / magnification) * (72.0 / (72.27 * 65536.0));
    let filtered_inputs = filter_inputs(raw_inputs, known_files);
    if filtered_inputs.is_empty() {
        return None;
    }

    let mut files: Vec<String> = Vec::new();
    let mut file_indices: HashMap<String, u32> = HashMap::new();
    let mut pages: Vec<PdfSourcePage> = Vec::new();
    let mut current_page: Option<(usize, Vec<PdfSourceBox>)> = None;
    let mut box_stack: Vec<BoxFrame> = Vec::new();

    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }

        if let Some(page_str) = line.strip_prefix('{') {
            if let Ok(page_num) = page_str.trim().parse::<usize>() {
                box_stack.clear();
                current_page = Some((page_num, Vec::new()));
            }
            continue;
        }

        if let Some(page_str) = line.strip_prefix('}') {
            if page_str.trim().parse::<usize>().is_ok() {
                if let Some((page_num, boxes)) = current_page.take() {
                    pages.push(PdfSourcePage {
                        page: page_num,
                        width_pt: 0.0,
                        height_pt: 0.0,
                        boxes,
                    });
                }
                box_stack.clear();
            }
            continue;
        }

        let Some((_, ref mut page_boxes)) = current_page else {
            continue;
        };

        let first = line.as_bytes()[0];
        match first {
            b'[' | b'(' => {
                let level = if first == b'[' { 1 } else { 0 };
                let Some((tag, src_line, col, h, v, cap_w, cap_h, cap_d)) =
                    parse_box_record(&line[1..])
                else {
                    continue;
                };
                let x = ((h + x_off) * scale) as f32;
                let y = ((v + y_off - cap_h) * scale) as f32;
                let w = (cap_w * scale) as f32;
                let box_h = ((cap_h + cap_d) * scale) as f32;
                box_stack.push(BoxFrame { y, h: box_h });

                if w > 0.0 && box_h > 0.0 && x.is_finite() && y.is_finite() && w.is_finite() && box_h.is_finite() {
                    if let Some((file_idx, mapped_line)) = resolve_location(
                        tag,
                        src_line,
                        main_file,
                        &filtered_inputs,
                        &mut files,
                        &mut file_indices,
                        prepended_lines,
                        inserted_lines,
                        insertion_after_lines,
                    ) {
                        page_boxes.push(PdfSourceBox {
                            x,
                            y,
                            w,
                            h: box_h,
                            file_idx,
                            line: mapped_line,
                            column: col,
                            level,
                        });
                    }
                }
            }
            b']' | b')' => {
                box_stack.pop();
            }
            b'x' => {
                let Some((tag, src_line, col, h, _v)) = parse_point_record(&line[1..]) else {
                    continue;
                };
                let Some(enclosing) = box_stack.iter().rev().find(|frame| frame.h > 0.0) else {
                    continue;
                };
                let x = ((h + x_off) * scale) as f32;
                if !x.is_finite() || !enclosing.y.is_finite() || !enclosing.h.is_finite() {
                    continue;
                }
                if let Some((file_idx, mapped_line)) = resolve_location(
                    tag,
                    src_line,
                    main_file,
                    &filtered_inputs,
                    &mut files,
                    &mut file_indices,
                    prepended_lines,
                    inserted_lines,
                    insertion_after_lines,
                ) {
                    page_boxes.push(PdfSourceBox {
                        x,
                        y: enclosing.y,
                        w: 12.0,
                        h: enclosing.h,
                        file_idx,
                        line: mapped_line,
                        column: col,
                        level: 0,
                    });
                }
            }
            _ => {}
        }
    }

    if pages.is_empty() {
        return None;
    }

    Some(PdfSourceMap { files, pages })
}

fn strip_leading_dotslash_and_slash(mut s: &str) -> &str {
    loop {
        if let Some(rest) = s.strip_prefix("./") {
            s = rest;
        } else if let Some(rest) = s.strip_prefix('/') {
            s = rest;
        } else {
            return s;
        }
    }
}

fn normalize_synctex_input(
    raw_path: &str,
    main_file: &str,
    tex_input_name: &str,
    project_dir: Option<&str>,
) -> String {
    let mut path = raw_path.trim().replace('\\', "/");
    if let Some(dir) = project_dir {
        let dir_norm = dir.trim().replace('\\', "/");
        let dir_trimmed = dir_norm.trim_end_matches('/');
        if !dir_trimmed.is_empty() {
            let prefix = format!("{dir_trimmed}/");
            if let Some(rest) = path.strip_prefix(&prefix) {
                path = rest.to_string();
            }
        }
    }

    while let Some(rest) = path.strip_prefix("./") {
        path = rest.to_string();
    }

    let path_cmp = strip_leading_dotslash_and_slash(&path);
    let tex_input_replaced = tex_input_name.trim().replace('\\', "/");
    let tex_input_norm = strip_leading_dotslash_and_slash(&tex_input_replaced);

    if matches!(path_cmp, "texput" | "texput.tex")
        || (!tex_input_norm.is_empty() && path_cmp == tex_input_norm)
    {
        return main_file.to_string();
    }

    path
}

fn filter_inputs(
    raw_inputs: HashMap<u32, String>,
    known_files: Option<&BTreeSet<String>>,
) -> HashMap<u32, String> {
    if let Some(known) = known_files {
        return raw_inputs
            .into_iter()
            .filter_map(|(id, path)| {
                if known.contains(&path) {
                    Some((id, path))
                } else if Path::new(&path).extension().is_none() {
                    let with_tex = format!("{path}.tex");
                    known.contains(&with_tex).then_some((id, with_tex))
                } else {
                    None
                }
            })
            .collect();
    }

    let has_tex = raw_inputs
        .values()
        .any(|path| path.to_ascii_lowercase().ends_with(".tex"));

    if !has_tex {
        return raw_inputs;
    }

    raw_inputs
        .into_iter()
        .filter(|(_, path)| {
            let ext = Path::new(path)
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase());
            !matches!(ext.as_deref(), Some("sty" | "cls" | "def" | "fd"))
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn resolve_location(
    tag: u32,
    src_line: usize,
    main_file: &str,
    filtered_inputs: &HashMap<u32, String>,
    files: &mut Vec<String>,
    file_indices: &mut HashMap<String, u32>,
    prepended_lines: usize,
    inserted_lines: usize,
    insertion_after_lines: Option<usize>,
) -> Option<(u32, usize)> {
    let path = filtered_inputs.get(&tag)?;
    let mapped_line = if path == main_file {
        map_prepared_main_line(
            src_line,
            prepended_lines,
            inserted_lines,
            insertion_after_lines,
        )?
    } else {
        src_line
    };

    let file_idx = if let Some(&idx) = file_indices.get(path) {
        idx
    } else {
        let idx = u32::try_from(files.len()).ok()?;
        files.push(path.clone());
        file_indices.insert(path.clone(), idx);
        idx
    };

    Some((file_idx, mapped_line))
}

fn parse_tag_line_col(s: &str) -> Option<(u32, usize, Option<usize>)> {
    let mut parts = s.split(',');
    let tag = parts.next()?.trim().parse::<u32>().ok()?;
    let line = parts.next()?.trim().parse::<usize>().ok()?;
    if line == 0 {
        return None;
    }
    let col = parts
        .next()
        .and_then(|c| c.trim().parse::<usize>().ok())
        .filter(|&c| c > 0);
    Some((tag, line, col))
}

fn parse_pair_f64(s: &str) -> Option<(f64, f64)> {
    let (a, b) = s.split_once(',')?;
    let a = a.trim().parse::<f64>().ok()?;
    let b = b.trim().parse::<f64>().ok()?;
    Some((a, b))
}

fn parse_box_record(rest: &str) -> Option<(u32, usize, Option<usize>, f64, f64, f64, f64, f64)> {
    let mut sections = rest.splitn(3, ':');
    let loc_part = sections.next()?;
    let pos_part = sections.next()?;
    let size_part = sections.next()?;

    let (tag, line, col) = parse_tag_line_col(loc_part)?;
    let (h, v) = parse_pair_f64(pos_part)?;
    let mut size_parts = size_part.split(',');
    let cap_w = size_parts.next()?.trim().parse::<f64>().ok()?;
    let cap_h = size_parts.next()?.trim().parse::<f64>().ok()?;
    let cap_d = size_parts.next()?.trim().parse::<f64>().ok()?;
    Some((tag, line, col, h, v, cap_w, cap_h, cap_d))
}

fn parse_point_record(rest: &str) -> Option<(u32, usize, Option<usize>, f64, f64)> {
    let (loc_part, pos_part) = rest.split_once(':')?;
    let (tag, line, col) = parse_tag_line_col(loc_part)?;
    let (h, v) = parse_pair_f64(pos_part)?;
    Some((tag, line, col, h, v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    #[test]
    fn converts_synctex_units_and_boxes_including_current_point_nodes() {
        let synctex = "\
SyncTeX Version:1
Input:1:./texput.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,1:4736287,9472574:30785863,655360,655360
(1,2,4:4736287,9472574:6553600,655360,0
x1,3:5391647,9472574
)
]
}1
";
        let map = parse_synctex_text(synctex, "main.tex", "texput.tex", None, None, 0, 0, None)
            .expect("synctex should parse");

        assert_eq!(map.files, vec!["main.tex"]);
        assert_eq!(map.pages.len(), 1);
        let page = &map.pages[0];
        assert_eq!(page.page, 1);
        assert_eq!(page.boxes.len(), 3);

        let scale = 72.0_f64 / (72.27 * 65536.0);
        let expected_x = (4736287.0 * scale) as f32;
        let expected_y = ((9472574.0 - 655360.0) * scale) as f32;
        let expected_h_hbox = (655360.0 * scale) as f32;
        let expected_h_vbox = (1310720.0 * scale) as f32;

        // vbox: level 1
        assert_eq!(page.boxes[0].level, 1);
        assert_eq!(page.boxes[0].line, 1);
        assert!((page.boxes[0].x - expected_x).abs() < 1e-3);
        assert!((page.boxes[0].y - expected_y).abs() < 1e-3);
        assert!((page.boxes[0].h - expected_h_vbox).abs() < 1e-3);

        // hbox: level 0, with column 4
        assert_eq!(page.boxes[1].level, 0);
        assert_eq!(page.boxes[1].line, 2);
        assert_eq!(page.boxes[1].column, Some(4));
        assert!((page.boxes[1].x - expected_x).abs() < 1e-3);
        assert!((page.boxes[1].y - expected_y).abs() < 1e-3);
        assert!((page.boxes[1].h - expected_h_hbox).abs() < 1e-3);

        // x current-point node: level 0, w = 12.0, inherits y/h from enclosing hbox
        assert_eq!(page.boxes[2].level, 0);
        assert_eq!(page.boxes[2].line, 3);
        assert_eq!(page.boxes[2].w, 12.0);
        assert!((page.boxes[2].x - (5391647.0 * scale) as f32).abs() < 1e-3);
        assert!((page.boxes[2].y - expected_y).abs() < 1e-3);
        assert!((page.boxes[2].h - expected_h_hbox).abs() < 1e-3);
    }

    #[test]
    fn remaps_prepared_main_lines_only_for_main_file_across_multi_file_inputs() {
        let synctex = "\
SyncTeX Version:1
Input:1:/workspace/proj/main.tex
Input:2:/workspace/proj/sections\\intro.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
(1,1:655360,655360:655360,655360,0
(1,2:655360,1310720:655360,655360,0
(1,3:655360,1966080:655360,655360,0
(1,4:655360,2621440:655360,655360,0
(2,2:655360,3276800:655360,655360,0
)
)
)
)
)
}1
";
        let known = BTreeSet::from(["main.tex".to_string(), "sections/intro.tex".to_string()]);
        // Suppose 1 prepended line at top, and 1 T1 fontenc line inserted after line 1 of original source.
        // Prepared lines:
        // 1 -> prepended guard (None)
        // 2 -> original line 1 (\documentclass)
        // 3 -> inserted T1 fontenc (None)
        // 4 -> original line 2
        let map = parse_synctex_text(
            synctex,
            "main.tex",
            "main.tex",
            Some("/workspace/proj"),
            Some(&known),
            1,
            1,
            Some(1),
        )
        .expect("synctex should parse");

        assert_eq!(map.pages[0].boxes.len(), 3);
        assert_eq!(map.files[map.pages[0].boxes[0].file_idx as usize], "main.tex");
        assert_eq!(map.pages[0].boxes[0].line, 1);
        assert_eq!(map.files[map.pages[0].boxes[1].file_idx as usize], "main.tex");
        assert_eq!(map.pages[0].boxes[1].line, 2);
        assert_eq!(
            map.files[map.pages[0].boxes[2].file_idx as usize],
            "sections/intro.tex"
        );
        assert_eq!(map.pages[0].boxes[2].line, 2);
    }

    #[test]
    fn filters_non_source_tex_extensions_when_known_files_is_none() {
        let synctex = "\
SyncTeX Version:1
Input:1:texput.tex
Input:2:/texmf/tex/latex/base/article.cls
Input:3:/texmf/tex/latex/xcolor/xcolor.sty
Input:4:/texmf/tex/latex/base/t1enc.def
Input:5:/texmf/tex/latex/base/t1cmr.fd
Input:6:./chapters/methods.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
(1,5:655360,655360:655360,655360,0
(2,10:655360,655360:655360,655360,0
(3,20:655360,655360:655360,655360,0
(4,30:655360,655360:655360,655360,0
(5,40:655360,655360:655360,655360,0
(6,7:655360,1310720:655360,655360,0
)
)
)
)
)
)
}1
";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(synctex.as_bytes()).unwrap();
        let gz = encoder.finish().unwrap();

        let map = parse_synctex_gz(&gz, "paper.tex", "texput.tex", None, None, 0, 0, None)
            .expect("gz synctex should parse");

        assert_eq!(map.files, vec!["paper.tex", "chapters/methods.tex"]);
        assert_eq!(map.pages[0].boxes.len(), 2);
        assert_eq!(map.pages[0].boxes[0].line, 5);
        assert_eq!(map.pages[0].boxes[1].line, 7);
    }

    #[test]
    fn keeps_sty_files_when_no_tex_file_exists_and_known_files_is_none() {
        let synctex = "\
SyncTeX Version:1
Input:1:custom.sty
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
(1,4:655360,655360:655360,655360,0
)
}1
";
        let map = parse_synctex_text(synctex, "main.tex", "texput.tex", None, None, 0, 0, None)
            .expect("fallback should retain non-tex when no tex exists");
        assert_eq!(map.files, vec!["custom.sty"]);
        assert_eq!(map.pages[0].boxes.len(), 1);
    }

    #[test]
    fn maps_texput_without_extension_and_leading_slash_to_main_file_with_known_files() {
        let known = BTreeSet::from(["resume_es.tex".to_string()]);
        for raw_input in ["texput", "/texput", "texput.tex", "/texput.tex", "./resume_es.tex", "/resume_es.tex"] {
            let synctex = format!(
                "\
SyncTeX Version:1
Input:1:{raw_input}
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{{1
(1,3:655360,655360:655360,655360,0
)
}}1
"
            );
            let map = parse_synctex_text(
                &synctex,
                "resume_es.tex",
                "resume_es.tex",
                None,
                Some(&known),
                0,
                0,
                None,
            )
            .unwrap_or_else(|| panic!("synctex should parse for Input:1:{raw_input}"));

            assert_eq!(map.files, vec!["resume_es.tex"]);
            assert_eq!(map.pages[0].boxes.len(), 1);
            assert_eq!(map.pages[0].boxes[0].line, 3);
        }
    }

    #[test]
    fn maps_empty_primary_input_line_to_main_file() {
        let synctex = "\
SyncTeX Version:1
Input:1:
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
(1,4:655360,655360:655360,655360,0
)
}1
";
        let known = BTreeSet::from(["resume_es.tex".to_string()]);
        let map = parse_synctex_text(
            synctex,
            "resume_es.tex",
            "resume_es.tex",
            None,
            Some(&known),
            0,
            0,
            None,
        )
        .expect("empty Input:1: should map to main_file");

        assert_eq!(map.files, vec!["resume_es.tex"]);
        assert_eq!(map.pages[0].boxes.len(), 1);
        assert_eq!(map.pages[0].boxes[0].line, 4);
    }
}
