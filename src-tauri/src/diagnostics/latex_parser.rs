use super::suggestions::get_smart_suggestion;
use crate::types::DiagnosticItem;
use std::path::Path;

pub fn prepare_latex_source(source: &str) -> (String, usize, usize) {
    let mut modified = source.to_string();
    let mut prepended_lines = 0;
    let mut inserted_lines = 0;

    // 0. Neutralize XeTeXtracingfonts to prevent Tectonic C-library SIGSEGV when fonts are missing from OS fontconfig
    let tracing_guard =
        "\\newcount\\sciencebatchtracingfonts\\let\\XeTeXtracingfonts\\sciencebatchtracingfonts\n";
    prepended_lines += tracing_guard.lines().count();
    modified = format!("{tracing_guard}{modified}");

    // 1. Resolve xcolor option clash (e.g. tikz loaded before \usepackage[options]{xcolor})
    if modified.contains("\\usepackage[")
        && modified.contains("{xcolor}")
        && !modified.contains("\\PassOptionsToPackage")
    {
        if let Some(xcolor_idx) = modified.find("{xcolor}") {
            let sub = &modified[..xcolor_idx];
            if let Some(bracket_start) = sub.rfind("\\usepackage[") {
                if let Some(bracket_end) = modified[bracket_start..xcolor_idx].find(']') {
                    let options = &modified[bracket_start + 12..bracket_start + bracket_end];
                    let pass_opt = format!("\\PassOptionsToPackage{{{options}}}{{xcolor}}\n");
                    prepended_lines += pass_opt.lines().count();
                    modified = format!("{pass_opt}{modified}");
                }
            }
        }
    }

    // 2. Resolve Times Roman font fallback in XeTeX/Tectonic (e.g. IEEEtran with \rmdefault{ptm})
    // Under XeTeX's default TU unicode encoding, ptm has no metric file and falls back to wide Latin Modern.
    // Ensuring T1 fontenc loads URW Nimbus Roman (NimbusRomNo9L), preserving exact page count and line breaking.
    let needs_t1 = (modified.contains("IEEEtran") || modified.contains("{ptm}"))
        && !modified.contains("{fontenc}")
        && !modified.contains("{fontspec}");

    if needs_t1 {
        if let Some(doc_class_pos) = modified.find("\\documentclass") {
            if let Some(newline_pos) = modified[doc_class_pos..].find('\n') {
                let insert_at = doc_class_pos + newline_pos + 1;
                let injection = "\\usepackage[T1]{fontenc}\n";
                inserted_lines = injection.lines().count();
                modified.insert_str(insert_at, injection);
            }
        }
    }

    // 3. Resolve biblatex backend for Tectonic (ensure backend=bibtex if not specified, avoiding Biber dependency)
    if modified.contains("{biblatex}") && !modified.contains("backend=") {
        let pass_backend = "\\PassOptionsToPackage{backend=bibtex}{biblatex}\n";
        prepended_lines += pass_backend.lines().count();
        modified = format!("{pass_backend}{modified}");
    }

    // 4. Resolve Cochineal & Cabin font loading for XeTeX/Tectonic (Overleaf compatibility)
    // Overleaf uses system-wide fontconfig font caches. In Tectonic VFS, OpenType fonts in the bundle
    // must be referenced by filename to bypass fontconfig.
    if modified.contains("{cochineal}") {
        if let Some(idx) = modified.find("{cochineal}") {
            if let Some(start) = modified[..idx].rfind("\\usepackage") {
                let end = idx + "{cochineal}".len();
                let replacement = "\\setmainfont{Cochineal-Roman.otf}[BoldFont=Cochineal-Bold.otf,ItalicFont=Cochineal-Italic.otf,BoldItalicFont=Cochineal-BoldItalic.otf]";
                modified.replace_range(start..end, replacement);
            }
        }
    }
    if modified.contains("{cabin}") {
        if let Some(idx) = modified.find("{cabin}") {
            if let Some(start) = modified[..idx].rfind("\\usepackage") {
                let end = idx + "{cabin}".len();
                let replacement = "\\setsansfont{Cabin-Regular.otf}[BoldFont=Cabin-Bold.otf,ItalicFont=Cabin-Italic.otf,BoldItalicFont=Cabin-BoldItalic.otf]";
                modified.replace_range(start..end, replacement);
            }
        }
    }

    (modified, prepended_lines, inserted_lines)
}

pub fn extract_candidate_filename(s: &str) -> Option<String> {
    let s = s.trim_start();
    if s.starts_with('"') {
        let after_quote = &s[1..];
        if let Some(end_quote) = after_quote.find('"') {
            return Some(after_quote[..end_quote].to_string());
        }
    }
    let end = s
        .find(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == '[' || c == ']')
        .unwrap_or(s.len());
    let cand = &s[..end];
    if cand.is_empty() {
        None
    } else {
        Some(cand.to_string())
    }
}

