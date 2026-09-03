use std::collections::HashSet;
use std::path::Path;

pub fn extract_balanced_braces(source: &str, start_search: usize) -> Option<(String, usize, usize)> {
    let bytes = source.as_bytes();
    let mut scan = start_search;
    while scan < bytes.len() && (bytes[scan] == b' ' || bytes[scan] == b'\t' || bytes[scan] == b'\n') {
        scan += 1;
    }
    if scan >= bytes.len() || bytes[scan] != b'{' {
        return None;
    }
    let content_start = scan + 1;
    let mut depth = 1;
    let mut j = content_start;
    while j < bytes.len() && depth > 0 {
        if bytes[j] == b'\\' {
            j += 1;
            if j < bytes.len() && (bytes[j] == b'{' || bytes[j] == b'}' || bytes[j] == b'\\') {
                j += 1;
            }
            continue;
        }
        if bytes[j] == b'{' {
            depth += 1;
        } else if bytes[j] == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some((source[content_start..j].to_string(), start_search, j + 1));
            }
        }
        j += 1;
    }
    None
}

pub fn extract_balanced_brackets(source: &str, start_search: usize) -> Option<(String, usize, usize)> {
    let bytes = source.as_bytes();
    let mut scan = start_search;
    while scan < bytes.len() && (bytes[scan] == b' ' || bytes[scan] == b'\t' || bytes[scan] == b'\n') {
        scan += 1;
    }
    if scan >= bytes.len() || bytes[scan] != b'[' {
        return None;
    }
    let content_start = scan + 1;
    let mut depth = 1;
    let mut j = content_start;
    while j < bytes.len() && depth > 0 {
        if bytes[j] == b'\\' {
            j += 1;
            if j < bytes.len() && (bytes[j] == b'[' || bytes[j] == b']' || bytes[j] == b'\\') {
                j += 1;
            }
            continue;
        }
        if bytes[j] == b'[' {
            depth += 1;
        } else if bytes[j] == b']' {
            depth -= 1;
            if depth == 0 {
                return Some((source[content_start..j].to_string(), start_search, j + 1));
            }
        }
        j += 1;
    }
    None
}

pub fn extract_balanced_parens(source: &str, start_search: usize) -> Option<(String, usize, usize)> {
    let bytes = source.as_bytes();
    let mut scan = start_search;
    while scan < bytes.len() && (bytes[scan] == b' ' || bytes[scan] == b'\t' || bytes[scan] == b'\n') {
        scan += 1;
    }
    if scan >= bytes.len() || bytes[scan] != b'(' {
        return None;
    }
    let content_start = scan + 1;
    let mut depth = 1;
    let mut j = content_start;
    while j < bytes.len() && depth > 0 {
        if bytes[j] == b'\\' {
            j += 1;
            if j < bytes.len() && (bytes[j] == b'(' || bytes[j] == b')' || bytes[j] == b'\\') {
                j += 1;
            }
            continue;
        }
        if bytes[j] == b'(' {
            depth += 1;
        } else if bytes[j] == b')' {
            depth -= 1;
            if depth == 0 {
                return Some((source[content_start..j].to_string(), start_search, j + 1));
            }
        }
        j += 1;
    }
    None
}

pub fn remove_latex_command_balanced(source: &str, cmd: &str) -> String {
    let mut result = String::with_capacity(source.len());
    let mut i = 0;
    let cmd_pattern = format!("\\{cmd}");
    let cmd_star_pattern = format!("\\{cmd}*");

    while i < source.len() {
        let remaining = &source[i..];
        let mut matched_len = 0;
        if remaining.starts_with(&cmd_star_pattern) {
            matched_len = cmd_star_pattern.len();
        } else if remaining.starts_with(&cmd_pattern) {
            matched_len = cmd_pattern.len();
        }

        if matched_len > 0 {
            let mut scan = i + matched_len;
            let mut skip_cmd = false;
            if scan < source.len() && source[scan..].chars().next().map(|c| c.is_alphabetic()).unwrap_or(false) {
                skip_cmd = true;
            }

            if !skip_cmd {
                if scan < source.len() && source.as_bytes()[scan] == b'[' {
                    if let Some(end_bracket) = source[scan..].find(']') {
                        scan += end_bracket + 1;
                    }
                }
                while scan < source.len() && (source.as_bytes()[scan] == b' ' || source.as_bytes()[scan] == b'\t' || source.as_bytes()[scan] == b'\n') {
                    scan += 1;
                }

                if scan < source.len() && source.as_bytes()[scan] == b'{' {
                    if let Some((_, _, end_pos)) = extract_balanced_braces(source, scan) {
                        i = end_pos;
                        continue;
                    }
                } else {
                    i = scan;
                    continue;
                }
            }
        }

        let ch = source[i..].chars().next().unwrap();
        result.push(ch);
        i += ch.len_utf8();
    }
    result
}

pub fn replace_latex_command_balanced(source: &str, cmd: &str, prefix: &str, suffix: &str) -> String {
    let mut result = String::with_capacity(source.len());
    let mut i = 0;
    let cmd_pattern = format!("\\{cmd}");
    let cmd_star_pattern = format!("\\{cmd}*");

    while i < source.len() {
        let remaining = &source[i..];
        let mut matched_len = 0;
        if remaining.starts_with(&cmd_star_pattern) {
            matched_len = cmd_star_pattern.len();
        } else if remaining.starts_with(&cmd_pattern) {
            matched_len = cmd_pattern.len();
        }

        if matched_len > 0 {
            let mut scan = i + matched_len;
            let mut skip_cmd = false;
            if scan < source.len() && source[scan..].chars().next().map(|c| c.is_alphabetic()).unwrap_or(false) {
                skip_cmd = true;
            }

            if !skip_cmd {
                if scan < source.len() && source.as_bytes()[scan] == b'[' {
                    if let Some(end_bracket) = source[scan..].find(']') {
                        scan += end_bracket + 1;
                    }
                }
                while scan < source.len() && (source.as_bytes()[scan] == b' ' || source.as_bytes()[scan] == b'\t' || source.as_bytes()[scan] == b'\n') {
                    scan += 1;
                }

                if scan < source.len() && source.as_bytes()[scan] == b'{' {
                    if let Some((inner, _, end_pos)) = extract_balanced_braces(source, scan) {
                        result.push_str(prefix);
                        result.push_str(&inner);
                        result.push_str(suffix);
                        i = end_pos;
                        continue;
                    }
                }
            }
        }

        let ch = source[i..].chars().next().unwrap();
        result.push(ch);
        i += ch.len_utf8();
    }
    result
}

pub fn clean_latex_inline_formatting(s: &str) -> String {
    let mut res = s.to_string();
    res = remove_latex_command_balanced(&res, "orcidlinked");
    res = remove_latex_command_balanced(&res, "label");
    res = replace_latex_command_balanced(&res, "textbf", "", "");
    res = replace_latex_command_balanced(&res, "textit", "", "");
    res = replace_latex_command_balanced(&res, "emph", "", "");
    res = replace_latex_command_balanced(&res, "texttt", "", "");
    res = replace_latex_command_balanced(&res, "textsuperscript", "", "");
    res = replace_latex_command_balanced(&res, "textdaggerdbl", "", "");
    res = replace_latex_command_balanced(&res, "IEEEauthorblockN", "", "");
    res = replace_latex_command_balanced(&res, "IEEEauthorblockA", "", "");
    res = replace_latex_command_balanced(&res, "small", "", "");
    res = replace_latex_command_balanced(&res, "LARGE", "", "");
    res = replace_latex_command_balanced(&res, "Large", "", "");
    res = replace_latex_command_balanced(&res, "Huge", "", "");
    res = replace_latex_command_balanced(&res, "large", "", "");
    res = replace_latex_command_balanced(&res, "bfseries", "", "");
    res = replace_latex_command_balanced(&res, "sffamily", "", "");
    res = replace_latex_command_balanced(&res, "rmfamily", "", "");
    res = replace_latex_command_balanced(&res, "textsc", "", "");
    res = res.replace("\\\\", ", ")
        .replace("\\,", " ")
        .replace("\\;", " ")
        .replace("\\and", ", ")
        .replace("\\&", "&")
        .replace("\\%", "%")
        .replace("~", " ")
        .replace(" ,", ",");

    let mut out = String::new();
    let mut prev_space = false;
    for c in res.chars() {
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out.trim().trim_matches(',').trim().to_string()
}

pub fn clean_fontawesome_icons(s: &str) -> String {
    let mut res = s.to_string();
    let icons = [
        "faEnvelopeO", "faEnvelope", "faLinkedin", "faPhone", "faGlobe", "faGithub", "faTwitter",
        "faUser", "faMapMarker", "faGraduationCap", "faBriefcase", "faBook", "faFileTextO", "faIdBadge"
    ];
    for icon in &icons {
        res = remove_latex_command_balanced(&res, icon);
        res = res.replace(&format!("\\{icon}"), "");
    }
    res
}

pub fn convert_tabular_to_markdown_table(raw: &str) -> String {
    let mut cleaned = raw.to_string();
    cleaned = cleaned.replace("\\toprule", "")
        .replace("\\midrule", "")
        .replace("\\bottomrule", "")
        .replace("\\hline", "");

    let mut rows: Vec<Vec<String>> = Vec::new();
    for raw_row in cleaned.split("\\\\") {
        let trimmed_row = raw_row.trim();
        if trimmed_row.is_empty() {
            continue;
        }
        let mut cells = Vec::new();
        for raw_cell in trimmed_row.split('&') {
            let mut c = raw_cell.trim().to_string();
            // Clean \multicolumn{n}{...}{content}
            while let Some(m_idx) = c.find("\\multicolumn") {
                let scan = m_idx + "\\multicolumn".len();
                if let Some((_, _, p1)) = extract_balanced_braces(&c, scan) {
                    if let Some((_, _, p2)) = extract_balanced_braces(&c, p1) {
                        if let Some((content, _, p3)) = extract_balanced_braces(&c, p2) {
                            c = format!("{}{}{}", &c[..m_idx], content, &c[p3..]);
                            continue;
                        }
                    }
                }
                break;
            }
            // Clean \makecell{content}
            while let Some(m_idx) = c.find("\\makecell") {
                let scan = m_idx + "\\makecell".len();
                if let Some((content, _, end_pos)) = extract_balanced_braces(&c, scan) {
                    let inline_content = content.replace("\\\\", "<br>");
                    c = format!("{}{}{}", &c[..m_idx], inline_content, &c[end_pos..]);
                    continue;
                }
                break;
            }
            // Clean \makefield{icon}{content}
            while let Some(mf_idx) = c.find("\\makefield") {
                let scan = mf_idx + "\\makefield".len();
                if let Some((_, _, p1)) = extract_balanced_braces(&c, scan) {
                    if let Some((content, _, p2)) = extract_balanced_braces(&c, p1) {
                        c = format!("{}{}{}", &c[..mf_idx], content, &c[p2..]);
                        continue;
                    }
                }
                break;
            }
            c = c.replace("\\par", "<br>").replace('\n', " ");
            while c.contains("<br> ") {
                c = c.replace("<br> ", "<br>");
            }
            while c.contains(" <br>") {
                c = c.replace(" <br>", "<br>");
            }
            c = clean_fontawesome_icons(&c);
            c = replace_latex_command_balanced(&c, "textbf", "**", "**");
            c = replace_latex_command_balanced(&c, "textit", "*", "*");
            c = replace_latex_command_balanced(&c, "texttt", "`", "`");
            c = replace_latex_command_balanced(&c, "url", "<", ">");
            cells.push(c.trim().to_string());
        }
        if !cells.is_empty() && cells.iter().any(|c| !c.is_empty()) {
            rows.push(cells);
        }
    }

    if rows.is_empty() {
        return String::new();
    }

    let max_cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    if max_cols == 0 {
        return String::new();
    }

    let mut out = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        let mut padded = row.clone();
        while padded.len() < max_cols {
            padded.push(String::new());
        }
        out.push(format!("| {} |", padded.join(" | ")));
        if idx == 0 {
            let sep = vec!["__MD_DASH__"; max_cols];
            out.push(format!("| {} |", sep.join(" | ")));
        }
    }

    out.join("\n")
}

