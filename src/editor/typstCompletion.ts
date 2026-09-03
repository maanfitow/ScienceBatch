import type { Monaco } from '@monaco-editor/react';
import { 
  getProjectImages, 
  getProjectBibFiles, 
  getProjectSubfiles 
} from './projectContext';

let typstCompletionDisposable: { dispose: () => void } | null = null;

interface TypstCompletionItemDef {
  name: string;
  kind?: number;
  insertText: string; // without leading '#'
  detail: string;
  documentation: string;
}

const TYPST_COMPLETIONS: TypstCompletionItemDef[] = [
  // Templates & Page Setup
  {
    name: 'set page',
    insertText: 'set page(paper: "${1:a4}", margin: (x: ${2:2.5cm}, y: ${3:2.5cm}))\n',
    detail: 'Configure document page dimensions and margins',
    documentation: 'Configure page size, orientation, and margins.\n\nExample:\n`#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm))`',
  },
  {
    name: 'set text',
    insertText: 'set text(font: ("${1:DejaVu Sans}", "Libertinus Serif"), size: ${2:11pt}, lang: "${3:es}")\n',
    detail: 'Configure default text typography and language',
    documentation: 'Configure default document font family, size, and hyphenation language.',
  },
  {
    name: 'set par',
    insertText: 'set par(justify: ${1:true}, leading: ${2:0.65em})\n',
    detail: 'Configure paragraph justification and line spacing',
    documentation: 'Set paragraph alignment justification and line spacing (leading).',
  },
  {
    name: 'set math.equation',
    insertText: 'set math.equation(numbering: "${1:(1)}")\n',
    detail: 'Enable automatic equation numbering',
    documentation: 'Number math equations automatically for cross-referencing (@label).',
  },
  {
    name: 'set',
    insertText: 'set ${1:element}(${2:properties})\n',
    detail: 'Style rule: set element properties',
    documentation: 'Applies default styles or configuration to an element type throughout the document.',
  },
  {
    name: 'show',
    insertText: 'show ${1:target}: ${2:it => [...]}\n',
    detail: 'Transform or style rule',
    documentation: 'Customizes how elements of a certain type are displayed or rendered.',
  },
  {
    name: 'let',
    insertText: 'let ${1:name} = ${2:value}\n',
    detail: 'Variable or function declaration',
    documentation: 'Binds a value or defines a reusable function in Typst.',
  },
  {
    name: 'import',
    insertText: 'import "${1:file.typ}": ${2:*}\n',
    detail: 'Import module or items',
    documentation: 'Imports definitions, variables, or functions from another Typst module or package.',
  },
  {
    name: 'include',
    insertText: 'include "${1:file.typ}"\n',
    detail: 'Include subfile contents',
    documentation: 'Includes another Typst file directly into the document structure.',
  },
  {
    name: 'for',
    insertText: 'for ${1:item} in ${2:items} {\n  ${3}\n}\n',
    detail: 'For loop iteration',
    documentation: 'Iterates over an array, dictionary, or range to generate content dynamically.',
  },
  {
    name: 'if',
    insertText: 'if ${1:condition} {\n  ${2}\n} else {\n  ${3}\n}\n',
    detail: 'Conditional expression',
    documentation: 'Conditionally renders content or evaluates expressions based on a boolean condition.',
  },

  // Layout & Elements
  {
    name: 'align',
    insertText: 'align(${1|center,left,right,top,bottom|})[\n  ${2:Content}\n]\n',
    detail: 'Align block or inline content',
    documentation: 'Aligns content along the horizontal and vertical axes (e.g. center, left, right).',
  },
  {
    name: 'table',
    insertText: 'table(\n  columns: (${1:2}),\n  align: (${2:left, center}),\n  [${3:Header 1}], [${4:Header 2}],\n  [${5:Cell 1}], [${6:Cell 2}],\n)\n',
    detail: 'Structured tabular data',
    documentation: 'Creates publication-ready tables with customizable column widths, fills, and strokes.',
  },
  {
    name: 'grid',
    insertText: 'grid(\n  columns: (${1:1fr, 1fr}),\n  gutter: ${2:1em},\n  [${3:Left}], [${4:Right}],\n)\n',
    detail: 'Multi-column grid container',
    documentation: 'Lays out content in a responsive, multi-column grid with configurable gutter spacing.',
  },
  {
    name: 'figure',
    insertText: 'figure(\n  image("${1:path/to/image.png}", width: ${2:80%}),\n  caption: [${3:Description of figure}],\n) <${4:fig:label}>\n',
    detail: 'Numbered figure with caption & label',
    documentation: 'Creates a captioned, numbered figure (image, table, code) with automatic reference label.',
  },
  {
    name: 'image',
    insertText: 'image("${1:path/to/image.png}", width: ${2:80%})\n',
    detail: 'Embed image asset',
    documentation: 'Inserts an image file (PNG, JPEG, SVG) into the document flow.',
  },
  {
    name: 'text',
    insertText: 'text(size: ${1:12pt}, fill: ${2:rgb("#3b82f6")})[${3:Content}]',
    detail: 'Styled inline text',
    documentation: 'Applies inline font formatting, weight, color (fill), tracking, or styling to text.',
  },
  {
    name: 'rect',
    insertText: 'rect(width: ${1:100%}, height: ${2:2cm}, fill: ${3:rgb("#f1f5f9")}, radius: ${4:4pt})[\n  ${5:Content}\n]\n',
    detail: 'Rectangle box with optional fill and border',
    documentation: 'Draws a rectangle with customizable dimensions, fill color, and border radius.',
  },
  {
    name: 'circle',
    insertText: 'circle(radius: ${1:1cm}, fill: ${2:rgb("#3b82f6")})\n',
    detail: 'Circle shape',
    documentation: 'Draws a circle with specified radius and fill color.',
  },
  {
    name: 'line',
    insertText: 'line(length: ${1:100%}, stroke: ${2:0.5pt + luma(150)})\n',
    detail: 'Horizontal or angled line separator',
    documentation: 'Draws a line with specified length, angle, and stroke style.',
  },
  {
    name: 'block',
    insertText: 'block(fill: ${1:luma(240)}, inset: ${2:8pt}, radius: ${3:4pt})[\n  ${4:Content}\n]\n',
    detail: 'Styled block container',
    documentation: 'Creates a block-level container with margins, padding (inset), fill, and borders.',
  },
  {
    name: 'box',
    insertText: 'box(baseline: ${1:0%})[${2:Content}]',
    detail: 'Inline box container',
    documentation: 'Creates an inline container that flows alongside text without breaking lines.',
  },
  {
    name: 'v',
    insertText: 'v(${1:1em})\n',
    detail: 'Vertical spacing',
    documentation: 'Inserts vertical whitespace of a given length (pt, em, cm, etc.).',
  },
  {
    name: 'h',
    insertText: 'h(${1:1em})',
    detail: 'Horizontal spacing',
    documentation: 'Inserts horizontal whitespace of a given length.',
  },
  {
    name: 'pad',
    insertText: 'pad(x: ${1:1cm}, y: ${2:0.5cm})[${3:Content}]\n',
    detail: 'Add inner padding to content',
    documentation: 'Pads surrounding content with specified horizontal (x) and vertical (y) distances.',
  },
  {
    name: 'stack',
    insertText: 'stack(spacing: ${1:1em}, [${2:Item 1}], [${3:Item 2}])\n',
    detail: 'Stack multiple items with spacing',
    documentation: 'Arranges multiple items horizontally or vertically with consistent spacing.',
  },
  {
    name: 'colbreak',
    insertText: 'colbreak()\n',
    detail: 'Break column',
    documentation: 'Forces a break to the next column in a multi-column document.',
  },
  {
    name: 'pagebreak',
    insertText: 'pagebreak()\n',
    detail: 'Break page',
    documentation: 'Forces a page break to a new page.',
  },

  // Document Structure & Headings
  {
    name: 'heading',
    insertText: 'heading(level: ${1:1})[${2:Title}] <${3:sec:label}>\n',
    detail: 'Section heading with level',
    documentation: 'Creates a structural heading of specified level with optional reference anchor.',
  },
  {
    name: 'list',
    insertText: 'list([${1:First item}], [${2:Second item}])\n',
    detail: 'Bulleted list',
    documentation: 'Creates an unordered bulleted list.',
  },
  {
    name: 'enum',
    insertText: 'enum([${1:First item}], [${2:Second item}])\n',
    detail: 'Numbered list (enumeration)',
    documentation: 'Creates an ordered numbered list.',
  },
  {
    name: 'terms',
    insertText: 'terms([${1:Term}], [${2:Definition}])\n',
    detail: 'Description / terms list',
    documentation: 'Creates a definition list pairing terms with descriptions.',
  },
  {
    name: 'link',
    insertText: 'link("${1:https://}")[${2:Label}]',
    detail: 'Hyperlink to external URL',
    documentation: 'Creates a clickable hyperlink with custom display text.',
  },
  {
    name: 'quote',
    insertText: 'quote(attribution: [${1:Author}])[\n  ${2:Quote text}\n]\n',
    detail: 'Block quotation with attribution',
    documentation: 'Inserts a block quote with optional author attribution.',
  },
  {
    name: 'footnote',
    insertText: 'footnote[${1:Footnote text}]',
    detail: 'Footnote reference',
    documentation: 'Attaches a footnote reference at current position.',
  },
  {
    name: 'bibliography',
    insertText: 'bibliography("${1:works.bib}", title: "${2:References}", style: "${3:ieee}")\n',
    detail: 'Include bibliography from .bib file',
    documentation: 'Renders the bibliography section using BibTeX citations.',
  },
  {
    name: 'cite',
    insertText: 'cite(<${1:key}>)',
    detail: 'Citation reference to bibliography',
    documentation: 'Cites an entry defined in the bibliography source.',
  },
  {
    name: 'highlight',
    insertText: 'highlight(fill: ${1:rgb("#fef08a")})[${2:Content}]',
    detail: 'Highlight text with background color',
    documentation: 'Highlights text with a colored background.',
  },

  // Color & Utilities
  {
    name: 'calc',
    insertText: 'calc.${1|round,min,max,abs,sqrt,pow,sin,cos|}(${2})',
    detail: 'Math & Calculation library',
    documentation: 'Built-in mathematical calculations and numeric functions.',
  },
  {
    name: 'rgb',
    insertText: 'rgb("${1:#3b82f6}")',
    detail: 'Define RGB color',
    documentation: 'Creates a color from hex string or red, green, blue values.',
  },
  {
    name: 'luma',
    insertText: 'luma(${1:240})',
    detail: 'Define grayscale color (0-255)',
    documentation: 'Creates a grayscale luminance color.',
  },
  {
    name: 'lorem',
    insertText: 'lorem(${1:50})',
    detail: 'Generate lorem ipsum placeholder text',
    documentation: 'Generates mock Latin prose of specified word count.',
  },
];

