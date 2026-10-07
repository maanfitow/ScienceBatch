import type { MathContext } from '../../types/writing';
import {
  TypstStructureError,
  type TypstAlignment,
  type TypstMatrixDelimiter,
  type TypstMatrixOptions,
  type TypstTableFormat,
  type TypstTableOptions,
} from '../../types/typstWriting';
import { encodeTypstString, validateTypstMatrixCell, validateTypstTableCell } from './typstStructureValidation';

const tableAlignments = new Set<TypstAlignment>(['left', 'center', 'right']);
const tableFormats = new Set<TypstTableFormat>(['plain', 'grid', 'booktabs']);
const matrixDelimiters = new Set<TypstMatrixDelimiter>(['none', 'parentheses', 'brackets', 'braces', 'single-bars', 'double-bars']);

/** Generate native Typst table source, preserving unchanged parsed cell arguments. */
export function generateTypstTable(options: TypstTableOptions, placement: 'markup' | 'code' = 'markup'): string {
  validateDimensions(options.rows, options.columns, 20, 10, 'table');
  validateGrid(options.cells, options.rows, options.columns);
  validateOptionalGrid(options.cellTypst, options.rows, options.columns, 'Typst cell modes');
  validateOptionalGrid(options.sourceCells, options.rows, options.columns, 'table source cells');

  const alignments = options.alignment ?? Array<TypstAlignment>(options.columns).fill('left');
  if (alignments.length !== options.columns || alignments.some((alignment) => !tableAlignments.has(alignment))) {
    throw new TypstStructureError('Choose left, center, or right alignment for each table column.');
  }
  const format = options.format ?? 'plain';
  if (!tableFormats.has(format)) throw new TypstStructureError('Choose Plain, Grid, or Booktabs table formatting.');
  const header = options.header ?? false;
  const wrapped = options.wrapInFigure ?? false;
  const caption = options.caption ?? '';
  const label = options.label?.trim() ?? '';

  if (label && (!wrapped || !caption.trim())) throw new TypstStructureError('A table label requires a caption and the figure wrapper.');
  if (label && !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(label)) {
    throw new TypstStructureError('Labels must start with a letter and use only letters, numbers, hyphens, or underscores.');
  }
  if (placement === 'code' && label) throw new TypstStructureError('Labels can only be attached to a table figure in markup.');
  validateSingleLine(caption, 'Captions');

  const values: string[] = [];
  if (format === 'booktabs') values.push('table.hline(y: 0, stroke: 0.8pt)');

  for (let row = 0; row < options.rows; row += 1) {
    const isHeaderRow = header && row === 0;
    const rowValues = options.cells[row].map((content, column) => renderTableCell(options, row, column, content, isHeaderRow));
    if (isHeaderRow) values.push(`table.header(${rowValues.join(', ')})`);
    else values.push(...rowValues);

    if (format === 'booktabs' && isHeaderRow && options.rows > 1) {
      values.push('table.hline(y: 1, stroke: 0.5pt)');
    }
  }

  if (format === 'booktabs') values.push(`table.hline(y: ${options.rows}, stroke: 0.8pt)`);

  // Calls nested in `figure(...)` are already in code context and must not
  // carry markup's `#` prefix.
  const callPrefix = wrapped ? 'table' : placement === 'markup' ? '#table' : 'table';
  const tableSource = `${callPrefix}(\n  columns: ${options.columns},\n  align: (${alignments.join(', ')}),\n  inset: 5pt,\n  stroke: ${format === 'grid' ? '0.5pt' : 'none'},\n${values.map((value) => `  ${value},`).join('\n')}\n)`;

  if (!wrapped) return tableSource;
  const figurePrefix = placement === 'markup' ? '#figure' : 'figure';
  const figureArguments = [tableSource];
  if (caption.trim()) figureArguments.push(`caption: [#text(${encodeTypstString(caption)})]`);
  figureArguments.push('kind: table');
  const figureSource = `${figurePrefix}(\n  ${figureArguments.join(',\n  ')},\n)${label ? ` <${label}>` : ''}`;
  return figureSource;
}

