import type * as monacoType from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';
import { LATEX_COMMANDS } from './latexData';
import { getProjectCustomCommands } from './projectContext';

const ALIGNMENT_ENVIRONMENTS = new Set([
  'align',
  'align*',
  'tabular',
  'tabular*',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'matrix',
  'vmatrix',
  'Vmatrix',
  'cases',
  'array',
  'alignat',
  'alignat*',
  'gather',
  'gather*',
  'multline',
  'multline*',
]);

const MATH_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
  'alignat',
  'alignat*',
  'split',
  'cases',
  'dcases',
  'rcases',
  'drcases',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix',
  'array',
  'displaymath',
  'math',
  'subequations',
]);

const VERBATIM_ENVIRONMENTS = new Set([
  'verbatim',
  'verbatim*',
  'lstlisting',
  'minted',
  'comment',
  'filecontents',
  'filecontents*',
  'verbatimtab',
  'verbatimwrite',
  'rawhtml',
]);

// Build master dictionary of known standard LaTeX commands
const BUILTIN_COMMANDS = new Set<string>();

// 1. Populate from LATEX_COMMANDS data
for (const item of LATEX_COMMANDS) {
  const clean = item.name.replace(/^\\/, '');
  BUILTIN_COMMANDS.add(clean);
}

// 2. Add comprehensive standard TeX/LaTeX primitives, AMS math, typography, graphics, and layout
const ADDITIONAL_COMMANDS = [
  // Document structure & environments
  'begin', 'end', 'documentclass', 'usepackage', 'geometry', 'title', 'author', 'date', 
  'today', 'thanks', 'and', 'maketitle', 'tableofcontents', 'listoffigures', 'listoftables',
  'appendix', 'pagenumbering', 'pagestyle', 'thispagestyle', 'setcounter', 'addtocounter',
  'stepcounter', 'refstepcounter', 'newcounter', 'value', 'newpage', 'clearpage', 'cleardoublepage',
  'centering', 'raggedright', 'raggedleft', 'flushleft', 'flushright', 'center', 'item',
  'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'part', 'chapter',
  'frontmatter', 'mainmatter', 'backmatter', 'markboth', 'markright', 'abstract',

  // Author affiliation & metadata
  'affiliation', 'affil', 'institute', 'institution', 'email', 'keywords', 'subtitle',

  // Standard text symbols & escapes
  'textbackslash', 'textasciitilde', 'textasciicircum', 'textbar', 'textgreater', 'textless',
  'textunderscore', 'textendash', 'textemdash', 'textregistered', 'texttrademark', 'textcopyright',
  'textdegree', 'textbullet', 'textperiodcentered', 'copyright', 'pounds', 'dag', 'ddag', 'S', 'P',
  'TeX', 'LaTeX', 'LaTeXe', 'XeTeX', 'XeLaTeX', 'LuaTeX', 'LuaLaTeX', 'slash', 'backslash',
  'lq', 'rq',

  // Cross references, citations & bibliographies
  'label', 'ref', 'pageref', 'eqref', 'autoref', 'nameref', 'cref', 'Cref', 'crefrange', 'cpageref',
  'cite', 'citep', 'citet', 'nocite', 'citealp', 'citeauthor', 'citeyear', 'footcite', 'fullcite',
  'bibliographystyle', 'bibliography', 'printbibliography', 'addbibresource', 'bibitem',
  'footnote', 'footnotemark', 'footnotetext', 'caption', 'captionof', 'captionsetup', 'subcaption', 'subfloat',
  'rule',

  // Spacing & layout
  'vspace', 'hspace', 'vfill', 'hfill', 'quad', 'qquad', 'enspace', 'thinspace', 'negthinspace',
  'kern', 'hskip', 'vskip', 'mskip', 'hrule', 'vrule', 'hrulefill', 'dotfill', 'leaders',
  'bigskip', 'medskip', 'smallskip', 'noindent', 'indent', 'par', 'linebreak', 'nolinebreak',
  'pagebreak', 'nopagebreak', 'newline', 'sloppy', 'fussy', 'hyphenation',

  // Boxes & minipages
  'mbox', 'makebox', 'fbox', 'framebox', 'parbox', 'minipage', 'savebox', 'sbox', 'usebox',
  'newsavebox', 'raisebox', 'phantom', 'hphantom', 'vphantom',

  // Macro definitions & primitives
  'newcommand', 'renewcommand', 'providecommand', 'newenvironment', 'renewenvironment',
  'DeclareMathOperator', 'def', 'let', 'futurelet', 'edef', 'gdef', 'xdef', 'input', 'include', 'includeonly',
  'hypersetup', 'href', 'url', 'nolinkurl', 'hyperlink', 'hypertarget', 'autopageref',
  'setlength', 'addtolength', 'settowidth', 'settoheight', 'settodepth', 'newlength',
  'newtheorem', 'theoremstyle', 'proof', 'qedsymbol',
  'color', 'textcolor', 'colorbox', 'fcolorbox', 'definecolor', 'pagecolor', 'colorlet',
  'PassOptionsToPackage', 'ProvidesPackage', 'ProvidesClass', 'RequirePackage', 'LoadClass',
  'lstset', 'lstinline', 'lstdefinestyle', 'lstinputlisting', 'verb', 'linespread', 'fontsize', 'selectfont',
  'relax', 'bgroup', 'egroup', 'begingroup', 'endgroup', 'expandafter', 'noexpand', 'csname', 'endcsname',
  'string', 'meaning', 'the', 'number',

  // Math operators, calculus & symbols
  'frac', 'dfrac', 'tfrac', 'cfrac', 'sqrt', 'surd', 'sum', 'prod', 'coprod', 'int', 'iint', 'iiint',
  'iiiint', 'idotsint', 'oint', 'lim', 'limsup', 'liminf', 'sin', 'cos', 'tan', 'cot', 'sec',
  'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp',
  'deg', 'det', 'dim', 'gcd', 'hom', 'ker', 'inf', 'sup', 'max', 'min', 'arg', 'Pr', 'bmod',
  'pmod', 'pod', 'operatorname', 'operatorname*', 'partial', 'nabla', 'infty', 'aleph', 'beth', 'gimel', 'daleth',
  'hbar', 'ell', 'wp', 'Re', 'Im', 'top', 'bot', 'emptyset', 'varnothing', 'forall', 'exists', 'nexists',
  'neg', 'sim', 'simeq', 'cong', 'approx', 'equiv', 'propto', 'le', 'leq', 'leqslant', 'ge', 'geq', 'geqslant',
  'll', 'gg', 'ne', 'neq', 'subset', 'supset', 'subseteq', 'supseteq', 'nsubseteq', 'nsupseteq',
  'in', 'notin', 'ni', 'owns', 'cup', 'cap', 'setminus', 'times', 'cdot', 'circ', 'bullet', 'div', 'pm', 'mp',
  'ast', 'star', 'oplus', 'ominus', 'otimes', 'oslash', 'odot', 'vee', 'wedge', 'to',
  'rightarrow', 'leftarrow', 'Rightarrow', 'Leftarrow', 'leftrightarrow', 'Leftrightarrow',
  'mapsto', 'iff', 'implies', 'longrightarrow', 'longleftarrow', 'Longrightarrow',
  'Longleftarrow', 'longleftrightarrow', 'Longleftrightarrow', 'hookrightarrow', 'hookleftarrow',
  'nearrow', 'searrow', 'swarrow', 'nwarrow', 'uparrow', 'downarrow', 'updownarrow', 'Uparrow',
  'Downarrow', 'Updownarrow', 'left', 'right', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr',
  'Biggl', 'Biggr', 'big', 'Big', 'bigg', 'Bigg', 'vec', 'hat', 'widehat', 'bar', 'tilde', 'widetilde',
  'dot', 'ddot', 'dddot', 'ddddot', 'acute', 'grave', 'check', 'breve', 'mathring', 'mathbf', 'mathit',
  'mathrm', 'mathsf', 'mathtt', 'mathcal', 'mathscr', 'mathbb', 'mathfrak', 'boldsymbol', 'bm',
  'text', 'intertext', 'shortintertext', 'tag', 'notag', 'over', 'atop', 'choose', 'underset',
  'overset', 'substack', 'binom', 'dbinom', 'tbinom', 'dots', 'cdots', 'vdots', 'ddots',
  'ldots', 'dotsb', 'dotsm', 'dotsi', 'dotso', 'prime', 'degree', 'angle', 'triangle',
  'perp', 'parallel', 'mid', 'overbrace', 'underbrace', 'overline',

  // Greek letters
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta',
  'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'varpi',
  'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi',
  'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi',
  'Psi', 'Omega',

  // Typography & font styling
  'tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE',
  'huge', 'Huge', 'textbf', 'textit', 'texttt', 'textsf', 'textrm', 'textmd', 'textup',
  'textsl', 'textsc', 'textnormal', 'underline', 'emph', 'bfseries', 'mdseries', 'itshape',
  'slshape', 'scshape', 'upshape', 'rmfamily', 'sffamily', 'ttfamily', 'normalfont',

  // Tables (booktabs, tabularx, multirow)
  'toprule', 'midrule', 'bottomrule', 'cmidrule', 'addlinespace', 'specialrule',
  'multicolumn', 'multirow', 'hline', 'cline', 'vline', 'newcolumntype',

  // Graphics (graphicx)
  'includegraphics', 'graphicspath', 'rotatebox', 'scalebox', 'reflectbox', 'resizebox',

  // TikZ / PGF
  'tikz', 'node', 'draw', 'fill', 'path', 'coordinate', 'clip', 'shade', 'filldraw',
  'shadedraw', 'usetikzlibrary', 'tikzset', 'pgfplotsset',

  // Common packages (siunitx, csquotes, dummy text, notes, algorithms)
  'SI', 'num', 'unit', 'ang', 'qty', 'enquote', 'textquote', 'lipsum', 'blindtext',
  'blinddocument', 'todo', 'missingfigure',

  // Beamer presentation commands
  'frame', 'frametitle', 'framesubtitle', 'pause', 'only', 'uncover', 'invisible',
  'alert', 'action', 'temporal', 'alt', 'usetheme', 'usecolortheme', 'usefonttheme',
  'useinnertheme', 'useoutertheme', 'setbeamertemplate', 'setbeamercolor', 'setbeamerfont',
  'transdissolve', 'transblindshorizontal',

  // Classic TeX primitives & legacy font switches
  'rm', 'sc', 'bf', 'it', 'sl', 'sf', 'tt', 'cal', 'mit', 'oldstyle',
  'lower', 'raise', 'hbox', 'vbox', 'vtop', 'vcenter', 'unhbox', 'unvbox', 'unhcopy', 'unvcopy',
  'strut', 'null', 'leavevmode', 'unskip', 'dimen', 'skip', 'count', 'advance', 'multiply', 'divide',
  'global', 'hss', 'vss', 'hfil', 'vfil', 'mkern',

  // LaTeX kernel commands & text symbols
  'DeclareRobustCommand', 'NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand', 'DeclareDocumentCommand',
  'textsuperscript', 'textsubscript', 'textdagger', 'textdaggerdbl',
  'orcidicon', 'orcidlink',

  // Standard dimensions & layout lengths
  'textwidth', 'linewidth', 'columnwidth', 'paperwidth', 'paperheight', 'textheight',
  'topmargin', 'headheight', 'headsep', 'footskip', 'oddsidemargin', 'evensidemargin',
  'marginparwidth', 'marginparsep', 'parindent', 'parskip', 'baselineskip', 'lineskip',
  'itemsep', 'parsep', 'topsep', 'partopsep',

  // Academic class commands (IEEEtran, ACM acmart, Springer llncs)
  'IEEEoverridecommandlockouts', 'IEEEauthorblockN', 'IEEEauthorblockA', 'IEEEpeerreviewmaketitle',
  'IEEEpubid', 'IEEEpubidadjcol', 'IEEEcompsocitemizethanks', 'IEEEQED', 'IEEEQEDopen', 'IEEEQEDclosed',
  'IEEEPARstart', 'IEEEauthorrefmark', 'IEEEbiography', 'IEEEbiographynophoto',
  'authornote', 'authornotemark', 'orcid', 'country', 'state', 'postcode', 'city', 'streetaddress',
  'setcopyright', 'acmPrice', 'acmDOI', 'acmYear', 'acmConference', 'acmBooktitle', 'acmVolume', 'acmNumber',
  'acmArticle', 'acmMonth', 'titlerunning', 'authorrunning', 'inst',

  // Tables & algorithms packages (makecell, algorithmic, algpseudocode)
  'makecell', 'thead', 'makegapedcells', 'cellspacetoplimit', 'cellspacebottomlimit', 'diagbox',
  'State', 'Statex', 'Procedure', 'EndProcedure', 'Function', 'EndFunction',
  'Require', 'Ensure', 'ForAll', 'EndFor', 'While', 'EndWhile', 'Repeat', 'Until', 'Loop', 'EndLoop',
  'Return', 'Call', 'algorithmicrequire', 'algorithmicensure',

  // CurVe CV document class
  'leftheader', 'rightheader', 'photo', 'photoscale', 'makeheaders', 'makerubric', 'subrubric',
  'entry', 'prefix', 'rubric', 'headerscale', 'rubricfont', 'subrubricfont',
  'subrubricalignment', 'rubricalignment', 'keyalignment', 'rubricspace', 'rubricafterspace',
  'subrubricspace', 'subrubricbeforespace',

  // SimpleIcons package
  'simpleicon',

  // TeX conditional primitives & control flow
  'else', 'fi', 'or', 'if', 'ifx', 'ifnum', 'ifdim', 'ifodd', 'ifvoid', 'ifhbox', 'ifvbox', 'ifcase', 'iftrue', 'iffalse', 'newif',

  // Packages (comment, ragged2e, biblatex extended, xpatch)
  'includecomment', 'excludecomment', 'specialcomment',
  'justifying', 'RaggedRight', 'Centering', 'RaggedLeft',
  'DefineBibliographyStrings', 'bibnamedelima', 'bibnamedelimi', 'defbibheading', 'defbibfilter',
  'AtBeginBibliography', 'AtEveryBibitem', 'DeclareFieldFormat', 'iffieldformatundef', 'iffieldundef', 'clearfield',
  'xpretofieldformat', 'xapptofieldformat',

  // Common FontAwesome icons (for Quick Fix suggestions)
  'faEnvelope', 'faEnvelopeO', 'faLinkedin', 'faLinkedinIn', 'faPhone', 'faPhoneAlt', 'faGlobe', 'faGlobeAmericas', 'faLink', 'faBookmark',
  'faGithub', 'faGithubAlt', 'faTwitter', 'faTwitterSquare', 'faGraduationCap', 'faIdCard', 'faIdCardAlt', 'faMapMarker', 'faMapMarkerAlt',
  'faFilePdf', 'faCalendar', 'faCalendarAlt', 'faExternalLinkAlt', 'faUser', 'faUsers', 'faHome', 'faCheck', 'faTimes', 'faStar',
  'faSearch', 'faBook', 'faCode', 'faTerminal', 'faQuestion', 'faInfo', 'faExclamation', 'faAngleRight', 'faAngleLeft',
  'faChevronRight', 'faChevronLeft', 'faArrowRight', 'faArrowLeft', 'faHeart', 'faTag', 'faTags', 'faDownload', 'faUpload',
  'faEye', 'faCog', 'faCogs', 'faWrench', 'faSlidersH', 'faOrcid', 'faResearchgate', 'faGoogle', 'faGoogleScholar',
];

