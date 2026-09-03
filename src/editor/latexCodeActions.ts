import type * as monacoType from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';

let codeActionProviderDisposable: monacoType.IDisposable | null = null;

/**
 * Registers Monaco CodeActionProvider for LaTeX to enable interactive 1-click Quick Fixes
 * (lightbulb icon, Ctrl + . / Cmd + ., and problem hover actions).
 */
export function registerLatexCodeActions(monaco: Monaco): void {
  // Dispose previous provider to prevent duplicates across component re-mounts
  if (codeActionProviderDisposable) {
    codeActionProviderDisposable.dispose();
  }

  codeActionProviderDisposable = monaco.languages.registerCodeActionProvider('latex', {
    provideCodeActions(model, _range, context) {
      const actions: monacoType.languages.CodeAction[] = [];

      for (const marker of context.markers) {
        const code = typeof marker.code === 'string'
          ? marker.code
          : (typeof marker.code === 'object' && marker.code !== null ? (marker.code as any).value : '');

        // 1. Command Typo Quick Fixes (e.g. \seciton -> \section, or \textt -> \texttt, \text, \textit)
        let suggestedCmds: string[] = [];
        if (code && code.startsWith('latex:typo:')) {
          suggestedCmds = code.replace('latex:typo:', '').split(',').filter(Boolean);
        } else {
          // Fallback: parse all '\command' suggestions from marker message
          const matches = [...marker.message.matchAll(/'\\([a-zA-Z]+)'/g)];
          suggestedCmds = matches.map((m) => m[1]);
        }

        suggestedCmds.forEach((cmd, idx) => {
          actions.push({
            title: `Change to '\\${cmd}'`,
            kind: 'quickfix',
            isPreferred: idx === 0,
            diagnostics: [marker],
            edit: {
              edits: [
                {
                  resource: model.uri,
                  textEdit: {
                    range: marker,
                    text: `\\${cmd}`,
                  },
                  versionId: model.getVersionId(),
                },
              ],
            },
          });
        });

        // 2. Unescaped Underscore Quick Fix: _ -> \_ or $_$
        if (code === 'latex:unescaped-underscore' || marker.message.includes("Unescaped underscore '_'")) {
          actions.push({
            title: "Escape as '\\_'",
            kind: 'quickfix',
            isPreferred: true,
            diagnostics: [marker],
            edit: {
              edits: [
                {
                  resource: model.uri,
                  textEdit: {
                    range: marker,
                    text: '\\_',
                  },
                  versionId: model.getVersionId(),
                },
              ],
            },
          });

          actions.push({
            title: "Wrap in math mode '$_$'",
            kind: 'quickfix',
            isPreferred: false,
            diagnostics: [marker],
            edit: {
              edits: [
                {
                  resource: model.uri,
                  textEdit: {
                    range: marker,
                    text: '$_$',
                  },
                  versionId: model.getVersionId(),
                },
              ],
            },
          });
        }

        // 3. Misplaced Ampersand Quick Fix: & -> \&
        if (code === 'latex:misplaced-ampersand' || marker.message.includes("Misplaced alignment tab character '&'")) {
          actions.push({
            title: "Escape as '\\&'",
            kind: 'quickfix',
            isPreferred: true,
            diagnostics: [marker],
            edit: {
              edits: [
                {
                  resource: model.uri,
                  textEdit: {
                    range: marker,
                    text: '\\&',
                  },
                  versionId: model.getVersionId(),
                },
              ],
            },
          });
        }
      }

      return {
        actions,
        dispose() {},
      };
    },
  });
}
