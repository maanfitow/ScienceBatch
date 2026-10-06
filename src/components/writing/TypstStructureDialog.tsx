import React, { useMemo, useState } from 'react';
import { ArrowDownToLine, Braces, ChevronDown, Grid2X2, Table2, X } from 'lucide-react';
import type { MathContext, WritingEditorBridge, WritingSession } from '../../types/writing';
import type {
  ParsedTypstStructure, TypstAlignment, TypstMatrixDelimiter, TypstMatrixOptions, TypstTableFormat, TypstTableOptions,
} from '../../types/typstWriting';
import { generateTypstMatrix, generateTypstTable } from '../../editor/writing/typstStructureGenerate';
import { validateTypstMatrixCell, validateTypstTableCell } from '../../editor/writing/typstStructureValidation';
import { WritingSelect } from './WritingSelect';

type StructureKind = 'table' | 'matrix';
type CompatibleTypstStructure = Extract<ParsedTypstStructure, { compatible: true }>;

interface TypstStructureDialogProps {
  kind: StructureKind;
  session: WritingSession;
  bridge: WritingEditorBridge;
  context: MathContext;
  rangeContext: MathContext;
  parsed?: CompatibleTypstStructure;
  sectionRef: (node: HTMLElement | null) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  onCancel: () => void;
  onApplied: (session: WritingSession) => void;
}

const tableDefaults = (): TypstTableOptions => ({
  rows: 3,
  columns: 3,
  cells: Array.from({ length: 3 }, () => Array(3).fill('')),
  alignment: Array(3).fill('left'),
  format: 'plain',
  header: false,
  wrapInFigure: false,
  cellTypst: Array.from({ length: 3 }, () => Array(3).fill(false)),
});

const matrixDefaults = (): TypstMatrixOptions => ({
  rows: 2,
  columns: 2,
  cells: Array.from({ length: 2 }, () => Array(2).fill('')),
  delimiter: 'parentheses',
});

const delimiterOptions: Array<{ value: TypstMatrixDelimiter; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'parentheses', label: 'Parentheses' },
  { value: 'brackets', label: 'Brackets' },
  { value: 'braces', label: 'Braces' },
  { value: 'single-bars', label: 'Single bars' },
  { value: 'double-bars', label: 'Double bars' },
];

const alignmentOptions: Array<{ value: TypstAlignment; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];

function ensureTableDimensions(options: TypstTableOptions, rows: number, columns: number): TypstTableOptions {
  return {
    ...options,
    rows,
    columns,
    cells: Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => options.cells[row]?.[column] ?? '')),
    alignment: Array.from({ length: columns }, (_, column) => options.alignment?.[column] ?? 'left'),
    cellTypst: Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => options.cellTypst?.[row]?.[column] ?? false)),
    sourceCells: options.sourceCells ? Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => options.sourceCells?.[row]?.[column])) : undefined,
  };
}

function ensureMatrixDimensions(options: TypstMatrixOptions, rows: number, columns: number): TypstMatrixOptions {
  return {
    ...options,
    rows,
    columns,
    cells: Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => options.cells[row]?.[column] ?? '')),
    sourceCells: options.sourceCells ? Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => options.sourceCells?.[row]?.[column])) : undefined,
  };
}

function displayLabel(value: TypstMatrixDelimiter): string {
  switch (value) {
    case 'none': return '';
    case 'parentheses': return '( )';
    case 'brackets': return '[ ]';
    case 'braces': return '{ }';
    case 'single-bars': return '| |';
    case 'double-bars': return '‖ ‖';
  }
}

function formatIndexes(indexes: number[]): string {
  if (indexes.length === 0) return '';
  const ranges: string[] = [];
  let start = indexes[0];
  let end = start;
  for (const value of indexes.slice(1)) {
    if (value === end + 1) end = value;
    else { ranges.push(start === end ? `${start}` : `${start}–${end}`); start = value; end = value; }
  }
  ranges.push(start === end ? `${start}` : `${start}–${end}`);
  return ranges.join(', ');
}

