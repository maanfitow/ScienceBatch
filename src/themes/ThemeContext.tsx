import React, { createContext, useContext, useState, useEffect } from 'react';

export type AppTheme = 'dark' | 'light' | 'monokai';

interface ThemeContextType {
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
  monacoTheme: string;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'dark',
  setTheme: () => {},
  monacoTheme: 'sciencebatch-dark',
});

const THEME_STORAGE_KEY = 'sciencebatch-app-theme';

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<AppTheme>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'monokai') {
      return saved;
    }
    return 'dark';
  });

  const setTheme = (newTheme: AppTheme) => {
    setThemeState(newTheme);
    localStorage.setItem(THEME_STORAGE_KEY, newTheme);
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Map App theme to Monaco custom theme name
  const monacoTheme = theme === 'light' ? 'sciencebatch-light' : theme === 'monokai' ? 'sciencebatch-monokai' : 'sciencebatch-dark';

  return (
    <ThemeContext.Provider value={{ theme, setTheme, monacoTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);

/**
 * Registers custom themes in Monaco editor instance.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerMonacoCustomThemes(monaco: any) {
  if (!monaco || !monaco.editor) return;

  // 1. ScienceBatch Dark Theme
  const darkConfig = {
    base: 'vs-dark' as const,
    inherit: true,
    rules: [
      { token: '', foreground: 'f3f4f6' },
      { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
      { token: 'keyword', foreground: '569cd6', fontStyle: 'bold' },
      { token: 'keyword.control', foreground: 'c586c0' },
      { token: 'keyword.heading', foreground: '569cd6', fontStyle: 'bold' },
      { token: 'function', foreground: 'dcdcaa' },
      { token: 'support.function', foreground: 'dcdcaa' },
      { token: 'type', foreground: '4ec9b0' },
      { token: 'type.environment', foreground: '4ec9b0', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: '4ec9b0' },
      { token: 'string', foreground: 'ce9178' },
      { token: 'string.verbatim', foreground: 'ce9178' },
      { token: 'string.math', foreground: 'e5c07b' },
      { token: 'keyword.math', foreground: 'e5c07b', fontStyle: 'bold' },
      { token: 'operator.math', foreground: 'd4d4d4' },
      { token: 'number.math', foreground: 'b5cea8' },
      { token: 'number', foreground: 'b5cea8' },
      { token: 'variable', foreground: '9cdcfe' },
      { token: 'variable.parameter', foreground: '9cdcfe' },
      { token: 'variable.name', foreground: '9cdcfe' },
      { token: 'tag', foreground: '4fc1ff' },
      { token: 'tag.label', foreground: 'e5c07b' },
      { token: 'tag.reference', foreground: '4fc1ff' },
      { token: 'delimiter', foreground: 'd4d4d4' },
      { token: 'operator', foreground: 'd4d4d4' },
      { token: 'constant.character.escape', foreground: 'd7ba7d' },
      { token: 'strong', fontStyle: 'bold' },
      { token: 'emphasis', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#121316',
      'editor.foreground': '#f3f4f6',
      'editorCursor.foreground': '#3b82f6',
      'editor.lineHighlightBackground': '#1a1c22',
      'editorLineNumber.foreground': '#4b5563',
      'editorLineNumber.activeForeground': '#9ca3af',
      'editor.selectionBackground': '#2563eb44',
      'editor.inactiveSelectionBackground': '#1e293b44',
      'editorWidget.background': '#1a1c22',
      'editorSuggestWidget.background': '#1a1c22',
      'editorSuggestWidget.border': '#2b2e3b',
      'editorSuggestWidget.selectedBackground': '#2e3240',
    },
  };
  monaco.editor.defineTheme('sciencebatch-dark', darkConfig);

  // 2. ScienceBatch Light Theme
  const lightConfig = {
    base: 'vs' as const,
    inherit: true,
    rules: [
      { token: '', foreground: '0f172a' },
      { token: 'comment', foreground: '008000', fontStyle: 'italic' },
      { token: 'keyword', foreground: '0000ff', fontStyle: 'bold' },
      { token: 'keyword.control', foreground: 'af00db' },
      { token: 'keyword.heading', foreground: '0000ff', fontStyle: 'bold' },
      { token: 'function', foreground: '795e26' },
      { token: 'support.function', foreground: '795e26' },
      { token: 'type', foreground: '0891b2' },
      { token: 'type.environment', foreground: '0891b2', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: '0891b2' },
      { token: 'string', foreground: 'a31515' },
      { token: 'string.verbatim', foreground: 'a31515' },
      { token: 'string.math', foreground: 'b91c1c' },
      { token: 'keyword.math', foreground: 'b91c1c', fontStyle: 'bold' },
      { token: 'operator.math', foreground: '334155' },
      { token: 'number.math', foreground: '098658' },
      { token: 'number', foreground: '098658' },
      { token: 'variable', foreground: '001080' },
      { token: 'variable.parameter', foreground: '001080' },
      { token: 'variable.name', foreground: '001080' },
      { token: 'tag', foreground: '800000' },
      { token: 'tag.label', foreground: 'b45309' },
      { token: 'tag.reference', foreground: '2563eb' },
      { token: 'delimiter', foreground: '334155' },
      { token: 'operator', foreground: '334155' },
      { token: 'constant.character.escape', foreground: '811f3f' },
      { token: 'strong', fontStyle: 'bold' },
      { token: 'emphasis', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#0f172a',
      'editorCursor.foreground': '#2563eb',
      'editor.lineHighlightBackground': '#f1f5f9',
      'editorLineNumber.foreground': '#94a3b8',
      'editorLineNumber.activeForeground': '#475569',
      'editor.selectionBackground': '#bfdbfe77',
      'editor.inactiveSelectionBackground': '#e2e8f088',
      'editorWidget.background': '#ffffff',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.border': '#cbd5e1',
      'editorSuggestWidget.selectedBackground': '#f1f5f9',
    },
  };
  monaco.editor.defineTheme('sciencebatch-light', lightConfig);

  // 3. ScienceBatch Monokai Theme (and 'monokai' alias)
  const monokaiConfig = {
    base: 'vs-dark' as const,
    inherit: true,
    rules: [
      { token: '', foreground: 'f8f8f2' },
      { token: 'comment', foreground: '75715e', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'f92672', fontStyle: 'bold' },
      { token: 'keyword.control', foreground: 'f92672' },
      { token: 'keyword.heading', foreground: 'f92672', fontStyle: 'bold' },
      { token: 'function', foreground: 'a6e22e' },
      { token: 'support.function', foreground: 'a6e22e' },
      { token: 'type', foreground: '66d9ef', fontStyle: 'italic' },
      { token: 'type.environment', foreground: '66d9ef', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: '66d9ef' },
      { token: 'string', foreground: 'e6db74' },
      { token: 'string.verbatim', foreground: 'e6db74' },
      { token: 'string.math', foreground: 'fd971f' },
      { token: 'keyword.math', foreground: 'fd971f', fontStyle: 'bold' },
      { token: 'operator.math', foreground: 'f8f8f2' },
      { token: 'number.math', foreground: 'ae81ff' },
      { token: 'number', foreground: 'ae81ff' },
      { token: 'variable', foreground: 'fd971f' },
      { token: 'variable.parameter', foreground: 'fd971f' },
      { token: 'variable.name', foreground: 'fd971f' },
      { token: 'tag', foreground: 'f92672' },
      { token: 'tag.label', foreground: 'e6db74' },
      { token: 'tag.reference', foreground: '66d9ef' },
      { token: 'delimiter', foreground: 'f8f8f2' },
      { token: 'operator', foreground: 'f92672' },
      { token: 'constant.character.escape', foreground: 'ae81ff' },
      { token: 'strong', fontStyle: 'bold' },
      { token: 'emphasis', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#272822',
      'editor.foreground': '#f8f8f2',
      'editorCursor.foreground': '#f8f8f0',
      'editor.lineHighlightBackground': '#3e3d32',
      'editorLineNumber.foreground': '#90908a',
      'editorLineNumber.activeForeground': '#c2c2bf',
      'editor.selectionBackground': '#49483e',
      'editor.inactiveSelectionBackground': '#383830',
      'editorWidget.background': '#1e1f1c',
      'editorSuggestWidget.background': '#1e1f1c',
      'editorSuggestWidget.border': '#49483e',
      'editorSuggestWidget.selectedBackground': '#383830',
    },
  };

  monaco.editor.defineTheme('sciencebatch-monokai', monokaiConfig);
  monaco.editor.defineTheme('monokai', monokaiConfig);
}
