/**
 * Default starter template for Typst documents in ScienceBatch.
 */
export const DEFAULT_TYPST_SOURCE = `#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm))
#set text(font: ("Libertinus Serif", "New Computer Modern"), size: 11pt, lang: "en")
#set par(justify: true)
#set math.equation(numbering: "(1)")
#set heading(numbering: "1.1")

#align(center)[
  #text(20pt, weight: "bold")[ScienceBatch Showcase & Technical Tutorial] \\
  #v(0.4em)
  #text(12pt, fill: rgb("#2563eb"), weight: "medium")[Native Dual Studio: Tectonic LaTeX & Rust Typst] \\
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
In *ScienceBatch*, compilation is triggered on-demand via the global keyboard shortcut \`Ctrl + S\` (or \`Cmd + S\` on macOS) or the *Compile* button in the primary toolbar. Rather than writing intermediate auxiliary files to disk, ScienceBatch compiles source directly in RAM and renders PDF pages on hardware-accelerated canvas elements.

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
    [Multi-File Resolver], [\`\\input\`, \`\\include\`], [\`#include\`], [Relative Resolver], [Automatic],
  ),
  caption: [Comprehensive comparison between typesetting engines in ScienceBatch.],
) <tab:benchmarks>

= Graphics, Figures, and Multimedia Assets <sec:figures>
Figures with captions and automatic numbering are declared using the \`#figure\` function:

#figure(
  image("assets/sample.png", width: 70%),
  caption: [ScienceBatch Studio: high-performance desktop typesetting architecture and dual engine pipeline.],
) <fig:banner>

== Dynamic Multimedia & Web Export <subsec:multimedia>
In desktop PDF documents, Typst captures the visual asset directly into vector/raster PDF streams. When exporting to standalone HTML documents, animated assets such as \`assets/sample.gif\` are embedded as base64 data URIs and animate live in web browsers:

#figure(
  image("assets/sample.gif", width: 25%),
  caption: [Live dynamic pulse asset. Renders animated in HTML export and file viewer, static first frame in PDF.],
) <fig:anim>

= Source Code Listings <sec:code>
Source code snippets are formatted with raw code blocks:

\`\`\`rust
// Typst in-memory compilation through native typst-embed
let project = typst_embed::Project::builder("main.typ")
    .source_file("main.typ", typst_source)
    .build()?;
\`\`\`

= Lists and Feature Highlights <sec:lists>
Features are structured using nested unordered and ordered lists:
- *Zero Configuration Setup:*
  + Embedded TeX package bundle handles core packages automatically.
  + Automatic BibTeX and font discovery.
- *Multi-Target Document Export:*
  - Standalone HTML with KaTeX and responsive CSS tables.
  - GitHub Flavored Markdown (GFM) with preserved math and clean headers.

= Citations and Bibliographic References <sec:citations>
Citations link directly to the project's \`references.bib\` file. Relativistic physics was revolutionized by Einstein @einstein1905.
Cross-referencing ties the paper together: @sec:math formulates @eq:einstein, @sec:tables details @tab:benchmarks, and @sec:figures showcases @fig:banner and @fig:anim.

#bibliography("references.bib")
`;