export const TypstStructureDialog: React.FC<TypstStructureDialogProps> = ({
  kind, session, bridge, context, rangeContext, parsed, sectionRef, onKeyDown, onCancel, onApplied,
}) => {
  const parsedTable = parsed?.kind === 'table' ? parsed.value : null;
  const parsedMatrix = parsed?.kind === 'matrix' ? parsed.value : null;
  const [table, setTable] = useState<TypstTableOptions>(() => parsedTable ?? tableDefaults());
  const [matrix, setMatrix] = useState<TypstMatrixOptions>(() => parsedMatrix ?? matrixDefaults());
  const [moreOptions, setMoreOptions] = useState(Boolean(parsedTable && (parsedTable.wrapInFigure || (parsedTable.format ?? 'plain') !== 'plain' || parsedTable.header)));
  const [sourceTab, setSourceTab] = useState(false);
  const [validation, setValidation] = useState('');
  const [confirmShrink, setConfirmShrink] = useState(false);
  const [pendingDimensions, setPendingDimensions] = useState<{ rows: number; columns: number } | null>(null);
  const [rowsInput, setRowsInput] = useState<HTMLInputElement | null>(null);
  const editing = Boolean(parsed);
  const sessionCurrent = bridge.isCurrent(session);
  const insertionContext: MathContext = parsed?.kind === 'matrix'
    ? (parsed.placement === 'display' ? 'text' : 'math-inline')
    : parsed?.kind === 'table'
      ? (parsed.placement === 'code' ? 'text' : 'text')
      : context;
  const activeRangeContext = editing ? insertionContext : rangeContext;
  const focusTarget = parsed ? { start: parsed.start, end: parsed.end } : { start: session.start, end: session.end };
  const cellError = useMemo(() => {
    if (kind === 'table') {
      for (let row = 0; row < table.rows; row += 1) for (let column = 0; column < table.columns; column += 1) {
        const content = table.cells[row]?.[column] ?? '';
        try {
          if (table.cellTypst?.[row]?.[column]) validateTypstTableCell(content);
          else if (/[\r\n\u2028\u2029]/u.test(content)) throw new Error('Cell content must stay on one line.');
        } catch (error) { return `Row ${row + 1}, column ${column + 1}: ${error instanceof Error ? error.message : 'Invalid Typst content.'}`; }
      }
    } else {
      for (let row = 0; row < matrix.rows; row += 1) for (let column = 0; column < matrix.columns; column += 1) {
        try { validateTypstMatrixCell(matrix.cells[row]?.[column] ?? ''); }
        catch (error) { return `Row ${row + 1}, column ${column + 1}: ${error instanceof Error ? error.message : 'Invalid Typst math expression.'}`; }
      }
    }
    return '';
  }, [kind, table, matrix]);

  let generated = '';
  let generationError = '';
  try {
    if (kind === 'table') {
      generated = generateTypstTable(table, parsed?.kind === 'table' ? parsed.placement : 'markup');
    } else {
      const generationContext = editing ? insertionContext : rangeContext;
      generated = generateTypstMatrix(matrix, generationContext, { source: session.source, start: focusTarget.start, end: focusTarget.end });
    }
  } catch (error) {
    generationError = error instanceof Error ? error.message : 'Unable to generate this structure.';
  }

  const populatedCellsAffected = (rows: number, columns: number): { rows: number[]; columns: number[] } => {
    const value = kind === 'table' ? table : matrix;
    const affectedRows = new Set<number>();
    const affectedColumns = new Set<number>();
    value.cells.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
      if (cell.length > 0 && (rowIndex >= rows || columnIndex >= columns)) {
        if (rowIndex >= rows) affectedRows.add(rowIndex + 1);
        if (columnIndex >= columns) affectedColumns.add(columnIndex + 1);
      }
    }));
    return { rows: [...affectedRows], columns: [...affectedColumns] };
  };
  const affected = pendingDimensions ? populatedCellsAffected(pendingDimensions.rows, pendingDimensions.columns) : { rows: [], columns: [] };
  const shrinkMessage = [affected.rows.length ? `rows ${formatIndexes(affected.rows)}` : '', affected.columns.length ? `columns ${formatIndexes(affected.columns)}` : ''].filter(Boolean).join(' and ');

  const commitDimensions = (rows: number, columns: number) => {
    if (kind === 'table') setTable((current) => ensureTableDimensions(current, rows, columns));
    else setMatrix((current) => ensureMatrixDimensions(current, rows, columns));
    setPendingDimensions(null);
    setConfirmShrink(false);
  };

  const requestDimensions = (rowsValue: number, columnsValue: number) => {
    const rows = Math.max(1, Math.min(kind === 'table' ? 20 : 12, rowsValue));
    const columns = Math.max(1, Math.min(kind === 'table' ? 10 : 12, columnsValue));
    const current = kind === 'table' ? table : matrix;
    const removesContent = current.cells.some((row, rowIndex) => row.some((cell, columnIndex) => cell.length > 0 && (rowIndex >= rows || columnIndex >= columns)));
    if (removesContent) {
      setPendingDimensions({ rows, columns });
      setConfirmShrink(true);
      return;
    }
    commitDimensions(rows, columns);
  };

  const confirmReduction = () => {
    if (pendingDimensions) commitDimensions(pendingDimensions.rows, pendingDimensions.columns);
    window.requestAnimationFrame(() => rowsInput?.focus());
  };

  const updateTableCell = (row: number, column: number, value: string) => {
    setValidation('');
    setTable((current) => ({ ...current, cells: current.cells.map((cells, rowIndex) => rowIndex === row ? cells.map((cell, columnIndex) => columnIndex === column ? value : cell) : cells) }));
  };

  const toggleCellTypst = (row: number, column: number) => {
    setValidation('');
    setTable((current) => ({ ...current, cellTypst: current.cells.map((cells, rowIndex) => cells.map((_, columnIndex) => rowIndex === row && columnIndex === column ? !(current.cellTypst?.[rowIndex]?.[columnIndex] ?? false) : current.cellTypst?.[rowIndex]?.[columnIndex] ?? false)) }));
  };

  const updateMatrixCell = (row: number, column: number, value: string) => {
    setValidation('');
    setMatrix((current) => ({ ...current, cells: current.cells.map((cells, rowIndex) => rowIndex === row ? cells.map((cell, columnIndex) => columnIndex === column ? value : cell) : cells) }));
  };

  const sourceValidation = useMemo(() => {
    if (editing) return '';
    if (rangeContext === 'blocked') return 'The current selection crosses an unavailable Typst context.';
    if (kind === 'table' && rangeContext !== 'text') return 'Tables can only be inserted in Typst markup.';
    return '';
  }, [editing, rangeContext, kind]);

  const applyStructure = () => {
    if (!sessionCurrent) { setValidation('The editor changed while this dialog was open. Close it and try again.'); return; }
    if (confirmShrink && pendingDimensions) { setValidation('Confirm or cancel the dimension change before inserting.'); return; }
    if (sourceValidation) { setValidation(sourceValidation); return; }
    if (cellError) { setValidation(cellError); return; }
    if (!generated || generationError) { setValidation(generationError || 'Unable to generate this structure.'); return; }
    const caret = focusTarget.start + generated.length;
    const result = bridge.apply(session, { ...focusTarget, text: generated, selection: { anchor: caret, active: caret } });
    if (!result) { setValidation('The editor changed before this structure could be applied.'); return; }
    onApplied(result);
  };

  const currentRows = kind === 'table' ? table.rows : matrix.rows;
  const currentColumns = kind === 'table' ? table.columns : matrix.columns;
  const title = kind === 'table' ? (editing ? 'Edit table' : 'Create a table') : (editing ? 'Edit matrix' : 'Create a matrix');
  const icon = kind === 'table' ? <Table2 size={18} aria-hidden="true" /> : <Grid2X2 size={18} aria-hidden="true" />;

  return <section className="writing-dialog writing-dialog-builder writing-dialog-typst-structure" role="dialog" aria-modal="true" aria-labelledby="writing-typst-structure-title" ref={sectionRef} onKeyDown={onKeyDown}>
    <header className="writing-dialog-header">
      <div className="writing-dialog-heading">{icon}<div><h2 id="writing-typst-structure-title">{title}</h2><p>{sessionCurrent ? `Typst · ${activeRangeContext.replace('-', ' ')}` : 'The editor session is no longer current.'}</p></div></div>
      <button type="button" className="writing-icon-button" aria-label="Close writing tools" onClick={onCancel}><X size={17} /></button>
    </header>
    {!sessionCurrent && <p className="writing-alert" role="alert">The editor changed while this dialog was open. Close it and retry.</p>}
    <div className="writing-builder-body">
      <div className="writing-builder-tabs" role="tablist" aria-label="Builder view">
        <button type="button" role="tab" aria-selected={!sourceTab} className={!sourceTab ? 'is-active' : ''} onClick={() => setSourceTab(false)}>Build</button>
        <button type="button" role="tab" aria-selected={sourceTab} className={sourceTab ? 'is-active' : ''} onClick={() => setSourceTab(true)}>Source</button>
      </div>
      {!sourceTab ? <div className="writing-builder-grid">
        <div className="writing-builder-controls">
          <fieldset className="writing-dimensions"><legend>Dimensions</legend>
            <label>Rows<input ref={setRowsInput} type="number" min="1" max={kind === 'table' ? 20 : 12} value={pendingDimensions?.rows ?? currentRows} onChange={(event) => requestDimensions(Number(event.target.value), pendingDimensions?.columns ?? currentColumns)} /></label>
            <label>Columns<input type="number" min="1" max={kind === 'table' ? 10 : 12} value={pendingDimensions?.columns ?? currentColumns} onChange={(event) => requestDimensions(pendingDimensions?.rows ?? currentRows, Number(event.target.value))} /></label>
          </fieldset>
          {confirmShrink && <div className="writing-confirm-shrink" role="alert"><span>Reducing dimensions will remove populated cells in {shrinkMessage}.</span><button type="button" onClick={() => { setConfirmShrink(false); setPendingDimensions(null); window.requestAnimationFrame(() => rowsInput?.focus()); }}>Keep cells</button><button type="button" onClick={confirmReduction}>Confirm reduction</button></div>}
          {kind === 'table' ? <>
            <fieldset className="writing-dimensions"><legend>Column alignment</legend><div className="writing-alignment-row">{Array.from({ length: table.columns }, (_, column) => <div className="writing-alignment-field" key={column}><span>Column {column + 1}</span><WritingSelect label={`Column ${column + 1} alignment`} value={table.alignment?.[column] ?? 'left'} options={alignmentOptions} onValueChange={(value) => setTable((current) => ({ ...current, alignment: current.alignment?.map((alignment, index) => index === column ? value as TypstAlignment : alignment) }))} /></div>)}</div></fieldset>
            <button type="button" className="writing-more-toggle" aria-expanded={moreOptions} onClick={() => setMoreOptions((value) => !value)}>More options <ChevronDown size={14} className={moreOptions ? 'is-open' : ''} /></button>
            {moreOptions && <div className="writing-more-options">
              <div className="writing-select-field"><span>Format</span><WritingSelect label="Format" value={table.format ?? 'plain'} options={[{ value: 'plain', label: 'Plain' }, { value: 'grid', label: 'Grid' }, { value: 'booktabs', label: 'Booktabs' }]} onValueChange={(value) => setTable((current) => ({ ...current, format: value as TypstTableFormat }))} /></div>
              <label className="writing-check"><input type="checkbox" checked={table.header ?? false} onChange={(event) => setTable((current) => ({ ...current, header: event.target.checked }))} />Header row</label>
              <label className="writing-check"><input type="checkbox" checked={table.wrapInFigure ?? false} onChange={(event) => setTable((current) => ({ ...current, wrapInFigure: event.target.checked }))} />Wrap in figure</label>
              {table.wrapInFigure && <><label>Caption<input value={table.caption ?? ''} onChange={(event) => setTable((current) => ({ ...current, caption: event.target.value }))} placeholder="Optional caption" /></label><label>Label<input value={table.label ?? ''} onChange={(event) => setTable((current) => ({ ...current, label: event.target.value }))} placeholder="Optional label" /></label><p className="writing-table-preview-note">Captions are literal text. Custom numbering and placement are not evaluated.</p></>}
            </div>}
          </> : <div className="writing-select-field"><span>Matrix delimiters</span><WritingSelect label="Matrix delimiters" value={matrix.delimiter ?? 'parentheses'} options={delimiterOptions} onValueChange={(value) => setMatrix((current) => ({ ...current, delimiter: value as TypstMatrixDelimiter }))} /></div>}
        </div>
        <div className="writing-cell-editor" aria-label="Structure cells">
          {Array.from({ length: currentRows }, (_, row) => <div className="writing-cell-row" key={row}>{Array.from({ length: currentColumns }, (_, column) => {
            const isTypst = kind === 'table' && Boolean(table.cellTypst?.[row]?.[column]);
            const value = kind === 'table' ? table.cells[row]?.[column] ?? '' : matrix.cells[row]?.[column] ?? '';
            return <div className={`writing-cell ${kind === 'table' && table.header && row === 0 ? 'is-header' : ''}`} key={column}>
              <span className="sr-only">Row {row + 1}, column {column + 1}{kind === 'table' && table.header && row === 0 ? ', header' : ''}</span>
              <input aria-label={`Row ${row + 1}, column ${column + 1}${kind === 'table' ? (isTypst ? ', Typst markup' : ', text') : ', Typst math expression'}`} aria-invalid={cellError.startsWith(`Row ${row + 1}, column ${column + 1}:`) || undefined} aria-describedby={cellError.startsWith(`Row ${row + 1}, column ${column + 1}:`) ? 'writing-typst-cell-error' : undefined} value={value} onChange={(event) => kind === 'table' ? updateTableCell(row, column, event.target.value) : updateMatrixCell(row, column, event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); (event.currentTarget.closest('.writing-cell')?.nextElementSibling?.querySelector('input') as HTMLInputElement | null)?.focus(); } }} />
              {kind === 'table' && <button type="button" className="writing-cell-mode" title={isTypst ? 'Cell content is Typst markup' : 'Cell content is literal text'} aria-label={`Toggle Typst markup for row ${row + 1}, column ${column + 1}`} aria-pressed={isTypst} onClick={() => toggleCellTypst(row, column)}><Braces size={12} /></button>}
            </div>;
          })}</div>)}
          {cellError && <p id="writing-typst-cell-error" className="writing-note" role="alert">{cellError}</p>}
          {kind === 'table' ? <TypstTablePreview options={table} /> : <TypstMatrixPreview options={matrix} />}
          <p className="writing-table-preview-note">Schematic preview. Final font and size depend on the document rules.</p>
        </div>
      </div> : <div className="writing-source-pane"><pre>{generated}</pre></div>}
      <div className="writing-dialog-footer"><span className="writing-inline-status" role={validation || generationError ? 'alert' : 'status'}>{validation || cellError || sourceValidation || generationError}</span><button type="button" className="writing-secondary-button" onClick={onCancel}>Cancel</button><button type="button" className="writing-primary-button" onClick={applyStructure} disabled={!sessionCurrent || confirmShrink || Boolean(sourceValidation || cellError || generationError)}><ArrowDownToLine size={15} />{editing ? 'Update' : 'Insert'}</button></div>
    </div>
  </section>;
};