for (const cmd of ADDITIONAL_COMMANDS) {
  BUILTIN_COMMANDS.add(cmd);
}

// Compute Damerau-Levenshtein distance (supports insertion, deletion, substitution, and adjacent transposition)
function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    d[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,       // deletion
        d[i][j - 1] + 1,       // insertion
        d[i - 1][j - 1] + cost // substitution
      );
      // Adjacent character transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// Find top closest valid commands ranked by distance and prefix relevance (up to maxCount)
function findTopMatches(cmd: string, candidates: Set<string>, maxCount = 3): string[] {
  const scored: { name: string; score: number }[] = [];

  for (const candidate of candidates) {
    if (Math.abs(candidate.length - cmd.length) > 2) continue;
    const dist = damerauLevenshtein(cmd, candidate);
    if (dist <= 2) {
      let score = dist * 10 + Math.abs(candidate.length - cmd.length);
      if (candidate.startsWith(cmd)) {
        // User typed an exact prefix of the command (e.g. textt -> texttt)
        score -= 6;
      } else if (cmd.startsWith(candidate)) {
        // Command is an exact prefix of user input (e.g. textt -> text)
        score -= 3;
      }
      scored.push({ name: candidate, score });
    }
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, maxCount).map((s) => s.name);
}

export function lintLatexDocument(
  model: monacoType.editor.ITextModel,
  monaco: Monaco
): void {
  const lineCount = model.getLineCount();
  const markers: monacoType.editor.IMarkerData[] = [];

  const fullText = model.getValue();

  // 1. Collect all \label{...} anchors in document for cross-reference validation
  const definedLabels = new Set<string>();
  const labelRegex = /\\label\{([^}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = labelRegex.exec(fullText)) !== null) {
    if (match[1]) {
      definedLabels.add(match[1].trim());
    }
  }

  // 2. Collect user-defined macros in document (\newcommand, \renewcommand, \providecommand, \def, \let, \DeclareMathOperator, \DeclareRobustCommand, LaTeX3 DocumentCommands, \newcounter)
  const userCommands = new Set<string>();
  const defRegex = /\\(?:(?:re|provide)?newcommand|DeclareMathOperator|DeclareRobustCommand|(?:New|Renew|Provide|Declare)DocumentCommand)\*?\s*\{?\\([a-zA-Z]+)\}?/g;
  while ((match = defRegex.exec(fullText)) !== null) {
    if (match[1]) userCommands.add(match[1]);
  }
  const defPrimRegex = /\\(?:def|let)\s*\\([a-zA-Z]+)/g;
  while ((match = defPrimRegex.exec(fullText)) !== null) {
    if (match[1]) userCommands.add(match[1]);
  }
  const counterRegex = /\\newcounter\s*\{([a-zA-Z]+)\}/g;
  while ((match = counterRegex.exec(fullText)) !== null) {
    if (match[1]) {
      userCommands.add(match[1]);
      userCommands.add(`the${match[1]}`);
    }
  }
  const newifRegex = /\\newif\s*\\if([a-zA-Z]+)/g;
  while ((match = newifRegex.exec(fullText)) !== null) {
    if (match[1]) {
      userCommands.add(`if${match[1]}`);
      userCommands.add(`${match[1]}true`);
      userCommands.add(`${match[1]}false`);
    }
  }

  // 3. Project-level custom macros extracted from workspace .cls and .sty files
  const projectCommands = getProjectCustomCommands();

  // Environment stack: [ { name: string, line: number, column: number } ]
  const envStack: { name: string; line: number; column: number }[] = [];
  let activeVerbatimEnv: string | null = null;
  let inDisplayBracketMath = false;
  let inDisplayDollarMath = false;

  for (let lineNum = 1; lineNum <= lineCount; lineNum++) {
    const rawLine = model.getLineContent(lineNum);

    // 1. If currently inside a multi-line verbatim block:
    if (activeVerbatimEnv !== null) {
      // Look for the matching closing tag without stripping comments (% is literal inside verbatim)
      const endPattern = new RegExp(`\\\\end\\{(${activeVerbatimEnv})\\}`);
      const endMatch = endPattern.exec(rawLine);
      if (!endMatch) {
        // Entire line is verbatim; bypass all checks
        continue;
      }

      // Verbatim block ends on this line! Pop matching environment from stack
      if (envStack.length > 0 && envStack[envStack.length - 1].name === activeVerbatimEnv) {
        envStack.pop();
      } else {
        const idx = envStack.map((e) => e.name).lastIndexOf(activeVerbatimEnv);
        if (idx !== -1) envStack.splice(idx, 1);
      }
      activeVerbatimEnv = null;
      // Bypass remaining checks on the line that closed verbatim
      continue;
    }

    // 2. Outside verbatim: strip comments (unescaped %)
    const unescapedPercent = /(?<!\\)%/.exec(rawLine);
    const line = unescapedPercent ? rawLine.substring(0, unescapedPercent.index) : rawLine;

    // Track \[ ... \] and $$ ... $$ display math delimiters across lines
    const wasInDisplayBracket = inDisplayBracketMath;
    const wasInDisplayDollar = inDisplayDollarMath;

    const openBracketIdx = line.indexOf('\\[');
    const closeBracketIdx = line.indexOf('\\]');
    if (inDisplayBracketMath) {
      if (closeBracketIdx !== -1) {
        inDisplayBracketMath = false;
      }
    } else {
      if (openBracketIdx !== -1 && closeBracketIdx === -1) {
        inDisplayBracketMath = true;
      }
    }

    const dollarMatches = line.match(/(?<!\\)\$\$/g);
    if (dollarMatches && dollarMatches.length % 2 !== 0) {
      inDisplayDollarMath = !inDisplayDollarMath;
    }

    // A. Check for \begin{env}
    const beginRegex = /\\begin\{([a-zA-Z*]+)\}/g;
    let bMatch: RegExpExecArray | null;
    while ((bMatch = beginRegex.exec(line)) !== null) {
      const envName = bMatch[1];
      envStack.push({
        name: envName,
        line: lineNum,
        column: bMatch.index + 1,
      });

      if (VERBATIM_ENVIRONMENTS.has(envName)) {
        activeVerbatimEnv = envName;
      }
    }

    // B. Check for \end{env}
    const endRegex = /\\end\{([a-zA-Z*]+)\}/g;
    let eMatch: RegExpExecArray | null;
    while ((eMatch = endRegex.exec(line)) !== null) {
      const endName = eMatch[1];
      if (envStack.length === 0) {
        markers.push({
          severity: monaco.MarkerSeverity.Error,
          message: `Unexpected '\\end{${endName}}' without matching '\\begin{${endName}}'`,
          startLineNumber: lineNum,
          startColumn: eMatch.index + 1,
          endLineNumber: lineNum,
          endColumn: eMatch.index + 1 + eMatch[0].length,
        });
      } else {
        const lastEnv = envStack.pop()!;
        if (lastEnv.name !== endName) {
          markers.push({
            severity: monaco.MarkerSeverity.Error,
            message: `Mismatched environment: '\\begin{${lastEnv.name}}' closed by '\\end{${endName}}'`,
            startLineNumber: lineNum,
            startColumn: eMatch.index + 1,
            endLineNumber: lineNum,
            endColumn: eMatch.index + 1 + eMatch[0].length,
          });
        }
      }

      if (activeVerbatimEnv === endName) {
        activeVerbatimEnv = null;
      }
    }

    // If a verbatim environment was opened on this line and remains active:
    if (activeVerbatimEnv !== null) {
      continue;
    }

    // Current active environments
    const isInsideAlignEnv = envStack.some((e) => ALIGNMENT_ENVIRONMENTS.has(e.name));
    const isInsideMathEnv =
      wasInDisplayBracket ||
      wasInDisplayDollar ||
      inDisplayBracketMath ||
      inDisplayDollarMath ||
      openBracketIdx !== -1 ||
      envStack.some((e) =>
        MATH_ENVIRONMENTS.has(e.name) ||
        e.name.includes('equation') ||
        e.name.includes('align') ||
        e.name.includes('gather') ||
        e.name.includes('matrix') ||
        e.name.includes('cases') ||
        e.name.includes('split') ||
        e.name.includes('multline') ||
        e.name.includes('math')
      );

    // C. Check for misplaced '&' outside alignment environments
    const ampersandRegex = /(?<!\\)&/g;
    let ampMatch: RegExpExecArray | null;
    while ((ampMatch = ampersandRegex.exec(line)) !== null) {
      if (!isInsideAlignEnv) {
        markers.push({
          severity: monaco.MarkerSeverity.Warning,
          message: `Misplaced alignment tab character '&'. Use '\\&' for a literal ampersand or place inside an alignment environment ('align', 'tabular', 'pmatrix').`,
          code: 'latex:misplaced-ampersand',
          startLineNumber: lineNum,
          startColumn: ampMatch.index + 1,
          endLineNumber: lineNum,
          endColumn: ampMatch.index + 2,
        });
      }
    }

    // D. Check for undefined \ref{...} and \eqref{...}
    const refRegex = /\\(eq)?ref\{([^}]+)\}/g;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = refRegex.exec(line)) !== null) {
      const refKey = rMatch[2].trim();
      if (!definedLabels.has(refKey)) {
        markers.push({
          severity: monaco.MarkerSeverity.Warning,
          message: `Undefined reference anchor: '\\ref{${refKey}}'. No matching '\\label{${refKey}}' found in document.`,
          startLineNumber: lineNum,
          startColumn: rMatch.index + 1,
          endLineNumber: lineNum,
          endColumn: rMatch.index + 1 + rMatch[0].length,
        });
      }
    }

    // E. Check for unescaped '_' in text mode (which causes '! Missing $ inserted')
    if (!isInsideMathEnv) {
      let lineForUnderscores = line;

      // 1. Mask inline verbatim: \verb|...|, \lstinline|...|
      lineForUnderscores = lineForUnderscores.replace(/\\(verb|lstinline)([\S])(.*?)\2/g, (_full, verbCmd, _del, inner) => {
        return `\\${verbCmd} ${' '.repeat(inner.length + 2)}`;
      });

      // 2. Mask commands with safe arguments that legitimately contain underscores
      lineForUnderscores = lineForUnderscores.replace(
        /\\(label|ref|eqref|cite[a-z]*|url|href|includegraphics|photo|makerubric|subfile|subimport|import|includepdf|bibliography|addbibresource|graphicspath|input|include|usepackage|documentclass|texttt|detokenize|definecolor)\*?(?:\[[^\]]*\])?\{([^}]+)\}/g,
        (_fullMatch, cmdName, argContent) => {
          return `\\${cmdName}{${' '.repeat(argContent.length)}}`;
        }
      );

      // 3. Mask display math on this line: \[ ... \] and $$ ... $$
      lineForUnderscores = lineForUnderscores.replace(/\\\[[\s\S]*?\\\]/g, (m) => ' '.repeat(m.length));
      lineForUnderscores = lineForUnderscores.replace(/\$\$[\s\S]*?\$\$/g, (m) => ' '.repeat(m.length));

      // 4. Mask inline math: \( ... \) and $ ... $
      lineForUnderscores = lineForUnderscores.replace(/\\\([\s\S]*?\\\)/g, (m) => ' '.repeat(m.length));
      lineForUnderscores = lineForUnderscores.replace(/(?<!\\)\$[^$\n]*?(?<!\\)\$/g, (m) => ' '.repeat(m.length));

      // 5. Detect unescaped underscores in plain text
      const underscoreRegex = /(?<!\\)_/g;
      let uMatch: RegExpExecArray | null;
      while ((uMatch = underscoreRegex.exec(lineForUnderscores)) !== null) {
        markers.push({
          severity: monaco.MarkerSeverity.Warning,
          message: `Unescaped underscore '_' in text mode. In LaTeX this triggers '! Missing $ inserted'. Use '\\_' for a literal underscore or wrap in math mode '$ ... $'.`,
          code: 'latex:unescaped-underscore',
          startLineNumber: lineNum,
          startColumn: uMatch.index + 1,
          endLineNumber: lineNum,
          endColumn: uMatch.index + 2,
        });
      }
    }

    // F. Check for command / macro typos (\command)
    // Mask contents of URLs, filepaths, and inline code to prevent false alarms
    let lineForCmds = line;

    // Mask \\ linebreaks with spaces so they don't attach to following word
    lineForCmds = lineForCmds.replace(/\\\\/g, '  ');

    // Mask non-macro arguments that contain slashes or words (e.g. \url{...}, \href{...}{...}, \includegraphics{...}, \photo{...}, \makerubric{...})
    lineForCmds = lineForCmds.replace(
      /\\(url|href|includegraphics|photo|makerubric|subfile|subimport|import|includepdf|bibliography|addbibresource|graphicspath|input|include|cite[a-z]*|label|ref|eqref)\*?(?:\[[^\]]*\])?\{([^}]+)\}/g,
      (_fullMatch, cmdName, argContent) => {
        return `\\${cmdName}{${' '.repeat(argContent.length)}}`;
      }
    );

    // Mask inline verbatim: \verb|...|, \lstinline|...|
    lineForCmds = lineForCmds.replace(/\\(verb|lstinline)([\S])(.*?)\2/g, (_full, verbCmd, _del, inner) => {
      return `\\${verbCmd} ${' '.repeat(inner.length + 2)}`;
    });

    const cmdRegex = /\\([a-zA-Z]+)/g;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = cmdRegex.exec(lineForCmds)) !== null) {
      const cmdName = cMatch[1];
      const startCol = cMatch.index + 1;
      const endCol = startCol + 1 + cmdName.length;

      // Ignore standard single-letter or common accent commands
      if (cmdName.length === 1 && /^[a-zA-Z]$/.test(cmdName)) {
        continue;
      }

      // FontAwesome universal namespace: \fa[A-Z][a-zA-Z0-9]* (e.g. \faEnvelope, \faLinkedin, \faPhone)
      if (cmdName.startsWith('fa') && cmdName.length >= 3 && /^[A-Z]/.test(cmdName.slice(2))) {
        continue;
      }

      if (!BUILTIN_COMMANDS.has(cmdName) && !userCommands.has(cmdName) && !projectCommands.has(cmdName)) {
        const allKnown = new Set<string>([...BUILTIN_COMMANDS, ...userCommands, ...projectCommands]);
        const suggestions = findTopMatches(cmdName, allKnown, 3);
        let tip = '';
        if (suggestions.length === 1) {
          tip = ` Did you mean '\\${suggestions[0]}'?`;
        } else if (suggestions.length === 2) {
          tip = ` Did you mean '\\${suggestions[0]}' or '\\${suggestions[1]}'?`;
        } else if (suggestions.length >= 3) {
          tip = ` Did you mean '\\${suggestions[0]}', '\\${suggestions[1]}', or '\\${suggestions[2]}'?`;
        }

        markers.push({
          severity: monaco.MarkerSeverity.Warning,
          message: `Unknown or misspelled LaTeX command: '\\${cmdName}'.${tip}`,
          code: suggestions.length > 0 ? `latex:typo:${suggestions.join(',')}` : undefined,
          startLineNumber: lineNum,
          startColumn: startCol,
          endLineNumber: lineNum,
          endColumn: endCol,
        });
      }
    }
  }

  // G. Mark any remaining unclosed environments on the stack
  for (const unclosed of envStack) {
    markers.push({
      severity: monaco.MarkerSeverity.Error,
      message: `Unclosed LaTeX environment: '\\begin{${unclosed.name}}' is missing a matching '\\end{${unclosed.name}}'.`,
      startLineNumber: unclosed.line,
      startColumn: unclosed.column,
      endLineNumber: unclosed.line,
      endColumn: unclosed.column + 7 + unclosed.name.length,
    });
  }

  // Publish diagnostics to Monaco Editor
  monaco.editor.setModelMarkers(model, 'latex-realtime-linter', markers);
}
