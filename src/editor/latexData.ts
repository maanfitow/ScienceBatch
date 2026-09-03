export interface LatexSymbol {
  name: string;
  insertText: string;
  detail: string;
  documentation: string;
}

export interface LatexEnvironment {
  name: string;
  snippet: string;
  detail: string;
  documentation: string;
}

export const LATEX_COMMANDS: LatexSymbol[] = [
  // Preamble & Document Setup
  { name: '\\documentclass', insertText: '\\documentclass[${1:12pt,a4paper}]{${2:article}}', detail: 'Document class', documentation: 'Sets the document type (article, report, book, beamer).' },
  { name: '\\usepackage', insertText: '\\usepackage[${1:options}]{${2:package}}', detail: 'Import CTAN package', documentation: 'Loads a LaTeX package/extension into the preamble.' },
  { name: '\\geometry', insertText: '\\geometry{margin=${1:2.5cm}}', detail: 'Page geometry & margins', documentation: 'Configures paper size and page margins via the geometry package (e.g. margin=2.5cm, top=2cm, left=3cm).' },
  { name: '\\newtheorem', insertText: '\\newtheorem{${1:theorem}}{${2:Theorem}}[${3:section}]', detail: 'Define theorem environment', documentation: 'Defines a custom theorem-like environment (amsthm).' },
  { name: '\\hypersetup', insertText: '\\hypersetup{\n\tcolorlinks=${1:true},\n\tlinkcolor=${2:blue},\n\tcitecolor=${3:blue},\n\turlcolor=${4:cyan}\n}', detail: 'Configure hyperref links', documentation: 'Sets hyperlink styling and PDF metadata properties via the hyperref package.' },
  { name: '\\graphicspath', insertText: '\\graphicspath{{${1:./images/}}}', detail: 'Image search paths', documentation: 'Defines root directories where graphicx will search for image files.' },
  { name: '\\setlength', insertText: '\\setlength{\\${1:parindent}}{${2:0pt}}', detail: 'Set length parameter', documentation: 'Sets the value of a LaTeX length variable (e.g. \\parindent, \\parskip).' },
  { name: '\\newcommand', insertText: '\\newcommand{\\${1:cmd}}[${2:1}]{${3:definition}}', detail: 'Define custom macro', documentation: 'Creates a new user-defined LaTeX command macro.' },
  { name: '\\renewcommand', insertText: '\\renewcommand{\\${1:cmd}}[${2:1}]{${3:definition}}', detail: 'Redefine existing macro', documentation: 'Overwrites an existing LaTeX command macro.' },
  { name: '\\DeclareRobustCommand', insertText: '\\DeclareRobustCommand{\\${1:cmd}}[${2:1}]{${3:definition}}', detail: 'Define robust macro', documentation: 'Creates a robust macro that will not expand prematurely in moving arguments.' },
  { name: '\\IEEEoverridecommandlockouts', insertText: '\\IEEEoverridecommandlockouts', detail: 'IEEEtran unlock commands', documentation: 'Unlocks commands in IEEEtran to enable funding acknowledgments in title footnotes.' },
  { name: '\\IEEEauthorblockN', insertText: '\\IEEEauthorblockN{${1:Author Name}}', detail: 'IEEEtran author names block', documentation: 'Formats author names in IEEE conference title blocks.' },
  { name: '\\IEEEauthorblockA', insertText: '\\IEEEauthorblockA{${1:Affiliation}}', detail: 'IEEEtran author affiliation block', documentation: 'Formats author affiliation and email in IEEE conference title blocks.' },

  // Title & Frontmatter
  { name: '\\title', insertText: '\\title{${1:Document Title}}', detail: 'Document title', documentation: 'Sets the main title of the document.' },
  { name: '\\author', insertText: '\\author{${1:Author Name}}', detail: 'Document author', documentation: 'Sets the author(s) of the document.' },
  { name: '\\date', insertText: '\\date{${1:\\today}}', detail: 'Document date', documentation: 'Sets the date (use \\today for current date).' },
  { name: '\\today', insertText: '\\today', detail: 'Current date', documentation: 'Outputs the current date dynamically (e.g. March 15, 2026).' },
  { name: '\\maketitle', insertText: '\\maketitle', detail: 'Render title header', documentation: 'Typesets the title, author, and date block.' },
  { name: '\\tableofcontents', insertText: '\\tableofcontents\n\\newpage', detail: 'Table of contents', documentation: 'Generates the table of contents.' },
  { name: '\\listoffigures', insertText: '\\listoffigures', detail: 'List of figures', documentation: 'Generates an automated list of floating figures.' },
  { name: '\\listoftables', insertText: '\\listoftables', detail: 'List of tables', documentation: 'Generates an automated list of floating tables.' },
  { name: '\\appendix', insertText: '\\appendix', detail: 'Start appendix section', documentation: 'Changes section numbering to letters (A, B, C...) for appendixes.' },
  { name: '\\pagenumbering', insertText: '\\pagenumbering{${1:arabic}}', detail: 'Page numbering style', documentation: 'Sets page numbering format (arabic, roman, Roman, alph, Alph).' },
  { name: '\\setcounter', insertText: '\\setcounter{${1:page}}{${2:1}}', detail: 'Set counter value', documentation: 'Assigns a numeric value to a counter.' },
  { name: '\\addtocounter', insertText: '\\addtocounter{${1:page}}{${2:1}}', detail: 'Increment counter', documentation: 'Increments a counter by a given integer.' },
  { name: '\\newpage', insertText: '\\newpage', detail: 'Page break', documentation: 'Forces a break to a new page.' },
  { name: '\\clearpage', insertText: '\\clearpage', detail: 'Clear page & flush floats', documentation: 'Forces a page break and outputs all pending floating figures/tables.' },

  // Typography & Font Sizing Modifiers
  { name: '\\tiny', insertText: '\\tiny ', detail: 'Font size: tiny (~5pt)', documentation: 'Switches font size to tiny.' },
  { name: '\\scriptsize', insertText: '\\scriptsize ', detail: 'Font size: scriptsize (~7pt)', documentation: 'Switches font size to script size (for sub/superscripts).' },
  { name: '\\footnotesize', insertText: '\\footnotesize ', detail: 'Font size: footnotesize (~8pt)', documentation: 'Switches font size to footnote size.' },
  { name: '\\small', insertText: '\\small ', detail: 'Font size: small (~9pt)', documentation: 'Switches font size to small (commonly used for abstracts and author affiliations).' },
  { name: '\\normalsize', insertText: '\\normalsize ', detail: 'Font size: normal (~10-12pt)', documentation: 'Resets font size to the document default base size.' },
  { name: '\\large', insertText: '\\large ', detail: 'Font size: large (~12-14pt)', documentation: 'Switches font size to large.' },
  { name: '\\Large', insertText: '\\Large ', detail: 'Font size: Large (~14-17pt)', documentation: 'Switches font size to larger.' },
  { name: '\\LARGE', insertText: '\\LARGE ', detail: 'Font size: LARGE (~17-20pt)', documentation: 'Switches font size to extra large.' },
  { name: '\\huge', insertText: '\\huge ', detail: 'Font size: huge (~20-25pt)', documentation: 'Switches font size to huge.' },
  { name: '\\Huge', insertText: '\\Huge ', detail: 'Font size: Huge (~25pt+)', documentation: 'Switches font size to the largest available size.' },

  // Typography & Text Styling
  { name: '\\textbf', insertText: '\\textbf{${1:text}}', detail: 'Bold font', documentation: 'Applies bold font weight to the text enclosed in braces.' },
  { name: '\\textit', insertText: '\\textit{${1:text}}', detail: 'Italic font', documentation: 'Applies italic (oblique) font shape to the text.' },
  { name: '\\underline', insertText: '\\underline{${1:text}}', detail: 'Underline text', documentation: 'Underlines the specified text argument.' },
  { name: '\\texttt', insertText: '\\texttt{${1:code}}', detail: 'Monospace / Typewriter font', documentation: 'Applies fixed-width font suited for inline code, filenames, or variables.' },
  { name: '\\emph', insertText: '\\emph{${1:text}}', detail: 'Contextual emphasis', documentation: 'Emphasizes text by italicizing normal text or uprighting already italicized text.' },
  { name: '\\textsc', insertText: '\\textsc{${1:text}}', detail: 'Small capitals', documentation: 'Formats text in small capital letters.' },
  { name: '\\text', insertText: '\\text{${1:text}}', detail: 'Math mode inline text', documentation: 'Embeds normal text font inside mathematical equations (amsmath).' },
  { name: '\\textcolor', insertText: '\\textcolor{${1:blue}}{${2:text}}', detail: 'Colored text', documentation: 'Sets the foreground color of text (xcolor package).' },
  { name: '\\colorbox', insertText: '\\colorbox{${1:yellow}}{${2:text}}', detail: 'Highlighted background box', documentation: 'Places text on a colored background box.' },
  { name: '\\textbackslash', insertText: '\\textbackslash', detail: 'Literal backslash (\\)', documentation: 'Produces a literal backslash in text mode.' },
  { name: '\\textsuperscript', insertText: '\\textsuperscript{${1:text}}', detail: 'Superscript in text mode', documentation: 'Formats text as a superscript in text mode (e.g. for author affiliations).' },
  { name: '\\textsubscript', insertText: '\\textsubscript{${1:text}}', detail: 'Subscript in text mode', documentation: 'Formats text as a subscript in text mode.' },
  { name: '\\textdaggerdbl', insertText: '\\textdaggerdbl', detail: 'Double dagger symbol (‡)', documentation: 'Produces a double dagger symbol in text mode (commonly used for author footnotes).' },
  { name: '\\textdagger', insertText: '\\textdagger', detail: 'Dagger symbol (†)', documentation: 'Produces a dagger symbol in text mode.' },
  { name: '\\textwidth', insertText: '\\textwidth', detail: 'Text width dimension', documentation: 'The width of the text body on the page.' },
  { name: '\\linewidth', insertText: '\\linewidth', detail: 'Line width dimension', documentation: 'The current line width within the active environment or column.' },
  { name: '\\columnwidth', insertText: '\\columnwidth', detail: 'Column width dimension', documentation: 'The width of a single column in multi-column layout.' },
  { name: '\\makecell', insertText: '\\makecell{${1:text}}', detail: 'Multi-line table cell', documentation: 'Enables manual line breaks and aligned content inside tabular cells (makecell package).' },

  // Text Alignment
  { name: '\\centering', insertText: '\\centering', detail: 'Center alignment', documentation: 'Centers content within the current environment or scope.' },
  { name: '\\raggedright', insertText: '\\raggedright', detail: 'Left-aligned text (ragged right)', documentation: 'Aligns text to the left margin without right-side justification.' },
  { name: '\\raggedleft', insertText: '\\raggedleft', detail: 'Right-aligned text (ragged left)', documentation: 'Aligns text to the right margin.' },

  // Lists & Items
  { name: '\\item', insertText: '\\item ${1:Item text}', detail: 'List item', documentation: 'Adds a bullet or numbered entry inside itemize or enumerate environments.' },
  { name: '\\item[]', insertText: '\\item[${1:label}] ${2:Description}', detail: 'Custom labeled list item', documentation: 'Adds an item with a custom label (e.g. for description lists).' },

  // Sections & Document Structure
  { name: '\\section', insertText: '\\section{${1:Section Title}}\n\\label{sec:${2:label}}', detail: 'Numbered section', documentation: 'Creates a top-level numbered section heading.' },
  { name: '\\subsection', insertText: '\\subsection{${1:Subsection Title}}\n\\label{subsec:${2:label}}', detail: 'Numbered subsection', documentation: 'Creates a second-level numbered subsection heading.' },
  { name: '\\subsubsection', insertText: '\\subsubsection{${1:Subsubsection Title}}\n\\label{subsubsec:${2:label}}', detail: 'Numbered subsubsection', documentation: 'Creates a third-level numbered subsubsection heading.' },
  { name: '\\paragraph', insertText: '\\paragraph{${1:Paragraph Title}} ', detail: 'Inline paragraph heading', documentation: 'Creates an unnumbered bold inline paragraph heading.' },

  // Figures, Tables & Graphics
  { name: '\\includegraphics', insertText: '\\includegraphics[width=${1:0.8\\textwidth}]{${2:filename}}', detail: 'Include external graphic', documentation: 'Embeds an image file into the document (graphicx package).' },
  { name: '\\caption', insertText: '\\caption{${1:Caption description}}', detail: 'Figure/Table caption', documentation: 'Sets the descriptive caption for a floating figure or table.' },
  { name: '\\vspace', insertText: '\\vspace{${1:1em}}', detail: 'Vertical space', documentation: 'Inserts vertical whitespace of the specified dimension.' },
  { name: '\\hspace', insertText: '\\hspace{${1:1em}}', detail: 'Horizontal space', documentation: 'Inserts horizontal whitespace of the specified dimension.' },
  { name: '\\hfill', insertText: '\\hfill ', detail: 'Horizontal spring / fill', documentation: 'Expands horizontally to push content to the margins.' },
  { name: '\\vfill', insertText: '\\vfill ', detail: 'Vertical spring / fill', documentation: 'Expands vertically to push content to the bottom of the page.' },
  { name: '\\quad', insertText: '\\quad ', detail: 'Space: 1em quad', documentation: 'Inserts horizontal space equal to the current font size.' },
  { name: '\\qquad', insertText: '\\qquad ', detail: 'Space: 2em double quad', documentation: 'Inserts double horizontal space equal to 2em.' },

  // Math Operators & Calculus
  { name: '\\frac', insertText: '\\frac{${1:numerator}}{${2:denominator}}', detail: 'Fraction (num/den)', documentation: 'Inserts a fraction with numerator and denominator.' },
  { name: '\\sqrt', insertText: '\\sqrt{${1:x}}', detail: 'Square root', documentation: 'Inserts a square root, or n-th root with \\sqrt[n]{x}.' },
  { name: '\\sum', insertText: '\\sum_{${1:i=1}}^{${2:n}} ', detail: 'Summation operator (∑)', documentation: 'Inserts the summation symbol with lower and upper limits.' },
  { name: '\\int', insertText: '\\int_{${1:a}}^{${2:b}} ${3:f(x)} \\, d${4:x}', detail: 'Definite integral (∫)', documentation: 'Inserts an integral with lower and upper bounds and differential.' },
  { name: '\\iint', insertText: '\\iint_{${1:D}} ${2:f(x, y)} \\, dA', detail: 'Double integral (∬)', documentation: 'Inserts a double area integral.' },
  { name: '\\iiint', insertText: '\\iiint_{${1:V}} ${2:f(x, y, z)} \\, dV', detail: 'Triple integral (∭)', documentation: 'Inserts a triple volume integral.' },
  { name: '\\oint', insertText: '\\oint_{${1:C}} ${2:F} \\cdot d${3:r}', detail: 'Contour / Closed line integral (∮)', documentation: 'Inserts a closed curve line integral.' },
  { name: '\\prod', insertText: '\\prod_{${1:i=1}}^{${2:n}} ', detail: 'Product operator (∏)', documentation: 'Inserts the product sequence operator with limits.' },
  { name: '\\lim', insertText: '\\lim_{${1:x} \\to ${2:\\infty}} ', detail: 'Limit notation', documentation: 'Inserts a limit with variable approach target.' },
  { name: '\\partial', insertText: '\\partial', detail: 'Partial derivative (∂)', documentation: 'Partial differentiation symbol.' },
  { name: '\\nabla', insertText: '\\nabla', detail: 'Nabla / Del operator (∇)', documentation: 'Vector differential operator for gradient, divergence, and curl.' },
  { name: '\\infty', insertText: '\\infty', detail: 'Infinity (∞)', documentation: 'Mathematical infinity symbol.' },

  // Math Accents & Vectors
  { name: '\\vec', insertText: '\\vec{${1:v}}', detail: 'Vector arrow accent', documentation: 'Places a vector arrow over the symbol (e.g. \\vec{v}).' },
  { name: '\\hat', insertText: '\\hat{${1:x}}', detail: 'Hat / Unit vector accent', documentation: 'Places a caret (circumflex) hat over the symbol.' },
  { name: '\\bar', insertText: '\\bar{${1:x}}', detail: 'Bar / Mean accent', documentation: 'Places a horizontal bar over the symbol.' },
  { name: '\\tilde', insertText: '\\tilde{${1:x}}', detail: 'Tilde accent (~)', documentation: 'Places a tilde over the symbol.' },
  { name: '\\dot', insertText: '\\dot{${1:x}}', detail: 'Dot / First time derivative', documentation: 'Places a single dot over the symbol (Newtonian time derivative).' },
  { name: '\\ddot', insertText: '\\ddot{${1:x}}', detail: 'Double dot / Second derivative', documentation: 'Places two dots over the symbol.' },
  { name: '\\overline', insertText: '\\overline{${1:expression}}', detail: 'Overline bar', documentation: 'Draws a continuous horizontal line above the entire expression.' },
  { name: '\\boxed', insertText: '\\boxed{${1:equation}}', detail: 'Boxed equation formula', documentation: 'Encloses a formula inside a rectangular bounding box (amsmath).' },
  { name: '\\overbrace', insertText: '\\overbrace{${1:expression}}^{${2:annotation}}', detail: 'Overbrace with note', documentation: 'Draws a curly brace above an expression with an annotation.' },
  { name: '\\underbrace', insertText: '\\underbrace{${1:expression}}_{${2:annotation}}', detail: 'Underbrace with note', documentation: 'Draws a curly brace below an expression with an annotation.' },

  // Delimiters (Auto-sizing)
  { name: '\\left(', insertText: '\\left( ${1:expression} \\right)', detail: 'Auto-sizing parentheses ()', documentation: 'Encloses math in parentheses that scale automatically to the enclosed height.' },
  { name: '\\left[', insertText: '\\left[ ${1:expression} \\right]', detail: 'Auto-sizing brackets []', documentation: 'Encloses math in brackets that scale automatically to the enclosed height.' },
  { name: '\\left\\{', insertText: '\\left\\{ ${1:expression} \\right\\}', detail: 'Auto-sizing braces {}', documentation: 'Encloses math in curly braces that scale automatically to the enclosed height.' },
  { name: '\\left|', insertText: '\\left| ${1:expression} \\right|', detail: 'Auto-sizing absolute value ||', documentation: 'Encloses math in single vertical bars for absolute value / determinant.' },
  { name: '\\left\\|', insertText: '\\left\\| ${1:expression} \\right\\|', detail: 'Auto-sizing norm ‖‖', documentation: 'Encloses math in double vertical bars for vector/matrix norm.' },

  // Dots & Ellipses
  { name: '\\dots', insertText: '\\dots', detail: 'Baseline dots (...)', documentation: 'Ellipsis dots placed along the baseline.' },
  { name: '\\cdots', insertText: '\\cdots', detail: 'Centered dots (⋯)', documentation: 'Ellipsis dots placed centered between operators (e.g. 1 + 2 + \\cdots + n).' },
  { name: '\\vdots', insertText: '\\vdots', detail: 'Vertical dots (⋮)', documentation: 'Vertical ellipsis dots for matrices.' },
  { name: '\\ddots', insertText: '\\ddots', detail: 'Diagonal dots (⋱)', documentation: 'Diagonal ellipsis dots for matrix diagonals.' },

  // Greek Letters (Lowercase & Uppercase)
  { name: '\\alpha', insertText: '\\alpha', detail: 'Greek alpha (α)', documentation: 'Greek lowercase letter alpha.' },
  { name: '\\beta', insertText: '\\beta', detail: 'Greek beta (β)', documentation: 'Greek lowercase letter beta.' },
  { name: '\\gamma', insertText: '\\gamma', detail: 'Greek gamma (γ)', documentation: 'Greek lowercase letter gamma.' },
  { name: '\\Gamma', insertText: '\\Gamma', detail: 'Greek Gamma (Γ)', documentation: 'Greek uppercase letter Gamma.' },
  { name: '\\delta', insertText: '\\delta', detail: 'Greek delta (δ)', documentation: 'Greek lowercase letter delta.' },
  { name: '\\Delta', insertText: '\\Delta', detail: 'Greek Delta (Δ)', documentation: 'Greek uppercase letter Delta (Laplacian or difference).' },
  { name: '\\epsilon', insertText: '\\epsilon', detail: 'Greek epsilon (ε)', documentation: 'Greek lowercase letter epsilon.' },
  { name: '\\varepsilon', insertText: '\\varepsilon', detail: 'Greek varepsilon (𝜀)', documentation: 'Smooth variant of lowercase epsilon.' },
  { name: '\\zeta', insertText: '\\zeta', detail: 'Greek zeta (ζ)', documentation: 'Greek lowercase letter zeta.' },
  { name: '\\eta', insertText: '\\eta', detail: 'Greek eta (η)', documentation: 'Greek lowercase letter eta.' },
  { name: '\\theta', insertText: '\\theta', detail: 'Greek theta (θ)', documentation: 'Greek lowercase letter theta.' },
  { name: '\\Theta', insertText: '\\Theta', detail: 'Greek Theta (Θ)', documentation: 'Greek uppercase letter Theta.' },
  { name: '\\lambda', insertText: '\\lambda', detail: 'Greek lambda (λ)', documentation: 'Greek lowercase letter lambda (wavelength or eigenvalue).' },
  { name: '\\Lambda', insertText: '\\Lambda', detail: 'Greek Lambda (Λ)', documentation: 'Greek uppercase letter Lambda.' },
  { name: '\\mu', insertText: '\\mu', detail: 'Greek mu (μ)', documentation: 'Greek lowercase letter mu (micro or mean).' },
  { name: '\\nu', insertText: '\\nu', detail: 'Greek nu (ν)', documentation: 'Greek lowercase letter nu.' },
  { name: '\\xi', insertText: '\\xi', detail: 'Greek xi (ξ)', documentation: 'Greek lowercase letter xi.' },
  { name: '\\pi', insertText: '\\pi', detail: 'Constant Pi (π)', documentation: 'Mathematical circular constant π ≈ 3.14159.' },
  { name: '\\rho', insertText: '\\rho', detail: 'Greek rho (ρ)', documentation: 'Greek lowercase letter rho (density or resistivity).' },
  { name: '\\sigma', insertText: '\\sigma', detail: 'Greek sigma (σ)', documentation: 'Greek lowercase letter sigma (standard deviation or stress).' },
  { name: '\\Sigma', insertText: '\\Sigma', detail: 'Greek Sigma (Σ)', documentation: 'Greek uppercase letter Sigma (summation or covariance).' },
  { name: '\\tau', insertText: '\\tau', detail: 'Greek tau (τ)', documentation: 'Greek lowercase letter tau (torque or time constant).' },
  { name: '\\phi', insertText: '\\phi', detail: 'Greek phi (ϕ)', documentation: 'Greek lowercase letter phi.' },
  { name: '\\varphi', insertText: '\\varphi', detail: 'Greek varphi (φ)', documentation: 'Curly lowercase letter varphi.' },
  { name: '\\Phi', insertText: '\\Phi', detail: 'Greek Phi (Φ)', documentation: 'Greek uppercase letter Phi.' },
  { name: '\\psi', insertText: '\\psi', detail: 'Greek psi (ψ)', documentation: 'Greek lowercase letter psi (wavefunction).' },
  { name: '\\Psi', insertText: '\\Psi', detail: 'Greek Psi (Ψ)', documentation: 'Greek uppercase letter Psi.' },
  { name: '\\omega', insertText: '\\omega', detail: 'Greek omega (ω)', documentation: 'Greek lowercase letter omega (angular frequency).' },
  { name: '\\Omega', insertText: '\\Omega', detail: 'Greek Omega (Ω)', documentation: 'Greek uppercase letter Omega (Ohm resistance).' },

  // Relations, Arrows & Sets
  { name: '\\leq', insertText: '\\leq', detail: 'Less than or equal (≤)', documentation: 'Order relation less than or equal.' },
  { name: '\\geq', insertText: '\\geq', detail: 'Greater than or equal (≥)', documentation: 'Order relation greater than or equal.' },
  { name: '\\neq', insertText: '\\neq', detail: 'Not equal (≠)', documentation: 'Inequality relation.' },
  { name: '\\approx', insertText: '\\approx', detail: 'Approximately equal (≈)', documentation: 'Asymptotic or numerical approximation.' },
  { name: '\\equiv', insertText: '\\equiv', detail: 'Equivalent / Identical (≡)', documentation: 'Congruence or definition equality.' },
  { name: '\\times', insertText: '\\times', detail: 'Multiplication cross (×)', documentation: 'Cartesian product or arithmetic multiplication.' },
  { name: '\\cdot', insertText: '\\cdot', detail: 'Dot product (·)', documentation: 'Center dot scalar / dot product.' },
  { name: '\\pm', insertText: '\\pm', detail: 'Plus-minus (±)', documentation: 'Plus or minus uncertainty sign.' },
  { name: '\\mp', insertText: '\\mp', detail: 'Minus-plus (∓)', documentation: 'Minus or plus sign.' },
  { name: '\\rightarrow', insertText: '\\rightarrow', detail: 'Right arrow (→)', documentation: 'Single right arrow (mapping or limit).' },
  { name: '\\Leftarrow', insertText: '\\Leftarrow', detail: 'Implies left (⇐)', documentation: 'Logical implication left.' },
  { name: '\\Rightarrow', insertText: '\\Rightarrow', detail: 'Implies right (⇒)', documentation: 'Logical implication right.' },
  { name: '\\Leftrightarrow', insertText: '\\Leftrightarrow', detail: 'If and only if (⇔)', documentation: 'Logical equivalence.' },
  { name: '\\forall', insertText: '\\forall', detail: 'Universal quantifier (∀)', documentation: 'For all elements in set.' },
  { name: '\\exists', insertText: '\\exists', detail: 'Existential quantifier (∃)', documentation: 'There exists at least one element.' },
  { name: '\\in', insertText: '\\in', detail: 'Element of set (∈)', documentation: 'Indicates membership in a set.' },
  { name: '\\notin', insertText: '\\notin', detail: 'Not element of set (∉)', documentation: 'Indicates non-membership in a set.' },
  { name: '\\subset', insertText: '\\subset', detail: 'Subset (⊂)', documentation: 'Strict subset inclusion.' },
  { name: '\\subseteq', insertText: '\\subseteq', detail: 'Subset or equal (⊆)', documentation: 'Subset inclusion allowing equality.' },
  { name: '\\cup', insertText: '\\cup', detail: 'Set union (∪)', documentation: 'Union of sets.' },
  { name: '\\cap', insertText: '\\cap', detail: 'Set intersection (∩)', documentation: 'Intersection of sets.' },
  { name: '\\mathbb', insertText: '\\mathbb{${1:R}}', detail: 'Blackboard bold (ℝ, ℂ, ℕ, ℤ)', documentation: 'Number sets in blackboard bold font.' },
  { name: '\\mathcal', insertText: '\\mathcal{${1:L}}', detail: 'Calligraphic script (ℒ, ℋ)', documentation: 'Calligraphic font for operators and spaces.' },

  // References, Links, Labels & Citations
  { name: '\\label', insertText: '\\label{${1:key}}', detail: 'Anchor label', documentation: 'Assigns a unique key to refer to equations, figures, tables, or sections.' },
  { name: '\\ref', insertText: '\\ref{${1:key}}', detail: 'Cross-reference', documentation: 'Inserts the numbered reference for the given label.' },
  { name: '\\eqref', insertText: '\\eqref{${1:eq:key}}', detail: 'Equation reference with parentheses', documentation: 'Inserts equation reference enclosed in parentheses, e.g. (1).' },
  { name: '\\cite', insertText: '\\cite{${1:citation_key}}', detail: 'Bibliographic citation', documentation: 'Inserts a citation corresponding to a BibTeX bibliography entry.' },
  { name: '\\bibliographystyle', insertText: '\\bibliographystyle{${1:plain}}', detail: 'Bibliography style', documentation: 'Sets the formatting style for references (plain, unsrt, alpha, abbrv, ieeetr).' },
  { name: '\\bibliography', insertText: '\\bibliography{${1:references}}', detail: 'Include BibTeX file', documentation: 'Loads bibliography data from a .bib file.' },
  { name: '\\footnote', insertText: '\\footnote{${1:Footnote text.}}', detail: 'Numbered footnote', documentation: 'Inserts an automatically numbered footnote at the bottom of the page.' },
  { name: '\\url', insertText: '\\url{${1:https://}}', detail: 'Clickable URL link', documentation: 'Typesets a raw URL as a clickable link (hyperref package).' },
  { name: '\\href', insertText: '\\href{${1:https://}}{${2:link_text}}', detail: 'Hyperlink with text', documentation: 'Creates a hyperlink with custom anchor text (hyperref package).' },

  // CV & Resume (CurVe class)
  { name: '\\makeheaders', insertText: '\\makeheaders[${1:c}]', detail: 'Render CV header block', documentation: 'Typesets left and right CV header blocks with alignment option (c, l, r).' },
  { name: '\\makerubric', insertText: '\\makerubric{${1:rubric_file}}', detail: 'Include CV rubric section', documentation: 'Includes and typesets a modular CV section/rubric file (CurVe class).' },
  { name: '\\photo', insertText: '\\photo[${1:r}]{${2:photo_path}}', detail: 'CV portrait photo', documentation: 'Inserts a portrait photo with position option (l, r) in CurVe headers.' },
  { name: '\\photoscale', insertText: '\\photoscale{${1:0.2}}', detail: 'Scale factor for CV photo', documentation: 'Sets the scaling multiplier for the CV portrait photograph.' },
  { name: '\\entry*', insertText: '\\entry*[${1:date}]\n\t${2:Description}', detail: 'CV timeline entry item', documentation: 'Adds a key-aligned timeline entry item in CurVe rubric environments.' },
  { name: '\\justifying', insertText: '\\justifying', detail: 'Fully justified text alignment', documentation: 'Enforces full paragraph justification with hyphenation (ragged2e package).' },

  // Modern Icons (FontAwesome & SimpleIcons)
  { name: '\\faEnvelope', insertText: '\\faEnvelope', detail: 'FontAwesome envelope icon', documentation: 'Renders an email envelope icon (fontawesome5).' },
  { name: '\\faLinkedin', insertText: '\\faLinkedin', detail: 'FontAwesome LinkedIn icon', documentation: 'Renders a LinkedIn brand icon (fontawesome5).' },
  { name: '\\faPhone', insertText: '\\faPhone', detail: 'FontAwesome telephone icon', documentation: 'Renders a phone receiver icon (fontawesome5).' },
  { name: '\\faGithub', insertText: '\\faGithub', detail: 'FontAwesome GitHub icon', documentation: 'Renders a GitHub brand icon (fontawesome5).' },
  { name: '\\faGlobe', insertText: '\\faGlobe', detail: 'FontAwesome globe icon', documentation: 'Renders a globe / web URL icon (fontawesome5).' },
  { name: '\\simpleicon', insertText: '\\simpleicon{${1:brand}}', detail: 'SimpleIcons brand logo', documentation: 'Renders a brand icon by name from the embedded SimpleIcons suite (e.g. \\simpleicon{x}, \\simpleicon{python}).' },
];