pub fn parse_latex_tabular(source: &str) -> String {
    let mut text = source.to_string();
    let envs = ["tabularx", "tabulary", "tabular*", "tabular"];
    for env in &envs {
        let begin_tag = format!("\\begin{{{env}}}");
        let end_tag = format!("\\end{{{env}}}");
        while let Some(start) = text.find(&begin_tag) {
            let mut scan = start + begin_tag.len();
            // For tabularx, tabulary, or tabular*, first brace argument is width (e.g. {\textwidth})
            if env.ends_with('x') || env.ends_with('y') || env.ends_with('*') {
                while scan < text.len() && (text.as_bytes()[scan] == b' ' || text.as_bytes()[scan] == b'\t' || text.as_bytes()[scan] == b'\n') {
                    scan += 1;
                }
                if scan < text.len() && text.as_bytes()[scan] == b'{' {
                    if let Some((_, _, p_end)) = extract_balanced_braces(&text, scan) {
                        scan = p_end;
                    }
                }
            }
            while scan < text.len() && (text.as_bytes()[scan] == b' ' || text.as_bytes()[scan] == b'\t' || text.as_bytes()[scan] == b'\n') {
                scan += 1;
            }
            let content_start = if scan < text.len() && text.as_bytes()[scan] == b'{' {
                if let Some((_, _, p_end)) = extract_balanced_braces(&text, scan) {
                    p_end
                } else {
                    scan
                }
            } else {
                scan
            };

            if let Some(end_tabular) = text[content_start..].find(&end_tag) {
                let raw_table = &text[content_start..content_start + end_tabular];
                let md_table = convert_tabular_to_markdown_table(raw_table);
                text = format!("{}\n\n{}\n\n{}", &text[..start], md_table, &text[content_start + end_tabular + end_tag.len()..]);
            } else {
                break;
            }
        }
    }
    text
}

#[derive(Debug, Clone, Default)]
pub struct BibEntry {
    pub entry_type: String,
    pub key: String,
    pub title: String,
    pub authors: Vec<String>,
    pub journal_or_book: String,
    pub year: String,
    pub volume: String,
    pub number: String,
    pub pages: String,
    pub publisher: String,
    pub doi: String,
    pub url: String,
}

impl BibEntry {
    pub fn to_citation_markdown(&self) -> String {
        let mut parts = Vec::new();
        if !self.authors.is_empty() {
            let authors_str = if self.authors.len() == 1 {
                self.authors[0].clone()
            } else if self.authors.len() == 2 {
                format!("{} and {}", self.authors[0], self.authors[1])
            } else {
                format!("{}, and {}", self.authors[..self.authors.len() - 1].join(", "), self.authors.last().unwrap())
            };
            parts.push(authors_str);
        }
        if !self.title.is_empty() {
            parts.push(format!("\"{}\"", self.title.trim_end_matches('.')));
        }
        let mut venue_parts = Vec::new();
        if !self.journal_or_book.is_empty() {
            venue_parts.push(format!("*{}*", self.journal_or_book));
        }
        if !self.volume.is_empty() {
            venue_parts.push(format!("vol. {}", self.volume));
        }
        if !self.number.is_empty() {
            venue_parts.push(format!("no. {}", self.number));
        }
        if !self.pages.is_empty() {
            let pages_clean = self.pages.replace("--", "–");
            venue_parts.push(format!("pp. {}", pages_clean));
        }
        if !self.year.is_empty() {
            venue_parts.push(self.year.clone());
        }
        if !venue_parts.is_empty() {
            parts.push(venue_parts.join(", "));
        }
        if !self.doi.is_empty() {
            parts.push(format!("[DOI](https://doi.org/{})", self.doi));
        } else if !self.url.is_empty() {
            parts.push(format!("[URL]({})", self.url));
        }
        format!("{}.", parts.join(", ").trim_end_matches('.'))
    }
}

pub fn clean_latex_accents(s: &str) -> String {
    let mut out = s.to_string();
    let replacements = [
        ("{\\'a}", "á"), ("{\\'e}", "é"), ("{\\'i}", "í"), ("{\\'o}", "ó"), ("{\\'u}", "ú"),
        ("{\\'A}", "Á"), ("{\\'E}", "É"), ("{\\'I}", "Í"), ("{\\'O}", "Ó"), ("{\\'U}", "Ú"),
        ("{\\\"a}", "ä"), ("{\\\"e}", "ë"), ("{\\\"i}", "ï"), ("{\\\"o}", "ö"), ("{\\\"u}", "ü"),
        ("{\\\"A}", "Ä"), ("{\\\"E}", "Ë"), ("{\\\"I}", "Ï"), ("{\\\"O}", "Ö"), ("{\\\"U}", "Ü"),
        ("{\\~n}", "ñ"), ("{\\~N}", "Ñ"),
        ("{\\c{c}}", "ç"), ("{\\c{C}}", "Ç"),
        ("\\'a", "á"), ("\\'e", "é"), ("\\'i", "í"), ("\\'o", "ó"), ("\\'u", "ú"),
        ("\\'A", "Á"), ("\\'E", "É"), ("\\'I", "Í"), ("\\'O", "Ó"), ("\\'U", "Ú"),
        ("\\\"u", "ü"), ("\\\"a", "ä"), ("\\\"o", "ö"),
        ("\\~n", "ñ"), ("\\~N", "Ñ"),
        ("\\LaTeX", "LaTeX"), ("\\TeX", "TeX"),
        ("~", " "),
        ("{", ""), ("}", ""),
    ];
    for (from, to) in replacements {
        out = out.replace(from, to);
    }
    out
}

