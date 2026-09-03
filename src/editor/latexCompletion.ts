import type { Monaco } from '@monaco-editor/react';
import type { IDisposable } from 'monaco-editor';
import { LATEX_COMMANDS, LATEX_ENVIRONMENTS } from './latexData';
import { 
  getProjectImages, 
  getProjectBibFiles, 
  getProjectClsFiles, 
  getProjectSubfiles,
  getProjectCustomCommands
} from './projectContext';

let completionProviderDisposable: IDisposable | null = null;
let hoverProviderDisposable: IDisposable | null = null;
let isLanguageConfigured = false;

export function registerLatexLanguageSupport(monaco: Monaco): void {
  // 1. Language Configuration for LaTeX
  if (!isLanguageConfigured) {
    try {
      monaco.languages.register({ id: 'latex' });
    } catch {
      // Language might already be registered by Monaco built-in
    }

    monaco.languages.setLanguageConfiguration('latex', {
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
    });

    isLanguageConfigured = true;
  }

  // Dispose existing providers to prevent duplicates across hot-reloads
  if (completionProviderDisposable) {
    completionProviderDisposable.dispose();
  }
  if (hoverProviderDisposable) {
    hoverProviderDisposable.dispose();
  }

  // 2. Completion Provider
  completionProviderDisposable = monaco.languages.registerCompletionItemProvider('latex', {
    triggerCharacters: ['\\', '{', ':', '@', '$'],
    provideCompletionItems: (model, position) => {
      const lineContent = model.getLineContent(position.lineNumber);
      const textUntilPosition = lineContent.substring(0, position.column - 1);

      // Check if user is typing a LaTeX command with backslash prefix
      const cmdMatch = textUntilPosition.match(/\\([a-zA-Z@]*)$/);
      const isCmdPrefixed = cmdMatch !== null;
      const cmdPrefix = isCmdPrefixed ? cmdMatch[1] : '';
      const cmdPrefixLen = isCmdPrefixed ? cmdMatch[0].length : 0;

      const wordInfo = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: isCmdPrefixed ? position.column - cmdPrefixLen : wordInfo.startColumn,
        endColumn: position.column,
      };

      // Case A: User is typing \ref{ or \eqref{ -> Dynamically scan all \label{...} in document
      const refMatch = textUntilPosition.match(/\\(eq)?ref\{([^}]*)$/);
      if (refMatch) {
        const fullContent = model.getValue();
        const labelRegex = /\\label\{([^}]+)\}/g;
        const labels = new Set<string>();
        let match: RegExpExecArray | null;

        while ((match = labelRegex.exec(fullContent)) !== null) {
          if (match[1]) {
            labels.add(match[1].trim());
          }
        }

        const labelPrefix = refMatch[2] || '';
        const refRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - labelPrefix.length,
          endColumn: position.column,
        };

        const labelSuggestions = Array.from(labels).map((lbl, idx) => ({
          label: lbl,
          kind: monaco.languages.CompletionItemKind.Reference,
          insertText: lbl,
          detail: 'Detected \\label anchor',
          documentation: `Cross-reference anchor: ${lbl}`,
          range: refRange,
          sortText: `00_ref_${String(idx).padStart(3, '0')}_${lbl}`,
          filterText: lbl,
        }));

        return { suggestions: labelSuggestions };
      }

      // Case B: User is typing \cite{ -> Dynamically scan all BibTeX entries in document
      const citeMatch = textUntilPosition.match(/\\cite\{([^}]*)$/);
      if (citeMatch) {
        const fullContent = model.getValue();
        const bibRegex = /@\w+\s*\{\s*([^,\s]+)/g;
        const citations = new Set<string>();
        let match: RegExpExecArray | null;

        while ((match = bibRegex.exec(fullContent)) !== null) {
          if (match[1]) {
            citations.add(match[1].trim());
          }
        }

        const citePrefix = citeMatch[1] || '';
        const citeRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - citePrefix.length,
          endColumn: position.column,
        };

        const citeSuggestions = Array.from(citations).map((cit, idx) => ({
          label: cit,
          kind: monaco.languages.CompletionItemKind.Value,
          insertText: cit,
          detail: 'BibTeX citation entry',
          documentation: `Citation key: ${cit}`,
          range: citeRange,
          sortText: `00_cite_${String(idx).padStart(3, '0')}_${cit}`,
          filterText: cit,
        }));

        return { suggestions: citeSuggestions };
      }

      // Case C: User is typing \includegraphics{ -> Suggest image assets in project
      const imgMatch = textUntilPosition.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/);
      if (imgMatch) {
        const images = getProjectImages();
        const prefix = imgMatch[1] || '';
        const imgRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - prefix.length,
          endColumn: position.column,
        };

        const imgSuggestions = images.map((imgPath, idx) => ({
          label: imgPath,
          kind: monaco.languages.CompletionItemKind.File,
          insertText: imgPath,
          detail: 'Project Image Asset',
          documentation: `Relative path: ${imgPath}`,
          range: imgRange,
          sortText: `00_img_${String(idx).padStart(3, '0')}_${imgPath}`,
          filterText: imgPath,
        }));

        return { suggestions: imgSuggestions };
      }

      // Case D: User is typing \bibliography{ or \addbibresource{ -> Suggest .bib files
      const bibMatch = textUntilPosition.match(/\\(?:bibliography|addbibresource)\{([^}]*)$/);
      if (bibMatch) {
        const bibFiles = getProjectBibFiles();
        const prefix = bibMatch[1] || '';
        const bibRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - prefix.length,
          endColumn: position.column,
        };

        const bibSuggestions = bibFiles.map((bPath, idx) => {
          // Standard \bibliography takes filename without .bib extension
          const insertValue = textUntilPosition.includes('\\bibliography{') ? bPath.replace(/\.bib$/, '') : bPath;
          return {
            label: bPath,
            kind: monaco.languages.CompletionItemKind.File,
            insertText: insertValue,
            detail: 'Project Bibliography File',
            documentation: `Path: ${bPath}`,
            range: bibRange,
            sortText: `00_bib_${String(idx).padStart(3, '0')}_${bPath}`,
            filterText: bPath,
          };
        });

        return { suggestions: bibSuggestions };
      }

      // Case E: User is typing \documentclass{ -> Suggest local .cls files
      const clsMatch = textUntilPosition.match(/\\documentclass(?:\[[^\]]*\])?\{([^}]*)$/);
      if (clsMatch) {
        const clsFiles = getProjectClsFiles();
        const prefix = clsMatch[1] || '';
        const clsRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - prefix.length,
          endColumn: position.column,
        };

        const clsSuggestions = clsFiles.map((cPath, idx) => {
          const className = cPath.replace(/\.cls$/, '');
          return {
            label: className,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: className,
            detail: 'Custom Document Class (.cls)',
            documentation: `Local class file: ${cPath}`,
            range: clsRange,
            sortText: `00_cls_${String(idx).padStart(3, '0')}_${className}`,
            filterText: className,
          };
        });

        if (clsSuggestions.length > 0) {
          return { suggestions: clsSuggestions };
        }
      }

      // Case F: User is typing \input{ or \include{ -> Suggest subfiles in project
      const inputMatch = textUntilPosition.match(/\\(?:input|include)\{([^}]*)$/);
      if (inputMatch) {
        const subfiles = getProjectSubfiles('latex');
        const prefix = inputMatch[1] || '';
        const inputRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - prefix.length,
          endColumn: position.column,
        };

        const subSuggestions = subfiles.map((sFile, idx) => ({
          label: sFile,
          kind: monaco.languages.CompletionItemKind.File,
          insertText: sFile,
          detail: 'LaTeX Submodule File',
          documentation: `Include LaTeX file: ${sFile}`,
          range: inputRange,
          sortText: `00_sub_${String(idx).padStart(3, '0')}_${sFile}`,
          filterText: sFile,
        }));

        return { suggestions: subSuggestions };
      }

      const lowerPrefix = cmdPrefix.toLowerCase();
      const isBeginTyped = lowerPrefix.startsWith('beg') || lowerPrefix.startsWith('b');

      // Case C: Standard LaTeX Commands & Functions (Rank exact prefix matches highest)
      const commandSuggestions = LATEX_COMMANDS.map((cmd) => {
        const cmdNameNoSlash = cmd.name.replace(/^\\/, '').toLowerCase();
        
        // Exact prefix matching boosts score to top
        let priority = '20';
        if (lowerPrefix.length > 0) {
          if (cmdNameNoSlash === lowerPrefix) {
            priority = '00'; // Exact match (e.g. \url)
          } else if (cmdNameNoSlash.startsWith(lowerPrefix)) {
            priority = '05'; // Prefix match (e.g. \ur -> \url)
          } else if (cmdNameNoSlash.includes(lowerPrefix)) {
            priority = '30'; // Substring match
          } else {
            priority = '50';
          }
        }

        return {
          label: cmd.name,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: cmd.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: cmd.detail,
          documentation: {
            value: `### \`${cmd.name}\`\n\n${cmd.documentation}`,
          },
          range,
          sortText: `${priority}_${cmd.name}`,
          filterText: isCmdPrefixed ? cmd.name : cmd.name.replace(/^\\/, ''),
        };
      });

      // Case D: LaTeX Environments
      const envSuggestions = LATEX_ENVIRONMENTS.map((env) => {
        const envNameLower = env.name.toLowerCase();
        
        // Prioritize \begin{...} primarily when typing \begin or \beg
        let envPriority = '60';
        if (isBeginTyped) {
          envPriority = '10';
        } else if (lowerPrefix.length > 0 && envNameLower.startsWith(lowerPrefix)) {
          envPriority = '40';
        }

        return {
          label: `\\begin{${env.name}}`,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: env.snippet,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: `Environment: ${env.detail}`,
          documentation: {
            value: `### Environment \`\\begin{${env.name}}\`\n\n${env.documentation}\n\n\`\`\`latex\n${env.snippet}\n\`\`\``,
          },
          range,
          sortText: `${envPriority}_env_${env.name}`,
          filterText: isCmdPrefixed ? `\\begin{${env.name}}` : `begin{${env.name}}`,
        };
      });

      // Case E: Project-defined custom macros (from .cls, .sty)
      const projectCommands = getProjectCustomCommands();
      const customSuggestions = Array.from(projectCommands).map((cName) => {
        const fullCmd = `\\${cName}`;
        return {
          label: fullCmd,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: fullCmd,
          detail: 'Project Macro (Class/Package)',
          documentation: {
            value: `### \`${fullCmd}\`\n\nCustom command defined in workspace class (.cls) or style (.sty) file.`,
          },
          range,
          sortText: `15_${cName}`,
          filterText: isCmdPrefixed ? fullCmd : cName,
        };
      });

      return {
        suggestions: [...commandSuggestions, ...customSuggestions, ...envSuggestions],
      };
    },
  });

  // 3. Hover Documentation Provider
  hoverProviderDisposable = monaco.languages.registerHoverProvider('latex', {
    provideHover: (model, position) => {
      const lineContent = model.getLineContent(position.lineNumber);
      const textUntilPosition = lineContent.substring(0, position.column);

      const cmdMatch = textUntilPosition.match(/\\([a-zA-Z@]+)$/);
      const queryName = cmdMatch ? cmdMatch[0] : null;

      if (queryName) {
        const foundCmd = LATEX_COMMANDS.find((c) => c.name === queryName);
        if (foundCmd) {
          return {
            range: new monaco.Range(
              position.lineNumber,
              position.column - queryName.length,
              position.lineNumber,
              position.column
            ),
            contents: [
              { value: `**LaTeX Command: \`${foundCmd.name}\`**` },
              { value: `*${foundCmd.detail}*` },
              { value: foundCmd.documentation },
            ],
          };
        }
      }

      const word = model.getWordAtPosition(position);
      if (word) {
        const foundEnv = LATEX_ENVIRONMENTS.find((e) => e.name === word.word);
        if (foundEnv) {
          return {
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
            contents: [
              { value: `**LaTeX Environment: \`\\begin{${foundEnv.name}}\`**` },
              { value: `*${foundEnv.detail}*` },
              { value: foundEnv.documentation },
            ],
          };
        }
      }

      return null;
    },
  });
}
