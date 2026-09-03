import type * as Monaco from 'monaco-editor';

export const BIBTEX_LANGUAGE_ID = 'bibtex';

export const bibtexLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
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
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ],
};

export const bibtexMonarchTokens: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.bib',

  keywords: [
    '@article',
    '@book',
    '@booklet',
    '@inbook',
    '@incollection',
    '@inproceedings',
    '@manual',
    '@mastersthesis',
    '@misc',
    '@phdthesis',
    '@proceedings',
    '@techreport',
    '@unpublished',
    '@online',
    '@software',
    '@dataset',
    '@string',
    '@preamble',
    '@comment',
  ],

  fields: [
    'author',
    'title',
    'journal',
    'year',
    'month',
    'volume',
    'number',
    'pages',
    'booktitle',
    'publisher',
    'editor',
    'series',
    'address',
    'edition',
    'organization',
    'institution',
    'school',
    'howpublished',
    'note',
    'doi',
    'url',
    'urldate',
    'isbn',
    'issn',
    'eprint',
    'archiveprefix',
    'primaryclass',
    'abstract',
    'keywords',
  ],

  tokenizer: {
    root: [
      // Comments
      [/%(.*)$/, 'comment'],

      // Entry type (@article, @book, etc.)
      [/@[a-zA-Z]+/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'keyword.other',
        },
      }],

      // Field names (author, title, etc.) followed by whitespace and '='
      [/([a-zA-Z_-]+)(\s*)(=)/, [
        {
          cases: {
            '$1@fields': 'type.identifier',
            '@default': 'variable.name',
          },
        },
        'white',
        'delimiter',
      ]],

      // Strings in double quotes
      [/"([^"\\]|\\.)*"/, 'string'],

      // Numbers
      [/\b\d+\b/, 'number'],

      // Citation keys and braces
      [/[{}()[\],]/, 'delimiter'],
    ],
  },
};

/**
 * Registers the BibTeX language and monarch tokenizer in Monaco Editor.
 */
export function registerBibtexLanguage(monaco: typeof Monaco) {
  const isRegistered = monaco.languages.getLanguages().some((lang) => lang.id === BIBTEX_LANGUAGE_ID);
  if (!isRegistered) {
    monaco.languages.register({
      id: BIBTEX_LANGUAGE_ID,
      extensions: ['.bib'],
      aliases: ['BibTeX', 'bibtex', 'bib'],
      mimetypes: ['text/x-bibtex'],
    });

    monaco.languages.setLanguageConfiguration(BIBTEX_LANGUAGE_ID, bibtexLanguageConfiguration);
    monaco.languages.setMonarchTokensProvider(BIBTEX_LANGUAGE_ID, bibtexMonarchTokens);
  }
}