pub fn parse_bibtex_str(content: &str) -> Vec<BibEntry> {
    let mut entries = Vec::new();
    let mut i = 0;
    while let Some(at_idx) = content[i..].find('@') {
        let entry_start = i + at_idx;
        let rest = &content[entry_start + 1..];
        let type_end = match rest.find(|c: char| c == '{' || c == '(') {
            Some(idx) => idx,
            None => { i = entry_start + 1; continue; }
        };
        let entry_type = rest[..type_end].trim().to_lowercase();
        if entry_type == "comment" || entry_type == "string" || entry_type == "preamble" {
            i = entry_start + 1 + type_end + 1;
            continue;
        }

        let open_brace = entry_start + 1 + type_end;
        let is_brace = content.as_bytes()[open_brace] == b'{';

        let mut depth = 1;
        let mut scan = open_brace + 1;
        let bytes = content.as_bytes();
        while scan < bytes.len() && depth > 0 {
            if bytes[scan] == b'\\' {
                scan += 2;
                continue;
            }
            if bytes[scan] == b'{' {
                depth += 1;
            } else if bytes[scan] == b'}' {
                depth -= 1;
            } else if !is_brace && bytes[scan] == b')' {
                depth -= 1;
            }
            scan += 1;
        }

        let body_content = if depth == 0 {
            &content[open_brace + 1..scan - 1]
        } else {
            &content[open_brace + 1..]
        };

        let mut entry = BibEntry {
            entry_type,
            ..Default::default()
        };

        let (key, fields_str) = match body_content.find(',') {
            Some(comma) => (body_content[..comma].trim().to_string(), &body_content[comma + 1..]),
            None => (body_content.trim().to_string(), ""),
        };
        entry.key = key;

        let mut f_idx = 0;
        let f_bytes = fields_str.as_bytes();
        while f_idx < f_bytes.len() {
            while f_idx < f_bytes.len() && (f_bytes[f_idx].is_ascii_whitespace() || f_bytes[f_idx] == b',' || f_bytes[f_idx] == b'\n') {
                f_idx += 1;
            }
            if f_idx >= f_bytes.len() {
                break;
            }
            let name_start = f_idx;
            while f_idx < f_bytes.len() && (f_bytes[f_idx].is_ascii_alphanumeric() || f_bytes[f_idx] == b'_' || f_bytes[f_idx] == b'-') {
                f_idx += 1;
            }
            let field_name = fields_str[name_start..f_idx].trim().to_lowercase();
            while f_idx < f_bytes.len() && (f_bytes[f_idx].is_ascii_whitespace() || f_bytes[f_idx] == b'=') {
                f_idx += 1;
            }
            if f_idx >= f_bytes.len() {
                break;
            }

            let value_str: String;
            if f_bytes[f_idx] == b'{' {
                let start_val = f_idx + 1;
                let mut d = 1;
                f_idx += 1;
                while f_idx < f_bytes.len() && d > 0 {
                    if f_bytes[f_idx] == b'\\' {
                        f_idx += 2;
                        continue;
                    }
                    if f_bytes[f_idx] == b'{' { d += 1; }
                    else if f_bytes[f_idx] == b'}' { d -= 1; }
                    f_idx += 1;
                }
                value_str = if d == 0 {
                    fields_str[start_val..f_idx - 1].to_string()
                } else {
                    fields_str[start_val..].to_string()
                };
            } else if f_bytes[f_idx] == b'"' {
                let start_val = f_idx + 1;
                f_idx += 1;
                while f_idx < f_bytes.len() && f_bytes[f_idx] != b'"' {
                    if f_bytes[f_idx] == b'\\' {
                        f_idx += 2;
                        continue;
                    }
                    f_idx += 1;
                }
                value_str = fields_str[start_val..f_idx.min(f_bytes.len())].to_string();
                if f_idx < f_bytes.len() { f_idx += 1; }
            } else {
                let start_val = f_idx;
                while f_idx < f_bytes.len() && f_bytes[f_idx] != b',' && !f_bytes[f_idx].is_ascii_whitespace() {
                    f_idx += 1;
                }
                value_str = fields_str[start_val..f_idx].to_string();
            }

            let clean_val = clean_latex_accents(&value_str).trim().to_string();
            match field_name.as_str() {
                "title" => entry.title = clean_val,
                "author" => {
                    let raw_authors: Vec<String> = clean_val
                        .split(" and ")
                        .map(|a| a.trim().to_string())
                        .filter(|a| !a.is_empty())
                        .collect();
                    let mut formatted_authors = Vec::new();
                    for a in raw_authors {
                        if a.contains(',') {
                            let parts: Vec<&str> = a.splitn(2, ',').collect();
                            let last = parts[0].trim();
                            let first = parts[1].trim();
                            let first_initial = first.chars().next().map(|c| format!("{c}. ")).unwrap_or_default();
                            formatted_authors.push(format!("{first_initial}{last}"));
                        } else {
                            formatted_authors.push(a);
                        }
                    }
                    entry.authors = formatted_authors;
                }
                "journal" => entry.journal_or_book = clean_val,
                "booktitle" => if entry.journal_or_book.is_empty() { entry.journal_or_book = clean_val; },
                "year" => entry.year = clean_val,
                "volume" => entry.volume = clean_val,
                "number" => entry.number = clean_val,
                "pages" => entry.pages = clean_val,
                "publisher" => entry.publisher = clean_val,
                "doi" => entry.doi = clean_val,
                "url" => entry.url = clean_val,
                _ => {}
            }

            while f_idx < f_bytes.len() && (f_bytes[f_idx] == b',' || f_bytes[f_idx].is_ascii_whitespace()) {
                f_idx += 1;
            }
        }

        entries.push(entry);
        i = scan;
    }
    entries
}

pub fn parse_curve_header(preamble: &str, project_dir: Option<&Path>) -> Option<String> {
    let mut header_md = String::new();
    let left_header_content = if let Some(idx) = preamble.find("\\leftheader") {
        let scan = idx + "\\leftheader".len();
        extract_balanced_braces(preamble, scan).map(|(c, _, _)| c)
    } else {
        None
    };

    let photo_file = if let Some(idx) = preamble.find("\\photo") {
        let scan = idx + "\\photo".len();
        let mut p_scan = scan;
        if let Some((_, _, end_opt)) = extract_balanced_brackets(preamble, scan) {
            p_scan = end_opt;
        }
        extract_balanced_braces(preamble, p_scan).map(|(p, _, _)| p)
    } else {
        None
    };

    if left_header_content.is_none() && photo_file.is_none() {
        return None;
    }

    let mut name = String::new();
    let mut contact_lines = Vec::new();

    if let Some(lh) = left_header_content {
        let full_lh = lh.clone();
        if let Some(start_name) = full_lh.find("{\\LARGE")
            .or_else(|| full_lh.find("{\\Large"))
            .or_else(|| full_lh.find("{\\Huge"))
            .or_else(|| full_lh.find("{\\bfseries")) {
            if let Some((n_raw, _, _)) = extract_balanced_braces(&full_lh, start_name) {
                name = clean_latex_inline_formatting(&n_raw)
                    .replace("\\LARGE", "")
                    .replace("\\Large", "")
                    .replace("\\Huge", "")
                    .replace("\\bfseries", "")
                    .replace("\\sffamily", "")
                    .replace("\\rmfamily", "")
                    .trim()
                    .to_string();
            }
        }

        if name.is_empty() {
            for line in full_lh.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() && !trimmed.starts_with('%') && !trimmed.starts_with("\\makefield") {
                    name = clean_latex_inline_formatting(trimmed)
                        .replace("\\LARGE", "")
                        .replace("\\Large", "")
                        .replace("\\Huge", "")
                        .replace("\\bfseries", "")
                        .replace("\\sffamily", "")
                        .replace('{', "")
                        .replace('}', "")
                        .trim()
                        .to_string();
                    break;
                }
            }
        }

        // Extract fields: \makefield{icon}{field}
        let mut scan_f = 0;
        while let Some(rel_f) = full_lh[scan_f..].find("\\makefield") {
            let start_f = scan_f + rel_f + "\\makefield".len();
            if let Some((icon_raw, _, end_icon)) = extract_balanced_braces(&full_lh, start_f) {
                if let Some((field_raw, _, end_field)) = extract_balanced_braces(&full_lh, end_icon) {
                    let mut clean_field = field_raw.trim().to_string();
                    if let Some(h_idx) = clean_field.find("\\href") {
                        let h_scan = h_idx + "\\href".len();
                        if let Some((url, _, end_u)) = extract_balanced_braces(&clean_field, h_scan) {
                            if let Some((label, _, _)) = extract_balanced_braces(&clean_field, end_u) {
                                let clean_lbl = clean_latex_inline_formatting(&label).replace("\\texttt", "");
                                clean_field = format!("[{clean_lbl}]({url})");
                            }
                        }
                    } else if let Some(u_idx) = clean_field.find("\\url") {
                        let u_scan = u_idx + "\\url".len();
                        if let Some((url, _, _)) = extract_balanced_braces(&clean_field, u_scan) {
                            clean_field = format!("<{url}>");
                        }
                    } else {
                        clean_field = clean_latex_inline_formatting(&clean_field).replace("\\texttt", "").replace('{', "").replace('}', "");
                    }

                    let prefix = if icon_raw.contains("faEnvelope") || clean_field.contains('@') {
                        "📧 "
                    } else if icon_raw.contains("faLinkedin") {
                        "🔗 "
                    } else if icon_raw.contains("faPhone") {
                        "📞 "
                    } else if icon_raw.contains("faGlobe") {
                        "🌐 "
                    } else if icon_raw.contains("faGithub") {
                        "💻 "
                    } else {
                        "- "
                    };

                    if !clean_field.is_empty() {
                        contact_lines.push(format!("- {prefix}{clean_field}"));
                    }
                    scan_f = end_field;
                    continue;
                }
            }
            scan_f = start_f;
        }
    }

    if !name.is_empty() {
        header_md.push_str(&format!("# {name}\n\n"));
    }

    if let Some(photo) = photo_file {
        let photo_path = photo.trim().to_string();
        let resolved_photo = if let Some(dir) = project_dir {
            let direct = dir.join(&photo_path);
            if direct.exists() && direct.is_file() {
                photo_path
            } else {
                let extensions = ["jpg", "jpeg", "png", "webp"];
                let mut found = None;
                for ext in &extensions {
                    let cand = dir.join(format!("{photo_path}.{ext}"));
                    if cand.exists() && cand.is_file() {
                        found = Some(format!("{photo_path}.{ext}"));
                        break;
                    }
                }
                found.unwrap_or(photo_path)
            }
        } else {
            photo_path
        };
        header_md.push_str(&format!("![Photo]({resolved_photo})\n\n"));
    }

    if !contact_lines.is_empty() {
        header_md.push_str(&contact_lines.join("\n"));
        header_md.push_str("\n\n");
    }

    if header_md.trim().is_empty() {
        None
    } else {
        Some(header_md.trim().to_string())
    }
}

pub fn parse_curve_rubrics(text: &str) -> String {
    let mut res = text.to_string();

    while let Some(start) = res.find("\\makerubrichead") {
        let scan = start + "\\makerubrichead".len();
        if let Some((title, _, end_pos)) = extract_balanced_braces(&res, scan) {
            let clean_title = clean_latex_inline_formatting(&title);
            res = format!("{}\n\n## {}\n\n{}", &res[..start], clean_title, &res[end_pos..]);
        } else {
            break;
        }
    }

    while let Some(start) = res.find("\\begin{rubric}") {
        let scan = start + "\\begin{rubric}".len();
        let (title, content_start) = if let Some((t, _, end_p)) = extract_balanced_braces(&res, scan) {
            (clean_latex_inline_formatting(&t), end_p)
        } else {
            (String::new(), scan)
        };

        if let Some(end_rel) = res[content_start..].find("\\end{rubric}") {
            let rubric_body = &res[content_start..content_start + end_rel];
            let formatted_body = format_rubric_body(&title, rubric_body);
            res = format!("{}\n\n{}\n\n{}", &res[..start], formatted_body, &res[content_start + end_rel + "\\end{rubric}".len()..]);
        } else {
            break;
        }
    }

    res
}

