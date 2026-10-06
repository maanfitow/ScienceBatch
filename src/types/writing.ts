export interface WritingSession {
  documentId: string;
  modelId: string;
  language: WritingLanguage;
  contextRevision: number;
  version: number;
  source: string;
  start: number;
  end: number;
  anchor: number;
  active: number;
  scrollTop: number;
  scrollLeft: number;
}

export interface WritingChange {
  start: number;
  end: number;
  text: string;
  selection?: { anchor: number; active: number };
}

export interface WritingEditorState {
  language: WritingLanguage;
  available: boolean;
  editable: boolean;
  reason: string;
  source: string;
  cursorOffset: number;
  canAddPackages: boolean;
}

export type WritingLanguage = 'latex' | 'typst';

export interface WritingEditorBridge {
  capture(): WritingSession | null;
  isCurrent(session: WritingSession): boolean;
  apply(session: WritingSession, change: WritingChange): WritingSession | null;
  restore(session: WritingSession): void;
}

export type MathContext = 'text' | 'math-inline' | 'math-display' | 'math-environment' | 'blocked';
export type WritingCategory = 'Greek letters' | 'Operators' | 'Relations' | 'Arrows' | 'Sets and logic' | 'Miscellaneous';

export interface SymbolEntry {
  command: string;
  name: string;
  glyph: string;
  category: WritingCategory;
  aliases: string[];
  packages: string[];
}

export interface TableOptions {
  rows: number;
  columns: number;
  cells: string[][];
  alignment?: Array<'l' | 'c' | 'r'>;
  format?: 'plain' | 'grid' | 'booktabs';
  header?: boolean;
  wrapInTable?: boolean;
  caption?: string;
  captionLatex?: boolean;
  label?: string;
  latexCells?: boolean;
  cellLatex?: boolean[][];
}

export interface MatrixOptions {
  rows: number;
  columns: number;
  cells: string[][];
  environment?: 'matrix' | 'pmatrix' | 'bmatrix' | 'Bmatrix' | 'vmatrix' | 'Vmatrix';
}

export interface ParsedStructure<T> {
  kind: 'table' | 'matrix';
  start: number;
  end: number;
  value: T;
  compatible: boolean;
  reason?: string;
}

export interface PackageEditPlan {
  change: WritingChange;
  packagesToAdd: string[];
  verified: boolean;
  message?: string;
}
