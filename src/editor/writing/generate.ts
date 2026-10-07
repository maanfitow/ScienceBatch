import type { MathContext, MatrixOptions, TableOptions } from '../../types/writing';

export class WritingGenerationError extends Error { }

function checkDimensions(rows: number, columns: number, min: number, maxRows: number, maxColumns: number): void {
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < min || columns < min || rows > maxRows || columns > maxColumns) {
    throw new WritingGenerationError(`Dimensions must be between ${min} and ${maxRows} rows and ${min} and ${maxColumns} columns.`);
  }
}

function normalizedCells(cells: string[][], rows: number, columns: number, allowRawSeparators = false, cellLatex?: boolean[][]): string[][] {
  if (cells.length !== rows || cells.some((row) => row.length !== columns)) throw new WritingGenerationError('The cell content does not match the selected dimensions.');
  return cells.map((row, rowIndex) => row.map((cell, columnIndex) => {
    const rawLatex = cellLatex?.[rowIndex]?.[columnIndex] ?? allowRawSeparators;
    if (/[\r\n]/.test(cell)) throw new WritingGenerationError('Line breaks inside cells are not supported.');
    if (rawLatex && hasStructuralCellSyntax(cell)) throw new WritingGenerationError('Unescaped alignment separators, row terminators, comments, and nested writing structures are not allowed inside a LaTeX cell.');
    if (rawLatex) validateGroups(cell);
    return cell;
  }));
}

function hasStructuralCellSyntax(source: string): boolean {
  let slashCount = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const escaped = slashCount % 2 === 1;
    if ((char === '&' || char === '%') && !escaped) return true;
    if (char === '\\' && !escaped && source[i + 1] === '\\') return true;
    if (char === '\\' && !escaped && /^\\(?:begin|end)\s*\{(?:tabular|tabular\*|tabularx|longtable|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}/.test(source.slice(i))) return true;
    if (char === '\\') slashCount++;
    else slashCount = 0;
  }
  return false;
}

export function validateGroups(source: string): void {
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth < 0) throw new WritingGenerationError('Cell content contains an unmatched closing brace.');
  }
  if (depth !== 0) throw new WritingGenerationError('Cell content contains an unclosed brace group.');
}

function escapeTableText(value: string): string {
  const escaped: Record<string, string> = { '\\': '\\textbackslash{}', '#': '\\#', '$': '\\$', '%': '\\%', '&': '\\&', '_': '\\_', '{': '\\{', '}': '\\}', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}' };
  return value.replace(/[\\#$%&_{}^~]/g, (character) => escaped[character]);
}

export function generateTable(options: TableOptions, context: MathContext = 'text'): string {
  if (context !== 'text') throw new WritingGenerationError('Tables can only be inserted in text mode.');
  checkDimensions(options.rows, options.columns, 1, 20, 10);
  const cells = normalizedCells(options.cells, options.rows, options.columns, options.latexCells ?? false, options.cellLatex).map((row, rowIndex) => row.map((cell, columnIndex) => {
    const rawLatex = options.cellLatex?.[rowIndex]?.[columnIndex] ?? options.latexCells ?? false;
    return rawLatex ? cell : escapeTableText(cell);
  }));
  if (options.label?.trim() && !options.caption?.trim()) throw new WritingGenerationError('A label requires a caption.');
  if (options.caption?.trim()) {
    if (/[\r\n]/.test(options.caption)) throw new WritingGenerationError('Line breaks inside captions are not supported.');
    if (options.captionLatex) {
      validateGroups(options.caption);
      if (hasStructuralCellSyntax(options.caption)) throw new WritingGenerationError('Raw captions cannot contain comments, row terminators, or nested writing structures.');
    }
  }
  if (options.wrapInTable && options.label?.trim() && !/^[a-zA-Z0-9:._-]+$/.test(options.label.trim())) throw new WritingGenerationError('Labels may contain only letters, digits, colons, periods, underscores, and hyphens.');
  const alignment = Array.from({ length: options.columns }, (_, i) => options.alignment?.[i] ?? 'l');
  const bodyRows = cells.map((row, rowIndex) => {
    const values = row.map((cell) => options.header && rowIndex === 0 ? `\\textbf{${cell}}` : cell);
    return `${values.join(' & ')} \\\\`;
  });
  const format = options.format ?? 'plain';
  if (format === 'grid') {
    const lines = [`\\begin{tabular}{|${alignment.join('|')}|}`, '\\hline'];
    cells.forEach((row, rowIndex) => {
      const values = row.map((cell) => options.header && rowIndex === 0 ? `\\textbf{${cell}}` : cell);
      lines.push(`${values.join(' & ')} \\\\`, '\\hline');
    });
    lines.push('\\end{tabular}');
    bodyRows.splice(0, bodyRows.length, ...lines);
  } else if (format === 'booktabs') {
    const lines = ['\\begin{tabular}{' + alignment.join('') + '}', '\\toprule'];
    cells.forEach((row, rowIndex) => {
      const values = row.map((cell) => options.header && rowIndex === 0 ? `\\textbf{${cell}}` : cell);
      lines.push(`${values.join(' & ')} \\\\`);
      if (options.header && rowIndex === 0) lines.push('\\midrule');
    });
    lines.push('\\bottomrule', '\\end{tabular}');
    bodyRows.splice(0, bodyRows.length, ...lines);
  } else {
    bodyRows.unshift(`\\begin{tabular}{${alignment.join('')}}`);
    bodyRows.push('\\end{tabular}');
  }
  let content = bodyRows.join('\n');
  if (options.wrapInTable) {
    const caption = options.captionLatex ? options.caption?.trim() : options.caption?.trim() ? escapeTableText(options.caption.trim()) : undefined;
    const metadata = [caption ? `\\caption{${caption}}` : '', options.label?.trim() ? `\\label{${options.label.trim()}}` : ''].filter(Boolean).join('\n');
    content = `\\begin{table}[htbp]\n\\centering\n${metadata ? `${metadata}\n` : ''}${content}\n\\end{table}`;
  }
  return content;
}

const MATRIX_ENVS = new Set(['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix']);
export function generateMatrix(options: MatrixOptions, context: MathContext): string {
  if (context === 'blocked') throw new WritingGenerationError('This LaTeX context does not support matrix insertion.');
  checkDimensions(options.rows, options.columns, 1, 12, 12);
  const environment = options.environment ?? 'pmatrix';
  if (!MATRIX_ENVS.has(environment)) throw new WritingGenerationError('Choose a supported matrix delimiter.');
  const cells = normalizedCells(options.cells, options.rows, options.columns, true);
  const body = `${cells.map((row) => row.join('&')).join(' \\\\\n')} \\\\`;
  const matrix = `\\begin{${environment}}\n${body}\n\\end{${environment}}`;
  return context === 'text' ? `\\[\n${matrix}\n\\]` : matrix;
}