/**
 * Registers Typst completion and snippets in Monaco Editor.
 */
export function registerTypstCompletion(monaco: Monaco) {
  // Dispose existing provider to prevent duplicates across hot-reloads
  if (typstCompletionDisposable) {
    typstCompletionDisposable.dispose();
    typstCompletionDisposable = null;
  }

  typstCompletionDisposable = monaco.languages.registerCompletionItemProvider('typst', {
    triggerCharacters: ['#', '=', '$', '<', '@', '"', '/'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provideCompletionItems: (model: any, position: any) => {
      const lineContent = model.getLineContent(position.lineNumber);
      const textUntilPosition = lineContent.substring(0, position.column - 1);

      // Case 1: Typing image path in #image("..."
      const imgMatch = textUntilPosition.match(/(?:#?image\s*\(\s*)"([^"]*)$/);
      if (imgMatch) {
        const images = getProjectImages();
        const prefix = imgMatch[1] || '';
        const imgRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - prefix.length,
          endColumn: position.column,
        };

        return {
          suggestions: images.map((imgPath, idx) => ({
            label: imgPath,
            kind: monaco.languages.CompletionItemKind.File,
            insertText: imgPath,
            detail: 'Project Image Asset',
            documentation: `Insert image path: ${imgPath}`,
            range: imgRange,
            sortText: `00_img_${String(idx).padStart(3, '0')}_${imgPath}`,
          })),
        };
      }

      // Case 2: Typing bibliography path in #bibliography("..."
      const bibMatch = textUntilPosition.match(/(?:#?bibliography\s*\(\s*)"([^"]*)$/);
      if (bibMatch) {
        const bibFiles = getProjectBibFiles();
        const prefix = bibMatch[1] || '';
        const bibRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - prefix.length,
          endColumn: position.column,
        };

        return {
          suggestions: bibFiles.map((bFile, idx) => ({
            label: bFile,
            kind: monaco.languages.CompletionItemKind.File,
            insertText: bFile,
            detail: 'Project Bibliography File (.bib)',
            documentation: `Typst bibliography source: ${bFile}`,
            range: bibRange,
            sortText: `00_bib_${String(idx).padStart(3, '0')}_${bFile}`,
          })),
        };
      }

      // Case 3: Typing include path in #include "..."
      const incMatch = textUntilPosition.match(/(?:#?include\s+)"([^"]*)$/);
      if (incMatch) {
        const subfiles = getProjectSubfiles('typst');
        const prefix = incMatch[1] || '';
        const incRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - prefix.length,
          endColumn: position.column,
        };

        return {
          suggestions: subfiles.map((sFile, idx) => ({
            label: sFile,
            kind: monaco.languages.CompletionItemKind.File,
            insertText: sFile,
            detail: 'Typst Submodule File (.typ)',
            documentation: `Include Typst file: ${sFile}`,
            range: incRange,
            sortText: `00_inc_${String(idx).padStart(3, '0')}_${sFile}`,
          })),
        };
      }

      // Case 4: Cross-reference @label in document
      const refMatch = textUntilPosition.match(/@([a-zA-Z0-9_:-]*)$/);
      if (refMatch) {
        const fullContent = model.getValue();
        const labelRegex = /<([a-zA-Z0-9_:-]+)>/g;
        const labels = new Set<string>();
        let match: RegExpExecArray | null;

        while ((match = labelRegex.exec(fullContent)) !== null) {
          if (match[1]) {
            labels.add(match[1].trim());
          }
        }

        const prefix = refMatch[1] || '';
        const refRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - prefix.length,
          endColumn: position.column,
        };

        const labelSuggestions = Array.from(labels).map((lbl, idx) => ({
          label: `@${lbl}`,
          kind: monaco.languages.CompletionItemKind.Reference,
          insertText: lbl,
          detail: 'Typst Cross-reference Target',
          documentation: `Reference label: <${lbl}>`,
          range: refRange,
          sortText: `00_ref_${String(idx).padStart(3, '0')}_${lbl}`,
        }));

        if (labelSuggestions.length > 0) {
          return { suggestions: labelSuggestions };
        }
      }

      // Check if user is typing a command with '#' prefix (e.g. '#' or '#a' or '#align')
      const hashMatch = textUntilPosition.match(/#([a-zA-Z_0-9]*)$/);
      const isHashPrefixed = hashMatch !== null;
      const hashPrefixLen = isHashPrefixed ? hashMatch[0].length : 0;
      const hashPrefix = isHashPrefixed ? hashMatch[1].toLowerCase() : '';

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        // When '#' is prefixed, span from the '#' character so replacement replaces '#' cleanly without '##'
        startColumn: isHashPrefixed ? position.column - hashPrefixLen : word.startColumn,
        endColumn: position.column,
      };

      // Generate suggestions from the Typst catalog
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const suggestions: any[] = TYPST_COMPLETIONS.map((item) => {
        const nameLower = item.name.toLowerCase();
        const label = isHashPrefixed ? `#${item.name}` : item.name;
        const insertText = isHashPrefixed ? `#${item.insertText}` : item.insertText;
        const filterText = label;

        // Rank prefix matches highest (e.g. typing '#a' prioritizes '#align')
        let priority = '20';
        if (isHashPrefixed && hashPrefix.length > 0) {
          if (nameLower === hashPrefix) {
            priority = '00'; // Exact match
          } else if (nameLower.startsWith(hashPrefix)) {
            priority = '05'; // Prefix match (e.g. '#a' -> '#align')
          } else if (nameLower.includes(hashPrefix)) {
            priority = '30'; // Substring match
          } else {
            priority = '50';
          }
        } else if (!isHashPrefixed && word.word.length > 0) {
          const wLower = word.word.toLowerCase();
          if (nameLower.startsWith(wLower)) {
            priority = '05';
          }
        }

        return {
          label,
          kind: item.kind ?? monaco.languages.CompletionItemKind.Snippet,
          insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: item.detail,
          documentation: {
            value: `### \`${label}\`\n\n${item.documentation}`,
          },
          range,
          sortText: `${priority}_${label}`,
          filterText,
        };
      });

      // When NOT typing with '#' prefix, also include markup shortcuts (= Heading, $ Math $)
      if (!isHashPrefixed) {
        suggestions.push(
          {
            label: '= Heading 1',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: '= ${1:Section Title} <${2:sec:label}>\n',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: 'Top-level section heading',
            documentation: 'Top-level section heading with cross-reference label',
            range,
            sortText: '40_=1',
            filterText: '= Heading 1',
          },
          {
            label: '== Heading 2',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: '== ${1:Subsection Title} <${2:subsec:label}>\n',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: 'Second-level subsection heading',
            documentation: 'Second-level subsection heading with cross-reference label',
            range,
            sortText: '40_=2',
            filterText: '== Heading 2',
          },
          {
            label: '$ equation $ (block)',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: '$ ${1:E = m c^2} $ <${2:eq:label}>\n',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: 'Display math equation block',
            documentation: 'Display math equation block with reference label',
            range,
            sortText: '40_$eq',
            filterText: '$ equation',
          }
        );
      }

      return { suggestions };
    },
  });
}
