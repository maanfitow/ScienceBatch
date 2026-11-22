use std::collections::HashMap;

use typst::foundations::Smart;
use typst::layout::{Abs, Frame, FrameItem, Point, Transform};
use typst::syntax::{FileId, Source, Span, VirtualRoot};
use typst::{World, WorldExt};
use typst_layout::PagedDocument;

use crate::types::{PdfSourceBox, PdfSourceMap, PdfSourcePage};

/// Compiles a Typst project to PDF bytes and extracts a `PdfSourceMap` from its laid-out pages.
pub fn compile_and_extract_typst(
    project: &typst_embed::Project,
    env: &typst_embed::RenderEnvironment,
) -> Result<(Vec<u8>, PdfSourceMap), typst_embed::RenderError> {
    let world = typst_embed::ProjectWorld::new(project.clone(), env.clone())
        .map_err(typst_embed::RenderError::Project)?;

    let warned = typst::compile::<PagedDocument>(&world);
    let has_missing_font_warning = warned
        .warnings
        .iter()
        .any(|diag| diag.message.to_string().starts_with("unknown font family:"));

    if has_missing_font_warning || warned.output.is_err() {
        return match typst_embed::render_pdf_world(&world) {
            Err(err) => Err(err),
            Ok(artifact) => Ok((artifact.bytes().to_vec(), PdfSourceMap::default())),
        };
    }

    let document = match warned.output {
        Ok(doc) => doc,
        Err(_) => {
            return match typst_embed::render_pdf_world(&world) {
                Err(err) => Err(err),
                Ok(artifact) => Ok((artifact.bytes().to_vec(), PdfSourceMap::default())),
            };
        }
    };

    let pdf_bytes = match typst_pdf::pdf(
        &document,
        &typst_pdf::PdfOptions {
            ident: Smart::Auto,
            ..Default::default()
        },
    ) {
        Ok(bytes) => bytes,
        Err(_) => {
            return match typst_embed::render_pdf_world(&world) {
                Err(err) => Err(err),
                Ok(artifact) => Ok((artifact.bytes().to_vec(), PdfSourceMap::default())),
            };
        }
    };

    let source_map = extract_typst_source_map(&world, &document);
    Ok((pdf_bytes, source_map))
}

struct ExtractionContext<'a> {
    world: &'a dyn World,
    files: Vec<String>,
    file_indices: HashMap<String, u32>,
    sources: HashMap<FileId, Option<Source>>,
}

impl<'a> ExtractionContext<'a> {
    fn new(world: &'a dyn World) -> Self {
        Self {
            world,
            files: Vec::new(),
            file_indices: HashMap::new(),
            sources: HashMap::new(),
        }
    }

    fn resolve_span(&mut self, span: Span, offset: u16) -> Option<(u32, usize, usize)> {
        if span.is_detached() {
            return None;
        }
        let id = span.id()?;
        if !matches!(id.root(), VirtualRoot::Project) {
            return None;
        }
        let range = self.world.range(span)?;
        let source = self
            .sources
            .entry(id)
            .or_insert_with(|| self.world.source(id).ok())
            .as_ref()?;

        let byte_idx = range.start.saturating_add(offset as usize).min(range.end);
        let (line_zero, col_zero) = source
            .lines()
            .byte_to_line_column(byte_idx)
            .or_else(|| source.lines().byte_to_line_column(range.start))?;

        let path = id.vpath().get_without_slash();
        let file_idx = if let Some(&idx) = self.file_indices.get(path) {
            idx
        } else {
            let idx = u32::try_from(self.files.len()).ok()?;
            let owned = path.to_owned();
            self.files.push(owned.clone());
            self.file_indices.insert(owned, idx);
            idx
        };

        Some((file_idx, line_zero + 1, col_zero + 1))
    }
}

