use std::path::Path;
use super::markdown::{latex_to_markdown_with_dir, typst_to_markdown_with_dir};

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn format_inline(s: &str) -> String {
    let mut res = s.to_string();

    let mut math_spans = Vec::new();
    let mut idx = 0;
    let mut new_res = String::new();

    while idx < res.len() {
        let bytes = res.as_bytes();
        if bytes[idx] == b'\\' && idx + 1 < bytes.len() && bytes[idx + 1] == b'$' {
            new_res.push('$');
            idx += 2;
            continue;
        }
        if bytes[idx] == b'$' && idx + 1 < bytes.len() && bytes[idx + 1] == b'$' {
            if let Some(end_dollar) = res[idx + 2..].find("$$") {
                let end_pos = idx + 2 + end_dollar + 1;
                let formula = &res[idx..=end_pos];
                let placeholder = format!("__MATH_SPAN_{}__", math_spans.len());
                math_spans.push(formula.to_string());
                new_res.push_str(&placeholder);
                idx = end_pos + 1;
                continue;
            }
        }
        if bytes[idx] == b'$' {
            if let Some(end_dollar) = res[idx + 1..].find('$') {
                let end_pos = idx + 1 + end_dollar;
                let formula = &res[idx..=end_pos];
                let placeholder = format!("__MATH_SPAN_{}__", math_spans.len());
                math_spans.push(formula.to_string());
                new_res.push_str(&placeholder);
                idx = end_pos + 1;
                continue;
            }
        }
        let ch = res[idx..].chars().next().unwrap();
        new_res.push(ch);
        idx += ch.len_utf8();
    }
    res = new_res;

    while let Some(start) = res.find("**") {
        if let Some(end) = res[start + 2..].find("**") {
            let bold_text = &res[start + 2..start + 2 + end];
            let repl = format!("<strong>{bold_text}</strong>");
            res = format!("{}{}{}", &res[..start], repl, &res[start + 2 + end + 2..]);
        } else {
            break;
        }
    }

    while let Some(start) = res.find('*') {
        if let Some(end) = res[start + 1..].find('*') {
            let it_text = &res[start + 1..start + 1 + end];
            let repl = format!("<em>{it_text}</em>");
            res = format!("{}{}{}", &res[..start], repl, &res[start + 1 + end + 1..]);
        } else {
            break;
        }
    }

    while let Some(start) = res.find('`') {
        if let Some(end) = res[start + 1..].find('`') {
            let code_text = &res[start + 1..start + 1 + end];
            let repl = format!("<code>{}</code>", escape_html(code_text));
            res = format!("{}{}{}", &res[..start], repl, &res[start + 1 + end + 1..]);
        } else {
            break;
        }
    }

    while let Some(start) = res.find("![") {
        if let Some(alt_end) = res[start + 2..].find(']') {
            let alt = &res[start + 2..start + 2 + alt_end];
            let after_alt = start + 2 + alt_end + 1;
            if after_alt < res.len() && res.as_bytes()[after_alt] == b'(' {
                if let Some(url_end) = res[after_alt + 1..].find(')') {
                    let url = &res[after_alt + 1..after_alt + 1 + url_end];
                    let repl = if alt.eq_ignore_ascii_case("photo") || alt.eq_ignore_ascii_case("profile photo") {
                        format!("<figure class=\"profile-photo\"><img src=\"{url}\" alt=\"{alt}\"></figure>")
                    } else {
                        format!("<figure><img src=\"{url}\" alt=\"{alt}\"><figcaption>{alt}</figcaption></figure>")
                    };
                    res = format!("{}{}{}", &res[..start], repl, &res[after_alt + 1 + url_end + 1..]);
                    continue;
                }
            }
        }
        break;
    }

    while let Some(start) = res.find('[') {
        if let Some(txt_end) = res[start + 1..].find(']') {
            let label = &res[start + 1..start + 1 + txt_end];
            let after_txt = start + 1 + txt_end + 1;
            if after_txt < res.len() && res.as_bytes()[after_txt] == b'(' {
                if let Some(url_end) = res[after_txt + 1..].find(')') {
                    let url = &res[after_txt + 1..after_txt + 1 + url_end];
                    let repl = format!("<a href=\"{url}\" target=\"_blank\" rel=\"noopener\">{label}</a>");
                    res = format!("{}{}{}", &res[..start], repl, &res[after_txt + 1 + url_end + 1..]);
                    continue;
                }
            }
        }
        break;
    }

    for (i, span) in math_spans.iter().enumerate() {
        let placeholder = format!("__MATH_SPAN_{i}__");
        res = res.replace(&placeholder, span);
    }

    res
}