pub fn format_rubric_body(title: &str, body: &str) -> String {
    let mut out = String::new();
    if !title.is_empty() {
        out.push_str(&format!("## {}\n\n", title));
    }

    let mut lines = body.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed.starts_with('%') || trimmed.is_empty() {
            continue;
        }

        if let Some(sub_idx) = trimmed.find("\\subrubric") {
            let scan = sub_idx + "\\subrubric".len();
            if let Some((sub_title, _, _)) = extract_balanced_braces(trimmed, scan) {
                let clean_sub = clean_latex_inline_formatting(&sub_title);
                out.push_str(&format!("\n### {}\n\n", clean_sub));
                continue;
            }
        }

        if trimmed.starts_with("\\entry*") || trimmed.starts_with("\\entry") {
            let mut entry_str = trimmed.to_string();
            while let Some(&next_l) = lines.peek() {
                let next_t = next_l.trim();
                if next_t.starts_with("\\entry") || next_t.starts_with("\\subrubric") || next_t.starts_with("\\begin") || next_t.starts_with("\\end") {
                    break;
                }
                entry_str.push('\n');
                entry_str.push_str(next_l);
                lines.next();
            }

            let is_star = entry_str.starts_with("\\entry*");
            let cmd_len = if is_star { "\\entry*".len() } else { "\\entry".len() };
            let scan = cmd_len;
            let mut after_scan = scan;
            while after_scan < entry_str.len() && (entry_str.as_bytes()[after_scan] == b' ' || entry_str.as_bytes()[after_scan] == b'\t') {
                after_scan += 1;
            }

            let (date_key, item_text) = if after_scan < entry_str.len() && entry_str.as_bytes()[after_scan] == b'[' {
                if let Some((k, _, end_k)) = extract_balanced_brackets(&entry_str, after_scan) {
                    (k.trim().to_string(), entry_str[end_k..].trim())
                } else {
                    (String::new(), entry_str[after_scan..].trim())
                }
            } else {
                (String::new(), entry_str[after_scan..].trim())
            };

            let clean_date = date_key
                .replace("--", "–")
                .replace("\\hfill", "")
                .trim()
                .to_string();

            let mut clean_lines = Vec::new();
            for l in item_text.lines() {
                let t = l.trim();
                if t.starts_with('%') { continue; }
                if let Some(pct) = t.find('%') {
                    clean_lines.push(t[..pct].trim().to_string());
                } else {
                    clean_lines.push(t.to_string());
                }
            }
            let mut clean_item = clean_lines.join(" ");

            clean_item = clean_item
                .replace("\\par", "<br>")
                .replace("\\hfill", " ")
                .replace("\\prefix{}", "")
                .replace("\\LaTeX", "LaTeX")
                .replace("\\TeX", "TeX")
                .replace("~", " ")
                .replace("\\,", " ");

            clean_item = clean_item.trim().trim_end_matches("<br>").trim().to_string();

            if !clean_date.is_empty() {
                out.push_str(&format!("- **{}:** {}\n", clean_date, clean_item));
            } else if !clean_item.is_empty() {
                out.push_str(&format!("- {}\n", clean_item));
            }
            continue;
        }

        let clean = trimmed.replace("\\par", "\n\n").replace("\\hfill", "");
        if !clean.is_empty() {
            out.push_str(&format!("{}\n\n", clean));
        }
    }

    out.trim().to_string()
}

pub fn resolve_inputs(source: &str, project_dir: Option<&Path>, is_typst: bool) -> String {
    let Some(dir) = project_dir else {
        return source.to_string();
    };
    let mut visited = HashSet::new();
    resolve_inputs_rec(source, dir, is_typst, &mut visited)
}

fn resolve_inputs_rec(source: &str, dir: &Path, is_typst: bool, visited: &mut HashSet<String>) -> String {
    let mut text = source.to_string();
    if is_typst {
        let mut search_idx = 0;
        while let Some(rel_start) = text[search_idx..].find("#include ") {
            let start = search_idx + rel_start;
            let rest = &text[start + "#include ".len()..];
            let trimmed = rest.trim_start();
            if trimmed.starts_with('"') {
                if let Some(quote_end) = trimmed[1..].find('"') {
                    let rel_file = &trimmed[1..=quote_end];
                    let total_len = (rest.len() - trimmed.len()) + 1 + quote_end + 1 + "#include ".len();
                    let file_path = dir.join(rel_file);
                    let alt_path = dir.join(format!("{rel_file}.typ"));
                    let path_to_read = if file_path.exists() && file_path.is_file() {
                        Some(file_path)
                    } else if alt_path.exists() && alt_path.is_file() {
                        Some(alt_path)
                    } else {
                        None
                    };

                    if let Some(p) = path_to_read {
                        let path_str = p.canonicalize().map(|cp| cp.to_string_lossy().to_string()).unwrap_or_else(|_| p.to_string_lossy().to_string());
                        if !visited.contains(&path_str) {
                            visited.insert(path_str);
                            if let Ok(content) = std::fs::read_to_string(&p) {
                                let inlined = resolve_inputs_rec(&content, dir, true, visited);
                                text = format!("{}\n{}\n{}", &text[..start], inlined, &text[start + total_len..]);
                                search_idx = start;
                                continue;
                            }
                        }
                    }
                    search_idx = start + total_len;
                    continue;
                }
            }
            search_idx = start + "#include ".len();
        }
    } else {
        let commands = ["input", "include", "subfile", "makerubric"];
        for cmd in &commands {
            let pattern = format!("\\{cmd}");
            let mut search_idx = 0;
            while let Some(rel_start) = text[search_idx..].find(&pattern) {
                let start = search_idx + rel_start;
                let scan = start + pattern.len();
                if let Some((rel_file, _, end_pos)) = extract_balanced_braces(&text, scan) {
                    let rel_file = rel_file.trim();
                    let file_path = dir.join(rel_file);
                    let alt_path = dir.join(format!("{rel_file}.tex"));
                    let path_to_read = if file_path.exists() && file_path.is_file() {
                        Some(file_path)
                    } else if alt_path.exists() && alt_path.is_file() {
                        Some(alt_path)
                    } else {
                        None
                    };

                    if let Some(p) = path_to_read {
                        let path_str = p.canonicalize().map(|cp| cp.to_string_lossy().to_string()).unwrap_or_else(|_| p.to_string_lossy().to_string());
                        if !visited.contains(&path_str) {
                            visited.insert(path_str);
                            if let Ok(content) = std::fs::read_to_string(&p) {
                                let inlined = resolve_inputs_rec(&content, dir, false, visited);
                                text = format!("{}\n{}\n{}", &text[..start], inlined, &text[end_pos..]);
                                search_idx = start;
                                continue;
                            }
                        }
                    }
                    search_idx = end_pos;
                } else {
                    search_idx = scan;
                }
            }
        }
    }
    text
}

pub fn resolve_image_path(raw: &str, project_dir: Option<&Path>) -> String {
    let p = raw.trim();
    if p.is_empty() || p.starts_with("http://") || p.starts_with("https://") || p.starts_with("data:") {
        return p.to_string();
    }
    if let Some(dir) = project_dir {
        let direct = dir.join(p);
        if direct.exists() && direct.is_file() {
            return p.to_string();
        }
        for ext in &["png", "jpg", "jpeg", "svg", "webp", "gif", "pdf"] {
            let cand = dir.join(format!("{p}.{ext}"));
            if cand.exists() && cand.is_file() {
                return format!("{p}.{ext}");
            }
        }
    }
    p.to_string()
}

