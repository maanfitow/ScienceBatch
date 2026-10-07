export type TypstAlignment = 'left' | 'center' | 'right';
export type TypstTableFormat = 'plain' | 'grid' | 'booktabs';
export type TypstMatrixDelimiter = 'none' | 'parentheses' | 'brackets' | 'braces' | 'single-bars' | 'double-bars';

export interface TypstTableSourceCell {
  /** Complete Typst argument for the cell, including its content brackets. */
  source: string;
  /** The editable value represented by source. */
  content: string;
  isTypst: boolean;
  header: boolean;
}

export interface TypstMatrixSourceCell {
  /** Complete Typst argument for the cell. */
  source: string;
  /** The editable value represented by source. */
  content: string;
}

export interface TypstTableOptions {
  rows: number;
  columns: number;
  cells: string[][];
  alignment?: TypstAlignment[];
  format?: TypstTableFormat;
  header?: boolean;
  wrapInFigure?: boolean;
  caption?: string;
  label?: string;
  cellTypst?: boolean[][];
  sourceCells?: Array<Array<TypstTableSourceCell | undefined>>;
}

export interface TypstMatrixOptions {
  rows: number;
  columns: number;
  cells: string[][];
  delimiter?: TypstMatrixDelimiter;
  sourceCells?: Array<Array<TypstMatrixSourceCell | undefined>>;
}

export type TypstStructurePlacement = 'markup' | 'code' | 'math' | 'display';

export type ParsedTypstStructure =
  | { kind: 'table'; start: number; end: number; compatible: true; value: TypstTableOptions; placement: 'markup' | 'code' }
  | { kind: 'matrix'; start: number; end: number; compatible: true; value: TypstMatrixOptions; placement: 'math' | 'display' }
  | { kind: 'table' | 'matrix'; start: number; end: number; compatible: false; reason: string };

export class TypstStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypstStructureError';
  }
}