pub fn is_valid_tex_file_candidate(cand: &str, project_dir: Option<&str>) -> bool {
    let clean = cand.trim_matches('"').trim_start_matches("./");
    if clean.is_empty() {
        return false;
    }
    if clean == "texput.tex" {
        return true;
    }
    let lower = clean.to_lowercase();
    let extensions = [
        ".tex", ".sty", ".cls", ".bib", ".bbl", ".aux", ".def", ".ldf", ".fd", ".cfg", ".dtx",
        ".ins", ".toc", ".lof", ".lot", ".out", ".png", ".jpg", ".jpeg", ".pdf", ".eps",
    ];
    if extensions.iter().any(|ext| lower.ends_with(ext)) {
        return true;
    }
    if let Some(dir) = project_dir {
        let p = Path::new(dir).join(clean);
        if p.is_file() {
            return true;
        }
    }
    false
}

pub fn normalize_tex_file_name(
    cand: &str,
    main_file: Option<&str>,
    project_dir: Option<&str>,
) -> String {
    let clean = cand.trim_matches('"');
    if clean == "texput.tex" {
        return main_file.unwrap_or("main.tex").to_string();
    }
    if let Some(dir) = project_dir {
        let dir_prefix = dir.trim_end_matches('/');
        if let Some(rel) = clean.strip_prefix(dir_prefix) {
            return rel.trim_start_matches('/').to_string();
        }
    }
    let stripped = clean.trim_start_matches("./");
    if stripped.starts_with('/') {
        if let Some(name) = Path::new(stripped).file_name().and_then(|n| n.to_str()) {
            return name.to_string();
        }
    }
    stripped.to_string()
}

pub fn parse_latex_log(
    raw_log: &str,
    total_injected: usize,
    root_file: &str,
    project_dir: Option<&str>,
    main_file: Option<&str>,
) -> (Vec<DiagnosticItem>, Vec<DiagnosticItem>) {
    parse_latex_log_with_snapshot(
        raw_log,
        total_injected,
        root_file,
        project_dir,
        main_file,
        None,
    )
}

/// Parse a compiler log using the set of files captured in an in-memory project.
/// This variant resolves extensionless TeX input names without consulting disk.
pub fn parse_latex_log_with_snapshot(
    raw_log: &str,
    total_injected: usize,
    root_file: &str,
    project_dir: Option<&str>,
    main_file: Option<&str>,
    snapshot_files: Option<&std::collections::BTreeSet<String>>,
) -> (Vec<DiagnosticItem>, Vec<DiagnosticItem>) {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut file_stack: Vec<(usize, Option<String>)> = Vec::new();
    let mut paren_depth: usize = 0;

    let log_lines: Vec<&str> = raw_log.lines().collect();

    for (i, line) in log_lines.iter().enumerate() {
        let trimmed = line.trim();

        if trimmed.starts_with('!') {
            let msg = trimmed.to_string();
            let suggestion = get_smart_suggestion(&msg);

            let mut detected_line = None;
            for next_line in log_lines.iter().skip(i + 1).take(12) {
                let next_trim = next_line.trim();
                if next_trim.starts_with("l.") {
                    let rest = &next_trim[2..];
                    let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(num) = num_str.parse::<usize>() {
                        detected_line = Some(num);
                        break;
                    }
                }
            }

            let current_file = file_stack.last().and_then(|(_, file)| file.clone());

            if snapshot_files.is_some() && current_file.is_none() {
                detected_line = None;
            }

            // If the error indicates a missing package (.sty) or document class (.cls),
            // the 'l.<line>' printed in the log comes from an internal \usepackage or style file,
            // not the user's main source code. Do not assign it to the main file line.
            if msg.contains("File")
                && msg.contains("not found")
                && (msg.contains(".sty") || msg.contains(".cls"))
            {
                detected_line = None;
            } else if snapshot_files.is_none()
                && current_file.as_deref().unwrap_or(root_file) == root_file
            {
                if let Some(ref mut l) = detected_line {
                    if *l > total_injected {
                        *l -= total_injected;
                    }
                }
            } else if snapshot_files.is_some() && current_file.as_deref() == Some(root_file) {
                clear_injected_main_location(&mut detected_line, total_injected);
            }

            errors.push(DiagnosticItem {
                severity: "error".into(),
                message: msg,
                line: detected_line,
                file: current_file,
                suggestion,
            });
        } else if trimmed.starts_with("LaTeX Warning:")
            || trimmed.starts_with("Package") && trimmed.contains("Warning:")
        {
            let msg = trimmed.to_string();
            let suggestion = get_smart_suggestion(&msg);

            let mut detected_line = None;
            if let Some(pos) = msg.find("input line ") {
                let rest = &msg[pos + 11..];
                let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                detected_line = num_str.parse().ok();
            } else if let Some(pos) = msg.find("line ") {
                let rest = &msg[pos + 5..];
                let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                detected_line = num_str.parse().ok();
            }

            let current_file = file_stack.last().and_then(|(_, file)| file.clone());

            if snapshot_files.is_some() && current_file.is_none() {
                detected_line = None;
            }

            if snapshot_files.is_none() && current_file.as_deref().unwrap_or(root_file) == root_file
            {
                if let Some(ref mut l) = detected_line {
                    if *l > total_injected {
                        *l -= total_injected;
                    }
                }
            } else if snapshot_files.is_some() && current_file.as_deref() == Some(root_file) {
                clear_injected_main_location(&mut detected_line, total_injected);
            }

            warnings.push(DiagnosticItem {
                severity: "warning".into(),
                message: msg,
                line: detected_line,
                file: current_file,
                suggestion,
            });
        }

        // Scan characters in line to track TeX file enter/exit transitions
        let chars: Vec<(usize, char)> = line.char_indices().collect();
        for (idx, ch) in chars {
            if ch == '(' {
                paren_depth += 1;
                let remainder = &line[idx + 1..];
                if let Some(cand) = extract_candidate_filename(remainder) {
                    let normalized = if let Some(files) = snapshot_files {
                        resolve_snapshot_tex_name(&cand, files)
                    } else if is_valid_tex_file_candidate(&cand, project_dir) {
                        Some(normalize_tex_file_name(&cand, main_file, project_dir))
                    } else {
                        None
                    };
                    if snapshot_files.is_some() {
                        if normalized.is_some() || looks_like_engine_file(&cand) {
                            // Preserve unknown package/class frames too. Their diagnostics must
                            // not be attributed to the last project source file on the stack.
                            file_stack.push((paren_depth, normalized));
                        }
                    } else if let Some(normalized) = normalized {
                        file_stack.push((paren_depth, Some(normalized)));
                    }
                }
            } else if ch == ')' {
                if let Some((depth, _)) = file_stack.last() {
                    if *depth == paren_depth {
                        file_stack.pop();
                    }
                }
                paren_depth = paren_depth.saturating_sub(1);
            }
        }
    }

    (errors, warnings)
}

