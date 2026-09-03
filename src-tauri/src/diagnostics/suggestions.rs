pub fn extract_enclosed_token<'a>(s: &'a str) -> Option<&'a str> {
    // 1. TeX backtick-apostrophe: `token'
    if let Some(start) = s.find('`') {
        if let Some(end) = s[start + 1..].find('\'') {
            let inner = s[start + 1..start + 1 + end].trim();
            if !inner.is_empty() {
                return Some(inner);
            }
        }
    }
    // 2. Double quotes: "token"
    if let Some(start) = s.find('"') {
        if let Some(end) = s[start + 1..].find('"') {
            let inner = s[start + 1..start + 1 + end].trim();
            if !inner.is_empty() {
                return Some(inner);
            }
        }
    }
    // 3. Single quotes: 'token'
    if let Some(start) = s.find('\'') {
        if let Some(end) = s[start + 1..].find('\'') {
            let inner = s[start + 1..start + 1 + end].trim();
            if !inner.is_empty() {
                return Some(inner);
            }
        }
    }
    None
}

pub fn extract_word_after<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if let Some(pos) = s.find(prefix) {
        let remainder = s[pos + prefix.len()..].trim_start();
        let end = remainder
            .find(|c: char| c.is_whitespace() || c == '.' || c == ',' || c == ':' || c == ';')
            .unwrap_or(remainder.len());
        let word = remainder[..end].trim_matches(|c: char| c == '`' || c == '\'' || c == '"');
        if !word.is_empty() {
            return Some(word);
        }
    }
    None
}

pub fn extract_between<'a>(s: &'a str, start_delim: &str, end_delim: &str) -> Option<&'a str> {
    if let Some(start_pos) = s.find(start_delim) {
        let after_start = &s[start_pos + start_delim.len()..];
        if let Some(end_pos) = after_start.find(end_delim) {
            let token = after_start[..end_pos].trim();
            if !token.is_empty() {
                return Some(token);
            }
        }
    }
    None
}