export const LATEX_ENVIRONMENTS: LatexEnvironment[] = [
  {
    name: 'equation',
    detail: 'Numbered equation',
    documentation: 'Centered display mathematical equation with automatic numbering.',
    snippet: '\\begin{equation}\n\t\\label{eq:${1:label}}\n\t${2:E = mc^2}\n\\end{equation}',
  },
  {
    name: 'equation*',
    detail: 'Unnumbered equation',
    documentation: 'Centered display mathematical equation without number (amsmath).',
    snippet: '\\begin{equation*}\n\t${1:E = mc^2}\n\\end{equation*}',
  },
  {
    name: 'align',
    detail: 'Aligned equations (numbered)',
    documentation: 'Multiline equations aligned by ampersands (&) with automatic numbering on each line.',
    snippet: '\\begin{align}\n\t\\label{eq:${1:label}}\n\t${2:f(x)} &= ${3:ax^2 + bx + c} \\\\\n\t${4:g(x)} &= ${5:2ax + b}\n\\end{align}',
  },
  {
    name: 'align*',
    detail: 'Aligned equations (unnumbered)',
    documentation: 'Multiline equations aligned by ampersands without numbering.',
    snippet: '\\begin{align*}\n\t${1:f(x)} &= ${2:ax^2 + bx + c} \\\\\n\t${3:g(x)} &= ${4:2ax + b}\n\\end{align*}',
  },
  {
    name: 'figure',
    detail: 'Floating figure',
    documentation: 'Floating container for figures and graphics with caption and label.',
    snippet: '\\begin{figure}[htbp]\n\t\\centering\n\t% \\includegraphics[width=0.8\\textwidth]{${1:image_path}}\n\t\\caption{${2:Figure description.}}\n\t\\label{fig:${3:label}}\n\\end{figure}',
  },
  {
    name: 'table',
    detail: 'Floating table',
    documentation: 'Floating container for tabular data with caption and label.',
    snippet: '\\begin{table}[htbp]\n\t\\centering\n\t\\caption{${1:Table description.}}\n\t\\label{tab:${2:label}}\n\t\\begin{tabular}{${3:c c c}}\n\t\t\\hline\n\t\t${4:Header 1} & ${5:Header 2} & ${6:Header 3} \\\\\n\t\t\\hline\n\t\t${7:Data 1} & ${8:Data 2} & ${9:Data 3} \\\\\n\t\t\\hline\n\t\\end{tabular}\n\\end{table}',
  },
  {
    name: 'tabular',
    detail: 'Tabular alignment grid',
    documentation: 'Table grid alignment with columns (l=left, c=center, r=right).',
    snippet: '\\begin{tabular}{${1:l c r}}\n\t\\hline\n\t${2:Col 1} & ${3:Col 2} & ${4:Col 3} \\\\\n\t\\hline\n\t${5:Val 1} & ${6:Val 2} & ${7:Val 3} \\\\\n\t\\hline\n\\end{tabular}',
  },
  {
    name: 'itemize',
    detail: 'Unordered bulleted list',
    documentation: 'Creates an unordered list with bullet points.',
    snippet: '\\begin{itemize}\n\t\\item ${1:First item}\n\t\\item ${2:Second item}\n\\end{itemize}',
  },
  {
    name: 'enumerate',
    detail: 'Ordered numbered list',
    documentation: 'Creates a sequential list with automatic numbering (1, 2, 3...).',
    snippet: '\\begin{enumerate}\n\t\\item ${1:First step}\n\t\\item ${2:Second step}\n\\end{enumerate}',
  },
  {
    name: 'description',
    detail: 'Descriptive term list',
    documentation: 'List where each item starts with a bold defined term [term].',
    snippet: '\\begin{description}\n\t\\item[${1:Term 1}] ${2:Definition 1}\n\t\\item[${3:Term 2}] ${4:Definition 2}\n\\end{description}',
  },
  {
    name: 'pmatrix',
    detail: 'Matrix with parentheses ()',
    documentation: 'amsmath matrix enclosed in round parentheses.',
    snippet: '\\begin{pmatrix}\n\t${1:a_{11}} & ${2:a_{12}} \\\\\n\t${3:a_{21}} & ${4:a_{22}}\n\\end{pmatrix}',
  },
  {
    name: 'bmatrix',
    detail: 'Matrix with brackets []',
    documentation: 'amsmath matrix enclosed in square brackets.',
    snippet: '\\begin{bmatrix}\n\t${1:1} & ${2:0} \\\\\n\t${3:0} & ${4:1}\n\\end{bmatrix}',
  },
  {
    name: 'theorem',
    detail: 'Theorem environment',
    documentation: 'Formal theorem statement environment (amsthm).',
    snippet: '\\begin{theorem}[${1:Theorem Name}]\n\t\\label{thm:${2:label}}\n\t${3:Let $f: X \\to Y$ be a continuous mapping...}\n\\end{theorem}',
  },
  {
    name: 'proof',
    detail: 'Mathematical proof',
    documentation: 'Proof environment with end-of-proof QED square symbol (amsthm).',
    snippet: '\\begin{proof}\n\t${1:Let $\\epsilon > 0$ be arbitrary...}\n\\end{proof}',
  },
  {
    name: 'abstract',
    detail: 'Paper abstract section',
    documentation: 'Synopsis / abstract section for academic articles.',
    snippet: '\\begin{abstract}\n\t${1:This paper presents a study on...}\n\\end{abstract}',
  },
];