const TypstTablePreview: React.FC<{ options: TypstTableOptions }> = ({ options }) => {
  const format = options.format ?? 'plain';
  return <div className={`writing-table-preview format-${format} ${options.header ? 'has-header' : ''}`} aria-label="Schematic table preview">
    <div className="writing-table-preview-scroll" tabIndex={0} aria-label="Scrollable table preview">
      <table><tbody>{options.cells.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td className={options.header && rowIndex === 0 ? 'is-header' : ''} style={{ textAlign: options.alignment?.[columnIndex] ?? 'left' }} key={columnIndex}>{options.cellTypst?.[rowIndex]?.[columnIndex] ? <code>{cell || ' '}</code> : cell || ' '}</td>)}</tr>)}</tbody></table>
    </div>
  </div>;
};

const TypstMatrixPreview: React.FC<{ options: TypstMatrixOptions }> = ({ options }) => <div className="writing-typst-matrix-preview" aria-label={`${displayLabel(options.delimiter ?? 'parentheses')} matrix preview`}>
  <span className="writing-typst-matrix-delimiter" aria-hidden="true">{displayLabel(options.delimiter ?? 'parentheses').split(' ')[0]}</span>
  <table><tbody>{options.cells.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex}><code>{cell || ' '}</code></td>)}</tr>)}</tbody></table>
  <span className="writing-typst-matrix-delimiter" aria-hidden="true">{displayLabel(options.delimiter ?? 'parentheses').split(' ')[1]}</span>
</div>;
