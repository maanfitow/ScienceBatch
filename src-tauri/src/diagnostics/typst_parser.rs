use std::collections::BTreeMap;

use super::suggestions::SuggestionDetail;
use crate::types::DiagnosticItem;

pub fn get_os_font_suggestion(font_name: &str) -> String {
    get_os_font_suggestion_structured(font_name).message
}

pub fn get_os_font_suggestion_structured(font_name: &str) -> SuggestionDetail {
    let font_clean = font_name.trim().trim_matches('\'').trim_matches('"');
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let font_lower = font_clean.to_lowercase();

    #[cfg(target_os = "linux")]
    {
        let install_cmd = if font_lower.contains("dejavu") {
            "sudo apt install fonts-dejavu (Ubuntu/Debian) or sudo pacman -S ttf-dejavu (Arch)"
        } else if font_lower.contains("arial")
            || font_lower.contains("times")
            || font_lower.contains("courier")
        {
            "sudo apt install ttf-mscorefonts-installer"
        } else if font_lower.contains("roboto") {
            "sudo apt install fonts-roboto"
        } else if font_lower.contains("fira") {
            "sudo apt install fonts-firacode"
        } else if font_lower.contains("liberation") {
            "sudo apt install fonts-liberation"
        } else if font_lower.contains("noto") {
            "sudo apt install fonts-noto-core"
        } else if font_lower.contains("cantarell") {
            "sudo apt install fonts-cantarell"
        } else {
            "Install font package via system package manager (apt/pacman/dnf) or copy .ttf/.otf to ~/.local/share/fonts"
        };

        SuggestionDetail {
            code: "typst.font_not_found_linux",
            params: BTreeMap::from([
                ("font".to_string(), font_clean.to_string()),
                ("installCmd".to_string(), install_cmd.to_string()),
            ]),
            message: format!(
                "Font '{font_clean}' is not installed on your Linux system. To install: '{install_cmd}'. You can also use bundled fonts: 'Libertinus Serif' or 'New Computer Modern', or define a fallback: font: (\"{font_clean}\", \"Libertinus Serif\")."
            ),
        }
    }

    #[cfg(target_os = "windows")]
    {
        SuggestionDetail {
            code: "typst.font_not_found_windows",
            params: BTreeMap::from([("font".to_string(), font_clean.to_string())]),
            message: format!(
                "Font '{font_clean}' was not found on your Windows system. Download and install it in Settings > Personalization > Fonts (or right-click > 'Install for all users'). Alternatively, use 'Libertinus Serif' or define a fallback: font: (\"{font_clean}\", \"Libertinus Serif\")."
            ),
        }
    }

    #[cfg(target_os = "macos")]
    {
        SuggestionDetail {
            code: "typst.font_not_found_macos",
            params: BTreeMap::from([
                ("font".to_string(), font_clean.to_string()),
                ("brewName".to_string(), font_lower.clone()),
            ]),
            message: format!(
                "Font '{font_clean}' was not found on macOS. Install it in Font Book or via Homebrew ('brew install --cask font-{font_lower}'). Alternatively, use 'Libertinus Serif' or define a fallback: font: (\"{font_clean}\", \"Libertinus Serif\")."
            ),
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        SuggestionDetail {
            code: "typst.font_not_found_other",
            params: BTreeMap::from([("font".to_string(), font_clean.to_string())]),
            message: format!(
                "Font '{font_clean}' is not available. Install it on your system or use the bundled font 'Libertinus Serif'."
            ),
        }
    }
}

pub fn parse_typst_diagnostics(
    err: typst_embed::RenderError,
    main_file: Option<&str>,
) -> (Vec<DiagnosticItem>, String) {
    let mut errors = Vec::new();
    let mut raw_log = String::new();

    match err {
        typst_embed::RenderError::Diagnostics(diags) => {
            for d in diags {
                let msg = d.message().to_string();
                raw_log.push_str(&format!("Typst error: {msg}\n"));

                let mut line = None;
                if let Some(pos) = msg.find("line ") {
                    let rest = &msg[pos + 5..];
                    let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    line = num_str.parse().ok();
                }

                let detail = if msg.contains("unknown font family") {
                    let font_name = if let Some(pos) = msg.find("unknown font family:") {
                        &msg[pos + 20..]
                    } else {
                        "unknown"
                    };
                    get_os_font_suggestion_structured(font_name)
                } else if msg.contains("cannot reference equation without numbering") {
                    SuggestionDetail {
                        code: "typst.equation_numbering",
                        params: BTreeMap::new(),
                        message: "To cross-reference equations with @label, enable equation numbering by adding: #set math.equation(numbering: \"(1)\") to your document.".into(),
                    }
                } else if msg.contains("unknown variable") {
                    let var_name = if let Some(pos) = msg.find("unknown variable:") {
                        msg[pos + 17..].trim().trim_matches('\'').trim_matches('"')
                    } else {
                        ""
                    };
                    if !var_name.is_empty() {
                        SuggestionDetail {
                            code: "typst.unknown_variable",
                            params: BTreeMap::from([("name".to_string(), var_name.to_string())]),
                            message: format!("Variable '{var_name}' is not defined. Check spelling or declare it with a #let statement: '#let {var_name} = ...'."),
                        }
                    } else {
                        SuggestionDetail {
                            code: "typst.unknown_variable_generic",
                            params: BTreeMap::new(),
                            message: "Undefined variable. Check spelling or declare it with a #let statement.".into(),
                        }
                    }
                } else if msg.contains("unexpected closing delimiter")
                    || msg.contains("unclosed delimiter")
                {
                    SuggestionDetail {
                        code: "typst.delimiter_mismatch",
                        params: BTreeMap::new(),
                        message: "Unclosed or mismatched delimiter. Check matching parentheses (), brackets [], or braces {}.".into(),
                    }
                } else {
                    SuggestionDetail {
                        code: "typst.generic_syntax",
                        params: BTreeMap::new(),
                        message: "Review Typst syntax or function arguments.".into(),
                    }
                };

                errors.push(DiagnosticItem {
                    severity: "error".into(),
                    message: msg,
                    line,
                    file: main_file.map(|s| s.to_string()),
                    suggestion: Some(detail.message),
                    suggestion_code: Some(detail.code.to_string()),
                    suggestion_params: if detail.params.is_empty() {
                        None
                    } else {
                        Some(detail.params)
                    },
                });
            }
        }
        other => {
            let msg = other.to_string();
            raw_log.push_str(&format!("Typst render failure: {msg}\n"));
            errors.push(DiagnosticItem {
                severity: "error".into(),
                message: msg,
                line: None,
                file: main_file.map(|s| s.to_string()),
                suggestion: None,
                suggestion_code: None,
                suggestion_params: None,
            });
        }
    }

    (errors, raw_log)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_suggestion_structured_matches_target_os_code_and_params() {
        let detail = get_os_font_suggestion_structured("'Roboto'");
        assert_eq!(detail.params.get("font").map(String::as_str), Some("Roboto"));
        #[cfg(target_os = "linux")]
        {
            assert_eq!(detail.code, "typst.font_not_found_linux");
            assert!(detail
                .params
                .get("installCmd")
                .is_some_and(|cmd| cmd.contains("fonts-roboto")));
        }
        #[cfg(target_os = "windows")]
        assert_eq!(detail.code, "typst.font_not_found_windows");
        #[cfg(target_os = "macos")]
        {
            assert_eq!(detail.code, "typst.font_not_found_macos");
            assert_eq!(detail.params.get("brewName").map(String::as_str), Some("roboto"));
        }
        assert_eq!(get_os_font_suggestion("'Roboto'"), detail.message);
    }

    #[test]
    fn parse_typst_diagnostics_populates_structured_codes() {
        let project = typst_embed::Project::builder("main.typ")
            .source_file("main.typ", "#let y = unknown_var\n")
            .build()
            .unwrap();
        let env = typst_embed::RenderEnvironment::builder()
            .font_set(crate::compiler::typst::get_system_font_set())
            .build()
            .unwrap();
        let err = crate::compiler::typst_sourcemap::compile_and_extract_typst(&project, &env)
            .expect_err("unknown variable should fail");
        let (errors, _) = parse_typst_diagnostics(err, Some("main.typ"));
        assert!(!errors.is_empty());
        assert_eq!(
            errors[0].suggestion_code.as_deref(),
            Some("typst.unknown_variable")
        );
        assert_eq!(
            errors[0]
                .suggestion_params
                .as_ref()
                .and_then(|p| p.get("name"))
                .map(String::as_str),
            Some("unknown_var")
        );
    }
}
