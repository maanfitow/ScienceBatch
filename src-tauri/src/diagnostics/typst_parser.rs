use crate::types::DiagnosticItem;

pub fn get_os_font_suggestion(font_name: &str) -> String {
    let font_clean = font_name.trim().trim_matches('\'').trim_matches('"');
    let font_lower = font_clean.to_lowercase();

    #[cfg(target_os = "linux")]
    {
        let install_cmd = if font_lower.contains("dejavu") {
            "sudo apt install fonts-dejavu (Ubuntu/Debian) or sudo pacman -S ttf-dejavu (Arch)"
        } else if font_lower.contains("arial") || font_lower.contains("times") || font_lower.contains("courier") {
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

        format!(
            "Font '{font_clean}' is not installed on your Linux system. To install: '{install_cmd}'. You can also use bundled fonts: 'Libertinus Serif' or 'New Computer Modern', or define a fallback: font: (\"{font_clean}\", \"Libertinus Serif\")."
        )
    }

    #[cfg(target_os = "windows")]
    {
        format!(
            "Font '{font_clean}' was not found on your Windows system. Download and install it in Settings > Personalization > Fonts (or right-click > 'Install for all users'). Alternatively, use 'Libertinus Serif' or define a fallback: font: (\"{font_clean}\", \"Libertinus Serif\")."
        )
    }

    #[cfg(target_os = "macos")]
    {
        format!(
            "Font '{font_clean}' was not found on macOS. Install it in Font Book or via Homebrew ('brew install --cask font-{font_lower}'). Alternatively, use 'Libertinus Serif' or define a fallback: font: (\"{font_clean}\", \"Libertinus Serif\")."
        )
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        format!(
            "Font '{font_clean}' is not available. Install it on your system or use the bundled font 'Libertinus Serif'."
        )
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

                let suggestion = if msg.contains("unknown font family") {
                    let font_name = if let Some(pos) = msg.find("unknown font family:") {
                        &msg[pos + 20..]
                    } else {
                        "unknown"
                    };
                    Some(get_os_font_suggestion(font_name))
                } else if msg.contains("cannot reference equation without numbering") {
                    Some("To cross-reference equations with @label, enable equation numbering by adding: #set math.equation(numbering: \"(1)\") to your document.".into())
                } else if msg.contains("unknown variable") {
                    let var_name = if let Some(pos) = msg.find("unknown variable:") {
                        msg[pos + 17..].trim().trim_matches('\'').trim_matches('"')
                    } else {
                        ""
                    };
                    if !var_name.is_empty() {
                        Some(format!("Variable '{var_name}' is not defined. Check spelling or declare it with a #let statement: '#let {var_name} = ...'."))
                    } else {
                        Some("Undefined variable. Check spelling or declare it with a #let statement.".into())
                    }
                } else if msg.contains("unexpected closing delimiter") || msg.contains("unclosed delimiter") {
                    Some("Unclosed or mismatched delimiter. Check matching parentheses (), brackets [], or braces {}.".into())
                } else {
                    Some("Review Typst syntax or function arguments.".into())
                };

                errors.push(DiagnosticItem {
                    severity: "error".into(),
                    message: msg,
                    line,
                    file: main_file.map(|s| s.to_string()),
                    suggestion,
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
            });
        }
    }

    (errors, raw_log)
}