export const DEFAULT_TYPST_SOURCE_ES = `#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm))
#set text(font: ("Libertinus Serif", "New Computer Modern"), size: 11pt, lang: "es")
#set par(justify: true)
#set math.equation(numbering: "(1)")
#set heading(numbering: "1.1")

#align(center)[
  #text(20pt, weight: "bold")[Guía de Demostración y Tutorial Técnico de ScienceBatch] \\
  #v(0.4em)
  #text(12pt, fill: rgb("#2563eb"), weight: "medium")[Estudio Dual Nativo: Tectonic LaTeX y Rust Typst] \\
  #v(0.3em)
  #text(10pt, style: "italic")[Grupo de Investigación de ScienceBatch — Departamento de Ciencias de la Computación y Matemática Aplicada]
]

#v(1em)

#rect(width: 100%, stroke: 0.5pt + rgb("#cbd5e1"), radius: 4pt, fill: rgb("#f8fafc"), inset: 12pt)[
  #text(weight: "bold", fill: rgb("#0f172a"))[Resumen] \
  #v(0.3em)
  Este documento funciona tanto como banco de pruebas interactivo como tutorial arquitectónico para *ScienceBatch*. Impulsado por el motor en memoria _Tectonic_ XeTeX y _Typst_ nativo en Rust, ScienceBatch ejecuta la composición tipográfica 100% sin conexión directamente en un sistema de archivos virtual en RAM (VFS) sin ensuciar el disco. Esta demostración presenta jerarquías de secciones (H1--H3), ecuaciones simples y multilínea, álgebra matricial, teoremas formales, tablas de nivel editorial, gráficos, recursos dinámicos, bloques de código y citas automatizadas con BibTeX.
]

#v(1em)

= Introducción y Arquitectura del Sistema <sec:intro>
Typst es un sistema de composición tipográfica de nueva generación basado en marcado y diseñado en Rust. Combina la expresividad matemática de LaTeX con una sintaxis concisa e intuitiva y compilación ultrarrápida en memoria (< 50 ms).

== Flujo de Compilación <subsec:pipeline>
En *ScienceBatch*, la compilación se activa bajo demanda mediante el atajo global de teclado \`Ctrl + S\` (o \`Cmd + S\` en macOS) o el botón *Compilar* en la barra de herramientas principal. En lugar de escribir archivos auxiliares intermedios en el disco, ScienceBatch compila el código fuente directamente en RAM y renderiza las páginas PDF sobre elementos canvas acelerados por hardware.

=== Subproceso Trabajador Aislado <subsubsec:worker>
Para evitar que código malformado bloquee la interfaz de la aplicación, la compilación se ejecuta en un subproceso trabajador hijo aislado que se comunica mediante tuberías IPC asíncronas.

= Física Matemática y Ecuaciones Avanzadas <sec:math>
Las expresiones matemáticas se escriben de forma natural usando delimitadores de dólar. Entre las ecuaciones en línea se incluyen la identidad de Euler $e^(i pi) + 1 = 0$, la integral gaussiana $integral_(-oo)^oo e^(-x^2) dif x = sqrt(pi)$ y el límite fundamental $lim_(x -> 0) (sin x) / x = 1$.

== Ecuaciones Numeradas en Bloque <subsec:equations>
Las ecuaciones en bloque con numeración automática y etiquetas se declaran con signos de dólar y etiquetas de referencia:

$ E = m c^2 $ <eq:einstein>

== Ecuaciones de Campo Multilínea Alineadas <subsec:maxwell>
Las ecuaciones de campo electrodinámicas ilustran sistemas multilínea con referencias cruzadas individuales:

$ nabla dot bold(E) = rho / epsilon_0 $ <eq:maxwell-gauss>
$ nabla times bold(E) = - (partial bold(B)) / (partial t) $ <eq:maxwell-faraday>
$ nabla dot bold(B) = 0 $ <eq:maxwell-mag>
$ nabla times bold(B) = mu_0 bold(J) + mu_0 epsilon_0 (partial bold(E)) / (partial t) $ <eq:maxwell-ampere>

== Álgebra Lineal y Rotaciones de Coordenadas <subsec:algebra>
Las transformaciones de coordenadas planas y los operadores lineales se declaran mediante sintaxis matricial:

$ mat(x'; y') = mat(cos theta, -sin theta; sin theta, cos theta) mat(x; y) $ <eq:rotation>

== Teoremas Formales y Demostraciones <subsec:theorems>
Los bloques académicos destacados y los teoremas se presentan con gran claridad:

#rect(width: 100%, stroke: 0.5pt + rgb("#3b82f6"), radius: 4pt, fill: rgb("#eff6ff"), inset: 10pt)[
  #text(weight: "bold", fill: rgb("#1d4ed8"))[Teorema 1 (Teorema Fundamental del Cálculo)] \
  Sea $f: [a, b] -> RR$ una función real continua y sea $F$ una antiderivada de $f$ en $[a, b]$. Entonces:
  $ integral_a^b f(x) dif x = F(b) - F(a) $ <eq:ftc>
]

= Datos Tabulares Estructurados y Comparativas <sec:tables>
Typst permite construir datos tabulares limpios y listos para publicación de manera declarativa con personalización por celda:

#figure(
  table(
    columns: (auto, auto, auto, auto, 1fr),
    fill: (col, row) => if row == 0 { rgb("#3b82f6").lighten(85%) } else if calc.odd(row) { rgb("#f8fafc") } else { none },
    stroke: 0.5pt + rgb("#cbd5e1"),
    [*Característica*], [*LaTeX (Tectonic)*], [*Typst (Rust)*], [*ScienceBatch VFS*], [*Aceleración*],
    [Motor de Compilación], [XeTeX en VFS RAM], [Motor Rust Nativo], [Cero E/S en Disco], [10x],
    [Latencia de Arranque], [< 1.2 s], [< 0.05 s], [Paquete en Memoria], [Instantánea],
    [Sintaxis Matemática], [Sistema de Macros TeX], [Declarativa Moderna], [Vista Previa Unificada], [Dinámica],
    [Soporte Gráfico], [PNG, JPEG, PDF], [PNG, SVG, GIF], [Embebido Base64], [Fluido],
    [Resolución Multiarchivo], [\`\\input\`, \`\\include\`], [\`#include\`], [Resolutor Relativo], [Automática],
  ),
  caption: [Comparativa integral entre los motores tipográficos de ScienceBatch.],
) <tab:benchmarks>

= Gráficos, Figuras y Recursos Multimedia <sec:figures>
Las figuras con leyendas y numeración automática se declaran utilizando la función \`#figure\`:

#figure(
  image("assets/sample.png", width: 70%),
  caption: [ScienceBatch Studio: arquitectura de composición tipográfica de alto rendimiento y flujo de doble motor.],
) <fig:banner>

== Multimedia Dinámica y Exportación Web <subsec:multimedia>
En documentos PDF de escritorio, Typst captura el recurso visual directamente en flujos PDF vectoriales o rasterizados. Al exportar a documentos HTML autónomos, los recursos animados como \`assets/sample.gif\` se incrustan como URI de datos base64 y se animan en vivo en los navegadores web:

#figure(
  image("assets/sample.gif", width: 25%),
  caption: [Recurso dinámico animado. Se muestra con animación en la exportación HTML y el visor de archivos, y como primer fotograma estático en PDF.],
) <fig:anim>

= Listados de Código Fuente <sec:code>
Los fragmentos de código fuente se formatean con bloques de código sin procesar:

\`\`\`rust
// Compilación en memoria de Typst mediante typst-embed nativo
let project = typst_embed::Project::builder("main.typ")
    .source_file("main.typ", typst_source)
    .build()?;
\`\`\`

= Listas y Aspectos Destacados <sec:lists>
Las funcionalidades se estructuran mediante listas anidadas ordenadas y sin ordenar:
- *Configuración Sin Fricción:*
  + El paquete TeX embebido gestiona automáticamente las bibliotecas esenciales.
  + Descubrimiento automático de BibTeX y tipografías.
- *Exportación Multiformato:*
  - HTML autónomo con KaTeX y tablas CSS adaptativas.
  - GitHub Flavored Markdown (GFM) conservando matemáticas y encabezados limpios.

= Citas y Referencias Bibliográficas <sec:citations>
Las citas enlazan directamente con el archivo \`references.bib\` del proyecto. La física relativista fue revolucionada por Einstein @einstein1905.
Las referencias cruzadas conectan todo el artículo: @sec:math formula @eq:einstein, @sec:tables detalla @tab:benchmarks y @sec:figures muestra @fig:banner y @fig:anim.

#bibliography("references.bib")
`;

export function getDefaultTypstSource(language?: string): string {
  return language?.toLowerCase().startsWith('es')
    ? DEFAULT_TYPST_SOURCE_ES
    : DEFAULT_TYPST_SOURCE;
}

export function isDefaultTypstSource(source: string): boolean {
  return source === DEFAULT_TYPST_SOURCE || source === DEFAULT_TYPST_SOURCE_ES;
}
