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

use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuggestionDetail {
    pub code: &'static str,
    pub params: BTreeMap<String, String>,
    pub message: String,
}

fn suggestion(code: &'static str, message: impl Into<String>) -> Option<SuggestionDetail> {
    Some(SuggestionDetail {
        code,
        params: BTreeMap::new(),
        message: message.into(),
    })
}

fn suggestion_with_params(
    code: &'static str,
    params: BTreeMap<String, String>,
    message: impl Into<String>,
) -> Option<SuggestionDetail> {
    Some(SuggestionDetail {
        code,
        params,
        message: message.into(),
    })
}

pub fn get_smart_suggestion(msg: &str) -> Option<String> {
    get_smart_suggestion_structured(msg).map(|detail| detail.message)
}

pub fn get_smart_suggestion_structured(msg: &str) -> Option<SuggestionDetail> {
    if msg.contains("Misplaced alignment tab character &") {
        suggestion(
            "latex.misplaced_ampersand",
            "Literal '&' used in text mode. Use '\\&' for an ampersand, or enclose columns inside an alignment environment like 'tabular' or 'align'.",
        )
    } else if msg.contains("Undefined control sequence") {
        suggestion(
            "latex.undefined_control_sequence",
            "LaTeX command or macro not recognized. Check for typos or verify the required package is imported in the preamble.",
        )
    } else if msg.contains("Environment") && msg.contains("undefined") {
        let env_name = extract_between(msg, "Environment ", " undefined")
            .or_else(|| extract_enclosed_token(msg));
        if let Some(env) = env_name {
            suggestion_with_params(
                "latex.undefined_environment",
                BTreeMap::from([("env".to_string(), env.to_string())]),
                format!("Environment '{env}' is not recognized. Verify spelling or import the LaTeX package that provides '\\begin{{{env}}}'."),
            )
        } else {
            suggestion(
                "latex.undefined_environment_generic",
                "Environment not recognized. Verify spelling or check that the providing package is imported in the preamble.",
            )
        }
    } else if msg.contains("Missing $ inserted") {
        suggestion(
            "latex.missing_dollar",
            "Math symbol used in text mode. Wrap formulas inside '$ ... $' for inline math or '\\[ ... \\]' for display math.",
        )
    } else if msg.contains("Extra }, or forgotten $") {
        suggestion(
            "latex.extra_brace_or_dollar",
            "Unbalanced delimiter or curly brace. Check that every '{' and '$' has a matching closing pair.",
        )
    } else if msg.contains("ended by \\end") {
        let begin_env = extract_between(msg, "\\begin{", "}");
        let end_env = extract_between(msg, "\\end{", "}");
        match (begin_env, end_env) {
            (Some(b), Some(e)) => suggestion_with_params(
                "latex.mismatched_env",
                BTreeMap::from([
                    ("beginEnv".to_string(), b.to_string()),
                    ("endEnv".to_string(), e.to_string()),
                ]),
                format!("Mismatched environment closure: '\\begin{{{b}}}' was closed with '\\end{{{e}}}'. Ensure tags match and are properly nested."),
            ),
            _ => suggestion(
                "latex.mismatched_env_generic",
                "Mismatched environment tags. Ensure each '\\begin{...}' has a matching '\\end{...}'.",
            ),
        }
    } else if msg.contains("Reference") && msg.contains("undefined") {
        if let Some(key) = extract_enclosed_token(msg) {
            suggestion_with_params(
                "latex.undefined_reference",
                BTreeMap::from([("key".to_string(), key.to_string())]),
                format!("Cross-reference key '{key}' not found. Ensure a matching '\\label{{{key}}}' exists in your document."),
            )
        } else {
            suggestion(
                "latex.undefined_reference_generic",
                "Cross-reference key not found. Ensure a matching '\\label{...}' anchor exists in your document.",
            )
        }
    } else if msg.contains("Citation") && msg.contains("undefined") {
        if let Some(key) = extract_enclosed_token(msg) {
            suggestion_with_params(
                "latex.undefined_citation",
                BTreeMap::from([("key".to_string(), key.to_string())]),
                format!("Citation key '{key}' not found. Check that the entry exists in your .bib file and matches case-sensitively."),
            )
        } else {
            suggestion(
                "latex.undefined_citation_generic",
                "Citation key not found in bibliography (.bib). Verify case sensitivity and bibliography entry keys.",
            )
        }
    } else if msg.contains("fontspec Error: The font") && msg.contains("cannot be found") {
        if let Some(font_name) = extract_enclosed_token(msg) {
            suggestion_with_params(
                "latex.font_not_found",
                BTreeMap::from([("font".to_string(), font_name.to_string())]),
                format!("Font '{font_name}' was not found by XeTeX. Ensure it is installed on your OS, or load the font by exact file name (e.g. '\\setmainfont{{{font_name}.otf}}') if it resides in the project."),
            )
        } else {
            suggestion(
                "latex.font_not_found_generic",
                "Font not found by XeTeX. Ensure the font is installed on your OS or specify the exact OpenType/TrueType filename.",
            )
        }
    } else if msg.contains("inputenc package ignored") {
        suggestion(
            "latex.inputenc_ignored",
            "Tectonic runs on XeTeX which natively supports UTF-8 Unicode. You can safely remove '\\usepackage[utf8]{inputenc}'.",
        )
    } else if msg.contains("PageLabels entry") {
        suggestion(
            "latex.pagelabels_info",
            "Informational notice from hyperref. Document outline and page labels will synchronize automatically on subsequent runs.",
        )
    } else if msg.contains("Option clash for package") {
        let pkg = extract_word_after(msg, "Option clash for package ");
        if let Some(pkg_name) = pkg {
            suggestion_with_params(
                "latex.option_clash",
                BTreeMap::from([("pkg".to_string(), pkg_name.to_string())]),
                format!("Package '{pkg_name}' was loaded multiple times with conflicting options. Declare options globally using '\\PassOptionsToPackage{{options}}{{{pkg_name}}}' before \\documentclass, or consolidate package imports."),
            )
        } else {
            suggestion(
                "latex.option_clash_generic",
                "Package was loaded multiple times with conflicting options. Declare options globally using '\\PassOptionsToPackage{options}{package}' before \\documentclass.",
            )
        }
    } else if msg.contains("Unknown document class") && msg.contains("caption") {
        suggestion(
            "latex.unknown_docclass_caption",
            "Document class has custom caption formatting that may conflict with the 'caption' package. Configure styling with '\\captionsetup' or suppress the notice with '\\WarningFilter{caption}{Unknown document class}'.",
        )
    } else if msg.contains("Unable to load picture or PDF file") {
        if let Some(file) = extract_enclosed_token(msg) {
            suggestion_with_params(
                "latex.asset_not_found",
                BTreeMap::from([("file".to_string(), file.to_string())]),
                format!("Figure or asset '{file}' was not found. Verify the relative path matches your project directory structure."),
            )
        } else {
            suggestion(
                "latex.asset_not_found_generic",
                "Figure or asset not found. Verify the relative path matches your project folder structure (e.g. 'figures/image.pdf').",
            )
        }
    } else if msg.contains("File") && msg.contains("not found") {
        let extracted_file = extract_enclosed_token(msg);
        if let Some(file) = extracted_file {
            let lower = file.to_lowercase();
            let params = BTreeMap::from([("file".to_string(), file.to_string())]);
            if lower.ends_with(".sty") {
                suggestion_with_params(
                    "latex.sty_not_found",
                    params,
                    format!("LaTeX package '{file}' not found. Verify the package name or place '{file}' in your project folder."),
                )
            } else if lower.ends_with(".cls") {
                suggestion_with_params(
                    "latex.cls_not_found",
                    params,
                    format!("Document class '{file}' not found. Ensure '{file}' is present in your project root directory."),
                )
            } else if lower.ends_with(".bib") {
                suggestion_with_params(
                    "latex.bib_not_found",
                    params,
                    format!("Bibliography database '{file}' not found. Verify the file name and path in your project directory."),
                )
            } else if lower.ends_with(".png")
                || lower.ends_with(".jpg")
                || lower.ends_with(".jpeg")
                || lower.ends_with(".pdf")
                || lower.ends_with(".eps")
            {
                suggestion_with_params(
                    "latex.graphic_not_found",
                    params,
                    format!("Graphic file '{file}' not found. Verify the file path matches your project folder structure."),
                )
            } else {
                suggestion_with_params(
                    "latex.file_not_found",
                    params,
                    format!("File '{file}' not found in bundle or project. Verify the file name and relative path."),
                )
            }
        } else if msg.contains(".sty") {
            suggestion(
                "latex.sty_not_found_generic",
                "LaTeX package (.sty) not found in bundle or project. Verify required package name or place the '.sty' file in your project folder.",
            )
        } else if msg.contains(".cls") {
            suggestion(
                "latex.cls_not_found_generic",
                "Document class (.cls) file not found. Ensure the custom class file is present in your project directory.",
            )
        } else if msg.contains(".bib") {
            suggestion(
                "latex.bib_not_found_generic",
                "Bibliography (.bib) file not found. Verify the file name matches your project folder structure.",
            )
        } else {
            suggestion(
                "latex.asset_not_found_generic",
                "Figure or asset not found. Verify the relative path matches your project folder structure (e.g. 'figures_pdf/image.pdf').",
            )
        }
    } else if msg.contains("float specifier changed") {
        suggestion(
            "latex.float_specifier",
            "LaTeX float placement specifier '[h]' alone is too restrictive. Use '[htbp]' so LaTeX can position the float at the top or bottom of the column if it does not fit inline.",
        )
    } else if msg.contains("usepackage before documentclass")
        || msg.contains("\\usepackage before \\documentclass")
    {
        suggestion(
            "latex.usepackage_before_documentclass",
            "All '\\usepackage{...}' declarations must be placed in the preamble after '\\documentclass{...}' and before '\\begin{document}'.",
        )
    } else if msg.contains("Using fall-back BibTeX") {
        suggestion(
            "latex.fallback_bibtex",
            "Informational notice: BibLaTeX is using the embedded in-memory BibTeX backend without requiring external Biber.",
        )
    } else if msg.contains("Empty bibliography") {
        suggestion(
            "latex.empty_bibliography",
            "No matching entries found in .bib for this category or filter. Comment out this \\printbibliography command if you have no publications of this type.",
        )
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_suggestions_emit_expected_codes_and_params() {
        let env = get_smart_suggestion_structured("! LaTeX Error: Environment theorembox undefined.")
            .expect("environment suggestion");
        assert_eq!(env.code, "latex.undefined_environment");
        assert_eq!(env.params.get("env").map(String::as_str), Some("theorembox"));

        let mismatch = get_smart_suggestion_structured(
            "! LaTeX Error: \\begin{itemize} on input line 4 ended by \\end{enumerate}.",
        )
        .expect("mismatch suggestion");
        assert_eq!(mismatch.code, "latex.mismatched_env");
        assert_eq!(mismatch.params.get("beginEnv").map(String::as_str), Some("itemize"));
        assert_eq!(mismatch.params.get("endEnv").map(String::as_str), Some("enumerate"));

        let clash = get_smart_suggestion_structured("! LaTeX Error: Option clash for package xcolor.")
            .expect("option clash suggestion");
        assert_eq!(clash.code, "latex.option_clash");
        assert_eq!(clash.params.get("pkg").map(String::as_str), Some("xcolor"));

        let sty = get_smart_suggestion_structured("! LaTeX Error: File `tabularray.sty' not found.")
            .expect("sty suggestion");
        assert_eq!(sty.code, "latex.sty_not_found");
        assert_eq!(sty.params.get("file").map(String::as_str), Some("tabularray.sty"));

        let cls = get_smart_suggestion_structured("! LaTeX Error: File `custom.cls' not found.")
            .expect("cls suggestion");
        assert_eq!(cls.code, "latex.cls_not_found");
        assert_eq!(cls.params.get("file").map(String::as_str), Some("custom.cls"));

        let bib = get_smart_suggestion_structured("! LaTeX Error: File `refs.bib' not found.")
            .expect("bib suggestion");
        assert_eq!(bib.code, "latex.bib_not_found");
        assert_eq!(bib.params.get("file").map(String::as_str), Some("refs.bib"));

        let gfx = get_smart_suggestion_structured("! LaTeX Error: File `fig.png' not found.")
            .expect("graphic suggestion");
        assert_eq!(gfx.code, "latex.graphic_not_found");
        assert_eq!(gfx.params.get("file").map(String::as_str), Some("fig.png"));

        let generic = get_smart_suggestion_structured("LaTeX Warning: Empty bibliography on input line 12.")
            .expect("empty bib suggestion");
        assert_eq!(generic.code, "latex.empty_bibliography");
        assert!(generic.params.is_empty());
        assert_eq!(
            get_smart_suggestion("LaTeX Warning: Empty bibliography on input line 12."),
            Some(generic.message)
        );
    }
}
