import React, { createContext, useContext, useState, useEffect } from 'react';

export type AppTheme = 'obsidian-pastel' | 'coral-depths' | 'light' | 'dark' | 'monokai';

export interface ThemeOption {
  id: AppTheme;
  label: string;
  description: string;
  swatches: [string, string, string];
}

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'obsidian-pastel',
    label: 'Obsidian Pastel (Default)',
    description: 'Obsidian canvas with mint, lilac & butter editorial pastels',
    swatches: ['#0b0c0d', '#74eec8', '#dec2ff'],
  },
  {
    id: 'coral-depths',
    label: 'Coral Depths',
    description: 'Deep abyssal indigo with seafoam teal & Swiss plum accents',
    swatches: ['#060511', '#2dd4bf', '#9f96f2'],
  },
  {
    id: 'light',
    label: 'Light Editorial',
    description: 'Warm paper canvas with high-contrast ink & pastel accents',
    swatches: ['#f6f5f1', '#111214', '#74eec8'],
  },
  {
    id: 'dark',
    label: 'Dark Slate',
    description: 'Crisp neutral graphite with clean teal & steel accents',
    swatches: ['#111316', '#14b8a6', '#6ba4e8'],
  },
  {
    id: 'monokai',
    label: 'Monokai Noir',
    description: 'Charcoal-black surfaces with warm gold, sage & rose syntax',
    swatches: ['#121211', '#e5c76b', '#e06c88'],
  },
];

interface ThemeContextType {
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
  monacoTheme: string;
}

const DEFAULT_THEME: AppTheme = 'obsidian-pastel';

const ThemeContext = createContext<ThemeContextType>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  monacoTheme: 'sciencebatch-obsidian-pastel',
});

const THEME_STORAGE_KEY = 'sciencebatch-app-theme';

function isAppTheme(value: string | null): value is AppTheme {
  return (
    value === 'obsidian-pastel' ||
    value === 'coral-depths' ||
    value === 'light' ||
    value === 'dark' ||
    value === 'monokai'
  );
}

function resolveMonacoTheme(theme: AppTheme): string {
  switch (theme) {
    case 'coral-depths':
      return 'sciencebatch-coral-depths';
    case 'light':
      return 'sciencebatch-light';
    case 'dark':
      return 'sciencebatch-dark';
    case 'monokai':
      return 'sciencebatch-monokai';
    case 'obsidian-pastel':
    default:
      return 'sciencebatch-obsidian-pastel';
  }
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<AppTheme>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (isAppTheme(saved)) {
      return saved;
    }
    return DEFAULT_THEME;
  });

  const setTheme = (newTheme: AppTheme) => {
    setThemeState(newTheme);
    localStorage.setItem(THEME_STORAGE_KEY, newTheme);
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const monacoTheme = resolveMonacoTheme(theme);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, monacoTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);