fn clear_injected_main_location(line: &mut Option<usize>, injected: usize) {
    // The compiler preparation may insert lines at the start and after the document class.
    // A total count cannot map a compiler line back across both insertion points exactly.
    if injected > 0 {
        *line = None;
    }
}

fn looks_like_engine_file(candidate: &str) -> bool {
    let clean = candidate.trim_matches('"').trim_start_matches("./");
    let lower = clean.to_ascii_lowercase();
    [
        ".tex", ".sty", ".cls", ".bib", ".bbl", ".aux", ".def", ".ldf", ".fd", ".cfg", ".dtx",
        ".ins", ".toc", ".lof", ".lot", ".out", ".pdf", ".png", ".jpg", ".jpeg", ".eps",
    ]
    .iter()
    .any(|extension| lower.ends_with(extension))
}

fn resolve_snapshot_tex_name(
    candidate: &str,
    files: &std::collections::BTreeSet<String>,
) -> Option<String> {
    let clean = candidate
        .trim_matches('"')
        .trim_start_matches("./")
        .replace('\\', "/");
    if files.contains(&clean) {
        return Some(clean);
    }
    if Path::new(&clean).extension().is_some() {
        return None;
    }
    [
        ".tex", ".sty", ".cls", ".bib", ".bbl", ".def", ".ldf", ".fd", ".cfg", ".pdf", ".png",
        ".jpg", ".jpeg", ".eps",
    ]
    .iter()
    .map(|extension| format!("{clean}{extension}"))
    .find(|path| files.contains(path))
}

#[cfg(test)]
mod snapshot_location_tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn maps_extensionless_nested_inputs_to_snapshot_files_without_disk_reads() {
        let files = BTreeSet::from(["paper.tex".to_owned(), "sections/body.tex".to_owned()]);
        let log = "(paper.tex\n(sections/body\n! Undefined control sequence.\nl.2 \\UnknownCommand\n)\n)\n";
        let (errors, _) = parse_latex_log_with_snapshot(
            log,
            0,
            "paper.tex",
            None,
            Some("paper.tex"),
            Some(&files),
        );
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].file.as_deref(), Some("sections/body.tex"));
        assert_eq!(errors[0].line, Some(2));
    }

    #[test]
    fn unknown_package_frames_and_unframed_errors_have_unknown_locations() {
        let files = BTreeSet::from(["paper.tex".to_owned()]);
        let log = "(paper.tex\n(foo.sty\n! Package failure.\nl.250 \\bad\n)\n)\n! Unframed failure.\nl.12 \\bad\n";
        let (errors, _) = parse_latex_log_with_snapshot(
            log,
            0,
            "paper.tex",
            None,
            Some("paper.tex"),
            Some(&files),
        );
        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0].file, None);
        assert_eq!(errors[0].line, None);
        assert_eq!(errors[1].file, None);
        assert_eq!(errors[1].line, None);
    }

    #[test]
    fn injected_main_file_lines_are_not_reported_when_unprovable() {
        let files = BTreeSet::from(["paper.tex".to_owned()]);
        let (errors, _) = parse_latex_log_with_snapshot(
            "(paper.tex\n! Failure.\nl.2 \\\\bad\n)\n",
            2,
            "paper.tex",
            None,
            Some("paper.tex"),
            Some(&files),
        );
        assert_eq!(errors[0].file.as_deref(), Some("paper.tex"));
        assert_eq!(errors[0].line, None);
    }
}
