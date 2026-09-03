import type * as Monaco from 'monaco-editor';
import type { Monaco as MonacoInstance } from '@monaco-editor/react';

export const LATEX_LANGUAGE_ID = 'latex';

export const latexLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '%',
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '$', close: '$' },
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '$', close: '$' },
  ],
  wordPattern: /(-?\d*\.\d\w*)|(\\[a-zA-Z@]+|[\w]+)/,
};

export const latexMonarchTokens: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.latex',

  keywords: [
    '\\documentclass',
    '\\usepackage',
    '\\geometry',
    '\\hypersetup',
    '\\graphicspath',
    '\\tableofcontents',
    '\\listoffigures',
    '\\listoftables',
    '\\maketitle',
    '\\appendix',
    '\\pagenumbering',
    '\\newpage',
    '\\clearpage',
    '\\part',
    '\\chapter',
    '\\section',
    '\\subsection',
    '\\subsubsection',
    '\\paragraph',
    '\\subparagraph',
    '\\item',
    '\\bibliography',
    '\\bibliographystyle',
    '\\addbibresource',
    '\\input',
    '\\include',
  ],

  controlKeywords: [
    '\\newcommand',
    '\\renewcommand',
    '\\providecommand',
    '\\newenvironment',
    '\\renewenvironment',
    '\\def',
    '\\let',
    '\\setlength',
    '\\setcounter',
    '\\addtocounter',
    '\\newtheorem',
    '\\theoremstyle',
  ],

  referenceKeywords: [
    '\\label',
    '\\ref',
    '\\eqref',
    '\\pageref',
    '\\autoref',
    '\\hyperref',
    '\\cite',
    '\\citep',
    '\\citet',
    '\\citealp',
    '\\nocite',
    '\\url',
    '\\href',
  ],

  functionCommands: [
    '\\title',
    '\\author',
    '\\date',
    '\\thanks',
    '\\textbf',
    '\\textit',
    '\\underline',
    '\\texttt',
    '\\emph',
    '\\textsc',
    '\\textsf',
    '\\textrm',
    '\\text',
    '\\textcolor',
    '\\colorbox',
    '\\color',
    '\\vspace',
    '\\hspace',
    '\\hfill',
    '\\vfill',
    '\\quad',
    '\\qquad',
    '\\centering',
    '\\raggedright',
    '\\raggedleft',
    '\\includegraphics',
    '\\caption',
    '\\footnote',
    '\\footnotemark',
    '\\footnotetext',
  ],

  mathCommands: [
    '\\frac',
    '\\sqrt',
    '\\sum',
    '\\int',
    '\\iint',
    '\\iiint',
    '\\oint',
    '\\prod',
    '\\lim',
    '\\partial',
    '\\infty',
    '\\nabla',
    '\\cdot',
    '\\times',
    '\\pm',
    '\\mp',
    '\\leq',
    '\\geq',
    '\\neq',
    '\\approx',
    '\\equiv',
    '\\sim',
    '\\propto',
    '\\alpha',
    '\\beta',
    '\\gamma',
    '\\delta',
    '\\epsilon',
    '\\varepsilon',
    '\\zeta',
    '\\eta',
    '\\theta',
    '\\vartheta',
    '\\iota',
    '\\kappa',
    '\\lambda',
    '\\mu',
    '\\nu',
    '\\xi',
    '\\pi',
    '\\varpi',
    '\\rho',
    '\\varrho',
    '\\sigma',
    '\\varsigma',
    '\\tau',
    '\\upsilon',
    '\\phi',
    '\\varphi',
    '\\chi',
    '\\psi',
    '\\omega',
    '\\Gamma',
    '\\Delta',
    '\\Theta',
    '\\Lambda',
    '\\Xi',
    '\\Pi',
    '\\Sigma',
    '\\Upsilon',
    '\\Phi',
    '\\Psi',
    '\\Omega',
    '\\sin',
    '\\cos',
    '\\tan',
    '\\cot',
    '\\sec',
    '\\csc',
    '\\log',
    '\\ln',
    '\\exp',
    '\\det',
    '\\dim',
    '\\ker',
    '\\deg',
    '\\arg',
    '\\max',
    '\\min',
    '\\sup',
    '\\inf',
    '\\forall',
    '\\exists',
    '\\nexists',
    '\\in',
    '\\notin',
    '\\subset',
    '\\subseteq',
    '\\supset',
    '\\supseteq',
    '\\cap',
    '\\cup',
    '\\vee',
    '\\wedge',
    '\\neg',
    '\\to',
    '\\rightarrow',
    '\\leftarrow',
    '\\Rightarrow',
    '\\Leftarrow',
    '\\iff',
    '\\mapsto',
    '\\vec',
    '\\mathbf',
    '\\mathbb',
    '\\mathcal',
    '\\mathit',
    '\\mathrm',
    '\\mathsf',
    '\\bm',
  ],

  tokenizer: {
    root: [
      // Escaped characters (e.g. \%, \$, \&, \#, \_, \{, \})
      [/\\[%&$#{}_]/, 'constant.character.escape'],
      [/\\\\/, 'delimiter'],

      // Comments (% until end of line)
      [/%.*$/, 'comment'],

      // Verbatim block environment
      [/(\\begin)(\s*\{)(verbatim\*?|lstlisting\*?|minted)(\})/, [
        'keyword',
        'delimiter',
        'type.environment',
        { token: 'delimiter', next: '@verbatim' },
      ]],

      // Begin and End Environments
      [/(\\begin)(\s*\{)([^}]+)(\})/, [
        'keyword',
        'delimiter',
        'type.environment',
        'delimiter',
      ]],
      [/(\\end)(\s*\{)([^}]+)(\})/, [
        'keyword',
        'delimiter',
        'type.environment',
        'delimiter',
      ]],

      // Display math $$ ... $$
      [/\$\$/, { token: 'string.math', next: '@displaymath' }],

      // Display math \[ ... \]
      [/\\\[/, { token: 'string.math', next: '@displaymathbracket' }],

      // Inline math $ ... $
      [/\$/, { token: 'string.math', next: '@inlinemath' }],

      // Inline math \( ... \)
      [/\\\(/, { token: 'string.math', next: '@inlinemathparen' }],

      // Inline verbatim: \verb|...|
      [/\\verb\*?([^a-zA-Z0-9\s]).*?\1/, 'string.verbatim'],

      // Document structure & Preamble keywords
      [/\\[a-zA-Z@]+/, {
        cases: {
          '@keywords': 'keyword',
          '@controlKeywords': 'keyword.control',
          '@referenceKeywords': 'tag.reference',
          '@functionCommands': 'support.function',
          '@mathCommands': 'keyword.math',
          '@default': 'support.function',
        },
      }],

      // Dimensions & Numbers: 10pt, 2.5cm, 1.2em, 42
      [/\b\d+(\.\d+)?(pt|mm|cm|in|ex|em|bp|pc|sp)\b/, 'number'],
      [/\b\d+(\.\d+)?\b/, 'number'],

      // Delimiters & brackets
      [/[{}()[\]]/, '@brackets'],
      [/&/, 'delimiter'],

      // Normal text words: keep empty token so they inherit base document text color
      [/[^\\%${}()[\]\s\d&]+/, ''],
    ],

    displaymath: [
      [/\$\$/, { token: 'string.math', next: '@pop' }],
      [/\\[%&$#{}_]/, 'constant.character.escape'],
      [/\\[a-zA-Z@]+/, 'keyword.math'],
      [/\b\d+(\.\d+)?\b/, 'number.math'],
      [/[+\-*/=<>^_~|]/, 'operator.math'],
      [/[{}()[\]]/, 'delimiter'],
      [/[^$\\{}()[\]+\-*/=<>^_~|\d\s]+/, 'string.math'],
    ],

    displaymathbracket: [
      [/\\\]/, { token: 'string.math', next: '@pop' }],
      [/\\[%&$#{}_]/, 'constant.character.escape'],
      [/\\[a-zA-Z@]+/, 'keyword.math'],
      [/\b\d+(\.\d+)?\b/, 'number.math'],
      [/[+\-*/=<>^_~|]/, 'operator.math'],
      [/[{}()[\]]/, 'delimiter'],
      [/[^$\\{}()[\]+\-*/=<>^_~|\d\s]+/, 'string.math'],
    ],

    inlinemath: [
      [/\$/, { token: 'string.math', next: '@pop' }],
      [/\\[%&$#{}_]/, 'constant.character.escape'],
      [/\\[a-zA-Z@]+/, 'keyword.math'],
      [/\b\d+(\.\d+)?\b/, 'number.math'],
      [/[+\-*/=<>^_~|]/, 'operator.math'],
      [/[{}()[\]]/, 'delimiter'],
      [/[^$\\{}()[\]+\-*/=<>^_~|\d\s]+/, 'string.math'],
    ],

    inlinemathparen: [
      [/\\\)/, { token: 'string.math', next: '@pop' }],
      [/\\[%&$#{}_]/, 'constant.character.escape'],
      [/\\[a-zA-Z@]+/, 'keyword.math'],
      [/\b\d+(\.\d+)?\b/, 'number.math'],
      [/[+\-*/=<>^_~|]/, 'operator.math'],
      [/[{}()[\]]/, 'delimiter'],
      [/[^$\\{}()[\]+\-*/=<>^_~|\d\s]+/, 'string.math'],
    ],

    verbatim: [
      [/(\\end)(\s*\{)(verbatim\*?|lstlisting\*?|minted)(\})/, [
        'keyword',
        'delimiter',
        'type.environment',
        { token: 'delimiter', next: '@pop' },
      ]],
      [/.*$/, 'string.verbatim'],
    ],
  },
};

/**
 * Registers LaTeX language configuration and monarch tokens provider in Monaco.
 */
export function registerLatexLanguage(monaco: MonacoInstance | typeof Monaco): void {
  const languages = monaco.languages.getLanguages();
  if (!languages.some((lang) => lang.id === LATEX_LANGUAGE_ID)) {
    try {
      monaco.languages.register({
        id: LATEX_LANGUAGE_ID,
        extensions: ['.tex', '.latex', '.sty', '.cls', '.dtx', '.ltx'],
        aliases: ['LaTeX', 'latex', 'TeX', 'tex'],
        mimetypes: ['text/x-latex', 'text/x-tex'],
      });
    } catch {
      // Ignored if already registered
    }
  }

  monaco.languages.setLanguageConfiguration(LATEX_LANGUAGE_ID, latexLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider(LATEX_LANGUAGE_ID, latexMonarchTokens);
}