fn extract_typst_source_map(world: &dyn World, document: &PagedDocument) -> PdfSourceMap {
    let mut ctx = ExtractionContext::new(world);
    let mut pages = Vec::with_capacity(document.pages().len());

    for (idx, page) in document.pages().iter().enumerate() {
        let mut boxes = Vec::new();
        traverse_frame(&page.frame, Transform::identity(), &mut ctx, &mut boxes);
        pages.push(PdfSourcePage {
            page: idx + 1,
            width_pt: page.frame.width().to_pt() as f32,
            height_pt: page.frame.height().to_pt() as f32,
            boxes,
        });
    }

    PdfSourceMap {
        files: ctx.files,
        pages,
    }
}

fn traverse_frame(
    frame: &Frame,
    tf: Transform,
    ctx: &mut ExtractionContext<'_>,
    boxes: &mut Vec<PdfSourceBox>,
) {
    for (pos, item) in frame.items() {
        match item {
            FrameItem::Group(group) => {
                let child_tf = tf
                    .pre_concat(Transform::translate(pos.x, pos.y))
                    .pre_concat(group.transform);
                traverse_frame(&group.frame, child_tf, ctx, boxes);
            }
            FrameItem::Text(text) => {
                let y0 = pos.y - text.size * 0.85;
                let y1 = pos.y + text.size * 0.25;
                let mut cursor_x = Abs::zero();
                let mut active_run: Option<(u32, usize, usize, Abs, Abs)> = None;

                for glyph in &text.glyphs {
                    let g_start = cursor_x;
                    let g_end = cursor_x + glyph.x_advance.at(text.size);
                    cursor_x = g_end;

                    let resolved = ctx.resolve_span(glyph.span.0, glyph.span.1);
                    match (active_run, resolved) {
                        (Some((rf, rl, rc, rx0, _)), Some((f, l, c)))
                            if rf == f && rl == l && rc == c =>
                        {
                            active_run = Some((rf, rl, rc, rx0, g_end));
                        }
                        (Some((rf, rl, rc, rx0, rx1)), next) => {
                            push_transformed_box(
                                tf,
                                pos.x + rx0,
                                y0,
                                pos.x + rx1,
                                y1,
                                rf,
                                rl,
                                Some(rc),
                                0,
                                boxes,
                            );
                            active_run = next.map(|(f, l, c)| (f, l, c, g_start, g_end));
                        }
                        (None, next) => {
                            active_run = next.map(|(f, l, c)| (f, l, c, g_start, g_end));
                        }
                    }
                }

                if let Some((rf, rl, rc, rx0, rx1)) = active_run {
                    push_transformed_box(
                        tf,
                        pos.x + rx0,
                        y0,
                        pos.x + rx1,
                        y1,
                        rf,
                        rl,
                        Some(rc),
                        0,
                        boxes,
                    );
                }
            }
            FrameItem::Shape(shape, span) => {
                if let Some((file_idx, line, col)) = ctx.resolve_span(*span, 0) {
                    let bbox = shape.bbox(true);
                    push_transformed_box(
                        tf,
                        pos.x + bbox.min.x,
                        pos.y + bbox.min.y,
                        pos.x + bbox.max.x,
                        pos.y + bbox.max.y,
                        file_idx,
                        line,
                        Some(col),
                        1,
                        boxes,
                    );
                }
            }
            FrameItem::Image(_, size, span) => {
                if let Some((file_idx, line, col)) = ctx.resolve_span(*span, 0) {
                    push_transformed_box(
                        tf,
                        pos.x,
                        pos.y,
                        pos.x + size.x,
                        pos.y + size.y,
                        file_idx,
                        line,
                        Some(col),
                        1,
                        boxes,
                    );
                }
            }
            FrameItem::Link(_, _) | FrameItem::Tag(_) => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn push_transformed_box(
    tf: Transform,
    x0: Abs,
    y0: Abs,
    x1: Abs,
    y1: Abs,
    file_idx: u32,
    line: usize,
    column: Option<usize>,
    level: u8,
    boxes: &mut Vec<PdfSourceBox>,
) {
    let corners = [
        Point::new(x0, y0).transform(tf),
        Point::new(x1, y0).transform(tf),
        Point::new(x0, y1).transform(tf),
        Point::new(x1, y1).transform(tf),
    ];

    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;

    for corner in corners {
        let cx = corner.x.to_pt() as f32;
        let cy = corner.y.to_pt() as f32;
        min_x = min_x.min(cx);
        min_y = min_y.min(cy);
        max_x = max_x.max(cx);
        max_y = max_y.max(cy);
    }

    let w = (max_x - min_x).max(0.0);
    let h = (max_y - min_y).max(0.0);
    if (w > 0.0 || h > 0.0)
        && min_x.is_finite()
        && min_y.is_finite()
        && w.is_finite()
        && h.is_finite()
    {
        boxes.push(PdfSourceBox {
            x: min_x,
            y: min_y,
            w,
            h,
            file_idx,
            line,
            column,
            level,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_env() -> typst_embed::RenderEnvironment {
        typst_embed::RenderEnvironment::builder()
            .font_set(typst_embed::FontSet::bundled())
            .build()
            .expect("bundled typst font environment should build")
    }

    #[test]
    fn extracts_typst_source_map_for_single_file_document() {
        let source = "= Heading\n\nFirst paragraph line.\n\n#rect(width: 40pt, height: 12pt)\n";
        let project = typst_embed::Project::builder("main.typ")
            .source_file("main.typ", source)
            .build()
            .expect("single-file project should build");

        let (pdf, map) =
            compile_and_extract_typst(&project, &test_env()).expect("typst compile should succeed");
        assert!(pdf.starts_with(b"%PDF-"));
        assert_eq!(map.files, vec!["main.typ"]);
        assert_eq!(map.pages.len(), 1);

        let page = &map.pages[0];
        assert_eq!(page.page, 1);
        assert!(page.width_pt > 0.0 && page.height_pt > 0.0);

        let lines: Vec<usize> = page.boxes.iter().map(|b| b.line).collect();
        assert!(lines.contains(&1), "expected heading line 1 in {lines:?}");
        assert!(lines.contains(&3), "expected paragraph line 3 in {lines:?}");
        assert!(
            page.boxes.iter().any(|b| b.level == 0 && b.column.is_some()),
            "expected text glyph runs at level 0 with columns"
        );
        assert!(
            page.boxes.iter().any(|b| b.level == 1 && b.line == 5),
            "expected shape fallback box at level 1 on line 5"
        );
    }

    #[test]
    fn extracts_typst_source_map_across_included_files() {
        let main_source = "#include \"sections/chapter.typ\"\n\nBack in main.\n";
        let chapter_source = "Line one in chapter.\n\nLine three in chapter.\n";
        let project = typst_embed::Project::builder("main.typ")
            .source_file("main.typ", main_source)
            .file("sections/chapter.typ", chapter_source.as_bytes().to_vec())
            .build()
            .expect("multi-file project should build");

        let (pdf, map) =
            compile_and_extract_typst(&project, &test_env()).expect("typst compile should succeed");
        assert!(pdf.starts_with(b"%PDF-"));
        assert!(map.files.contains(&"main.typ".to_string()));
        assert!(map.files.contains(&"sections/chapter.typ".to_string()));

        let chapter_idx = map
            .files
            .iter()
            .position(|f| f == "sections/chapter.typ")
            .unwrap() as u32;
        let main_idx = map.files.iter().position(|f| f == "main.typ").unwrap() as u32;

        let page = &map.pages[0];
        assert!(
            page.boxes
                .iter()
                .any(|b| b.file_idx == chapter_idx && b.line == 1),
            "expected box from sections/chapter.typ line 1"
        );
        assert!(
            page.boxes
                .iter()
                .any(|b| b.file_idx == chapter_idx && b.line == 3),
            "expected box from sections/chapter.typ line 3"
        );
        assert!(
            page.boxes
                .iter()
                .any(|b| b.file_idx == main_idx && b.line == 3),
            "expected box from main.typ line 3"
        );
    }
}