pub fn markdown_to_html_body(md: &str) -> String {
    let mut out = String::new();
    let mut in_code = false;
    let mut code_buf = Vec::new();
    let mut in_math = false;
    let mut math_buf = Vec::new();
    let mut in_ul = false;
    let mut in_ol = false;
    let mut in_blockquote = false;
    let mut bq_buf = Vec::new();

    let mut lines = md.lines().peekable();

    while let Some(line) = lines.next() {
        let trimmed = line.trim();

        // Code blocks
        if trimmed.starts_with("```") {
            if in_code {
                in_code = false;
                out.push_str("<pre><code>");
                out.push_str(&escape_html(&code_buf.join("\n")));
                out.push_str("</code></pre>\n");
                code_buf.clear();
            } else {
                in_code = true;
            }
            continue;
        }
        if in_code {
            code_buf.push(line);
            continue;
        }

        // Display math single-line
        if trimmed.starts_with("$$") && trimmed.ends_with("$$") && trimmed.len() > 2 && !trimmed[2..trimmed.len() - 2].contains("$$") {
            let content = trimmed[2..trimmed.len() - 2].trim();
            out.push_str(&format!("<div class=\"math-block\">$$\n{content}\n$$</div>\n"));
            continue;
        }

        // Display math multi-line
        if trimmed == "$$" {
            if in_math {
                in_math = false;
                out.push_str("<div class=\"math-block\">$$\n");
                out.push_str(&math_buf.join("\n"));
                out.push_str("\n$$</div>\n");
                math_buf.clear();
            } else {
                in_math = true;
            }
            continue;
        }
        if in_math {
            math_buf.push(line);
            continue;
        }

        // Markdown Table
        if trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.len() > 1 {
            let mut table_lines = vec![trimmed];
            while let Some(&next_l) = lines.peek() {
                let next_t = next_l.trim();
                if next_t.starts_with('|') && next_t.ends_with('|') && next_t.len() > 1 {
                    table_lines.push(next_t);
                    lines.next();
                } else {
                    break;
                }
            }

            if table_lines.len() >= 2 && table_lines[1].contains("---") {
                out.push_str("<div class=\"table-container\">\n<table class=\"latex-table\">\n<thead>\n<tr>\n");
                let header_cells = table_lines[0].split('|').map(|c| c.trim()).filter(|c| !c.is_empty());
                for c in header_cells {
                    out.push_str(&format!("  <th>{}</th>\n", format_inline(c)));
                }
                out.push_str("</tr>\n</thead>\n<tbody>\n");
                for row_line in &table_lines[2..] {
                    out.push_str("<tr>\n");
                    let cells = row_line.split('|').map(|c| c.trim()).filter(|c| !c.is_empty());
                    for c in cells {
                        out.push_str(&format!("  <td>{}</td>\n", format_inline(c)));
                    }
                    out.push_str("</tr>\n");
                }
                out.push_str("</tbody>\n</table>\n</div>\n");
                continue;
            }
        }

        // Blockquotes
        if trimmed.starts_with('>') {
            let bq_content = trimmed.strip_prefix('>').unwrap_or("").trim();
            bq_buf.push(bq_content);
            in_blockquote = true;
            continue;
        } else if in_blockquote {
            in_blockquote = false;
            let formatted_inner = bq_buf.iter().map(|l| format_inline(l)).collect::<Vec<_>>().join("<br>\n");
            out.push_str(&format!("<blockquote>\n{formatted_inner}\n</blockquote>\n"));
            bq_buf.clear();
        }

        // Lists
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            if !in_ul {
                if in_ol {
                    out.push_str("</ol>\n");
                    in_ol = false;
                }
                out.push_str("<ul>\n");
                in_ul = true;
            }
            let item_content = format_inline(&trimmed[2..]);
            out.push_str(&format!("  <li>{item_content}</li>\n"));
            continue;
        } else if trimmed.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) && trimmed.contains(". ") {
            if let Some(dot_idx) = trimmed.find(". ") {
                if !in_ol {
                    if in_ul {
                        out.push_str("</ul>\n");
                        in_ul = false;
                    }
                    out.push_str("<ol>\n");
                    in_ol = true;
                }
                let item_content = format_inline(&trimmed[dot_idx + 2..]);
                out.push_str(&format!("  <li>{item_content}</li>\n"));
                continue;
            }
        }

        if in_ul {
            out.push_str("</ul>\n");
            in_ul = false;
        }
        if in_ol {
            out.push_str("</ol>\n");
            in_ol = false;
        }

        if trimmed.is_empty() {
            continue;
        }

        if let Some(h) = trimmed.strip_prefix("#### ") {
            out.push_str(&format!("<h4>{}</h4>\n", format_inline(h)));
        } else if let Some(h) = trimmed.strip_prefix("### ") {
            out.push_str(&format!("<h3>{}</h3>\n", format_inline(h)));
        } else if let Some(h) = trimmed.strip_prefix("## ") {
            out.push_str(&format!("<h2>{}</h2>\n", format_inline(h)));
        } else if let Some(h) = trimmed.strip_prefix("# ") {
            out.push_str(&format!("<h1>{}</h1>\n", format_inline(h)));
        } else if trimmed == "---" {
            out.push_str("<hr>\n");
        } else {
            out.push_str(&format!("<p>{}</p>\n", format_inline(trimmed)));
        }
    }

    if in_code {
        out.push_str("<pre><code>");
        out.push_str(&escape_html(&code_buf.join("\n")));
        out.push_str("</code></pre>\n");
    }
    if in_math {
        out.push_str("<div class=\"math-block\">$$\n");
        out.push_str(&math_buf.join("\n"));
        out.push_str("\n$$</div>\n");
    }
    if in_blockquote {
        let formatted_inner = bq_buf.iter().map(|l| format_inline(l)).collect::<Vec<_>>().join("<br>\n");
        out.push_str(&format!("<blockquote>\n{formatted_inner}\n</blockquote>\n"));
    }
    if in_ul {
        out.push_str("</ul>\n");
    }
    if in_ol {
        out.push_str("</ol>\n");
    }

    out
}