pub fn latex_to_markdown_with_dir(source: &str, project_dir: Option<&Path>) -> String {
    let resolved_source = resolve_inputs(source, project_dir, false);
    let mut title = None;
    let mut author = None;

    if let Some(t_idx) = resolved_source.find("\\title") {
        let scan = t_idx + 6;
        if let Some((t_content, _, _)) = extract_balanced_braces(&resolved_source, scan) {
            let cleaned = clean_latex_inline_formatting(&t_content);
            if !cleaned.is_empty() {
                title = Some(cleaned);
            }
        }
    }

    if let Some(a_idx) = resolved_source.find("\\author") {
        let scan = a_idx + 7;
        if let Some((a_content, _, _)) = extract_balanced_braces(&resolved_source, scan) {
            let cleaned = clean_latex_inline_formatting(&a_content);
            if !cleaned.is_empty() {
                author = Some(cleaned);
            }
        }
    }

    let (preamble, body) = if let Some(begin) = resolved_source.find("\\begin{document}") {
        let p = &resolved_source[..begin];
        let content_start = begin + "\\begin{document}".len();
        let b = if let Some(end) = resolved_source[content_start..].find("\\end{document}") {
            &resolved_source[content_start..content_start + end]
        } else {
            &resolved_source[content_start..]
        };
        (p, b)
    } else {
        ("", resolved_source.as_str())
    };

    let curve_header = parse_curve_header(preamble, project_dir)
        .or_else(|| parse_curve_header(&resolved_source, project_dir));
    let has_curve_header = curve_header.is_some();

    let mut text = body.to_string();

    if let Some(ref ch) = curve_header {
        if let Some(mh_idx) = text.find("\\makeheaders") {
            let mh_scan = mh_idx + "\\makeheaders".len();
            let end_mh = if let Some((_, _, p)) = extract_balanced_brackets(&text, mh_scan) {
                p
            } else {
                mh_scan
            };
            text = format!("{}\n\n{}\n\n{}", &text[..mh_idx], ch, &text[end_mh..]);
        } else {
            text = format!("{}\n\n{}", ch, text);
        }
    }

    // Process CurVe rubrics
    text = parse_curve_rubrics(&text);

    // Clean comments
    let mut cleaned_lines = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('%') {
            continue;
        }
        let mut clean_line = String::new();
        let mut chars = line.chars().peekable();
        let mut prev_char = ' ';
        while let Some(c) = chars.next() {
            if c == '%' && prev_char != '\\' {
                break;
            }
            clean_line.push(c);
            prev_char = c;
        }
        cleaned_lines.push(clean_line);
    }
    text = cleaned_lines.join("\n");

    // Remove title/author if they appear inside document body to prevent duplicate display
    text = remove_latex_command_balanced(&text, "title");
    text = remove_latex_command_balanced(&text, "author");
    text = remove_latex_command_balanced(&text, "date");

    // Code blocks
    for env in &["verbatim", "lstlisting"] {
        let begin_tag = format!("\\begin{{{env}}}");
        let end_tag = format!("\\end{{{env}}}");
        while let Some(start) = text.find(&begin_tag) {
            if let Some(end) = text[start..].find(&end_tag) {
                let code_content = &text[start + begin_tag.len()..start + end];
                let replacement = format!("\n```\n{}\n```\n", code_content.trim_matches('\n'));
                text = format!("{}{}{}", &text[..start], replacement, &text[start + end + end_tag.len()..]);
            } else {
                break;
            }
        }
    }

    // Equations
    for env in &["equation", "equation*", "align", "align*", "gather", "gather*"] {
        let begin_tag = format!("\\begin{{{env}}}");
        let end_tag = format!("\\end{{{env}}}");
        while let Some(start) = text.find(&begin_tag) {
            if let Some(end) = text[start..].find(&end_tag) {
                let math_content = &text[start + begin_tag.len()..start + end];
                let clean_math = remove_latex_command_balanced(math_content, "label");
                let formatted_math = if env.starts_with("align") {
                    format!("\\begin{{aligned}}\n{}\n\\end{{aligned}}", clean_math.trim())
                } else {
                    clean_math.trim().to_string()
                };
                let replacement = format!("\n$$\n{}\n$$\n", formatted_math);
                text = format!("{}{}{}", &text[..start], replacement, &text[start + end + end_tag.len()..]);
            } else {
                break;
            }
        }
    }

    while let Some(start) = text.find("\\[") {
        if let Some(end) = text[start + 2..].find("\\]") {
            let math_content = &text[start + 2..start + 2 + end];
            let clean_math = remove_latex_command_balanced(math_content, "label");
            let replacement = format!("\n$$\n{}\n$$\n", clean_math.trim());
            text = format!("{}{}{}", &text[..start], replacement, &text[start + 2 + end + 2..]);
        } else {
            break;
        }
    }

    // Abstract
    while let Some(start) = text.find("\\begin{abstract}") {
        if let Some(end) = text[start..].find("\\end{abstract}") {
            let content = &text[start + "\\begin{abstract}".len()..start + end];
            let block = format!("\n> **Abstract**\n> \n> {}\n", content.trim().replace('\n', "\n> "));
            text = format!("{}{}{}", &text[..start], block, &text[start + end + "\\end{abstract}".len()..]);
        } else {
            break;
        }
    }

    // Keywords
    for kw in &["keywords", "IEEEkeywords"] {
        let b = format!("\\begin{{{kw}}}");
        let e = format!("\\end{{{kw}}}");
        while let Some(start) = text.find(&b) {
            if let Some(end) = text[start..].find(&e) {
                let content = &text[start + b.len()..start + end];
                let block = format!("\n**Keywords:** {}\n", content.trim());
                text = format!("{}{}{}", &text[..start], block, &text[start + end + e.len()..]);
            } else {
                break;
            }
        }
    }

    // Theorems & Lemmas
    let theorem_envs = ["theorem", "lemma", "definition", "corollary", "proposition", "example", "remark", "proof"];
    for env in &theorem_envs {
        let b = format!("\\begin{{{env}}}");
        let e = format!("\\end{{{env}}}");
        while let Some(start) = text.find(&b) {
            let scan = start + b.len();
            let opt = extract_balanced_brackets(&text, scan);
            let content_start = if let Some((_, _, end_pos)) = opt { end_pos } else { scan };
            let opt_name = if let Some((ref n, _, _)) = opt { format!(" ({n})") } else { String::new() };

            if let Some(end) = text[content_start..].find(&e) {
                let content = &text[content_start..content_start + end];
                let capitalized = env[..1].to_uppercase() + &env[1..];
                let block = format!("\n> **{capitalized}{opt_name}:**\n> {}\n", content.trim().replace('\n', "\n> "));
                text = format!("{}{}{}", &text[..start], block, &text[content_start + end + e.len()..]);
            } else {
                break;
            }
        }
    }

    // TikZ pictures
    while let Some(start) = text.find("\\begin{tikzpicture}") {
        if let Some(end) = text[start..].find("\\end{tikzpicture}") {
            text = format!("{}\n\n*[Diagram: TikZ Picture]*\n\n{}", &text[..start], &text[start + end + "\\end{tikzpicture}".len()..]);
        } else {
            break;
        }
    }

    // Parse tabular tables before float wrappers and backslash replacements
    text = parse_latex_tabular(&text);

    // Lists
    while let Some(start) = text.find("\\begin{itemize}") {
        if let Some(end) = text[start..].find("\\end{itemize}") {
            let inner = &text[start + 15..start + end];
            let mut items = Vec::new();
            for line in inner.lines() {
                let t = line.trim();
                if let Some(rest) = t.strip_prefix("\\item") {
                    items.push(format!("- {}", rest.trim_start()));
                } else if !t.is_empty() {
                    items.push(format!("  {t}"));
                }
            }
            let replacement = format!("\n{}\n", items.join("\n"));
            text = format!("{}{}{}", &text[..start], replacement, &text[start + end + 13..]);
        } else {
            break;
        }
    }

    while let Some(start) = text.find("\\begin{enumerate}") {
        if let Some(end) = text[start..].find("\\end{enumerate}") {
            let inner = &text[start + 17..start + end];
            let mut items = Vec::new();
            let mut num = 1;
            for line in inner.lines() {
                let t = line.trim();
                if let Some(rest) = t.strip_prefix("\\item") {
                    items.push(format!("{num}. {}", rest.trim_start()));
                    num += 1;
                } else if !t.is_empty() {
                    items.push(format!("   {t}"));
                }
            }
            let replacement = format!("\n{}\n", items.join("\n"));
            text = format!("{}{}{}", &text[..start], replacement, &text[start + end + 15..]);
        } else {
            break;
        }
    }

    // Figure environments (parse before float cleaner and general caption replacement)
    while let Some(start) = text.find("\\begin{figure}").or_else(|| text.find("\\begin{figure*}")) {
        let tag = if text[start..].starts_with("\\begin{figure*}") { "figure*" } else { "figure" };
        let end_tag = format!("\\end{{{tag}}}");
        if let Some(end) = text[start..].find(&end_tag) {
            let fig_end = start + end + end_tag.len();
            let inner = &text[start..fig_end];

            let mut img_src = String::new();
            if let Some(img_idx) = inner.find("\\includegraphics") {
                let scan = img_idx + "\\includegraphics".len();
                if let Some(brace_rel) = inner[scan..].find('{') {
                    let brace_scan = scan + brace_rel;
                    if let Some((path, _, _)) = extract_balanced_braces(inner, brace_scan) {
                        img_src = resolve_image_path(&path, project_dir);
                    }
                }
            }

            let mut caption_text = "Figure".to_string();
            if let Some(cap_idx) = inner.find("\\caption") {
                let scan = cap_idx + "\\caption".len();
                if let Some((cap, _, _)) = extract_balanced_braces(inner, scan) {
                    caption_text = cap;
                }
            }

            if !img_src.is_empty() {
                let replacement = format!("\n\n![{caption_text}]({img_src})\n\n*{caption_text}*\n\n");
                text = format!("{}{}{}", &text[..start], replacement, &text[fig_end..]);
                continue;
            }
        }
        break;
    }

    // Clean float containers
    for env in &["figure", "figure*", "table", "table*", "minipage", "subfigure"] {
        let b = format!("\\begin{{{env}}}");
        let e = format!("\\end{{{env}}}");
        while let Some(start) = text.find(&b) {
            let scan = start + b.len();
            let mut after = scan;
            while after < text.len() && (text.as_bytes()[after] == b' ' || text.as_bytes()[after] == b'\t' || text.as_bytes()[after] == b'\n') {
                after += 1;
            }
            if after < text.len() && text.as_bytes()[after] == b'[' {
                if let Some(end_bracket) = text[after..].find(']') {
                    after += end_bracket + 1;
                }
            }
            while after < text.len() && (text.as_bytes()[after] == b' ' || text.as_bytes()[after] == b'\t' || text.as_bytes()[after] == b'\n') {
                after += 1;
            }
            if after < text.len() && text.as_bytes()[after] == b'{' {
                if let Some((_, _, end_pos)) = extract_balanced_braces(&text, after) {
                    after = end_pos;
                }
            }
            text = format!("{}\n{}", &text[..start], &text[after..]);
        }
        text = text.replace(&e, "\n");
    }

    // Headings
    text = replace_latex_command_balanced(&text, "part", "\n\n# ", "\n\n");
    text = replace_latex_command_balanced(&text, "chapter", "\n\n# ", "\n\n");
    text = replace_latex_command_balanced(&text, "section", "\n\n## ", "\n\n");
    text = replace_latex_command_balanced(&text, "subsection", "\n\n### ", "\n\n");
    text = replace_latex_command_balanced(&text, "subsubsection", "\n\n#### ", "\n\n");
    text = replace_latex_command_balanced(&text, "paragraph", "\n\n**", "**\n\n");

    // Inlines
    text = replace_latex_command_balanced(&text, "textbf", "**", "**");
    text = replace_latex_command_balanced(&text, "textit", "*", "*");
    text = replace_latex_command_balanced(&text, "emph", "*", "*");
    text = replace_latex_command_balanced(&text, "underline", "<u>", "</u>");
    text = replace_latex_command_balanced(&text, "texttt", "`", "`");
    text = replace_latex_command_balanced(&text, "caption", "\n*Caption: ", "*\n");

    // Citations & references
    text = replace_latex_command_balanced(&text, "cite", "[@", "]");
    text = replace_latex_command_balanced(&text, "citep", "[@", "]");
    text = replace_latex_command_balanced(&text, "citet", "[@", "]");
    text = replace_latex_command_balanced(&text, "ref", "[@", "]");
    text = replace_latex_command_balanced(&text, "eqref", "(eq:", ")");
    text = replace_latex_command_balanced(&text, "autoref", "[@", "]");
    text = replace_latex_command_balanced(&text, "pageref", "[page @", "]");

    // Bibliography rendering from .bib file
    if text.contains("\\printbibliography") || text.contains("\\bibliography") {
        let mut bib_entries = Vec::new();
        if let Some(dir) = project_dir {
            let mut bib_files = Vec::new();
            let mut scan_bib = 0;
            while let Some(rel_idx) = resolved_source[scan_bib..].find("\\addbibresource") {
                let p = scan_bib + rel_idx + "\\addbibresource".len();
                if let Some((f, _, end_p)) = extract_balanced_braces(&resolved_source, p) {
                    bib_files.push(f.trim().to_string());
                    scan_bib = end_p;
                } else {
                    scan_bib = p;
                }
            }
            let mut scan_bib2 = 0;
            while let Some(rel_idx) = resolved_source[scan_bib2..].find("\\bibliography") {
                let p = scan_bib2 + rel_idx + "\\bibliography".len();
                if let Some((f, _, end_p)) = extract_balanced_braces(&resolved_source, p) {
                    let mut fname = f.trim().to_string();
                    if !fname.ends_with(".bib") {
                        fname = format!("{fname}.bib");
                    }
                    bib_files.push(fname);
                    scan_bib2 = end_p;
                } else {
                    scan_bib2 = p;
                }
            }
            if bib_files.is_empty() {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|e| e.to_str()) == Some("bib") {
                            bib_files.push(path.file_name().unwrap().to_string_lossy().to_string());
                        }
                    }
                }
            }
            for bf in &bib_files {
                let bib_path = dir.join(bf);
                if let Ok(content) = std::fs::read_to_string(&bib_path) {
                    bib_entries.extend(parse_bibtex_str(&content));
                }
            }
        }

        while let Some(start) = text.find("\\printbibliography") {
            let scan = start + "\\printbibliography".len();
            let opt = extract_balanced_brackets(&text, scan);
            let end_pos = if let Some((_, _, end_p)) = opt { end_p } else { scan };
            let opt_str = if let Some((ref s, _, _)) = opt { s.clone() } else { String::new() };

            let mut title_bib = String::new();
            if let Some(t_idx) = opt_str.find("title={") {
                if let Some(t_end) = opt_str[t_idx + 7..].find('}') {
                    title_bib = opt_str[t_idx + 7..t_idx + 7 + t_end].trim().to_string();
                }
            } else if let Some(t_idx) = opt_str.find("title=") {
                let rest = &opt_str[t_idx + 6..];
                let t_end = rest.find(',').unwrap_or(rest.len());
                title_bib = rest[..t_end].trim().trim_matches('{').trim_matches('}').to_string();
            }

            let mut type_filter = String::new();
            if let Some(type_idx) = opt_str.find("type=") {
                let rest = &opt_str[type_idx + 5..];
                let type_end = rest.find(|c: char| c == ',' || c == ']' || c == '}').unwrap_or(rest.len());
                type_filter = rest[..type_end].trim().trim_matches('{').trim_matches('}').to_lowercase();
            }

            let mut filter_opt = String::new();
            if let Some(f_idx) = opt_str.find("filter=") {
                let rest = &opt_str[f_idx + 7..];
                let f_end = rest.find(|c: char| c == ',' || c == ']' || c == '}').unwrap_or(rest.len());
                filter_opt = rest[..f_end].trim().trim_matches('{').trim_matches('}').to_lowercase();
            }

            let matching_entries: Vec<&BibEntry> = bib_entries.iter().filter(|e| {
                if !type_filter.is_empty() {
                    if type_filter == "inproceedings" {
                        e.entry_type == "inproceedings" || e.entry_type == "conference"
                    } else {
                        e.entry_type == type_filter
                    }
                } else if !filter_opt.is_empty() {
                    if filter_opt == "booksandchapters" {
                        e.entry_type == "book" || e.entry_type == "incollection" || e.entry_type == "inbook"
                    } else {
                        true
                    }
                } else {
                    true
                }
            }).collect();

            let mut replacement = String::new();
            if !matching_entries.is_empty() {
                if !title_bib.is_empty() {
                    replacement.push_str(&format!("\n\n### {}\n\n", title_bib));
                }
                for (idx, entry) in matching_entries.iter().enumerate() {
                    replacement.push_str(&format!("{}. {}\n", idx + 1, entry.to_citation_markdown()));
                }
                replacement.push('\n');
            }

            text = format!("{}{}{}", &text[..start], replacement, &text[end_pos..]);
        }
    }

    // CRITICAL: Eliminate labels cleanly without leaking label identifiers
    text = remove_latex_command_balanced(&text, "label");
    text = remove_latex_command_balanced(&text, "vspace");
    text = remove_latex_command_balanced(&text, "hspace");
    text = remove_latex_command_balanced(&text, "hfill");
    text = remove_latex_command_balanced(&text, "vfill");
    text = remove_latex_command_balanced(&text, "geometry");
    text = remove_latex_command_balanced(&text, "bibliography");
    text = remove_latex_command_balanced(&text, "bibliographystyle");
    text = remove_latex_command_balanced(&text, "nocite");
    text = remove_latex_command_balanced(&text, "justifying");
    text = remove_latex_command_balanced(&text, "prefix");
    text = remove_latex_command_balanced(&text, "photoscale");
    text = remove_latex_command_balanced(&text, "mynames");
    text = remove_latex_command_balanced(&text, "DefineBibliographyStrings");
    text = remove_latex_command_balanced(&text, "PassOptionsToPackage");
    text = remove_latex_command_balanced(&text, "definecolor");
    text = remove_latex_command_balanced(&text, "colorlet");
    text = remove_latex_command_balanced(&text, "prefixmarker");
    text = remove_latex_command_balanced(&text, "includecomment");
    text = remove_latex_command_balanced(&text, "excludecomment");
    text = remove_latex_command_balanced(&text, "makeheaders");
    text = remove_latex_command_balanced(&text, "photo");

    // Loose Images
    while let Some(start) = text.find("\\includegraphics") {
        let mut scan = start + "\\includegraphics".len();
        if scan < text.len() && text.as_bytes()[scan] == b'[' {
            if let Some(end_bracket) = text[scan..].find(']') {
                scan += end_bracket + 1;
            }
        }
        if scan < text.len() && text.as_bytes()[scan] == b'{' {
            if let Some((img_path, _, end_pos)) = extract_balanced_braces(&text, scan) {
                let resolved_path = resolve_image_path(&img_path, project_dir);
                let replacement = format!("![Image]({resolved_path})");
                text = format!("{}{}{}", &text[..start], replacement, &text[end_pos..]);
                continue;
            }
        }
        break;
    }

    // Links
    while let Some(start) = text.find("\\href") {
        let scan = start + 5;
        if let Some((url, _, end_url)) = extract_balanced_braces(&text, scan) {
            if let Some((label, _, end_label)) = extract_balanced_braces(&text, end_url) {
                let replacement = format!("[{label}]({url})");
                text = format!("{}{}{}", &text[..start], replacement, &text[end_label..]);
                continue;
            }
        }
        break;
    }

    text = replace_latex_command_balanced(&text, "url", "<", ">");

    // Clean TeX noise
    text = text
        .replace("\\maketitle", "")
        .replace("\\tableofcontents", "")
        .replace("\\newpage", "\n\n---\n\n")
        .replace("\\clearpage", "\n\n---\n\n")
        .replace("\\pagebreak", "\n\n---\n\n")
        .replace("\\noindent", "")
        .replace("\\centering", "")
        .replace("\\raggedright", "")
        .replace("\\raggedleft", "")
        .replace("\\justifying", "")
        .replace("\\LaTeX", "LaTeX")
        .replace("\\TeX", "TeX")
        .replace("\\par", "\n\n")
        .replace("\\&", "&")
        .replace("\\%", "%")
        .replace("\\$", "$")
        .replace("\\_", "_")
        .replace("\\#", "#")
        .replace("\\{", "{")
        .replace("\\}", "}")
        .replace("---", "—")
        .replace("--", "–")
        .replace("``", "\"")
        .replace("''", "\"")
        .replace("~", " ")
        .replace("\\,", " ")
        .replace("\\;", " ")
        .replace("\\ ", " ")
        .replace("\\\\", "\n");

    // Restore markdown table dashes
    text = text.replace("__MD_DASH__", "---");

    let mut header_parts = Vec::new();
    if !has_curve_header {
        if let Some(t) = title {
            header_parts.push(format!("# {t}"));
        }
        if let Some(a) = author {
            header_parts.push(format!("**Author:** {a}"));
        }
    }
    if !header_parts.is_empty() {
        text = format!("{}\n\n{}", header_parts.join("\n\n"), text);
    }

    let mut result_lines = Vec::new();
    let mut prev_blank = false;
    for line in text.lines() {
        let is_blank = line.trim().is_empty();
        if is_blank && prev_blank {
            continue;
        }
        result_lines.push(line);
        prev_blank = is_blank;
    }

    result_lines.join("\n").trim().to_string()
}

