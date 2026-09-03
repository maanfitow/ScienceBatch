import type * as MonacoEditor from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';

export const TYPST_LANGUAGE_ID = 'typst';

export const typstLanguageConfiguration: MonacoEditor.languages.LanguageConfiguration = {
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
    ['$', '$'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: '`', close: '`' },
    { open: '$', close: '$' },
    { open: '*', close: '*' },
    { open: '_', close: '_' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: '`', close: '`' },
    { open: '$', close: '$' },
    { open: '*', close: '*' },
    { open: '_', close: '_' },
  ],
  wordPattern: /(-?\d*\.\d\w*)|(#[a-zA-Z_]\w*|[a-zA-Z_]\w*)/,
};

export const typstMonarchTokens: MonacoEditor.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.typst',

  keywords: [
    'set',
    'show',
    'let',
    'import',
    'include',
    'return',
    'if',
    'else',
    'for',
    'while',
    'break',
    'continue',
    'context',
    'as',
    'in',
    'not',
    'and',
    'or',
    'none',
    'auto',
    'true',
    'false',
  ],

  builtinFunctions: [
    // Document & Page layout
    'page',
    'document',
    'paper',
    'margin',
    'par',
    'parbreak',
    'text',
    'heading',
    'align',
    'block',
    'box',
    'colbreak',
    'pagebreak',
    'v',
    'h',
    'place',
    'move',
    'rotate',
    'scale',
    'hide',
    'pad',
    'stack',
    'grid',
    'table',
    'columns',
    'rows',

    // Content & Structure
    'list',
    'enum',
    'terms',
    'highlight',
    'raw',
    'link',
    'label',
    'ref',
    'quote',
    'cite',
    'bibliography',
    'footnote',
    'figure',

    // Shapes & Visuals
    'rect',
    'circle',
    'ellipse',
    'line',
    'polygon',
    'path',
    'image',
    'pattern',
    'gradient',

    // Math
    'math',
    'equation',
    'accent',
    'attach',
    'binom',
    'cancel',
    'cases',
    'class',
    'display',
    'frac',
    'inline',
    'limits',
    'lr',
    'mat',
    'mid',
    'norm',
    'op',
    'overbracket',
    'overline',
    'primes',
    'quad',
    'root',
    'scripts',
    'sqrt',
    'stretch',
    'style',
    'tag',
    'underbracket',
    'underline',
    'vec',

    // Data, Types & Standard Library
    'calc',
    'rgb',
    'cmyk',
    'luma',
    'color',
    'json',
    'yaml',
    'csv',
    'xml',
    'datetime',
    'duration',
    'lorem',
    'type',
    'repr',
    'str',
    'int',
    'float',
    'bool',
    'array',
    'dict',
    'regex',
    'measure',
    'locate',
    'counter',
    'state',
    'query',
    'panic',
    'assert',
    'range',
    'lower',
    'upper',
  ],

  // Keywords used strictly inside code mode expressions
  codeKeywords: [
    'set',
    'show',
    'let',
    'import',
    'include',
    'return',
    'if',
    'else',
    'for',
    'while',
    'break',
    'continue',
    'context',
    'as',
    'in',
    'not',
    'and',
    'or',
    'none',
    'auto',
    'true',
    'false',
  ],

  tokenizer: {
    // 1. Root state: MARKUP MODE (Normal prose & document text)
    root: [
      // Comments
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],

      // Raw / Code blocks (multiline)
      [/```.*$/, { token: 'string.verbatim', next: '@rawblock' }],

      // Inline Code: `code`
      [/`[^`]*`/, 'string.verbatim'],

      // Headings: = Heading, == Subheading
      [/^(=+)(\s+)(.*)$/, ['tag', 'delimiter', 'keyword.heading']],

      // Math blocks: $ ... $
      [/\$/, { token: 'string.math', next: '@math' }],

      // Label anchor: <label>
      [/<[a-zA-Z0-9_:-]+>/, 'tag.label'],

      // Reference / citation: @label
      [/@[a-zA-Z0-9_:-]+/, 'tag.reference'],

      // Linebreaks in Typst
      [/\\\\/, 'delimiter'],

      // Bold and Italic markup
      [/\*[^*]+\*/, 'strong'],
      [/_[^_]+_/, 'emphasis'],

      // Strings in markup
      [/"([^"\\]|\\.)*"/, 'string'],

      // #set and #show rules: e.g. #set page(...) or #set math.equation(...) or #show heading: ...
      [/([#](?:set|show))(\s+)([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/, [
        'keyword',
        '',
        'support.function',
      ]],

      // Directives starting with # (e.g. #set, #show, #let, #import, #include, #if, #for)
      [/#(set|show|let|import|include|return|if|else|for|while|break|continue|context)\b/, 'keyword'],

      // Any function or element call starting with # (e.g. #align, #table, #text, #v, #h)
      [/#[a-zA-Z_]\w*/, 'support.function'],

      // Delimiters that transition into code mode
      [/\(/, { token: '@brackets', next: '@code' }],
      [/\{/, { token: '@brackets', next: '@code' }],
      [/\[/, '@brackets'],
      [/[}\])]/, '@brackets'],

      // Plain prose words: keep empty token so they inherit base document text color!
      // This prevents common words like "in", "for", "and", "or" from being falsely colored as keywords.
      [/[^#$/*_`=<@\\{}()[\]\s]+/, ''],
    ],

    // 2. Code state: CODE MODE (Inside parentheses, function arguments, dictionaries, arrays, code blocks)
    code: [
      // Comments inside code
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],

      // Strings
      [/"([^"\\]|\\.)*"/, 'string'],

      // Named arguments / parameters: e.g. "paper:", "fill:", "stroke:", "margin:", "columns:"
      // Strictly matched ONLY inside code mode!
      [/\b([a-zA-Z_]\w*)\s*(?=:)/, 'variable.parameter'],

      // Numbers with units: 10pt, 2.5cm, 100%, 12em, 1fr, 45deg
      [/\b\d+(\.\d+)?(pt|mm|cm|in|em|%|fr|deg|rad)\b/, 'number'],
      [/\b\d+(\.\d+)?\b/, 'number'],

      // Directives and functions with # inside code mode
      [/([#](?:set|show))(\s+)([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/, [
        'keyword',
        '',
        'support.function',
      ]],
      [/#(set|show|let|import|include|return|if|else|for|while|break|continue|context)\b/, 'keyword'],
      [/#[a-zA-Z_]\w*/, 'support.function'],

      // Dotted module function calls: e.g. math.equation(...), calc.round(...), rgb.lighten(...)
      [/\b([a-zA-Z_]\w*\.)+[a-zA-Z_]\w*(?=\s*\()/, 'support.function'],

      // Dotted property/module access: e.g. math.equation, color.red
      [/\b[a-zA-Z_]\w*\.[a-zA-Z_]\w*\b/, 'support.function'],

      // Function calls with opening parenthesis: e.g. page(...), rgb(...), bold(...)
      [/\b[a-zA-Z_]\w*(?=\s*\()/, {
        cases: {
          '@builtinFunctions': 'support.function',
          '@codeKeywords': 'keyword',
          '@default': 'support.function',
        },
      }],

      // Standalone keywords and constants inside code (e.g. if, else, for, in, and, or, not, auto, none, true, false)
      [/\b[a-zA-Z_]\w*\b/, {
        cases: {
          '@codeKeywords': 'keyword',
          '@builtinFunctions': 'support.function',
          '@default': 'variable',
        },
      }],

      // Delimiters & operators
      [/(=>|==|!=|<=|>=|\+=|-=|\*=|\/=|[-+*/=<>])/, 'operator'],
      [/[,;:]/, 'delimiter'],

      // Nested parentheses and braces in code
      [/\(/, { token: '@brackets', next: '@push' }],
      [/\)/, { token: '@brackets', next: '@pop' }],
      [/\{/, { token: '@brackets', next: '@push' }],
      [/\}/, { token: '@brackets', next: '@pop' }],

      // Content blocks [ ... ] inside code switch BACK to markup mode!
      [/\[/, { token: '@brackets', next: '@contentBlock' }],

      // Math inside code
      [/\$/, { token: 'string.math', next: '@math' }],
    ],

    // 3. Content Block state: MARKUP MODE (Inside [ ... ] in code arguments)
    contentBlock: [
      // Comments
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],

      // Raw / Code
      [/```.*$/, { token: 'string.verbatim', next: '@rawblock' }],
      [/`[^`]*`/, 'string.verbatim'],

      // Math
      [/\$/, { token: 'string.math', next: '@math' }],

      // Labels & References
      [/<[a-zA-Z0-9_:-]+>/, 'tag.label'],
      [/@[a-zA-Z0-9_:-]+/, 'tag.reference'],

      // Linebreaks
      [/\\\\/, 'delimiter'],

      // Bold and Italic
      [/\*[^*]+\*/, 'strong'],
      [/_[^_]+_/, 'emphasis'],

      // Directives and functions with #
      [/([#](?:set|show))(\s+)([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/, [
        'keyword',
        '',
        'support.function',
      ]],
      [/#(set|show|let|import|include|return|if|else|for|while|break|continue|context)\b/, 'keyword'],
      [/#[a-zA-Z_]\w*/, 'support.function'],

      // Delimiters
      [/\[/, { token: '@brackets', next: '@push' }],
      [/\]/, { token: '@brackets', next: '@pop' }],
      [/\(/, { token: '@brackets', next: '@code' }],
      [/\{/, { token: '@brackets', next: '@code' }],

      // Regular prose words in content block
      [/[^#$/*_`=<@\\{}()[\]\s]+/, ''],
    ],

    comment: [
      [/[^/*]+/, 'comment'],
      [/\/\*/, 'comment', '@push'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],

    math: [
      [/\$/, { token: 'string.math', next: '@pop' }],
      [/\\(\$|.)/, 'constant.character.escape'],
      [/\b\d+(\.\d+)?\b/, 'number.math'],
      [/[+\-*/=<>^_~|]/, 'operator.math'],
      [/\b(nabla|dot|times|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|sigma|phi|omega|Delta|Gamma|Theta|Lambda|Sigma|Phi|Omega|sum|integral|diff|approx|equiv|in|subset|supset|forall|exists)\b/, 'keyword.math'],
      [/\b(bold|italic|sqrt|frac|abs|floor|ceil|vec|mat|cal|frak)\s*(?=\()/, 'support.function'],
      [/[{}()[\]]/, 'delimiter'],
      [/[^$\\{}()[\]+\-*/=<>^_~|\d\s]+/, 'string.math'],
    ],

    rawblock: [
      [/```/, { token: 'string.verbatim', next: '@pop' }],
      [/.*$/, 'string.verbatim'],
    ],
  },
};

/**
 * Registers custom language support for Typst in Monaco Editor.
 * Includes Monarch tokenizer for high-precision syntax highlighting.
 */
export function registerTypstLanguageSupport(monaco: Monaco) {
  const languages = monaco.languages.getLanguages();
  if (!languages.some((l) => l.id === TYPST_LANGUAGE_ID)) {
    try {
      monaco.languages.register({
        id: TYPST_LANGUAGE_ID,
        extensions: ['.typ'],
        aliases: ['Typst', 'typst'],
        mimetypes: ['text/x-typst'],
      });
    } catch {
      // Already registered
    }
  }

  // Always update configuration and tokens provider to ensure latest rules are active
  monaco.languages.setLanguageConfiguration(TYPST_LANGUAGE_ID, typstLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider(TYPST_LANGUAGE_ID, typstMonarchTokens);
}