pub fn base64_encode(data: &[u8]) -> String {
    const CHARSET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        result.push(CHARSET[(b0 >> 2) as usize] as char);
        result.push(CHARSET[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARSET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARSET[(b2 & 0x3f) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

pub fn embed_local_images_as_base64(html: &str, project_dir: Option<&Path>) -> String {
    let Some(dir) = project_dir else {
        return html.to_string();
    };

    let mut result = String::with_capacity(html.len());
    let mut i = 0;
    let marker = "<img src=\"";

    while i < html.len() {
        if html[i..].starts_with(marker) {
            let src_start = i + marker.len();
            if let Some(quote_rel) = html[src_start..].find('"') {
                let src_end = src_start + quote_rel;
                let src_path = &html[src_start..src_end];

                if !src_path.starts_with("http://") && !src_path.starts_with("https://") && !src_path.starts_with("data:") {
                    let mut full_path = dir.join(src_path);
                    if !full_path.exists() {
                        for ext in &["jpg", "jpeg", "png", "svg", "webp", "gif"] {
                            let cand = dir.join(format!("{src_path}.{ext}"));
                            if cand.exists() && cand.is_file() {
                                full_path = cand;
                                break;
                            }
                        }
                    }
                    if full_path.exists() && full_path.is_file() {
                        let ext = full_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                        let mime = match ext.as_str() {
                            "png" => Some("image/png"),
                            "jpg" | "jpeg" => Some("image/jpeg"),
                            "svg" => Some("image/svg+xml"),
                            "webp" => Some("image/webp"),
                            "gif" => Some("image/gif"),
                            _ => None,
                        };
                        if let Some(m) = mime {
                            if let Ok(img_bytes) = std::fs::read(&full_path) {
                                let b64 = base64_encode(&img_bytes);
                                result.push_str("<img src=\"data:");
                                result.push_str(m);
                                result.push_str(";base64,");
                                result.push_str(&b64);
                                result.push('"');
                                i = src_end + 1;
                                continue;
                            }
                        }
                    }
                }
            }
        }
        let ch = html[i..].chars().next().unwrap();
        result.push(ch);
        i += ch.len_utf8();
    }
    result
}

pub fn wrap_html_template(title: &str, body: &str) -> String {
    format!(
r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
    onload="renderMathInElement(document.body, {{delimiters: [{{left: '$$', right: '$$', display: true}}, {{left: '$', right: '$', display: false}}]}});"></script>
  <style>
    :root {{
      --bg: #ffffff;
      --text: #1e293b;
      --muted: #64748b;
      --border: #e2e8f0;
      --code-bg: #f8fafc;
      --primary: #2563eb;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --bg: #0f172a;
        --text: #f8fafc;
        --muted: #94a3b8;
        --border: #334155;
        --code-bg: #1e293b;
        --primary: #3b82f6;
      }}
    }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.7;
      margin: 0;
      padding: 40px 20px;
    }}
    .container {{
      max-width: 860px;
      margin: 0 auto;
    }}
    h1, h2, h3, h4 {{
      color: var(--text);
      font-weight: 700;
      line-height: 1.3;
    }}
    h1 {{
      font-size: 2.2rem;
      border-bottom: 2px solid var(--border);
      padding-bottom: 12px;
      margin-top: 0;
    }}
    h2 {{
      font-size: 1.6rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      margin-top: 2rem;
    }}
    h3 {{ font-size: 1.25rem; margin-top: 1.5rem; }}
    h4 {{ font-size: 1.05rem; margin-top: 1.2rem; }}
    p {{ margin: 1rem 0; }}
    a {{ color: var(--primary); text-decoration: underline; }}
    code {{
      font-family: "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace;
      background: var(--code-bg);
      padding: 0.2em 0.4em;
      border-radius: 4px;
      font-size: 0.9em;
      border: 1px solid var(--border);
    }}
    pre {{
      background: var(--code-bg);
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      border: 1px solid var(--border);
    }}
    pre code {{ background: none; padding: 0; border: none; }}
    blockquote {{
      border-left: 4px solid var(--primary);
      margin: 1.5rem 0;
      padding: 0.8rem 1.2rem;
      color: var(--text);
      background: var(--code-bg);
      border-radius: 0 6px 6px 0;
      font-size: 0.95rem;
    }}
    blockquote strong {{
      color: var(--primary);
    }}
    .table-container {{
      margin: 1.8rem 0;
      overflow-x: auto;
      border-radius: 8px;
      border: 1px solid var(--border);
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 0.95rem;
      text-align: left;
    }}
    th {{
      background: var(--code-bg);
      font-weight: 600;
      padding: 10px 14px;
      border-bottom: 2px solid var(--border);
      color: var(--text);
    }}
    td {{
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
    }}
    tr:last-child td {{
      border-bottom: none;
    }}
    tr:nth-child(even) td {{
      background: rgba(0, 0, 0, 0.015);
    }}
    @media (prefers-color-scheme: dark) {{
      tr:nth-child(even) td {{
        background: rgba(255, 255, 255, 0.02);
      }}
    }}
    img {{ max-width: 100%; height: auto; border-radius: 6px; }}
    figure {{ margin: 1.5rem 0; text-align: center; }}
    figure.profile-photo {{ margin: 1.5rem 0 2rem 0; text-align: left; }}
    figure.profile-photo img {{ max-width: 140px; height: 140px; border-radius: 50%; object-fit: cover; border: 3px solid var(--primary); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12); }}
    figcaption {{ color: var(--muted); font-size: 0.9rem; margin-top: 6px; }}
    .math-block {{ margin: 1.5rem 0; text-align: center; overflow-x: auto; }}
    ul, ol {{ padding-left: 2rem; margin: 1rem 0; }}
    li {{ margin-bottom: 0.4rem; }}
    hr {{ border: none; border-top: 1px solid var(--border); margin: 2rem 0; }}
    @media print {{
      body {{
        padding: 0;
        background: #ffffff;
        color: #000000;
      }}
      .container {{
        max-width: 100%;
      }}
      .table-container {{
        border: 1px solid #ccc;
      }}
      th, td {{
        border-color: #ccc;
      }}
      a {{
        color: #000000;
        text-decoration: none;
      }}
    }}
  </style>
</head>
<body>
  <article class="container">
    {body}
  </article>
</body>
</html>"#
    )
}

pub fn latex_to_html_with_dir(latex: &str, title: &str, project_dir: Option<&Path>) -> String {
    let md = latex_to_markdown_with_dir(latex, project_dir);
    let body = markdown_to_html_body(&md);
    let html = wrap_html_template(title, &body);
    embed_local_images_as_base64(&html, project_dir)
}

pub fn latex_to_html(latex: &str, title: &str) -> String {
    latex_to_html_with_dir(latex, title, None)
}

pub fn typst_to_html_with_dir(typst: &str, title: &str, project_dir: Option<&Path>) -> String {
    let md = typst_to_markdown_with_dir(typst, project_dir);
    let body = markdown_to_html_body(&md);
    let html = wrap_html_template(title, &body);
    embed_local_images_as_base64(&html, project_dir)
}

pub fn typst_to_html(typst: &str, title: &str) -> String {
    typst_to_html_with_dir(typst, title, None)
}