pub fn latex_to_markdown(source: &str) -> String {
    latex_to_markdown_with_dir(source, None)
}

/// Extracts all unique local image paths referenced in Markdown via `![...](path)` syntax.
pub fn extract_markdown_image_paths(md: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut scan = 0;
    while let Some(start) = md[scan..].find("![") {
        let alt_start = scan + start + 2;
        if let Some((_, _, end_bracket)) = extract_balanced_brackets(md, alt_start - 1) {
            if end_bracket < md.len() && md.as_bytes()[end_bracket] == b'(' {
                let paren_start = end_bracket;
                if let Some((path_content, _, end_paren)) = extract_balanced_parens(md, paren_start) {
                    let p = path_content.trim();
                    if !p.is_empty()
                        && !p.starts_with("http://")
                        && !p.starts_with("https://")
                        && !p.starts_with("data:")
                        && !p.starts_with('#')
                        && !paths.contains(&p.to_string())
                    {
                        paths.push(p.to_string());
                    }
                    scan = end_paren;
                    continue;
                }
            }
        }
        scan = alt_start;
    }
    paths
}

/// Embeds local images as Base64 Data URIs in Markdown `![alt](data:image/...;base64,...)`.
pub fn embed_local_images_as_base64_in_markdown(md: &str, project_dir: Option<&Path>) -> String {
    let Some(dir) = project_dir else {
        return md.to_string();
    };

    let mut result = String::with_capacity(md.len());
    let mut scan = 0;

    while scan < md.len() {
        if let Some(rel_start) = md[scan..].find("![") {
            let start = scan + rel_start;
            result.push_str(&md[scan..start]);
            let alt_start = start + 2;

            if let Some((alt_text, _, end_bracket)) = extract_balanced_brackets(md, alt_start - 1) {
                if end_bracket < md.len() && md.as_bytes()[end_bracket] == b'(' {
                    if let Some((path_content, _, end_paren)) = extract_balanced_parens(md, end_bracket) {
                        let raw_path = path_content.trim();
                        if !raw_path.starts_with("http://")
                            && !raw_path.starts_with("https://")
                            && !raw_path.starts_with("data:")
                            && !raw_path.starts_with('#')
                        {
                            let mut full_path = dir.join(raw_path);
                            if !full_path.exists() {
                                for ext in &["jpg", "jpeg", "png", "svg", "webp", "gif"] {
                                    let cand = dir.join(format!("{raw_path}.{ext}"));
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
                                        let b64 = crate::exporters::html::base64_encode(&img_bytes);
                                        result.push_str(&format!("![{alt_text}](data:{m};base64,{b64})"));
                                        scan = end_paren;
                                        continue;
                                    }
                                }
                            }
                        }
                        result.push_str(&md[start..end_paren]);
                        scan = end_paren;
                        continue;
                    }
                }
            }
            result.push_str("![");
            scan = alt_start;
        } else {
            result.push_str(&md[scan..]);
            break;
        }
    }
    result
}