export const DEFAULT_LATEX_SOURCE = `\\documentclass[12pt,a4paper]{article}

% Core mathematical and typography packages
\\usepackage{amsmath,amssymb,amsfonts,amsthm}
\\usepackage{geometry}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{hyperref}

\\geometry{margin=2.5cm}

% Theorem environments
\\newtheorem{theorem}{Theorem}[section]
\\newtheorem{lemma}[theorem]{Lemma}
\\newtheorem{definition}[theorem]{Definition}

\\hypersetup{
    colorlinks=true,
    linkcolor=blue,
    citecolor=blue,
    urlcolor=blue
}

\\title{\\textbf{ScienceBatch Showcase \\& Technical Tutorial}}
\\author{\\textbf{ScienceBatch Research Group} \\\\ Department of Computer Science and Applied Mathematics \\\\ \\small \\texttt{research@sciencebatch.internal}}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
This document serves as both an interactive test suite and an architectural tutorial for \\textbf{ScienceBatch}. Powered by the \\textit{Tectonic} XeTeX in-memory engine and Rust-native \\textit{Typst}, ScienceBatch executes 100\\% offline typesetting directly in RAM VFS without disk pollution. This showcase demonstrates section hierarchies (H1--H3), single and multi-line equations, matrix algebra, formal theorems, publication-grade tables, graphics, dynamic assets, code listings, and automated BibTeX citations.
\\end{abstract}

\\section{Introduction \\& System Architecture}
\\label{sec:intro}

LaTeX remains the standard for rigorous scientific publication and mathematical typography. In \\textbf{ScienceBatch}, compilation is strictly on-demand, triggered via the global keyboard shortcut \\texttt{Ctrl + S} (or \\texttt{Cmd + S} on macOS) or the \\textbf{Compile} button in the primary toolbar.

\\subsection{Compilation Pipeline}
\\label{subsec:pipeline}

Unlike traditional TeX distributions requiring multi-gigabyte installations and writing intermediate auxiliary files (\\texttt{.aux}, \\texttt{.log}, \\texttt{.toc}) to the disk, ScienceBatch processes LaTeX source in RAM. Raw PDF bytes are returned to the frontend and rendered on hardware-accelerated canvas elements without screen flicker.

\\subsubsection{Isolated Worker Subprocess}
\\label{subsubsec:isolated-worker}

To guarantee that malformed TeX macros or C library faults cannot crash the desktop application, the typesetting engine runs in an isolated child process using asynchronous IPC pipes.

\\section{Mathematical Physics \\& Advanced Equations}
\\label{sec:math}

Mathematical formulations can be placed inline, such as Euler's identity $e^{i\\pi} + 1 = 0$, the Gaussian integral $\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}$, or the fundamental limit $\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$.

\\subsection{Numbered Display Equations}
\\label{subsec:equations}

Single-line equations are declared with the \\texttt{equation} environment and cross-referenced with \\texttt{\\textbackslash eqref\\{...\\}}, as demonstrated in Einstein's mass-energy equivalence in Eq.~\\eqref{eq:einstein}:

\\begin{equation}
\\label{eq:einstein}
E = m c^2
\\end{equation}

\\subsection{Aligned Multi-Line Field Equations}
\\label{subsec:maxwell}

Coupled differential equations, such as Maxwell's equations in microscopic differential form, are typeset using the \\texttt{align} environment in Eq.~\\eqref{eq:maxwell-gauss}--\\eqref{eq:maxwell-ampere}:

\\begin{align}
\\label{eq:maxwell-gauss}
\\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\varepsilon_0} \\\\[6pt]
\\label{eq:maxwell-faraday}
\\nabla \\times \\mathbf{E} &= -\\frac{\\partial \\mathbf{B}}{\\partial t} \\\\[6pt]
\\label{eq:maxwell-mag}
\\nabla \\cdot \\mathbf{B} &= 0 \\\\[6pt]
\\label{eq:maxwell-ampere}
\\nabla \\times \\mathbf{B} &= \\mu_0 \\mathbf{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}
\\end{align}

\\subsection{Linear Algebra \\& Coordinate Rotations}
\\label{subsec:algebra}

Planar coordinate transformations and linear operators are expressed cleanly through matrix environments as shown in Eq.~\\eqref{eq:rotation}:

\\begin{equation}
\\label{eq:rotation}
\\begin{bmatrix}
x' \\\\[3pt]
y'
\\end{bmatrix}
=
\\begin{bmatrix}
\\cos\\theta & -\\sin\\theta \\\\[3pt]
\\sin\\theta & \\cos\\theta
\\end{bmatrix}
\\begin{bmatrix}
x \\\\[3pt]
y
\\end{bmatrix}
\\end{equation}

\\subsection{Formal Theorems \\& Proofs}
\\label{subsec:theorems}

Academic environments are styled consistently and integrate into document structure:

\\begin{theorem}[Fundamental Theorem of Calculus]
\\label{thm:ftc}
Let $f: [a, b] \\to \\mathbb{R}$ be a continuous real-valued function, and let $F$ be an antiderivative of $f$ on $[a, b]$. Then:
\\begin{equation}
\\label{eq:ftc}
\\int_{a}^{b} f(x) \\, dx = F(b) - F(a)
\\end{equation}
\\end{theorem}

\\begin{proof}
By partitioning $[a, b]$ into $n$ subintervals and applying the Mean Value Theorem to $F$ on each subinterval, the Riemann sum converges uniformly to $F(b) - F(a)$ as $n \\to \\infty$.
\\end{proof}

\\section{Structured Tabular Data \\& Benchmarks}
\\label{sec:tables}

Tables are formatted using the professional \\texttt{booktabs} package with distinct header, mid-level, and bottom rules. Table~\\ref{tab:benchmarks} summarizes key architectural metrics:

\\begin{table}[htbp]
\\centering
\\caption{Comprehensive comparison between typesetting engines in ScienceBatch.}
\\label{tab:benchmarks}
\\begin{tabular}{lcccr}
\\toprule
\\textbf{Feature} & \\textbf{LaTeX (Tectonic)} & \\textbf{Typst (Rust)} & \\textbf{ScienceBatch VFS} & \\textbf{Speedup} \\\\
\\midrule
Compilation Engine & XeTeX RAM VFS & Native Rust Engine & Zero Disk I/O & $10\\times$ \\\\
Cold Start Latency & $< 1.2\\text{ s}$ & $< 0.05\\text{ s}$ & In-Memory Bundle & Instant \\\\
Mathematical Syntax & TeX Macro System & Modern Declarative & Unified Preview & Dynamic \\\\
Graphics Support & PNG, JPEG, PDF & PNG, SVG, GIF & Base64 Inlined & Seamless \\\\
Multi-File Resolver & \\texttt{\\textbackslash input}, \\texttt{\\textbackslash include} & \\texttt{\\#include} & Relative Resolver & Automatic \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\section{Graphics, Figures, and Multimedia Assets}
\\label{sec:figures}

Visual figures are embedded using the \\texttt{graphicx} package inside \\texttt{figure} environments. The image in Fig.~\\ref{fig:banner} illustrates the dual-engine architecture:

\\begin{figure}[htbp]
\\centering
\\includegraphics[width=0.7\\textwidth]{assets/sample.png}
\\caption{ScienceBatch Studio: high-performance desktop typesetting architecture and dual engine pipeline.}
\\label{fig:banner}
\\end{figure}

\\subsection{Dynamic Multimedia \\& Web Export}
\\label{subsec:multimedia}

In traditional PDF publication, standard TeX engines embed static vector and raster graphics (PNG, JPEG, PDF) as shown in Fig.~\\ref{fig:banner}.
When exporting to modern standalone HTML documents via ScienceBatch, multimedia assets including animated GIFs (such as \\texttt{assets/sample.gif}) are automatically encoded as base64 data URIs, delivering fully animated, offline-ready web publications.

\\section{Source Code Listings}
\\label{sec:code}

Source code snippets can be included directly for documentation or reproducibility:

\\begin{verbatim}
// Rust asynchronous IPC event emission
app_handle.emit("compilation-progress", ProgressPayload {
    status: "compiling".into(),
    message: "Processing LaTeX source in memory...".into(),
})?;
\\end{verbatim}

\\section{Lists and Itemization}
\\label{sec:lists}

Features are structured using nested unordered and ordered lists:

\\begin{itemize}
    \\item \\textbf{Zero Configuration Setup:}
    \\begin{enumerate}
        \\item Embedded TeX package bundle handles core packages automatically.
        \\item Automatic BibTeX and font discovery.
    \\end{enumerate}
    \\item \\textbf{Multi-Target Document Export:}
    \\begin{itemize}
        \\item Standalone HTML with KaTeX and responsive CSS tables.
        \\item GitHub Flavored Markdown (GFM) with preserved math and clean headers.
    \\end{itemize}
\\end{itemize}

\\section{Citations and Bibliographic References}
\\label{sec:citations}

Citations link directly to the project's \\texttt{references.bib} file. For instance, relativistic physics was revolutionized in the landmark 1905 paper by Einstein~\\cite{einstein1905}.
Cross-referencing ties the paper together: Section~\\ref{sec:math} formulates Eq.~\\eqref{eq:einstein}, Section~\\ref{sec:tables} details Table~\\ref{tab:benchmarks}, and Section~\\ref{sec:figures} introduces Fig.~\\ref{fig:banner}.

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`;