/**
 * Registers all custom ScienceBatch themes in the Monaco editor instance.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerMonacoCustomThemes(monaco: any) {
  if (!monaco || !monaco.editor) return;

  // 1. ScienceBatch Obsidian Pastel (Default)
  const obsidianPastelConfig = {
    base: 'vs-dark' as const,
    inherit: true,
    rules: [
      { token: '', foreground: 'f4f4f2' },
      { token: 'comment', foreground: '7c818c', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'dec2ff', fontStyle: 'bold' },
      { token: 'keyword.control', foreground: 'f3a6b8' },
      { token: 'keyword.heading', foreground: 'dec2ff', fontStyle: 'bold' },
      { token: 'function', foreground: '74eec8' },
      { token: 'support.function', foreground: '74eec8' },
      { token: 'type', foreground: 'a5d8ff' },
      { token: 'type.environment', foreground: 'a5d8ff', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: 'a5d8ff' },
      { token: 'string', foreground: 'f6b89e' },
      { token: 'string.verbatim', foreground: 'f6b89e' },
      { token: 'string.math', foreground: 'fde068' },
      { token: 'keyword.math', foreground: 'fde068', fontStyle: 'bold' },
      { token: 'operator.math', foreground: 'd4d6dc' },
      { token: 'number.math', foreground: 'a7e3c5' },
      { token: 'number', foreground: 'a7e3c5' },
      { token: 'variable', foreground: 'd4d6dc' },
      { token: 'variable.parameter', foreground: 'a5d8ff' },
      { token: 'variable.name', foreground: 'd4d6dc' },
      { token: 'tag', foreground: '74eec8' },
      { token: 'tag.label', foreground: 'fde068' },
      { token: 'tag.reference', foreground: 'dec2ff' },
      { token: 'delimiter', foreground: '9ca0a8' },
      { token: 'operator', foreground: 'c5c8ce' },
      { token: 'constant.character.escape', foreground: 'fde068' },
      { token: 'strong', fontStyle: 'bold' },
      { token: 'emphasis', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#0b0c0d',
      'editor.foreground': '#f4f4f2',
      'editorCursor.foreground': '#74eec8',
      'editor.lineHighlightBackground': '#141517',
      'editorLineNumber.foreground': '#5a5e68',
      'editorLineNumber.activeForeground': '#d4d6dc',
      'editor.selectionBackground': '#74eec82b',
      'editor.inactiveSelectionBackground': '#25272b88',
      'editorWidget.background': '#141517',
      'editorSuggestWidget.background': '#141517',
      'editorSuggestWidget.border': '#25272b',
      'editorSuggestWidget.selectedBackground': '#25272b',
      'editorHoverWidget.background': '#141517',
      'editorHoverWidget.border': '#25272b',
    },
  };
  monaco.editor.defineTheme('sciencebatch-obsidian-pastel', obsidianPastelConfig);

  // 2. ScienceBatch Coral Depths (Abyssal Indigo)
  const coralDepthsConfig = {
    base: 'vs-dark' as const,
    inherit: true,
    rules: [
      { token: '', foreground: 'f2f1fa' },
      { token: 'comment', foreground: '7572a1', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'a9a0f7', fontStyle: 'bold' },
      { token: 'keyword.control', foreground: 'eb84a2' },
      { token: 'keyword.heading', foreground: 'a9a0f7', fontStyle: 'bold' },
      { token: 'function', foreground: '3dd5c4' },
      { token: 'support.function', foreground: '3dd5c4' },
      { token: 'type', foreground: '85a8f2' },
      { token: 'type.environment', foreground: '85a8f2', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: '85a8f2' },
      { token: 'string', foreground: 'eba08e' },
      { token: 'string.verbatim', foreground: 'eba08e' },
      { token: 'string.math', foreground: 'f0ca6e' },
      { token: 'keyword.math', foreground: 'f0ca6e', fontStyle: 'bold' },
      { token: 'operator.math', foreground: 'cbc8e4' },
      { token: 'number.math', foreground: '5fd4b3' },
      { token: 'number', foreground: '5fd4b3' },
      { token: 'variable', foreground: 'e2e0f5' },
      { token: 'variable.parameter', foreground: '85a8f2' },
      { token: 'variable.name', foreground: 'e2e0f5' },
      { token: 'tag', foreground: '3dd5c4' },
      { token: 'tag.label', foreground: 'f0ca6e' },
      { token: 'tag.reference', foreground: 'a9a0f7' },
      { token: 'delimiter', foreground: '8f8cb5' },
      { token: 'operator', foreground: 'cbc8e4' },
      { token: 'constant.character.escape', foreground: 'f0ca6e' },
      { token: 'strong', fontStyle: 'bold' },
      { token: 'emphasis', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#060511',
      'editor.foreground': '#f2f1fa',
      'editorCursor.foreground': '#2dd4bf',
      'editor.lineHighlightBackground': '#0c0a1d',
      'editorLineNumber.foreground': '#4f4c7a',
      'editorLineNumber.activeForeground': '#cbc8e4',
      'editor.selectionBackground': '#5950b855',
      'editor.inactiveSelectionBackground': '#23204888',
      'editorWidget.background': '#0c0a1d',
      'editorSuggestWidget.background': '#0c0a1d',
      'editorSuggestWidget.border': '#232048',
      'editorSuggestWidget.selectedBackground': '#1b183d',
      'editorHoverWidget.background': '#0c0a1d',
      'editorHoverWidget.border': '#232048',
    },
  };
  monaco.editor.defineTheme('sciencebatch-coral-depths', coralDepthsConfig);

  // 3. ScienceBatch Dark Slate Theme (Crisp Non-Pastel Graphite)
  const darkConfig = {
    base: 'vs-dark' as const,
    inherit: true,
    rules: [
      { token: '', foreground: 'f1f3f5' },
      { token: 'comment', foreground: '717a8a', fontStyle: 'italic' },
      { token: 'keyword', foreground: '6ba4e8', fontStyle: 'bold' },
      { token: 'keyword.control', foreground: 'c084fc' },
      { token: 'keyword.heading', foreground: '6ba4e8', fontStyle: 'bold' },
      { token: 'function', foreground: '2dd4bf' },
      { token: 'support.function', foreground: '2dd4bf' },
      { token: 'type', foreground: '34d399' },
      { token: 'type.environment', foreground: '34d399', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: '34d399' },
      { token: 'string', foreground: 'fb923c' },
      { token: 'string.verbatim', foreground: 'fb923c' },
      { token: 'string.math', foreground: 'fbbf24' },
      { token: 'keyword.math', foreground: 'fbbf24', fontStyle: 'bold' },
      { token: 'operator.math', foreground: 'd2d6de' },
      { token: 'number.math', foreground: 'a3e635' },
      { token: 'number', foreground: 'a3e635' },
      { token: 'variable', foreground: 'c9cfd8' },
      { token: 'variable.parameter', foreground: '6ba4e8' },
      { token: 'variable.name', foreground: 'c9cfd8' },
      { token: 'tag', foreground: '2dd4bf' },
      { token: 'tag.label', foreground: 'fbbf24' },
      { token: 'tag.reference', foreground: '6ba4e8' },
      { token: 'delimiter', foreground: '8d95a3' },
      { token: 'operator', foreground: 'c9cfd8' },
      { token: 'constant.character.escape', foreground: 'fbbf24' },
      { token: 'strong', fontStyle: 'bold' },
      { token: 'emphasis', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#111316',
      'editor.foreground': '#f1f3f5',
      'editorCursor.foreground': '#14b8a6',
      'editor.lineHighlightBackground': '#181b20',
      'editorLineNumber.foreground': '#555e6e',
      'editorLineNumber.activeForeground': '#c9cfd8',
      'editor.selectionBackground': '#14b8a633',
      'editor.inactiveSelectionBackground': '#21252c88',
      'editorWidget.background': '#181b20',
      'editorSuggestWidget.background': '#181b20',
      'editorSuggestWidget.border': '#2e343e',
      'editorSuggestWidget.selectedBackground': '#2a2f38',
    },
  };
  monaco.editor.defineTheme('sciencebatch-dark', darkConfig);

  // 4. ScienceBatch Light Editorial Theme
  const lightConfig = {
    base: 'vs' as const,
    inherit: true,
    rules: [
      { token: '', foreground: '111214' },
      { token: 'comment', foreground: '6c6f76', fontStyle: 'italic' },
      { token: 'keyword', foreground: '5b3b8c', fontStyle: 'bold' },
      { token: 'keyword.control', foreground: '9d3452' },
      { token: 'keyword.heading', foreground: '5b3b8c', fontStyle: 'bold' },
      { token: 'function', foreground: '0f766e' },
      { token: 'support.function', foreground: '0f766e' },
      { token: 'type', foreground: '2c5282' },
      { token: 'type.environment', foreground: '2c5282', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: '2c5282' },
      { token: 'string', foreground: '9a4726' },
      { token: 'string.verbatim', foreground: '9a4726' },
      { token: 'string.math', foreground: '8a5a00' },
      { token: 'keyword.math', foreground: '8a5a00', fontStyle: 'bold' },
      { token: 'operator.math', foreground: '393c42' },
      { token: 'number.math', foreground: '157347' },
      { token: 'number', foreground: '157347' },
      { token: 'variable', foreground: '26292e' },
      { token: 'variable.parameter', foreground: '2c5282' },
      { token: 'variable.name', foreground: '26292e' },
      { token: 'tag', foreground: '0f766e' },
      { token: 'tag.label', foreground: '8a5a00' },
      { token: 'tag.reference', foreground: '5b3b8c' },
      { token: 'delimiter', foreground: '52555c' },
      { token: 'operator', foreground: '393c42' },
      { token: 'constant.character.escape', foreground: '9d3452' },
      { token: 'strong', fontStyle: 'bold' },
      { token: 'emphasis', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#111214',
      'editorCursor.foreground': '#111214',
      'editor.lineHighlightBackground': '#f6f5f1',
      'editorLineNumber.foreground': '#8c8f96',
      'editorLineNumber.activeForeground': '#111214',
      'editor.selectionBackground': '#dec2ff66',
      'editor.inactiveSelectionBackground': '#eceae3aa',
      'editorWidget.background': '#ffffff',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.border': '#e2e0d8',
      'editorSuggestWidget.selectedBackground': '#eceae3',
    },
  };
  monaco.editor.defineTheme('sciencebatch-light', lightConfig);

  // 5. ScienceBatch Monokai Noir Theme (and 'monokai' alias)
  const monokaiConfig = {
    base: 'vs-dark' as const,
    inherit: true,
    rules: [
      { token: '', foreground: 'f3f2ec' },
      { token: 'comment', foreground: '79766b', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'e06c88', fontStyle: 'bold' },
      { token: 'keyword.control', foreground: 'e06c88' },
      { token: 'keyword.heading', foreground: 'e06c88', fontStyle: 'bold' },
      { token: 'function', foreground: '95c470' },
      { token: 'support.function', foreground: '95c470' },
      { token: 'type', foreground: '78b7c4', fontStyle: 'italic' },
      { token: 'type.environment', foreground: '78b7c4', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: '78b7c4' },
      { token: 'string', foreground: 'e5c76b' },
      { token: 'string.verbatim', foreground: 'e5c76b' },
      { token: 'string.math', foreground: 'df965b' },
      { token: 'keyword.math', foreground: 'df965b', fontStyle: 'bold' },
      { token: 'operator.math', foreground: 'f3f2ec' },
      { token: 'number.math', foreground: 'a794d6' },
      { token: 'number', foreground: 'a794d6' },
      { token: 'variable', foreground: 'df965b' },
      { token: 'variable.parameter', foreground: 'df965b' },
      { token: 'variable.name', foreground: 'df965b' },
      { token: 'tag', foreground: 'e06c88' },
      { token: 'tag.label', foreground: 'e5c76b' },
      { token: 'tag.reference', foreground: '78b7c4' },
      { token: 'delimiter', foreground: 'c9c7bd' },
      { token: 'operator', foreground: 'e06c88' },
      { token: 'constant.character.escape', foreground: 'a794d6' },
      { token: 'strong', fontStyle: 'bold' },
      { token: 'emphasis', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#121211',
      'editor.foreground': '#f3f2ec',
      'editorCursor.foreground': '#e5c76b',
      'editor.lineHighlightBackground': '#181816',
      'editorLineNumber.foreground': '#5e5c54',
      'editorLineNumber.activeForeground': '#c9c7bd',
      'editor.selectionBackground': '#2c2c28',
      'editor.inactiveSelectionBackground': '#21211e',
      'editorWidget.background': '#181816',
      'editorSuggestWidget.background': '#181816',
      'editorSuggestWidget.border': '#2c2c28',
      'editorSuggestWidget.selectedBackground': '#2c2c28',
    },
  };

  monaco.editor.defineTheme('sciencebatch-monokai', monokaiConfig);
  monaco.editor.defineTheme('monokai', monokaiConfig);
}