pub fn convert_typst_math_to_latex(math_expr: &str) -> String {
    let mut res = math_expr.trim().to_string();

    if let Some(lt_idx) = res.rfind('<') {
        if res.ends_with('>') && lt_idx > 0 {
            res = res[..lt_idx].trim().to_string();
        }
    }

    while let Some(start) = res.find("bold(") {
        let scan = start + 4;
        if let Some((inner, _, end_pos)) = extract_balanced_parens(&res, scan) {
            let repl = format!("\\mathbf{{{}}}", convert_typst_math_to_latex(&inner));
            res = format!("{}{}{}", &res[..start], repl, &res[end_pos..]);
            continue;
        }
        break;
    }

    while let Some(start) = res.find("sqrt(") {
        let scan = start + 4;
        if let Some((inner, _, end_pos)) = extract_balanced_parens(&res, scan) {
            let repl = format!("\\sqrt{{{}}}", convert_typst_math_to_latex(&inner));
            res = format!("{}{}{}", &res[..start], repl, &res[end_pos..]);
            continue;
        }
        break;
    }

    // Convert Typst fractions: (num) / (den)
    while let Some(slash_idx) = res.find('/') {
        let before = res[..slash_idx].trim_end();
        let after = res[slash_idx + 1..].trim_start();
        if before.ends_with(')') && after.starts_with('(') {
            let mut depth = 0;
            let before_bytes = before.as_bytes();
            let mut num_start = None;
            for j in (0..before_bytes.len()).rev() {
                if before_bytes[j] == b')' {
                    depth += 1;
                } else if before_bytes[j] == b'(' {
                    depth -= 1;
                    if depth == 0 {
                        num_start = Some(j);
                        break;
                    }
                }
            }
            if let Some(n_start) = num_start {
                let num_content = &before[n_start + 1..before.len() - 1];
                let after_offset = slash_idx + 1 + ((res.len() - slash_idx - 1) - after.len());
                if let Some((den_content, _, after_end)) = extract_balanced_parens(&res, after_offset) {
                    let repl = format!("\\frac{{{}}}{{{}}}", convert_typst_math_to_latex(num_content), convert_typst_math_to_latex(&den_content));
                    res = format!("{}{}{}", &res[..n_start], repl, &res[after_end..]);
                    continue;
                }
            }
        }
        break;
    }

    let symbols = [
        ("dif", "\\mathrm{d}"),
        ("nabla", "\\nabla"),
        ("dot", "\\cdot"),
        ("times", "\\times"),
        ("approx", "\\approx"),
        ("equiv", "\\equiv"),
        ("infty", "\\infty"),
        ("partial", "\\partial"),
        ("integral", "\\int"),
        ("sum", "\\sum"),
        ("product", "\\prod"),
        ("alpha", "\\alpha"),
        ("beta", "\\beta"),
        ("gamma", "\\gamma"),
        ("delta", "\\delta"),
        ("epsilon", "\\varepsilon"),
        ("theta", "\\theta"),
        ("lambda", "\\lambda"),
        ("mu", "\\mu"),
        ("pi", "\\pi"),
        ("rho", "\\rho"),
        ("sigma", "\\sigma"),
        ("phi", "\\phi"),
        ("omega", "\\omega"),
        ("Gamma", "\\Gamma"),
        ("Delta", "\\Delta"),
        ("Theta", "\\Theta"),
        ("Lambda", "\\Lambda"),
        ("Sigma", "\\Sigma"),
        ("Phi", "\\Phi"),
        ("Omega", "\\Omega"),
        ("<=", "\\le"),
        (">=", "\\ge"),
        ("!=", "\\ne"),
        ("arrow.r", "\\to"),
        ("->", "\\to"),
        ("=>", "\\implies"),
    ];

    for (typst_sym, tex_sym) in &symbols {
        let is_ident = typst_sym.chars().all(|c| c.is_alphabetic());
        if is_ident {
            let mut out = String::new();
            let mut i = 0;
            let pat_len = typst_sym.len();
            while i < res.len() {
                if res[i..].starts_with(typst_sym) {
                    let before_ok = i == 0 || res[..i].chars().next_back().map(|c| !c.is_alphanumeric() && c != '\\').unwrap_or(true);
                    let after_idx = i + pat_len;
                    let after_ok = after_idx >= res.len() || res[after_idx..].chars().next().map(|c| !c.is_alphanumeric()).unwrap_or(true);
                    if before_ok && after_ok {
                        out.push_str(tex_sym);
                        i = after_idx;
                        continue;
                    }
                }
                let ch = res[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8();
            }
            res = out;
        } else {
            res = res.replace(typst_sym, tex_sym);
        }
    }

    res
}

pub fn convert_typst_formatting(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let bytes = s.as_bytes();
        if bytes[i] == b'`' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != b'`' {
                j += 1;
            }
            if j < bytes.len() {
                out.push_str(&s[i..=j]);
                i = j + 1;
                continue;
            }
        }
        if bytes[i] == b'*' && (i == 0 || bytes[i - 1] != b'\\') {
            if i + 1 < bytes.len() && bytes[i + 1] != b'*' {
                let mut j = i + 1;
                let mut found = None;
                while j < bytes.len() {
                    if bytes[j] == b'*' && bytes[j - 1] != b'\\' {
                        found = Some(j);
                        break;
                    }
                    j += 1;
                }
                if let Some(end_idx) = found {
                    let inner = &s[i + 1..end_idx];
                    out.push_str("**");
                    out.push_str(inner);
                    out.push_str("**");
                    i = end_idx + 1;
                    continue;
                }
            }
        }
        if bytes[i] == b'_' && (i == 0 || bytes[i - 1] != b'\\') {
            if i + 1 < bytes.len() && bytes[i + 1] != b'_' {
                let mut j = i + 1;
                let mut found = None;
                while j < bytes.len() {
                    if bytes[j] == b'_' && bytes[j - 1] != b'\\' {
                        found = Some(j);
                        break;
                    }
                    j += 1;
                }
                if let Some(end_idx) = found {
                    let inner = &s[i + 1..end_idx];
                    out.push('*');
                    out.push_str(inner);
                    out.push('*');
                    i = end_idx + 1;
                    continue;
                }
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

pub fn parse_typst_table(source: &str) -> String {
    let mut text = source.to_string();
    while let Some(start) = text.find("#table(") {
        let paren_start = start + "#table".len();
        if let Some((inner, _, end_pos)) = extract_balanced_parens(&text, paren_start) {
            let mut cols = 2;
            if let Some(col_idx) = inner.find("columns:") {
                let after_col = col_idx + "columns:".len();
                let rest = inner[after_col..].trim_start();
                if rest.starts_with('(') {
                    if let Some((col_tuple, _, _)) = extract_balanced_parens(rest, 0) {
                        let count = col_tuple.split(',').filter(|s| !s.trim().is_empty()).count();
                        if count > 0 {
                            cols = count;
                        }
                    }
                } else if let Some(first_word) = rest.split(|c: char| c.is_whitespace() || c == ',').next() {
                    if let Ok(n) = first_word.parse::<usize>() {
                        if n > 0 {
                            cols = n;
                        }
                    }
                }
            }

            let mut cells = Vec::new();
            let mut idx = 0;
            while idx < inner.len() {
                if let Some(bracket_rel) = inner[idx..].find('[') {
                    let bracket_pos = idx + bracket_rel;
                    if let Some((cell_content, _, next_idx)) = extract_balanced_brackets(&inner, bracket_pos) {
                        let c = convert_typst_formatting(cell_content.trim());
                        cells.push(c);
                        idx = next_idx;
                        continue;
                    }
                }
                break;
            }

            if !cells.is_empty() {
                let mut table_rows = Vec::new();
                for (chunk_idx, chunk) in cells.chunks(cols).enumerate() {
                    let mut row_cells: Vec<String> = chunk.iter().map(|s| s.to_string()).collect();
                    while row_cells.len() < cols {
                        row_cells.push(String::new());
                    }
                    table_rows.push(format!("| {} |", row_cells.join(" | ")));
                    if chunk_idx == 0 {
                        let sep = vec!["---"; cols];
                        table_rows.push(format!("| {} |", sep.join(" | ")));
                    }
                }
                let md_table = table_rows.join("\n");
                text = format!("{}\n\n{}\n\n{}", &text[..start], md_table, &text[end_pos..]);
                continue;
            }
        }
        break;
    }
    text
}

pub fn typst_to_markdown_with_dir(source: &str, project_dir: Option<&Path>) -> String {
    let resolved_source = resolve_inputs(source, project_dir, true);
    let mut text = resolved_source;
    let mut title = None;
    let mut author = None;

    if let Some(doc_idx) = text.find("#set document(") {
        let scan = doc_idx + "#set document".len();
        if let Some((doc_args, _, _)) = extract_balanced_parens(&text, scan) {
            if let Some(t_idx) = doc_args.find("title:") {
                let rest = doc_args[t_idx + 6..].trim();
                if rest.starts_with('"') {
                    if let Some(q_end) = rest[1..].find('"') {
                        title = Some(rest[1..=q_end].to_string());
                    }
                }
            }
            if let Some(a_idx) = doc_args.find("author:") {
                let rest = doc_args[a_idx + 7..].trim();
                if rest.starts_with('"') {
                    if let Some(q_end) = rest[1..].find('"') {
                        author = Some(rest[1..=q_end].to_string());
                    }
                }
            }
        }
    }

    // Process #figure(...) before table and heading parsing
    while let Some(fig_idx) = text.find("#figure(") {
        let scan = fig_idx + "#figure".len();
        if let Some((inner, _, end_pos)) = extract_balanced_parens(&text, scan) {
            let mut img_src = String::new();
            let mut caption_text = String::new();

            // Find caption: [...]
            if let Some(cap_idx) = inner.find("caption:") {
                let cap_scan = cap_idx + "caption:".len();
                if let Some(b_idx) = inner[cap_scan..].find('[') {
                    let full_b_idx = cap_scan + b_idx;
                    if let Some((c_inner, _, _)) = extract_balanced_brackets(&inner, full_b_idx) {
                        caption_text = c_inner.trim().to_string();
                    }
                }
            }

            // Consume trailing label if present e.g. <fig:banner> or <tab:benchmarks>
            let mut after_end = end_pos;
            let after_str = text[end_pos..].trim_start();
            if after_str.starts_with('<') {
                if let Some(gt_idx) = after_str.find('>') {
                    let ws_len = text[end_pos..].len() - after_str.len();
                    after_end = end_pos + ws_len + gt_idx + 1;
                }
            }

            // If it contains image("path", ...)
            if let Some(img_idx) = inner.find("image(") {
                let img_scan = img_idx + "image".len();
                if let Some((img_args, _, _)) = extract_balanced_parens(&inner, img_scan) {
                    let first_arg = img_args.split(',').next().unwrap_or("").trim().trim_matches('"').trim();
                    img_src = first_arg.to_string();
                }
                let cap = if !caption_text.is_empty() { &caption_text } else { "Image" };
                let replacement = format!("\n\n![{cap}]({img_src})\n\n*{cap}*\n\n");
                text = format!("{}{}{}", &text[..fig_idx], replacement, &text[after_end..]);
                continue;
            }

            // If it contains table(...)
            if let Some(tbl_idx) = inner.find("table(") {
                let tbl_scan = tbl_idx + "table".len();
                if let Some((tbl_inner, _, _)) = extract_balanced_parens(&inner, tbl_scan) {
                    let cap_str = if !caption_text.is_empty() {
                        format!("\n\n*Caption: {caption_text}*\n\n")
                    } else {
                        String::new()
                    };
                    let replacement = format!("\n\n#table({tbl_inner})\n{cap_str}");
                    text = format!("{}{}{}", &text[..fig_idx], replacement, &text[after_end..]);
                    continue;
                }
            }

            // Otherwise preserve inner content
            let cap_str = if !caption_text.is_empty() {
                format!("\n\n*Caption: {caption_text}*\n\n")
            } else {
                String::new()
            };
            let replacement = format!("\n\n{inner}\n{cap_str}");
            text = format!("{}{}{}", &text[..fig_idx], replacement, &text[after_end..]);
            continue;
        }
        break;
    }

    // Standalone #image("path", ...)
    while let Some(img_idx) = text.find("#image(") {
        let scan = img_idx + "#image".len();
        if let Some((inner, _, end_pos)) = extract_balanced_parens(&text, scan) {
            let first_arg = inner.split(',').next().unwrap_or("").trim().trim_matches('"').trim();
            let replacement = format!("\n\n![Image]({first_arg})\n\n");
            text = format!("{}{}{}", &text[..img_idx], replacement, &text[end_pos..]);
            continue;
        }
        break;
    }

    text = parse_typst_table(&text);

    while let Some(start) = text.find("#align(center)[") {
        let scan = start + "#align(center)".len();
        if let Some((inner, _, end_pos)) = extract_balanced_brackets(&text, scan) {
            let mut lines = Vec::new();
            for l in inner.lines() {
                let t = l.trim().trim_end_matches('\\').trim();
                if t.contains("weight: \"bold\"") || t.contains("weight: 700") {
                    if let Some(b_idx) = t.find('[') {
                        if let Some((h_text, _, _)) = extract_balanced_brackets(t, b_idx) {
                            if title.is_none() {
                                title = Some(h_text.clone());
                            }
                            lines.push(format!("# {h_text}"));
                            continue;
                        }
                    }
                }
                if t.contains("style: \"italic\"") {
                    if let Some(b_idx) = t.find('[') {
                        if let Some((a_text, _, _)) = extract_balanced_brackets(t, b_idx) {
                            if author.is_none() {
                                author = Some(a_text.clone());
                            }
                            lines.push(format!("*{a_text}*"));
                            continue;
                        }
                    }
                }
                if let Some(b_idx) = t.find('[') {
                    if let Some((other_text, _, _)) = extract_balanced_brackets(t, b_idx) {
                        lines.push(other_text);
                        continue;
                    }
                }
            }
            let replacement = lines.join("\n\n");
            text = format!("{}\n\n{}\n\n{}", &text[..start], replacement, &text[end_pos..]);
            continue;
        }
        break;
    }

    let mut lines = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("#set ") || trimmed.starts_with("#show ") || trimmed.starts_with("#import ") || trimmed.starts_with("#let ") || trimmed.starts_with("#v(") {
            continue;
        }

        if trimmed.starts_with("= ") {
            let mut h = trimmed[2..].trim();
            if let Some(lt) = h.rfind('<') {
                if h.ends_with('>') { h = h[..lt].trim(); }
            }
            lines.push(format!("# {}", h));
            continue;
        } else if trimmed.starts_with("== ") {
            let mut h = trimmed[3..].trim();
            if let Some(lt) = h.rfind('<') {
                if h.ends_with('>') { h = h[..lt].trim(); }
            }
            lines.push(format!("## {}", h));
            continue;
        } else if trimmed.starts_with("=== ") {
            let mut h = trimmed[4..].trim();
            if let Some(lt) = h.rfind('<') {
                if h.ends_with('>') { h = h[..lt].trim(); }
            }
            lines.push(format!("### {}", h));
            continue;
        } else if trimmed.starts_with("==== ") {
            let mut h = trimmed[5..].trim();
            if let Some(lt) = h.rfind('<') {
                if h.ends_with('>') { h = h[..lt].trim(); }
            }
            lines.push(format!("#### {}", h));
            continue;
        }

        if trimmed.starts_with("+ ") {
            lines.push(format!("1. {}", &trimmed[2..]));
            continue;
        }

        if trimmed.starts_with("/ ") {
            if let Some(colon) = trimmed[2..].find(':') {
                let term = trimmed[2..2 + colon].trim();
                let desc = trimmed[2 + colon + 1..].trim();
                lines.push(format!("- **{term}:** {desc}"));
                continue;
            }
        }

        lines.push(line.to_string());
    }

    let mut processed_lines = Vec::new();
    for line in lines {
        let t = line.trim();
        if t.starts_with('$') {
            let formula_part = if let Some(last_dollar) = t[1..].rfind('$') {
                let end_dollar = 1 + last_dollar;
                let inside = &t[1..end_dollar];
                let converted = convert_typst_math_to_latex(inside);
                format!("$$\n{}\n$$", converted)
            } else {
                t.to_string()
            };
            processed_lines.push(formula_part);
            continue;
        }

        if t.starts_with('|') {
            processed_lines.push(line);
            continue;
        }

        let mut inline = convert_typst_formatting(&line);

        // References: @label -> [@label]
        let mut ref_converted = String::with_capacity(inline.len());
        let mut idx = 0;
        while idx < inline.len() {
            let b = inline.as_bytes();
            if b[idx] == b'@' && (idx == 0 || b[idx - 1] != b'[') {
                let rest = &inline[idx + 1..];
                let label_len: usize = rest.chars().take_while(|c| c.is_alphanumeric() || *c == ':' || *c == '_' || *c == '-').map(|c| c.len_utf8()).sum();
                if label_len > 0 {
                    let label = &rest[..label_len];
                    ref_converted.push_str(&format!("[@{label}]"));
                    idx += 1 + label_len;
                    continue;
                }
            }
            let ch = inline[idx..].chars().next().unwrap();
            ref_converted.push(ch);
            idx += ch.len_utf8();
        }
        inline = ref_converted;

        processed_lines.push(inline);
    }

    let mut final_lines = Vec::new();
    if let Some(t) = &title {
        let title_heading = format!("# {t}");
        if !processed_lines.iter().any(|l| l.trim() == title_heading) {
            final_lines.push(title_heading);
            final_lines.push(String::new());
        }
    }
    if let Some(a) = &author {
        let author_str = format!("**Author:** {a}");
        if !processed_lines.iter().any(|l| l.contains(a.as_str())) {
            final_lines.push(author_str);
            final_lines.push(String::new());
        }
    }
    final_lines.extend(processed_lines);

    final_lines.join("\n").trim().to_string()
}

pub fn typst_to_markdown(source: &str) -> String {
    typst_to_markdown_with_dir(source, None)
}