/** Generate native Typst `mat` source with the selected explicit delimiter. */
export function generateTypstMatrix(
  options: TypstMatrixOptions,
  context: MathContext = 'text',
  boundary?: { source: string; start: number; end: number },
): string {
  validateDimensions(options.rows, options.columns, 12, 12, 'matrix');
  validateGrid(options.cells, options.rows, options.columns);
  validateOptionalGrid(options.sourceCells, options.rows, options.columns, 'matrix source cells');
  if (context === 'blocked' || context === 'math-environment') {
    throw new TypstStructureError('The current editor context does not support matrix insertion.');
  }

  const delimiter = options.delimiter ?? 'parentheses';
  if (!matrixDelimiters.has(delimiter)) throw new TypstStructureError('Choose a supported matrix delimiter.');
  const rows = options.cells.map((row, rowIndex) => row.map((content, columnIndex) => renderMatrixCell(options, rowIndex, columnIndex, content)).join(', '));
  const delimiterSource = {
    // `none` is a value supplied from code context while the matrix's
    // arguments are parsed as math; `#none` is Typst's math code escape.
    none: '#none',
    parentheses: '"("',
    brackets: '"["',
    braces: '"{"',
    'single-bars': '"|"',
    'double-bars': '"‖"',
  } satisfies Record<TypstMatrixDelimiter, string>;
  const expression = `mat(delim: ${delimiterSource[delimiter]}, ${rows.join('; ')})`;
  if (context === 'text') return `$ ${expression} $`;
  if (!boundary) return expression;
  if (boundary.start < 0 || boundary.end < boundary.start || boundary.end > boundary.source.length) {
    throw new TypstStructureError('The matrix insertion range is outside the current document.');
  }
  const before = boundary.source[boundary.start - 1];
  const after = boundary.source[boundary.end];
  const joinsMathToken = (character: string | undefined) => Boolean(character && /[\p{L}\p{N}_\.]/u.test(character));
  return `${joinsMathToken(before) ? ' ' : ''}${expression}${joinsMathToken(after) ? ' ' : ''}`;
}

function renderTableCell(options: TypstTableOptions, row: number, column: number, content: string, header: boolean): string {
  const sourceCell = options.sourceCells?.[row]?.[column];
  const isTypst = options.cellTypst?.[row]?.[column] ?? sourceCell?.isTypst ?? false;

  validateSingleLine(content, 'Table cells');
  if (isTypst) validateTypstTableCell(content);
  const unchanged = sourceCell && sourceCell.content === content && sourceCell.isTypst === isTypst && sourceCell.header === header;
  if (unchanged) return validateAndReuseTableArgument(sourceCell.source);

  const cell = isTypst ? `[${content}]` : `[#text(${encodeTypstString(content)})]`;
  return header ? `[#strong${cell}]` : cell;
}

function validateAndReuseTableArgument(source: string): string {
  if (!source.startsWith('[') || !source.endsWith(']')) {
    throw new TypstStructureError('A parsed table cell no longer has a supported content argument.');
  }
  validateTypstTableCell(source.slice(1, -1));
  return source;
}

function renderMatrixCell(options: TypstMatrixOptions, row: number, column: number, content: string): string {
  const sourceCell = options.sourceCells?.[row]?.[column];
  validateSingleLine(content, 'Matrix cells');
  validateTypstMatrixCell(content);
  if (sourceCell && sourceCell.content === content) return validateAndReuseMatrixArgument(sourceCell.source);
  // An empty cell must retain its place in the matrix's row and column shape.
  return content.trim().length === 0 ? '""' : content;
}

function validateAndReuseMatrixArgument(source: string): string {
  if (!source.trim()) throw new TypstStructureError('A parsed matrix cell has an empty source argument.');
  validateTypstMatrixCell(source);
  return source;
}

function validateDimensions(rows: number, columns: number, maxRows: number, maxColumns: number, structure: string): void {
  if (!Number.isInteger(rows) || rows < 1 || rows > maxRows || !Number.isInteger(columns) || columns < 1 || columns > maxColumns) {
    throw new TypstStructureError(`${structure === 'table' ? 'Tables' : 'Matrices'} must have ${structure === 'table' ? '1–20 rows and 1–10 columns' : '1–12 rows and columns'}.`);
  }
}

function validateGrid(grid: string[][], rows: number, columns: number): void {
  if (!Array.isArray(grid) || grid.length !== rows || grid.some((row) => !Array.isArray(row) || row.length !== columns || row.some((value) => typeof value !== 'string'))) {
    throw new TypstStructureError('The cell content does not match the selected structure dimensions.');
  }
}

function validateOptionalGrid(grid: unknown[][] | undefined, rows: number, columns: number, label: string): void {
  if (grid && (grid.length !== rows || grid.some((row) => !Array.isArray(row) || row.length !== columns))) {
    throw new TypstStructureError(`${label} do not match the selected structure dimensions.`);
  }
}

function validateSingleLine(value: string, label: string): void {
  if (/[\r\n\u2028\u2029]/u.test(value)) throw new TypstStructureError(`${label} must stay on one line.`);
}
