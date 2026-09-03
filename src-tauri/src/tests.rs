use std::io::Read;
use std::path::Path;

use crate::compiler::latex::compile_latex_to_pdf;
use crate::compiler::typst::compile_typst_to_pdf;
use crate::compiler::embedded::get_embedded_package_file;
use crate::diagnostics::suggestions::get_smart_suggestion;
use crate::diagnostics::latex_parser::prepare_latex_source;
use crate::exporters::markdown::{latex_to_markdown, typst_to_markdown, latex_to_markdown_with_dir, typst_to_markdown_with_dir};
use crate::exporters::html::{latex_to_html, typst_to_html, latex_to_html_with_dir, typst_to_html_with_dir};
use crate::fs::archive::{export_project_to_zip, import_project_from_zip};
use crate::fs::project::validate_recent_paths;

#[test]
fn test_compile_typst_with_fonts() {
    let typst_code = r#"
    #set page(paper: "a4")
    #set text(font: ("DejaVu Sans", "Libertinus Serif"), size: 11pt)
    = Test Document
    Testing Typst compilation with system font discovery.
    $ E = m c^2 $
    "#;
    let resp = compile_typst_to_pdf(typst_code, None, None);
    assert!(resp.success, "Typst compilation failed: {:?}", resp.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert!(!resp.pdf_bytes.is_empty(), "PDF bytes should not be empty");
}

#[test]
fn test_unknown_font_diagnostic_suggestion() {
    let typst_code = r#"
    #set text(font: "Roboto")
    Hello world
    "#;
    let resp = compile_typst_to_pdf(typst_code, None, None);
    if !resp.success {
        let error = resp.errors.iter().find(|e| e.message.contains("unknown font family"));
        assert!(error.is_some());
        let err_item = error.unwrap();
        let suggestion = err_item.suggestion.as_ref().unwrap();
        #[cfg(target_os = "linux")]
        assert!(suggestion.contains("sudo apt install fonts-roboto"));
        assert!(suggestion.contains("Libertinus Serif"));
        assert!(suggestion.contains("Font 'roboto' is not installed"));
    }
}

#[test]
fn test_equation_numbering_diagnostic_suggestion() {
    let typst_code = r#"
    $ E = m c^2 $ <eq:energy>
    According to @eq:energy, energy equals mass times c squared.
    "#;
    let resp = compile_typst_to_pdf(typst_code, None, None);
    assert!(!resp.success);
    let error = resp.errors.iter().find(|e| e.message.contains("cannot reference equation without numbering"));
    assert!(error.is_some());
    let suggestion = error.unwrap().suggestion.as_ref().unwrap();
    assert!(suggestion.contains("set math.equation(numbering: \"(1)\")"));
}

#[test]
fn test_latex_bibtex_with_filesystem_root() {
    let temp_dir = std::env::temp_dir().join(format!("test_latex_bib_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::create_dir_all(&temp_dir);

    let bib_content = r#"@article{einstein1905,
  author = {Albert Einstein},
  title = {Zur Elektrodynamik bewegter Korper},
  journal = {Annalen der Physik},
  volume = {322},
  year = {1905}
}"#;
    let _ = std::fs::write(temp_dir.join("refs.bib"), bib_content);

    let latex_code = r#"\documentclass{article}
\begin{document}
Einstein's 1905 paper \cite{einstein1905}.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}"#;

    let resp = compile_latex_to_pdf(latex_code, temp_dir.to_str(), Some("main.tex"));
    let _ = std::fs::remove_dir_all(&temp_dir);

    assert!(resp.success, "LaTeX BibTeX compilation failed: {:?}", resp.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert!(!resp.pdf_bytes.is_empty(), "PDF bytes should not be empty");
}

#[test]
fn test_typst_bibtex_multi_file() {
    let temp_dir = std::env::temp_dir().join(format!("test_typst_bib_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::create_dir_all(&temp_dir);

    let bib_content = r#"@article{einstein1905,
  author = {Albert Einstein},
  title = {Zur Elektrodynamik bewegter Korper},
  journal = {Annalen der Physik},
  volume = {322},
  year = {1905}
}"#;
    let _ = std::fs::write(temp_dir.join("refs.bib"), bib_content);

    let typst_code = r#"
    According to Einstein @einstein1905, physics was revolutionized.
    #bibliography("refs.bib")
    "#;

    let resp = compile_typst_to_pdf(typst_code, temp_dir.to_str(), Some("main.typ"));
    let _ = std::fs::remove_dir_all(&temp_dir);

    assert!(resp.success, "Typst BibTeX compilation failed: {:?}", resp.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert!(!resp.pdf_bytes.is_empty(), "PDF bytes should not be empty");
}

#[test]
fn test_option_clash_smart_suggestion() {
    let msg = "! LaTeX Error: Option clash for package xcolor.";
    let suggestion = get_smart_suggestion(msg);
    assert!(suggestion.is_some());
    let tip = suggestion.unwrap();
    assert!(tip.contains("xcolor"));
    assert!(tip.contains("\\PassOptionsToPackage"));
}

#[test]
fn test_missing_asset_smart_suggestion() {
    let msg = "! Unable to load picture or PDF file 'figures_pdf/carview.pdf'.";
    let suggestion = get_smart_suggestion(msg);
    assert!(suggestion.is_some());
    let tip = suggestion.unwrap();
    assert!(tip.contains("figures_pdf/carview.pdf"));
}

#[test]
fn test_missing_simpleicons_smart_suggestion() {
    let msg = "! LaTeX Error: File `simpleicons.sty' not found.";
    let suggestion = get_smart_suggestion(msg);
    assert!(suggestion.is_some());
    let tip = suggestion.unwrap();
    assert!(tip.contains("simpleicons.sty"));
}

#[test]
fn test_missing_package_smart_suggestion() {
    let msg = "! LaTeX Error: File `tabularray.sty' not found.";
    let suggestion = get_smart_suggestion(msg);
    assert!(suggestion.is_some());
    let tip = suggestion.unwrap();
    assert!(tip.contains("tabularray.sty"));
}

#[test]
fn test_missing_class_smart_suggestion() {
    let msg = "! LaTeX Error: File `customreport.cls' not found.";
    let suggestion = get_smart_suggestion(msg);
    assert!(suggestion.is_some());
    let tip = suggestion.unwrap();
    assert!(tip.contains("customreport.cls"));
}

#[test]
fn test_missing_font_smart_suggestion() {
    let msg = "! Package fontspec Error: The font \"CustomFont-Bold\" cannot be found.";
    let suggestion = get_smart_suggestion(msg);
    assert!(suggestion.is_some());
    let tip = suggestion.unwrap();
    assert!(tip.contains("CustomFont-Bold"));
    assert!(tip.contains("XeTeX"));
}

#[test]
fn test_undefined_environment_smart_suggestion() {
    let msg = "! LaTeX Error: Environment customblock undefined.";
    let suggestion = get_smart_suggestion(msg);
    assert!(suggestion.is_some());
    let tip = suggestion.unwrap();
    assert!(tip.contains("customblock"));
    assert!(tip.contains("\\begin{customblock}"));
}

#[test]
fn test_undefined_reference_smart_suggestion() {
    let msg = "LaTeX Warning: Reference `sec:experiments' on page 3 undefined on input line 55.";
    let suggestion = get_smart_suggestion(msg);
    assert!(suggestion.is_some());
    let tip = suggestion.unwrap();
    assert!(tip.contains("sec:experiments"));
    assert!(tip.contains("\\label{sec:experiments}"));
}

#[test]
fn test_undefined_citation_smart_suggestion() {
    let msg = "LaTeX Warning: Citation `vaswani2017' on page 2 undefined on input line 40.";
    let suggestion = get_smart_suggestion(msg);
    assert!(suggestion.is_some());
    let tip = suggestion.unwrap();
    assert!(tip.contains("vaswani2017"));
    assert!(tip.contains(".bib"));
}

#[test]
fn test_mismatched_environment_smart_suggestion() {
    let msg = "! LaTeX Error: \\begin{itemize} on input line 10 ended by \\end{enumerate}.";
    let suggestion = get_smart_suggestion(msg);
    assert!(suggestion.is_some());
    let tip = suggestion.unwrap();
    assert!(tip.contains("itemize"));
    assert!(tip.contains("enumerate"));
}

#[test]
fn test_prepare_latex_source_biblatex_backend() {
    let raw = r#"\documentclass{article}
\usepackage{biblatex}
\begin{document}
Test
\end{document}"#;
    let (processed, prepended, _) = prepare_latex_source(raw);
    assert!(processed.contains("\\PassOptionsToPackage{backend=bibtex}{biblatex}"));
    assert_eq!(prepended, 2); // 1 tracing guard line + 1 pass options line
}

#[test]
fn test_float_specifier_smart_suggestion() {
    let msg = "LaTeX Warning: `h' float specifier changed to `ht'.";
    let suggestion = get_smart_suggestion(msg);
    assert!(suggestion.is_some());
    let tip = suggestion.unwrap();
    assert!(tip.contains("htbp"));
}

#[test]
fn test_prepare_latex_source_xcolor_and_font() {
    let raw = r#"\documentclass[conference]{IEEEtran}
\usepackage{tikz}
\usepackage[dvipsnames]{xcolor}
\begin{document}
Hello World
\end{document}
"#;
    let (processed, prepended, inserted) = prepare_latex_source(raw);
    assert!(processed.contains("\\PassOptionsToPackage{dvipsnames}{xcolor}\n"));
    assert!(processed.contains("\\usepackage[T1]{fontenc}\n"));
    assert_eq!(prepended, 2); // 1 tracing guard line + 1 pass options line
    assert_eq!(inserted, 1);
}

#[test]
fn test_embedded_package_simpleicons_files() {
    assert!(get_embedded_package_file("simpleicons.sty").is_some());
    assert!(get_embedded_package_file("simpleiconsglyphs-xeluatex.tex").is_some());
    assert!(get_embedded_package_file("SimpleIcons.otf").is_some());
    assert!(get_embedded_package_file("simpleicons.otf").is_some());
}

#[test]
fn test_import_project_from_zip() {
    let zip_path = "/home/mauri/Desktop/overleaf example/RDMO.zip";
    if !Path::new(zip_path).exists() {
        return;
    }
    let temp_parent = std::env::temp_dir().join(format!("test_zip_import_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::create_dir_all(&temp_parent);

    let res = import_project_from_zip(
        zip_path,
        temp_parent.to_str().unwrap(),
        Some("MyImportedTest"),
    );

    assert!(res.is_ok(), "Import failed: {:?}", res.err());
    let imported_dir = res.unwrap();
    let path = Path::new(&imported_dir);
    assert!(path.join("main.tex").exists(), "main.tex missing from imported project");
    assert!(path.join(".sciencebatch.json").exists(), ".sciencebatch.json missing from imported project");

    let config_str = std::fs::read_to_string(path.join(".sciencebatch.json")).unwrap();
    assert!(config_str.contains("\"engine\": \"latex\""));
    assert!(config_str.contains("\"mainFile\": \"main.tex\""));

    let _ = std::fs::remove_dir_all(&temp_parent);
}

#[test]
fn test_export_complex_paper_to_markdown_and_html() {
    let zip_path = "/home/mauri/Desktop/overleaf example/RDMO.zip";
    if !Path::new(zip_path).exists() {
        return;
    }
    let file = std::fs::File::open(zip_path).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let mut main_entry = archive.by_name("main.tex").unwrap();
    let mut content = String::new();
    main_entry.read_to_string(&mut content).unwrap();

    let md = latex_to_markdown(&content);
    assert!(!md.is_empty());
    assert!(md.contains("#"));

    let html = latex_to_html(&content, "RDMO Paper");
    assert!(!html.is_empty());
    assert!(html.contains("<!DOCTYPE html>"));
    assert!(html.contains("katex.min.css"));
}

#[test]
fn test_latex_to_markdown() {
    let latex = r#"\documentclass{article}
\title{Sample Paper}
\author{John Doe}
\begin{document}
\section{Introduction}
This is \textbf{bold text} and \textit{italic text}.
Here is inline math: $E = m c^2$.

\begin{equation}
\int_{0}^{1} x^2 dx = \frac{1}{3}
\end{equation}

\begin{itemize}
\item First point
\item Second point with \texttt{code}
\end{itemize}

\end{document}
"#;
    let md = latex_to_markdown(latex);
    assert!(md.contains("# Sample Paper"));
    assert!(md.contains("**Author:** John Doe"));
    assert!(md.contains("# Introduction"));
    assert!(md.contains("**bold text**"));
    assert!(md.contains("*italic text*"));
    assert!(md.contains("$E = m c^2$"));
    assert!(md.contains("$$\n\\int_{0}^{1} x^2 dx = \\frac{1}{3}\n$$"));
    assert!(md.contains("- First point"));
    assert!(md.contains("- Second point with `code`"));
}

#[test]
fn test_typst_to_markdown() {
    let typst = r#"
#set page(paper: "a4")
= Introduction to Typst
This is a list:
- First item
- Second item
Block equation:
$ a^2 + b^2 = c^2 $
"#;
    let md = typst_to_markdown(typst);
    assert!(md.contains("# Introduction to Typst"));
    assert!(md.contains("- First item"));
    assert!(md.contains("- Second item"));
    assert!(md.contains("$$\na^2 + b^2 = c^2\n$$"));
    assert!(!md.contains("#set page"));
}

#[test]
fn test_latex_to_html() {
    let latex = r#"\documentclass{article}
\title{HTML Export Test}
\begin{document}
\section{Welcome}
Formula: $x + y = z$.
\end{document}
"#;
    let html = latex_to_html(latex, "HTML Export Test");
    assert!(html.contains("<!DOCTYPE html>"));
    assert!(html.contains("katex.min.js"));
    assert!(html.contains("<h1>HTML Export Test</h1>") || html.contains("<h1>Welcome</h1>"));
    assert!(html.contains("$x + y = z$"));
}

#[test]
fn test_latex_table_and_academic_env_export() {
    let latex = r#"\documentclass{article}
\title{Table and Environments}
\begin{document}
\begin{abstract}
This is a summary of the work.
\end{abstract}
\section{Main Section}\label{sec:main}
\begin{table}[h!]
\centering
\caption{Benchmark Results}\label{tab:bench}
\begin{tabular}{|l|c|r|}
\hline
Model & Accuracy & F1 \\
\hline
Baseline & 85\% & 0.84 \\
Proposed & 92\% & 0.91 \\
\hline
\end{tabular}
\end{table}
Equation:
\begin{equation}\label{eq:sample}
y = f(x)
\end{equation}
Refer to Section~\ref{sec:main} and Table~\ref{tab:bench}.
\end{document}
"#;
    let md = latex_to_markdown(latex);
    // Verify label is not leaked into headings, captions, or math blocks
    assert!(!md.contains("Main Sectionsec:main"), "Label leaked into heading:\n{}", md);
    assert!(!md.contains("Results*tab:bench"), "Label leaked into caption:\n{}", md);
    assert!(!md.contains("$$ eq:sample"), "Label leaked into math block:\n{}", md);
    assert!(!md.contains("\\label"));
    assert!(md.contains("Refer to Section [@sec:main] and Table [@tab:bench]."));

    // Verify abstract converted to blockquote
    assert!(md.contains("> **Abstract**"));
    assert!(md.contains("This is a summary of the work."));

    // Verify table conversion to GFM
    assert!(md.contains("| Model | Accuracy | F1 |"));
    assert!(md.contains("| --- | --- | --- |"));
    assert!(md.contains("| Baseline | 85% | 0.84 |"));
    assert!(md.contains("| Proposed | 92% | 0.91 |"));

    // Verify HTML export
    let html = latex_to_html(latex, "Table Test");
    assert!(html.contains("<table class=\"latex-table\">"));
    assert!(html.contains("<th>Model</th>"));
    assert!(html.contains("<td>Baseline</td>"));
    assert!(html.contains("<blockquote>"));
    assert!(!html.contains("Main Sectionsec:main"));
}

#[test]
fn test_typst_to_html_and_table_export() {
    let typst = r#"
#set document(title: "Typst Export Test", author: "Jane Doe")
= Overview
Here is a table:
#table(
  columns: 2,
  [Parameter], [Value],
  [Learning Rate], [0.001],
  [Epochs], [50],
)

Math formulation:
$ bold(v) = (dif bold(x)) / (dif t) $
"#;
    let md = typst_to_markdown(typst);
    assert!(md.contains("# Typst Export Test"));
    assert!(md.contains("**Author:** Jane Doe"));
    assert!(md.contains("| Parameter | Value |"));
    assert!(md.contains("| Learning Rate | 0.001 |"));
    assert!(md.contains("\\mathbf{v} = \\frac{\\mathrm{d} \\mathbf{x}}{\\mathrm{d} t}"));

    let html = typst_to_html(typst, "Typst Export Test");
    assert!(html.contains("<!DOCTYPE html>"));
    assert!(html.contains("katex.min.js"));
    assert!(html.contains("<table class=\"latex-table\">"));
    assert!(html.contains("<th>Parameter</th>"));
    assert!(html.contains("<td>Learning Rate</td>"));
    assert!(html.contains("<td>0.001</td>"));
}

#[test]
fn test_multi_file_latex_and_typst_export() {
    let temp_dir = std::env::temp_dir().join(format!("test_multifile_exp_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::create_dir_all(&temp_dir);

    // LaTeX subfile
    let sub_tex = r#"\section{Sub Chapter}
Content from sub chapter.
"#;
    let _ = std::fs::write(temp_dir.join("sub.tex"), sub_tex);

    let main_tex = r#"\documentclass{article}
\title{Main Doc}
\begin{document}
\input{sub.tex}
\end{document}
"#;
    let md_tex = latex_to_markdown_with_dir(main_tex, Some(&temp_dir));
    assert!(md_tex.contains("# Sub Chapter"));
    assert!(md_tex.contains("Content from sub chapter."));

    let html_tex = latex_to_html_with_dir(main_tex, "Main Doc", Some(&temp_dir));
    assert!(html_tex.contains("Sub Chapter"));
    assert!(html_tex.contains("Content from sub chapter."));

    // Typst subfile
    let sub_typ = r#"== Typst Sub Section
Content from Typst subfile.
"#;
    let _ = std::fs::write(temp_dir.join("sub.typ"), sub_typ);

    let main_typ = r#"
= Typst Main
#include "sub.typ"
"#;
    let md_typ = typst_to_markdown_with_dir(main_typ, Some(&temp_dir));
    assert!(md_typ.contains("## Typst Sub Section"));
    assert!(md_typ.contains("Content from Typst subfile."));

    let html_typ = typst_to_html_with_dir(main_typ, "Typst Main", Some(&temp_dir));
    assert!(html_typ.contains("Typst Sub Section"));
    assert!(html_typ.contains("Content from Typst subfile."));

    let _ = std::fs::remove_dir_all(&temp_dir);
}


#[test]
fn test_export_project_to_zip() {
    let temp_dir = std::env::temp_dir().join(format!("test_zip_export_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::create_dir_all(&temp_dir);
    let _ = std::fs::write(temp_dir.join("main.tex"), "\\documentclass{article}\n\\begin{document}Hello\\end{document}");
    let _ = std::fs::write(temp_dir.join(".sciencebatch.json"), "{\"name\":\"Test\"}");

    let dest_zip = temp_dir.join("export.zip");
    let res = export_project_to_zip(
        dest_zip.to_str().unwrap(),
        Some(temp_dir.to_str().unwrap()),
        None,
        Some("latex"),
    );

    assert!(res.is_ok(), "Export to zip failed: {:?}", res.err());
    assert!(dest_zip.exists(), "Target zip was not created");

    // Verify entries inside the zip
    let zip_file = std::fs::File::open(&dest_zip).unwrap();
    let mut archive = zip::ZipArchive::new(zip_file).unwrap();
    let mut file_names = Vec::new();
    for i in 0..archive.len() {
        file_names.push(archive.by_index(i).unwrap().name().to_string());
    }
    assert!(file_names.contains(&"main.tex".to_string()));
    assert!(!file_names.contains(&".sciencebatch.json".to_string()), ".sciencebatch.json must never be included in exported ZIP");
    // Ensure the zip file itself wasn't recursively included
    assert!(!file_names.contains(&"export.zip".to_string()));

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_usepackage_before_documentclass_suggestion() {
    let msg = "! LaTeX Error: \\usepackage before \\documentclass.";
    let suggestion = get_smart_suggestion(msg);
    assert!(suggestion.is_some());
    let tip = suggestion.unwrap();
    assert!(tip.contains("preamble"));
    assert!(tip.contains("\\documentclass"));
}

#[test]
fn test_validate_recent_paths() {
    let current_dir = std::env::current_dir().unwrap().to_string_lossy().to_string();
    let fake_dir = "/path/that/definitely/does/not/exist/99999".to_string();
    let valid = validate_recent_paths(vec![current_dir.clone(), fake_dir]);
    assert_eq!(valid, vec![current_dir]);
}

#[test]
fn test_latex_multi_file_diagnostics_origin() {
    let temp_dir = std::env::temp_dir().join(format!("test_multifile_diag_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::create_dir_all(&temp_dir);

    let sub_content = r#"Hello from subfile!
\PackageWarning{mysubpkg}{This is a warning inside subfile on input line 2}
"#;
    let _ = std::fs::write(temp_dir.join("sub.tex"), sub_content);

    let main_content = r#"\documentclass{article}
\begin{document}
\input{sub.tex}
\end{document}"#;

    let resp = compile_latex_to_pdf(main_content, temp_dir.to_str(), Some("main.tex"));
    let _ = std::fs::remove_dir_all(&temp_dir);

    assert!(resp.success, "Compilation should succeed");
    assert!(!resp.warnings.is_empty(), "Should have emitted the subfile warning");
    let warn = resp.warnings.iter().find(|w| w.message.contains("This is a warning inside subfile")).unwrap();
    assert_eq!(warn.file.as_deref(), Some("sub.tex"), "Warning file must be sub.tex, got: {:?}", warn.file);
}

#[test]
fn test_default_latex_source_compilation_and_export() {
    let latex = r#"\documentclass[12pt,a4paper]{article}
\usepackage{amsmath,amssymb,amsfonts,amsthm}
\usepackage{geometry}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{hyperref}
\geometry{margin=2.5cm}
\newtheorem{theorem}{Theorem}[section]
\title{\textbf{ScienceBatch Showcase \& Technical Tutorial}}
\author{Research Group}
\date{\today}
\begin{document}
\maketitle
\begin{abstract}
Test abstract for showcase.
\end{abstract}
\section{Introduction}\label{sec:intro}
Welcome to ScienceBatch.
\subsection{Pipeline}\label{subsec:pipe}
In-memory compilation.
\subsubsection{Worker}\label{subsubsec:work}
Isolated worker.
\section{Equations}\label{sec:math}
\begin{equation}\label{eq:einstein}
E = m c^2
\end{equation}
\begin{align}\label{eq:maxwell}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0}
\end{align}
\section{Tables}\label{sec:tables}
\begin{table}[htbp]
\centering
\caption{Engines Comparison}\label{tab:benchmarks}
\begin{tabular}{lcr}
\toprule
Metric & LaTeX & Typst \\
\midrule
Speed & Fast & Instant \\
\bottomrule
\end{tabular}
\end{table}
\section{Figures}\label{sec:figures}
\begin{figure}[htbp]
\centering
\includegraphics[width=0.7\textwidth]{assets/sample.png}
\caption{ScienceBatch Architecture}\label{fig:banner}
\end{figure}
\end{document}
"#;

    // Compile in RAM VFS without project dir
    let resp = compile_latex_to_pdf(latex, None, None);
    assert!(resp.success, "LaTeX showcase compilation failed: {:?}", resp.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert!(!resp.pdf_bytes.is_empty(), "PDF bytes should not be empty");

    // Export to Markdown
    let md = latex_to_markdown(latex);
    assert!(md.contains("# ScienceBatch Showcase & Technical Tutorial"));
    assert!(md.contains("## Introduction"));
    assert!(md.contains("### Pipeline"));
    assert!(md.contains("#### Worker"));
    assert!(md.contains("| Metric | LaTeX | Typst |"));
    assert!(md.contains("![ScienceBatch Architecture](assets/sample.png)"));
    assert!(!md.contains("\\label"));

    // Export to HTML
    let html = latex_to_html(latex, "Showcase");
    assert!(html.contains("<!DOCTYPE html>"));
    assert!(html.contains("katex.min.js"));
    assert!(html.contains("<table class=\"latex-table\">"));
    assert!(html.contains("<figure><img src=\"assets/sample.png\" alt=\"ScienceBatch Architecture\">"));
}

#[test]
fn test_default_typst_source_compilation_and_export() {
    let typst = r#"#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm))
#set text(font: ("DejaVu Sans", "Libertinus Serif"), size: 11pt, lang: "en")
#set math.equation(numbering: "(1)")
#set heading(numbering: "1.1")

#align(center)[
  #text(20pt, weight: "bold")[ScienceBatch Showcase & Technical Tutorial] \
  #text(10pt, style: "italic")[Research Group]
]

= Introduction <sec:intro>
Typst typesetting.

== Pipeline <subsec:pipe>
In-memory compilation.

=== Worker <subsubsec:work>
Isolated worker.

= Equations <sec:math>
$ E = m c^2 $ <eq:einstein>

$ mat(x'; y') = mat(cos theta, -sin theta; sin theta, cos theta) mat(x; y) $ <eq:rotation>

= Tables <sec:tables>
#figure(
  table(
    columns: (auto, auto),
    [*Metric*], [*Speed*],
    [LaTeX], [Fast],
    [Typst], [Instant],
  ),
  caption: [Engines Comparison],
) <tab:benchmarks>

= Figures <sec:figures>
#figure(
  image("assets/sample.png", width: 70%),
  caption: [ScienceBatch Architecture],
) <fig:banner>

#figure(
  image("assets/sample.gif", width: 25%),
  caption: [Dynamic Live Pulse Asset],
) <fig:anim>
"#;

    // Compile in RAM VFS without project dir
    let resp = compile_typst_to_pdf(typst, None, None);
    assert!(resp.success, "Typst showcase compilation failed: {:?}", resp.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert!(!resp.pdf_bytes.is_empty(), "PDF bytes should not be empty");

    // Export to Markdown
    let md = typst_to_markdown(typst);
    assert!(md.contains("# ScienceBatch Showcase & Technical Tutorial"));
    assert!(md.contains("# Introduction"));
    assert!(md.contains("## Pipeline"));
    assert!(md.contains("### Worker"));
    assert!(md.contains("| **Metric** | **Speed** |"));
    assert!(md.contains("![ScienceBatch Architecture](assets/sample.png)"));
    assert!(md.contains("![Dynamic Live Pulse Asset](assets/sample.gif)"));

    // Export to HTML
    let html = typst_to_html(typst, "Showcase");
    assert!(html.contains("<!DOCTYPE html>"));
    assert!(html.contains("katex.min.js"));
    assert!(html.contains("<table class=\"latex-table\">"));
    assert!(html.contains("<figure><img src=\"assets/sample.png\" alt=\"ScienceBatch Architecture\">"));
    assert!(html.contains("<figure><img src=\"assets/sample.gif\" alt=\"Dynamic Live Pulse Asset\">"));
}

#[test]
fn test_showcase_typst_zero_errors_compilation() {
    let typst_source = r##"#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm))
#set text(font: ("DejaVu Sans", "Libertinus Serif"), size: 11pt, lang: "en")
#set par(justify: true)
#set math.equation(numbering: "(1)")
#set heading(numbering: "1.1")

#align(center)[
  #text(20pt, weight: "bold")[ScienceBatch Showcase & Technical Tutorial] \
  #v(0.4em)
  #text(12pt, fill: rgb("#2563eb"), weight: "medium")[Native Dual Studio: Tectonic LaTeX & Rust Typst] \
  #v(0.3em)
  #text(10pt, style: "italic")[ScienceBatch Research Group — Department of Computer Science and Applied Mathematics]
]

#v(1em)

#rect(width: 100%, stroke: 0.5pt + rgb("#cbd5e1"), radius: 4pt, fill: rgb("#f8fafc"), inset: 12pt)[
  #text(weight: "bold", fill: rgb("#0f172a"))[Abstract] \
  #v(0.3em)
  This document serves as both an interactive test suite and an architectural tutorial for *ScienceBatch*. Powered by the _Tectonic_ XeTeX in-memory engine and Rust-native _Typst_, ScienceBatch executes 100% offline typesetting directly in RAM VFS without disk pollution. This showcase demonstrates section hierarchies (H1--H3), single and multi-line equations, matrix algebra, formal theorems, publication-grade tables, graphics, dynamic assets, code listings, and automated BibTeX citations.
]

#v(1em)

= Introduction & System Architecture <sec:intro>
Typst is a next-generation markup-based typesetting system designed in Rust. It combines the mathematical expressiveness of LaTeX with concise, intuitive syntax and ultra-fast in-memory compilation (< 50 ms).

== Compilation Pipeline <subsec:pipeline>
In *ScienceBatch*, compilation is triggered on-demand via the global keyboard shortcut `Ctrl + S` (or `Cmd + S` on macOS) or the *Compile* button in the primary toolbar. Rather than writing intermediate auxiliary files to disk, ScienceBatch compiles source directly in RAM and renders PDF pages on hardware-accelerated canvas elements.

=== Isolated Worker Subprocess <subsubsec:worker>
To prevent malformed markup from freezing the application UI, compilation is executed in an isolated child worker subprocess communicating via asynchronous IPC pipes.

= Mathematical Physics & Advanced Equations <sec:math>
Mathematical expressions are written naturally using dollar delimiters. Inline equations include Euler's identity $e^(i pi) + 1 = 0$, Gaussian integrals $integral_(-oo)^oo e^(-x^2) dif x = sqrt(pi)$, and the fundamental limit $lim_(x -> 0) (sin x) / x = 1$.

== Numbered Display Equations <subsec:equations>
Display equations with automated numbering and labels are declared with dollar signs and label tags:

$ E = m c^2 $ <eq:einstein>

== Aligned Multi-Line Field Equations <subsec:maxwell>
Electrodynamic field equations illustrate multi-line systems with individual cross-references:

$ nabla dot bold(E) = rho / epsilon_0 $ <eq:maxwell-gauss>
$ nabla times bold(E) = - (partial bold(B)) / (partial t) $ <eq:maxwell-faraday>
$ nabla dot bold(B) = 0 $ <eq:maxwell-mag>
$ nabla times bold(B) = mu_0 bold(J) + mu_0 epsilon_0 (partial bold(E)) / (partial t) $ <eq:maxwell-ampere>

== Linear Algebra & Coordinate Rotations <subsec:algebra>
Planar coordinate transformations and linear operators are declared using matrix syntax:

$ mat(x'; y') = mat(cos theta, -sin theta; sin theta, cos theta) mat(x; y) $ <eq:rotation>

== Formal Theorems & Proofs <subsec:theorems>
Academic callout blocks and theorems are rendered cleanly:

#rect(width: 100%, stroke: 0.5pt + rgb("#3b82f6"), radius: 4pt, fill: rgb("#eff6ff"), inset: 10pt)[
  #text(weight: "bold", fill: rgb("#1d4ed8"))[Theorem 1 (Fundamental Theorem of Calculus)] \
  Let $f: [a, b] -> RR$ be a continuous real-valued function, and let $F$ be an antiderivative of $f$ on $[a, b]$. Then:
  $ integral_a^b f(x) dif x = F(b) - F(a) $ <eq:ftc>
]

= Structured Tabular Data & Benchmarks <sec:tables>
Typst allows constructing clean, publication-ready tabular data declaratively with cell-level customization:

#figure(
  table(
    columns: (auto, auto, auto, auto, 1fr),
    fill: (col, row) => if row == 0 { rgb("#3b82f6").lighten(85%) } else if calc.odd(row) { rgb("#f8fafc") } else { none },
    stroke: 0.5pt + rgb("#cbd5e1"),
    [*Feature*], [*LaTeX (Tectonic)*], [*Typst (Rust)*], [*ScienceBatch VFS*], [*Speedup*],
    [Compilation Engine], [XeTeX RAM VFS], [Native Rust Engine], [Zero Disk I/O], [10x],
    [Cold Start Latency], [< 1.2 s], [< 0.05 s], [In-Memory Bundle], [Instant],
    [Mathematical Syntax], [TeX Macro System], [Modern Declarative], [Unified Preview], [Dynamic],
    [Graphics Support], [PNG, JPEG, PDF], [PNG, SVG, GIF], [Base64 Inlined], [Seamless],
    [Multi-File Resolver], [`\input`, `\include`], [`#include`], [Relative Resolver], [Automatic],
  ),
  caption: [Comprehensive comparison between typesetting engines in ScienceBatch.],
) <tab:benchmarks>

= Graphics, Figures, and Multimedia Assets <sec:figures>
Figures with captions and automatic numbering are declared using the `#figure` function:

#figure(
  image("assets/sample.png", width: 70%),
  caption: [ScienceBatch Studio: high-performance desktop typesetting architecture and dual engine pipeline.],
) <fig:banner>

== Dynamic Multimedia & Web Export <subsec:multimedia>
In desktop PDF documents, Typst captures the visual asset directly into vector/raster PDF streams. When exporting to standalone HTML documents, animated assets such as `assets/sample.gif` are embedded as base64 data URIs and animate live in web browsers:

#figure(
  image("assets/sample.gif", width: 25%),
  caption: [Live dynamic pulse asset. Renders animated in HTML export and file viewer, static first frame in PDF.],
) <fig:anim>

= Source Code Listings <sec:code>
Source code snippets are formatted with raw code blocks:

```rust
// Typst in-memory compilation through native typst-embed
let project = typst_embed::Project::builder("main.typ")
    .source_file("main.typ", typst_source)
    .build()?;
```

= Lists and Feature Highlights <sec:lists>
Features are structured using nested unordered and ordered lists:
- *Zero Configuration Setup:*
  + Embedded TeX package bundle handles core packages automatically.
  + Automatic BibTeX and font discovery.
- *Multi-Target Document Export:*
  - Standalone HTML with KaTeX and responsive CSS tables.
  - GitHub Flavored Markdown (GFM) with preserved math and clean headers.

= Citations and Bibliographic References <sec:citations>
Citations link directly to the project's `references.bib` file. Relativistic physics was revolutionized by Einstein @einstein1905.
Cross-referencing ties the paper together: @sec:math formulates @eq:einstein, @sec:tables details @tab:benchmarks, and @sec:figures showcases @fig:banner and @fig:anim.

#bibliography("references.bib")
"##;

    let resp = compile_typst_to_pdf(typst_source, None, None);
    assert!(resp.success, "Typst compilation failed: {:?}", resp.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert!(resp.errors.is_empty(), "Expected 0 errors, got: {:?}", resp.errors);
    assert!(!resp.pdf_bytes.is_empty(), "PDF bytes must not be empty");
}

#[test]
fn test_showcase_latex_zero_warnings_compilation() {
    let latex_source = r#"\documentclass[12pt,a4paper]{article}
\usepackage{amsmath,amssymb,amsfonts,amsthm}
\usepackage{geometry}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{hyperref}

\geometry{margin=2.5cm}

\title{\textbf{ScienceBatch Showcase \& Technical Tutorial}}
\author{\textbf{ScienceBatch Research Group}}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
\label{sec:intro}

Single-line equations are declared with the \texttt{equation} environment and cross-referenced with \texttt{\textbackslash eqref\{...\}}, as demonstrated in Einstein's mass-energy equivalence in Eq.~\eqref{eq:einstein}:

\begin{equation}
\label{eq:einstein}
E = m c^2
\end{equation}

\section{Structured Tabular Data}
\label{sec:tables}

Table~\ref{tab:benchmarks} summarizes key metrics:

\begin{table}[htbp]
\centering
\caption{Comparison}
\label{tab:benchmarks}
\begin{tabular}{lcccr}
\toprule
\textbf{Feature} & \textbf{LaTeX} & \textbf{Typst} & \textbf{VFS} & \textbf{Speedup} \\
\midrule
Multi-File & \texttt{\textbackslash input} & \texttt{\#include} & Resolver & Auto \\
\bottomrule
\end{tabular}
\end{table}

\section{Figures}
\label{sec:figures}

\begin{figure}[htbp]
\centering
\includegraphics[width=0.7\textwidth]{assets/sample.png}
\caption{Architecture}
\label{fig:banner}
\end{figure}

\section{Citations}
\label{sec:citations}

Einstein revolutionized physics~\cite{einstein1905}.
References: Section~\ref{sec:intro}, Eq.~\eqref{eq:einstein}, Table~\ref{tab:benchmarks}, Fig.~\ref{fig:banner}.

\bibliographystyle{plain}
\bibliography{references}

\end{document}
"#;

    let resp = compile_latex_to_pdf(latex_source, None, None);
    assert!(resp.success, "LaTeX compilation failed: {:?}", resp.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert!(resp.errors.is_empty(), "Expected 0 errors, got: {:?}", resp.errors);
    let undefined_refs: Vec<_> = resp.warnings.iter()
        .filter(|w| w.message.to_lowercase().contains("undefined"))
        .collect();
    assert!(undefined_refs.is_empty(), "Expected no undefined reference warnings, got: {:?}", undefined_refs);
    assert!(!resp.pdf_bytes.is_empty(), "PDF bytes must not be empty");
}

#[test]
fn test_latex_export_with_spanish_accents_and_utf8() {
    let latex = r#"\documentclass{article}
\usepackage{amsmath}
\usepackage{graphicx}
\title{Guía Práctica de Física y Matemáticas}
\author{María José Núñez & Carlos Álvez}
\date{\today}
\begin{document}
\maketitle

\section{Introducción al Cálculo Diferencial}
\label{sec:calculo}
En esta sección analizamos la teoría de la relatividad y la electrodinámica clásica.
Como vimos en la ecuación~\eqref{eq:energia}:
\begin{equation}
\label{eq:energia}
E = m c^2
\end{equation}
La demostración matemática es sólida.

\begin{itemize}
    \item Primer análisis teórico.
    \item Verificación experimental en laboratorio.
\end{itemize}

\begin{figure}[htbp]
\centering
\includegraphics{assets/sample.png}
\caption{Diseño gráfico del módulo óptico}
\label{fig:optico}
\end{figure}

\end{document}
"#;

    let md = latex_to_markdown(latex);
    assert!(md.contains("## Introducción al Cálculo Diferencial"));
    assert!(md.contains("teoría de la relatividad"));
    assert!(md.contains("demostración matemática"));
    assert!(md.contains("$$"));
    assert!(md.contains("E = m c^2"));

    let html = latex_to_html(latex, "Guía Práctica");
    assert!(html.contains("<!DOCTYPE html>"));
    assert!(html.contains("Introducción al Cálculo Diferencial"));
    assert!(html.contains("demostración matemática"));
}

#[test]
fn test_typst_export_with_spanish_accents_and_utf8() {
    let typst = r#"
#set page(paper: "a4")
= Introducción y Demostración Práctica <sec:intro>
ScienceBatch — Grupo de Investigación en Ciencias Aplicadas.

En este artículo examinamos la hipótesis cuántica y la vibración armónica.
$ E = m c^2 $ <eq:energia>

Como se detalla en @sec:intro y @eq:energia, la formulación teórica es consistente.

#figure(
  image("assets/sample.png", width: 70%),
  caption: [Ilustración gráfica de simulación dinámica],
) <fig:sim>
"#;

    let md = typst_to_markdown(typst);
    assert!(md.contains("# Introducción y Demostración Práctica"));
    assert!(md.contains("hipótesis cuántica"));
    assert!(md.contains("vibración armónica"));
    assert!(md.contains("[@sec:intro]"));
    assert!(md.contains("[@eq:energia]"));

    let html = typst_to_html(typst, "Demostración Typst");
    assert!(html.contains("<!DOCTYPE html>"));
    assert!(html.contains("Introducción y Demostración Práctica"));
    assert!(html.contains("hipótesis cuántica"));
}

#[test]
fn test_open_external_url_security_validation() {
    use crate::commands::files::open_external_url;

    // Reject dangerous or unsupported schemes
    assert!(open_external_url("file:///etc/passwd".to_string()).is_err());
    assert!(open_external_url("javascript:alert(1)".to_string()).is_err());
    assert!(open_external_url("bash -c 'echo hacked'".to_string()).is_err());
    assert!(open_external_url("   ".to_string()).is_err());
}

#[tokio::test]
async fn test_compiler_manager_cancellation_and_generation_ids() {
    use crate::commands::compile::{CompilerManager, wait_for_cancellation};

    let manager = CompilerManager::new();
    let (id1, rx1) = manager.start_compilation();
    assert_eq!(id1, 1);
    assert!(!*rx1.borrow());

    // Starting second compilation should cancel first and increment id
    let (id2, rx2) = manager.start_compilation();
    assert_eq!(id2, 2);
    assert!(*rx1.borrow(), "Previous compilation must receive cancellation signal");
    assert!(!*rx2.borrow(), "New compilation must not be cancelled");

    // Test wait_for_cancellation helper finishes immediately for cancelled rx1
    wait_for_cancellation(rx1).await;

    // Explicit cancel_active on manager cancels second compilation
    manager.cancel_active();
    assert!(*rx2.borrow(), "Second compilation must receive cancellation signal");
    wait_for_cancellation(rx2).await;
}

#[test]
fn test_curve_cv_markdown_and_html_export() {
    let temp_dir = std::env::temp_dir().join(format!("test_curve_cv_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = std::fs::create_dir_all(&temp_dir);

    let edu_tex = r#"\begin{rubric}{Educación}
\entry*[2020 -- 2024]%
    \textbf{Doctorado en Ingeniería Industrial, Pontificia Universidad Católica de Valparaíso (PUCV), Chile.}
\entry*[2012 -- 2018]%
    \textbf{Licenciatura en Ingeniería Industrial, Universidad Católica Boliviana (UCB), Bolivia.}
\end{rubric}
"#;
    let _ = std::fs::write(temp_dir.join("education.tex"), edu_tex);

    let bib_content = r#"@article{paper2023,
  title={Advanced Optimization Algorithm},
  author={Figueroa-Torrez, Paulo and Dur{\'a}n, Orlando},
  journal={Mathematics},
  volume={11},
  number={16},
  pages={3475},
  year={2023}
}
"#;
    let _ = std::fs::write(temp_dir.join("own-bib.bib"), bib_content);

    // Dummy photo
    let _ = std::fs::write(temp_dir.join("photo.jpg"), b"fake image bytes");

    let main_tex = r#"\documentclass[a4paper,11pt]{curve}
\addbibresource{own-bib.bib}
\leftheader{%
  {\LARGE\bfseries Paulo Roberto Figueroa Torrez, Ph.D.}
  \makefield{\faEnvelopeO}{\href{mailto:paulo@example.com}{\texttt{paulo@example.com}}}
  \makefield{\faLinkedin}{\href{https://linkedin.com/in/paulo}{\texttt{Paulo Figueroa}}}
  \makefield{\faPhone}{\texttt{+591 70000000}}
}
\photo[r]{photo}
\title{Curriculum Vitae}

\begin{document}
\makeheaders[c]

Investigador en optimización y confiabilidad industrial.

\makerubric{education}

\makerubrichead{Publicaciones de investigación}
\printbibliography[heading={subbibliography},title={Artículos en revistas},type=article]

\begin{tabularx}{\textwidth}{@{}X X@{}}
\textbf{Prof X}\par
Professor\par
\makefield{\faEnvelopeO}{\url{prof.x@example.edu}}
&
\textbf{Prof Y}\par
Professor\par
\makefield{\faEnvelopeO}{\url{prof.y@example.edu}}
\\
\end{tabularx}

\end{document}
"#;

    let md = latex_to_markdown_with_dir(main_tex, Some(&temp_dir));
    assert!(md.contains("# Paulo Roberto Figueroa Torrez, Ph.D."));
    assert!(md.contains("![Photo](photo.jpg)"));
    assert!(md.contains("paulo@example.com"));
    assert!(md.contains("Investigador en optimización"));
    assert!(md.contains("## Educación"));
    assert!(md.contains("- **2020 – 2024:** **Doctorado en Ingeniería Industrial"));
    assert!(md.contains("## Publicaciones de investigación"));
    assert!(md.contains("### Artículos en revistas"));
    assert!(md.contains("Advanced Optimization Algorithm"));
    assert!(md.contains("Mathematics"));
    assert!(md.contains("| **Prof X**<br>Professor"));

    let html = latex_to_html_with_dir(main_tex, "CV Document", Some(&temp_dir));
    assert!(html.contains("<!DOCTYPE html>"));
    assert!(html.contains("Paulo Roberto Figueroa Torrez, Ph.D."));
    assert!(html.contains("figure class=\"profile-photo\""));
    assert!(html.contains("data:image/jpeg;base64,"));
    assert!(html.contains("Educación"));
    assert!(html.contains("Doctorado en Ingeniería Industrial"));
    assert!(html.contains("Advanced Optimization Algorithm"));

    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_generate_and_save_overleaf_cv_deliverables() {
    let cv_dir = std::path::Path::new("/home/mauri/Desktop/overleaf example/CV");
    if !cv_dir.exists() {
        return;
    }
    let temp_dir = std::env::temp_dir().join("sb_cv_deliverable_gen");
    let _ = std::fs::remove_dir_all(&temp_dir);
    let _ = std::fs::create_dir_all(&temp_dir);

    let zip_path = cv_dir.join("CV_Chile_Paulo_Figueroa.zip");
    if let Ok(file) = std::fs::File::open(&zip_path) {
        let mut archive = zip::ZipArchive::new(file).unwrap();
        archive.extract(&temp_dir).unwrap();

        let main_tex_path = temp_dir.join("0_cv-llt.tex");
        let main_tex = std::fs::read_to_string(&main_tex_path).unwrap();

        let md = latex_to_markdown_with_dir(&main_tex, Some(&temp_dir));
        let html = latex_to_html_with_dir(&main_tex, "Curriculum Vitae - Paulo Roberto Figueroa Torrez", Some(&temp_dir));

        assert!(md.contains("# Paulo Roberto Figueroa Torrez, Ph.D."));
        assert!(md.contains("## Educación"));
        assert!(md.contains("## Historial de empleo"));
        assert!(md.contains("## Publicaciones de investigación"));
        assert!(md.contains("## Historial de docencia"));
        assert!(md.contains("## Referencias"));
        assert!(html.contains("Paulo Roberto Figueroa Torrez, Ph.D."));
        assert!(html.contains("data:image/jpeg;base64,"));

        // Ensure referenced image assets (1-2025_2.jpg, photo.jpg) are copied to the destination folder
        for img_name in &["1-2025_2.jpg", "photo.jpg"] {
            let src_img = temp_dir.join(img_name);
            if src_img.exists() {
                let _ = std::fs::copy(&src_img, cv_dir.join(img_name));
            }
        }

        std::fs::write(cv_dir.join("CV_Chile_Paulo_Figueroa.md"), &md).unwrap();
        std::fs::write(cv_dir.join("CV_Chile_Paulo_Figueroa.html"), &html).unwrap();

        assert!(cv_dir.join("1-2025_2.jpg").is_file());
        let img_meta = std::fs::metadata(cv_dir.join("1-2025_2.jpg")).unwrap();
        assert!(img_meta.len() > 0);

        // Verify that extract_markdown_image_paths discovers the referenced image
        let extracted_paths = crate::exporters::markdown::extract_markdown_image_paths(&md);
        assert!(extracted_paths.contains(&"1-2025_2.jpg".to_string()));

        // Verify that embed_local_images_as_base64_in_markdown produces standalone markdown with data URI
        let standalone_md = crate::exporters::markdown::embed_local_images_as_base64_in_markdown(&md, Some(&temp_dir));
        assert!(standalone_md.contains("![Photo](data:image/jpeg;base64,"));
    }
    let _ = std::fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn test_export_document_to_markdown_copies_referenced_images() {
    let temp_src = std::env::temp_dir().join("sb_test_export_src");
    let temp_dest = std::env::temp_dir().join("sb_test_export_dest");
    let _ = std::fs::remove_dir_all(&temp_src);
    let _ = std::fs::remove_dir_all(&temp_dest);
    std::fs::create_dir_all(&temp_src).unwrap();
    std::fs::create_dir_all(&temp_dest).unwrap();

    let img_path = temp_src.join("sample_figure.png");
    std::fs::write(&img_path, b"fake png image bytes").unwrap();

    let tex_source = r#"
\documentclass{article}
\usepackage{graphicx}
\begin{document}
\includegraphics{sample_figure}
\end{document}
"#;

    let dest_md_path = temp_dest.join("output.md");
    let result = crate::commands::export::export_document_to_markdown(
        dest_md_path.to_string_lossy().to_string(),
        tex_source.to_string(),
        "latex".to_string(),
        Some(temp_src.to_string_lossy().to_string()),
    ).await;

    assert!(result.is_ok());
    assert!(dest_md_path.is_file());
    assert!(temp_dest.join("sample_figure.png").is_file());

    let _ = std::fs::remove_dir_all(&temp_src);
    let _ = std::fs::remove_dir_all(&temp_dest);
}