pub fn get_smart_suggestion(msg: &str) -> Option<String> {
    if msg.contains("Misplaced alignment tab character &") {
        Some("Literal '&' used in text mode. Use '\\&' for an ampersand, or enclose columns inside an alignment environment like 'tabular' or 'align'.".into())
    } else if msg.contains("Undefined control sequence") {
        Some("LaTeX command or macro not recognized. Check for typos or verify the required package is imported in the preamble.".into())
    } else if msg.contains("Environment") && msg.contains("undefined") {
        let env_name = extract_between(msg, "Environment ", " undefined")
            .or_else(|| extract_enclosed_token(msg));
        if let Some(env) = env_name {
            Some(format!("Environment '{env}' is not recognized. Verify spelling or import the LaTeX package that provides '\\begin{{{env}}}'."))
        } else {
            Some("Environment not recognized. Verify spelling or check that the providing package is imported in the preamble.".into())
        }
    } else if msg.contains("Missing $ inserted") {
        Some("Math symbol used in text mode. Wrap formulas inside '$ ... $' for inline math or '\\[ ... \\]' for display math.".into())
    } else if msg.contains("Extra }, or forgotten $") {
        Some("Unbalanced delimiter or curly brace. Check that every '{' and '$' has a matching closing pair.".into())
    } else if msg.contains("ended by \\end") {
        let begin_env = extract_between(msg, "\\begin{", "}");
        let end_env = extract_between(msg, "\\end{", "}");
        match (begin_env, end_env) {
            (Some(b), Some(e)) => Some(format!("Mismatched environment closure: '\\begin{{{b}}}' was closed with '\\end{{{e}}}'. Ensure tags match and are properly nested.")),
            _ => Some("Mismatched environment tags. Ensure each '\\begin{...}' has a matching '\\end{...}'.".into()),
        }
    } else if msg.contains("Reference") && msg.contains("undefined") {
        if let Some(key) = extract_enclosed_token(msg) {
            Some(format!("Cross-reference key '{key}' not found. Ensure a matching '\\label{{{key}}}' exists in your document."))
        } else {
            Some("Cross-reference key not found. Ensure a matching '\\label{...}' anchor exists in your document.".into())
        }
    } else if msg.contains("Citation") && msg.contains("undefined") {
        if let Some(key) = extract_enclosed_token(msg) {
            Some(format!("Citation key '{key}' not found. Check that the entry exists in your .bib file and matches case-sensitively."))
        } else {
            Some("Citation key not found in bibliography (.bib). Verify case sensitivity and bibliography entry keys.".into())
        }
    } else if msg.contains("fontspec Error: The font") && msg.contains("cannot be found") {
        if let Some(font_name) = extract_enclosed_token(msg) {
            Some(format!("Font '{font_name}' was not found by XeTeX. Ensure it is installed on your OS, or load the font by exact file name (e.g. '\\setmainfont{{{font_name}.otf}}') if it resides in the project."))
        } else {
            Some("Font not found by XeTeX. Ensure the font is installed on your OS or specify the exact OpenType/TrueType filename.".into())
        }
    } else if msg.contains("inputenc package ignored") {
        Some("Tectonic runs on XeTeX which natively supports UTF-8 Unicode. You can safely remove '\\usepackage[utf8]{inputenc}'.".into())
    } else if msg.contains("PageLabels entry") {
        Some("Informational notice from hyperref. Document outline and page labels will synchronize automatically on subsequent runs.".into())
    } else if msg.contains("Option clash for package") {
        let pkg = extract_word_after(msg, "Option clash for package ");
        if let Some(pkg_name) = pkg {
            Some(format!("Package '{pkg_name}' was loaded multiple times with conflicting options. Declare options globally using '\\PassOptionsToPackage{{options}}{{{pkg_name}}}' before \\documentclass, or consolidate package imports."))
        } else {
            Some("Package was loaded multiple times with conflicting options. Declare options globally using '\\PassOptionsToPackage{options}{package}' before \\documentclass.".into())
        }
    } else if msg.contains("Unknown document class") && msg.contains("caption") {
        Some("Document class has custom caption formatting that may conflict with the 'caption' package. Configure styling with '\\captionsetup' or suppress the notice with '\\WarningFilter{caption}{Unknown document class}'.".into())
    } else if msg.contains("Unable to load picture or PDF file") {
        if let Some(file) = extract_enclosed_token(msg) {
            Some(format!("Figure or asset '{file}' was not found. Verify the relative path matches your project directory structure."))
        } else {
            Some("Figure or asset not found. Verify the relative path matches your project folder structure (e.g. 'figures/image.pdf').".into())
        }
    } else if msg.contains("File") && msg.contains("not found") {
        let extracted_file = extract_enclosed_token(msg);
        if let Some(file) = extracted_file {
            let lower = file.to_lowercase();
            if lower.ends_with(".sty") {
                Some(format!("LaTeX package '{file}' not found. Verify the package name or place '{file}' in your project folder."))
            } else if lower.ends_with(".cls") {
                Some(format!("Document class '{file}' not found. Ensure '{file}' is present in your project root directory."))
            } else if lower.ends_with(".bib") {
                Some(format!("Bibliography database '{file}' not found. Verify the file name and path in your project directory."))
            } else if lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".pdf") || lower.ends_with(".eps") {
                Some(format!("Graphic file '{file}' not found. Verify the file path matches your project folder structure."))
            } else {
                Some(format!("File '{file}' not found in bundle or project. Verify the file name and relative path."))
            }
        } else if msg.contains(".sty") {
            Some("LaTeX package (.sty) not found in bundle or project. Verify required package name or place the '.sty' file in your project folder.".into())
        } else if msg.contains(".cls") {
            Some("Document class (.cls) file not found. Ensure the custom class file is present in your project directory.".into())
        } else if msg.contains(".bib") {
            Some("Bibliography (.bib) file not found. Verify the file name matches your project folder structure.".into())
        } else {
            Some("Figure or asset not found. Verify the relative path matches your project folder structure (e.g. 'figures_pdf/image.pdf').".into())
        }
    } else if msg.contains("float specifier changed") {
        Some("LaTeX float placement specifier '[h]' alone is too restrictive. Use '[htbp]' so LaTeX can position the float at the top or bottom of the column if it does not fit inline.".into())
    } else if msg.contains("usepackage before documentclass") || msg.contains("\\usepackage before \\documentclass") {
        Some("All '\\usepackage{...}' declarations must be placed in the preamble after '\\documentclass{...}' and before '\\begin{document}'.".into())
    } else if msg.contains("Using fall-back BibTeX") {
        Some("Informational notice: BibLaTeX is using the embedded in-memory BibTeX backend without requiring external Biber.".into())
    } else if msg.contains("Empty bibliography") {
        Some("No matching entries found in .bib for this category or filter. Comment out this \\printbibliography command if you have no publications of this type.".into())
    } else {
        None
    }
}
