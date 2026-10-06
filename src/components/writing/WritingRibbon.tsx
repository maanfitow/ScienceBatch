import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, Braces, Check, ChevronDown, CircleHelp, Grid2X2, ListFilter, Search, Sigma, Table2, X } from 'lucide-react';
import { WritingSelect } from './WritingSelect';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type {
  MathContext, MatrixOptions, ParsedStructure, SymbolEntry, TableOptions,
  WritingEditorBridge, WritingEditorState, WritingSession,
} from '../../types/writing';
import type { ParsedTypstStructure } from '../../types/typstWriting';
import {
  generateMatrix, generateTable, inspectPackageEligibility,
  inspectPackageLoadState, parseWritingStructureAt, planPackageAddition, requiredPackagesInSource,
} from '../../editor/writing';
import { getWritingSymbolAdapter } from '../../editor/writing/adapters';
import { parseTypstStructureAt } from '../../editor/writing/typstStructureParser';
import { TypstStructureDialog } from './TypstStructureDialog';
import './writing.css';

interface WritingRibbonProps {
  bridge: WritingEditorBridge | null;
  editorState: WritingEditorState;
  onOpenMainFile?: () => void;
}

type DialogKind = 'symbols' | 'table' | 'matrix';
type PreviewState = { html: string; error: string | null };
const MATRIX_ENVS: NonNullable<MatrixOptions['environment']>[] = ['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix'];
const CATEGORIES: SymbolEntry['category'][] = ['Greek letters', 'Operators', 'Relations', 'Arrows', 'Sets and logic', 'Miscellaneous'];

function renderMath(source: string): PreviewState {
  try {
    return { html: katex.renderToString(source || String.raw`\,`, { throwOnError: true, output: 'htmlAndMathml', trust: false, maxExpand: 100, maxSize: 10, displayMode: true }), error: null };
  } catch (error) {
    return { html: '', error: error instanceof Error ? error.message : 'Preview is unavailable for this expression.' };
  }
}

function trapDialogFocus(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return;
  const root = event.currentTarget;
  const items = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'))
    .filter((item) => item.getAttribute('aria-hidden') !== 'true');
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
}

function seedOptions<T>(parsed: ParsedStructure<T> | null, fallback: T): T {
  return parsed?.compatible ? parsed.value : fallback;
}

export const WritingRibbon: React.FC<WritingRibbonProps> = ({ bridge, editorState, onOpenMainFile }) => {
  const adapter = getWritingSymbolAdapter(editorState.language);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [session, setSession] = useState<WritingSession | null>(null);
  const [editing, setEditing] = useState<ParsedStructure<TableOptions | MatrixOptions> | null>(null);
  const [typstEditing, setTypstEditing] = useState<Extract<ParsedTypstStructure, { compatible: true }> | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SymbolEntry['category'] | 'All'>('All');
  const [table, setTable] = useState<TableOptions>({ rows: 3, columns: 3, cells: Array.from({ length: 3 }, () => Array(3).fill('')), alignment: ['l', 'l', 'l'], format: 'plain', header: false, wrapInTable: false, latexCells: false });
  const [matrix, setMatrix] = useState<MatrixOptions>({ rows: 2, columns: 2, cells: Array.from({ length: 2 }, () => Array(2).fill('')), environment: 'pmatrix' });
  const [moreOptions, setMoreOptions] = useState(false);
  const [sourceTab, setSourceTab] = useState(false);
  const [validation, setValidation] = useState('');
  const [confirmShrink, setConfirmShrink] = useState(false);
  const [pendingDimensions, setPendingDimensions] = useState<{ rows: number; columns: number } | null>(null);
  const [status, setStatus] = useState('');
  const [compactOpen, setCompactOpen] = useState(false);
  const [symbolIndex, setSymbolIndex] = useState(0);
  const [symbolPopoverMaxHeight, setSymbolPopoverMaxHeight] = useState<number>();
  const compactTrigger = useRef<HTMLButtonElement>(null);
  const pendingFocusRestore = useRef<WritingSession | null>(null);
  const ribbonRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const symbolResultsRef = useRef<HTMLDivElement>(null);
  const rowsInputRef = useRef<HTMLInputElement>(null);
  const available = editorState.available && Boolean(bridge);
  const sessionCurrent = Boolean(session && bridge?.isCurrent(session));
  const contextResult = session ? adapter.classifyContext(session.source, session.active) : { context: 'blocked' as const };
  const context: MathContext = contextResult.context;
  const rangeResult = session ? adapter.classifyRange(session.source, session.start, session.end) : { context: 'blocked' as const };
  const rangeContext: MathContext = rangeResult.context;
  const parsedAtCursor = adapter.language === 'latex' && adapter.supportsStructures && editorState.source ? parseWritingStructureAt(editorState.source, editorState.cursorOffset) : null;
  const parsedTypstAtCursor = adapter.language === 'typst' && adapter.supportsStructures && editorState.source ? parseTypstStructureAt(editorState.source, editorState.cursorOffset) : null;
  const parsedStructureAtCursor = parsedTypstAtCursor ?? parsedAtCursor;
  const symbols = useMemo(() => adapter.searchSymbols(query, category === 'All' ? undefined : category), [adapter, query, category]);
  const safeSymbolIndex = Math.min(symbolIndex, Math.max(0, symbols.length - 1));
  const activeSymbol = symbols[safeSymbolIndex] ?? null;
  const symbolPackages = activeSymbol?.packages ?? [];
  const symbolPackageState = adapter.language === 'latex' ? inspectPackageLoadState(editorState.source, symbolPackages) : { missing: [], uncertain: false };
  const symbolPackageEligibility = adapter.language === 'latex' ? inspectPackageEligibility(editorState.source) : { eligible: false, reason: undefined };
  const requiredPackages = useMemo(() => {
    let source = '';
    if (dialog === 'matrix') source = `\\begin{${matrix.environment ?? 'pmatrix'}}\n${matrix.cells.map((row) => row.join(' & ')).join(' \\\\\n')}\n\\end{${matrix.environment ?? 'pmatrix'}}`;
    if (dialog === 'table') {
      source = table.cells.flatMap((row, rowIndex) => row.filter((_, columnIndex) => table.cellLatex?.[rowIndex]?.[columnIndex] ?? table.latexCells ?? false)).join('\n');
      if (table.format === 'booktabs') source += '\n\\toprule';
      if (table.captionLatex && table.caption) source += `\n\\caption{${table.caption}}`;
    }
    return adapter.language === 'latex' ? requiredPackagesInSource(source) : [];
  }, [adapter.language, dialog, matrix, table]);
  const requiredPackageState = adapter.language === 'latex' ? inspectPackageLoadState(editorState.source, requiredPackages) : { missing: [], uncertain: false };
  const packageEligibility = adapter.language === 'latex' ? inspectPackageEligibility(editorState.source) : { eligible: false, reason: undefined };
  const packagePlanEligible = editorState.canAddPackages && packageEligibility.eligible && !requiredPackageState.uncertain;

  useEffect(() => {
    setSymbolIndex(0);
    if (symbolResultsRef.current) symbolResultsRef.current.scrollTop = 0;
  }, [query, category]);
  useEffect(() => {
    if (dialog) {
      const id = window.requestAnimationFrame(() => (dialog === 'symbols' ? searchRef.current : dialogRef.current?.querySelector<HTMLElement>('input,button,select,textarea'))?.focus());
      return () => window.cancelAnimationFrame(id);
    }
    return undefined;
  }, [dialog]);

  useEffect(() => {
    if (!dialog) {
      if (!pendingFocusRestore.current || !bridge) return undefined;
      const target = pendingFocusRestore.current;
      pendingFocusRestore.current = null;
      const id = window.requestAnimationFrame(() => bridge.restore(target));
      return () => window.cancelAnimationFrame(id);
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (dialogRef.current?.querySelector('[data-writing-select-popup="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      restoreAndClose();
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [dialog, bridge, session]);

  useEffect(() => {
    if (dialog === null || dialog === 'symbols') return undefined;
    const appRoot = document.getElementById('root');
    if (!appRoot) return undefined;
    const wasInert = appRoot.inert;
    const previousAriaHidden = appRoot.getAttribute('aria-hidden');
    appRoot.inert = true;
    appRoot.setAttribute('aria-hidden', 'true');
    const containFocus = (event: FocusEvent) => {
      if (dialogRef.current?.contains(event.target as Node)) return;
      window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')?.focus());
    };
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('focusin', containFocus);
      appRoot.inert = wasInert;
      if (previousAriaHidden === null) appRoot.removeAttribute('aria-hidden'); else appRoot.setAttribute('aria-hidden', previousAriaHidden);
    };
  }, [dialog]);

  useEffect(() => {
    if (dialog !== 'symbols') return undefined;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Element;
      if (dialogRef.current && !dialogRef.current.contains(target) && !target.closest('.writing-ribbon')) restoreAndClose();
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [dialog, session, bridge]);

  useLayoutEffect(() => {
    if (dialog !== 'symbols') return undefined;
    const updateAvailableHeight = () => {
      const ribbonBottom = ribbonRef.current?.getBoundingClientRect().bottom ?? 0;
      const bottomMargin = 12;
      const panelGap = 4;
      setSymbolPopoverMaxHeight(Math.max(0, window.innerHeight - ribbonBottom - panelGap - bottomMargin));
    };
    updateAvailableHeight();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateAvailableHeight);
    if (ribbonRef.current) observer?.observe(ribbonRef.current);
    if (dialogRef.current) observer?.observe(dialogRef.current);
    window.addEventListener('resize', updateAvailableHeight);
    window.addEventListener('scroll', updateAvailableHeight, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateAvailableHeight);
      window.removeEventListener('scroll', updateAvailableHeight, true);
    };
  }, [dialog]);

  useEffect(() => {
    if (!compactOpen) return undefined;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!target.closest('.writing-ribbon-compact')) setCompactOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [compactOpen]);

  const restoreAndClose = (restore = true, openMain = false, focusSession?: WritingSession) => {
    const target = focusSession ?? (restore ? session : null);
    if (target && bridge) {
      if (dialog && dialog !== 'symbols' && !openMain) pendingFocusRestore.current = target;
      else if (!openMain) bridge.restore(target);
    }
    setDialog(null); setSession(null); setEditing(null); setTypstEditing(null); setValidation(''); setStatus(''); setConfirmShrink(false); setPendingDimensions(null);
    setCompactOpen(false);
    if (openMain) window.requestAnimationFrame(() => onOpenMainFile?.());
  };

  const open = (kind: DialogKind) => {
    if (!available || !bridge || (kind !== 'symbols' && !adapter.supportsStructures)) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const captured = bridge.capture();
    if (!captured) return;
    setSession(captured); setEditing(null); setTypstEditing(null); setQuery(''); setCategory('All'); setMoreOptions(false); setSourceTab(false); setValidation(''); setStatus(''); setConfirmShrink(false); setPendingDimensions(null); setCompactOpen(false);
    if (kind === 'table') setTable({ rows: 3, columns: 3, cells: Array.from({ length: 3 }, () => Array(3).fill('')), alignment: ['l', 'l', 'l'], format: 'plain', header: false, wrapInTable: false, latexCells: false });
    if (kind === 'matrix') setMatrix({ rows: 2, columns: 2, cells: Array.from({ length: 2 }, () => Array(2).fill('')), environment: 'pmatrix' });
    setDialog(kind);
  };

  const openExisting = (kind: 'table' | 'matrix') => {
    if (!adapter.supportsStructures || !editorState.editable || !bridge) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const captured = bridge.capture();
    if (!captured) return;
    if (adapter.language === 'typst') {
      const parsed = parseTypstStructureAt(captured.source, captured.active);
      if (!parsed || parsed.kind !== kind || !parsed.compatible) {
        setStatus((parsed && 'reason' in parsed ? parsed.reason : undefined) ?? `No compatible ${kind} was found at the cursor.`);
        return;
      }
      setSession({ ...captured, start: parsed.start, end: parsed.end });
      setEditing(null);
      setTypstEditing(parsed);
      setMoreOptions(kind === 'table');
      setSourceTab(false); setValidation(''); setStatus(''); setConfirmShrink(false); setPendingDimensions(null); setCompactOpen(false);
      setDialog(kind);
      return;
    }
    const parsed = parseWritingStructureAt(captured.source, captured.active);
    if (!parsed || parsed.kind !== kind || !parsed.compatible) {
      setStatus(parsed?.reason ?? `No compatible ${kind} was found at the cursor.`);
      return;
    }
    setSession({ ...captured, start: parsed.start, end: parsed.end }); setEditing(parsed as ParsedStructure<TableOptions | MatrixOptions>); setTypstEditing(null); setMoreOptions(kind === 'table'); setSourceTab(false); setValidation(''); setStatus(''); setConfirmShrink(false); setPendingDimensions(null); setCompactOpen(false);
    if (kind === 'table') setTable(seedOptions(parsed as ParsedStructure<TableOptions>, { rows: 3, columns: 3, cells: [], format: 'plain', header: false, wrapInTable: false, alignment: ['l', 'l', 'l'] }));
    else setMatrix(seedOptions(parsed as ParsedStructure<MatrixOptions>, { rows: 2, columns: 2, cells: [], environment: 'pmatrix' }));
    setDialog(kind);
  };

  const focusSourceForEditing = () => {
    if (!bridge) return;
    const captured = bridge.capture();
    if (captured) bridge.restore(captured);
    setCompactOpen(false);
  };

  const apply = (text: string, selectedSession = session, replacement?: { start: number; end: number }) => {
    if (!selectedSession || !bridge || !bridge.isCurrent(selectedSession)) { setValidation('The editor changed while this tool was open. Close it and try again.'); return null; }
    const start = replacement?.start ?? selectedSession.start;
    const end = replacement?.end ?? selectedSession.end;
    const caret = start + text.length;
    const result = bridge.apply(selectedSession, { start, end, text, selection: { anchor: caret, active: caret } });
    if (!result) { setValidation('The edit could not be applied because the editor session changed.'); return null; }
    return result;
  };

  const insertSymbol = (entry: SymbolEntry | null) => {
    if (!entry || !session || !bridge) return;
    const insertion = adapter.symbolInsertion(entry.command, rangeContext, session.source, session.start, session.end);
    if (insertion.reason || !bridge.isCurrent(session)) { setValidation(insertion.reason ?? 'This symbol cannot be inserted at the current selection.'); return; }
    const caret = session.start + insertion.text.length;
    const result = bridge.apply(session, { start: session.start, end: session.end, text: insertion.text, selection: { anchor: caret, active: caret } });
    if (!result) { setValidation('The editor changed before the symbol could be inserted.'); return; }
    restoreAndClose(false);
  };

  const changeDimensions = (kind: DialogKind, rows: number, columns: number) => {
    const nextRows = Math.max(1, Math.min(kind === 'table' ? 20 : 12, rows));
    const nextColumns = Math.max(1, Math.min(kind === 'table' ? 10 : 12, columns));
    const old = kind === 'table' ? table : matrix;
    const hasContent = old.cells.some((row, r) => row.some((cell, c) => (r >= nextRows || c >= nextColumns) && cell.length > 0));
    if (hasContent) { setPendingDimensions({ rows: nextRows, columns: nextColumns }); setConfirmShrink(true); return; }
    setPendingDimensions(null); setConfirmShrink(false); commitDimensions(kind, nextRows, nextColumns);
  };

  const commitDimensions = (kind: DialogKind, rows: number, columns: number) => {
    if (kind === 'table') setTable((old) => ({ ...old, rows, columns, cells: Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => old.cells[r]?.[c] ?? '')), alignment: Array.from({ length: columns }, (_, c) => old.alignment?.[c] ?? 'l'), cellLatex: Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => old.cells[r]?.[c] !== undefined ? old.cellLatex?.[r]?.[c] ?? old.latexCells ?? false : false)) }));
    else setMatrix((old) => ({ ...old, rows, columns, cells: Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => old.cells[r]?.[c] ?? '')) }));
  };

  const confirmDimensions = () => {
    if (dialog && pendingDimensions) commitDimensions(dialog, pendingDimensions.rows, pendingDimensions.columns);
    setPendingDimensions(null); setConfirmShrink(false);
    window.requestAnimationFrame(() => rowsInputRef.current?.focus());
  };

  let generated: string | null = null;
  let generationError = '';
  const matrixContext: MathContext = editing?.kind === 'matrix' ? 'math-environment' : context;
  try { generated = adapter.language === 'latex' ? (dialog === 'matrix' ? generateMatrix(matrix, matrixContext) : dialog === 'table' ? generateTable(table, 'text') : null) : null; }
  catch (error) { generationError = error instanceof Error ? error.message : 'Unable to generate this structure.'; }
  let matrixPreviewSource = '';
  if (dialog === 'matrix') {
    if (adapter.language === 'latex') { try { matrixPreviewSource = generateMatrix(matrix, 'math-environment'); } catch { matrixPreviewSource = ''; } }
  }
  const preview = adapter.language === 'latex' && dialog === 'matrix' && matrixPreviewSource ? renderMath(matrixPreviewSource) : null;
  const symbolPreview = activeSymbol && adapter.previewKind === 'latex' ? renderMath(activeSymbol.command) : null;
  const symbolInsertionResult = activeSymbol && session
    ? adapter.symbolInsertion(activeSymbol.command, rangeContext, session.source, session.start, session.end)
    : null;
  const finalSymbolSyntax = symbolInsertionResult?.reason ? '' : symbolInsertionResult?.text ?? '';

  const insertStructure = () => {
    if (!session || !generated) return;
    if (!editing && rangeContext === 'blocked') { setValidation(rangeResult.reason ?? 'The current selection crosses a LaTeX boundary.'); return; }
    if (dialog === 'table' && !editing && rangeContext !== 'text') { setValidation('Tables can only be inserted in text mode.'); return; }
    if (generationError || !generated) { setValidation(generationError || 'Unable to generate this structure.'); return; }
    const result = apply(generated);
    if (result) restoreAndClose(false, false, result);
  };

  const addPackages = () => {
    if (!session || !bridge || !editorState.canAddPackages || requiredPackages.length === 0) return;
    const plan = planPackageAddition(session.source, requiredPackages, { start: session.start, end: session.end, anchor: session.anchor, active: session.active });
    if (!plan?.verified) { setValidation(plan?.message ?? 'Package requirements could not be verified automatically.'); return; }
    if (plan.packagesToAdd.length === 0) { setStatus('All required packages are already declared.'); return; }
    const result = bridge.apply(session, plan.change);
    if (!result) { setValidation('The editor changed before packages could be added.'); return; }
    const shift = plan.change.text.length - (plan.change.end - plan.change.start);
    const rebase = (offset: number) => offset >= plan.change.end ? offset + shift : offset;
    setSession({ ...result, start: rebase(session.start), end: rebase(session.end) });
    setEditing((old) => old ? { ...old, start: rebase(old.start), end: rebase(old.end) } : old);
    setStatus('Packages added. Review the generated source, then insert when ready.');
  };

  const addSymbolPackages = () => {
    if (!session || !bridge || !activeSymbol || !editorState.canAddPackages) return;
    const plan = planPackageAddition(session.source, activeSymbol.packages, { start: session.start, end: session.end, anchor: session.anchor, active: session.active });
    if (!plan?.verified) { setValidation(plan?.message ?? 'Package requirements could not be verified automatically.'); return; }
    if (plan.packagesToAdd.length === 0) { setStatus('All required packages are already declared.'); return; }
    const result = bridge.apply(session, plan.change);
    if (!result) { setValidation('The editor changed before packages could be added.'); return; }
    const shift = plan.change.text.length - (plan.change.end - plan.change.start);
    const rebase = (offset: number) => offset >= plan.change.end ? offset + shift : offset;
    setSession({ ...result, start: rebase(session.start), end: rebase(session.end) });
    setStatus('Packages added. The symbol insertion target has been preserved.');
  };

  const keyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      if (dialogRef.current?.querySelector('[data-writing-select-popup="true"]')) return;
      event.preventDefault(); restoreAndClose(); return;
    }
    const target = event.target as HTMLElement;
    const isSymbolOption = Boolean(target.closest('.writing-symbol-option'));
    const isSymbolNavigator = target === searchRef.current || isSymbolOption;
    const scrollSymbolIntoView = (index: number) => {
      const container = symbolResultsRef.current;
      const option = document.getElementById(`symbol-${index}`);
      if (!container || !option) return;
      const containerTop = container.getBoundingClientRect().top;
      const optionTop = option.getBoundingClientRect().top - containerTop + container.scrollTop;
      const optionBottom = optionTop + option.getBoundingClientRect().height;
      if (optionTop < container.scrollTop) container.scrollTop = optionTop;
      else if (optionBottom > container.scrollTop + container.clientHeight) container.scrollTop = optionBottom - container.clientHeight;
    };
    if (dialog === 'symbols' && isSymbolNavigator && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const next = Math.max(0, Math.min(symbols.length - 1, safeSymbolIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      setSymbolIndex(next);
      requestAnimationFrame(() => {
        scrollSymbolIntoView(next);
        if (isSymbolOption) document.getElementById(`symbol-${next}`)?.focus();
      });
    }
    if (dialog === 'symbols' && isSymbolNavigator && event.key === 'Enter' && activeSymbol) { event.preventDefault(); insertSymbol(activeSymbol); }
    if (dialog !== 'symbols') trapDialogFocus(event);
  };

  return (
    <div className="writing-ribbon" aria-label="Writing tools" ref={ribbonRef}>
      <div className="writing-ribbon-main">
        <button type="button" className="writing-ribbon-button" onClick={() => open('symbols')} disabled={!available} title={available ? 'Browse and insert math symbols' : editorState.reason}>
          <Sigma size={15} aria-hidden="true" /><span>Symbols</span>
        </button>
        <button type="button" className="writing-ribbon-button" onClick={() => open('table')} disabled={!available || !adapter.supportsStructures} title={!adapter.supportsStructures ? 'Table creation is unavailable for this language.' : available ? 'Create a table' : editorState.reason}>
          <Table2 size={15} aria-hidden="true" /><span>Table</span>
        </button>
        <button type="button" className="writing-ribbon-button" onClick={() => open('matrix')} disabled={!available || !adapter.supportsStructures} title={!adapter.supportsStructures ? 'Matrix creation is unavailable for this language.' : available ? 'Create a matrix' : editorState.reason}>
          <Grid2X2 size={15} aria-hidden="true" /><span>Matrix</span>
        </button>
        {editorState.editable && parsedStructureAtCursor && (parsedStructureAtCursor.compatible
          ? <button type="button" className="writing-ribbon-edit" onClick={() => openExisting(parsedStructureAtCursor.kind)} title={`Edit compatible ${parsedStructureAtCursor.kind} at the cursor`}>Edit {parsedStructureAtCursor.kind}</button>
          : <button type="button" className="writing-ribbon-edit" onClick={focusSourceForEditing} title={parsedStructureAtCursor.reason ?? 'Edit this source directly'}>Edit source</button>)}
      </div>
      <span className="writing-ribbon-hint" aria-live="polite">{status || (!available ? editorState.reason : '')}</span>
      <div className="writing-ribbon-compact">
        <button ref={compactTrigger} type="button" className="writing-ribbon-button" onClick={() => setCompactOpen((open) => !open)} disabled={!available && !(adapter.supportsStructures && editorState.editable && parsedStructureAtCursor)} aria-expanded={compactOpen} aria-haspopup="menu"><Sigma size={15} aria-hidden="true" />Insert<ChevronDown size={13} aria-hidden="true" /></button>
        {compactOpen && <div className="writing-compact-menu" role="menu" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setCompactOpen(false); compactTrigger.current?.focus(); } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); } }}>
          <button role="menuitem" type="button" disabled={!available} onClick={() => open('symbols')}>Symbols</button><button role="menuitem" type="button" disabled={!available || !adapter.supportsStructures} title={!adapter.supportsStructures ? 'Table creation is unavailable for this language.' : undefined} onClick={() => open('table')}>Table</button><button role="menuitem" type="button" disabled={!available || !adapter.supportsStructures} title={!adapter.supportsStructures ? 'Matrix creation is unavailable for this language.' : undefined} onClick={() => open('matrix')}>Matrix</button>
          {editorState.editable && parsedStructureAtCursor && (parsedStructureAtCursor.compatible
            ? <button role="menuitem" type="button" onClick={() => openExisting(parsedStructureAtCursor.kind)}>Edit {parsedStructureAtCursor.kind}</button>
            : <button role="menuitem" type="button" onClick={focusSourceForEditing}>Edit source</button>)}
        </div>}
      </div>
      {dialog === 'symbols' && <section className="writing-dialog writing-dialog-symbols writing-symbol-popover" style={{ maxHeight: symbolPopoverMaxHeight }} role="dialog" aria-modal="false" aria-labelledby="writing-title" ref={dialogRef} onKeyDown={keyDown}>
        <header className="writing-dialog-header">
          <div className="writing-dialog-heading"><Sigma size={18} aria-hidden="true" /><div><h2 id="writing-title">Insert a symbol</h2><p>{sessionCurrent ? `${adapter.language === 'typst' ? 'Typst' : 'LaTeX'} · ${context.replace('-', ' ')}` : 'The editor session is no longer current.'}</p></div></div>
          <button type="button" className="writing-icon-button" aria-label="Close writing tools" onClick={() => restoreAndClose()}><X size={17} /></button>
        </header>
        {!sessionCurrent && <p className="writing-alert" role="alert">The editor changed while this panel was open. Close it and retry.</p>}
        <div className="writing-symbols-body">
          <div className="writing-symbol-layout">
            <div className="writing-symbol-list-column">
              <label className="writing-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Search symbols</span><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={adapter.language === 'typst' ? 'Search by name, identifier, or alias' : 'Search by name, command, or alias'} aria-activedescendant={activeSymbol ? `symbol-${safeSymbolIndex}` : undefined} /></label>
              <div ref={symbolResultsRef} className="writing-symbol-results" role="listbox" aria-label="Math symbols" aria-activedescendant={activeSymbol ? `symbol-${safeSymbolIndex}` : undefined}>
              {symbols.map((entry, index) => <button type="button" role="option" aria-selected={index === safeSymbolIndex} tabIndex={index === safeSymbolIndex ? 0 : -1} id={`symbol-${index}`} className={`writing-symbol-option ${index === safeSymbolIndex ? 'is-selected' : ''}`} key={entry.command} onFocus={() => setSymbolIndex(index)} onClick={() => setSymbolIndex(index)}>
                <span className="writing-symbol-glyph">{entry.glyph}</span><span className="writing-symbol-name">{entry.name}</span><code>{entry.command}</code>{index === safeSymbolIndex && <Check className="writing-symbol-check" size={14} aria-hidden="true" />}
              </button>)}
              {symbols.length === 0 && <p className="writing-empty">No symbols match this search.</p>}
              </div>
            </div>
            <aside className="writing-symbol-preview" aria-live="polite">
              <div className="writing-category"><ListFilter size={14} aria-hidden="true" /><WritingSelect label="Category" value={category} options={[{ value: 'All', label: 'All categories' }, ...CATEGORIES.map((item) => ({ value: item, label: item }))]} onValueChange={(value) => setCategory(value as typeof category)} /></div>
              {activeSymbol ? <>
                {adapter.previewKind === 'glyph'
                  ? <div className="writing-glyph-preview" role="img" aria-label={`${activeSymbol.name} symbol illustration`} title="Glyph illustration only; it is not compiled Typst output and may not match the document font.">{activeSymbol.glyph}</div>
                  : symbolPreview?.html ? <div className="writing-preview-math" dangerouslySetInnerHTML={{ __html: symbolPreview.html }} /> : <div className="writing-preview-fallback" role="img" aria-label={`${activeSymbol.name} symbol illustration`}>{activeSymbol.glyph}</div>}
                <h3>{activeSymbol.name}</h3><code>{activeSymbol.command}</code>
                <p className="writing-final-syntax">{finalSymbolSyntax || (symbolInsertionResult?.reason ? 'Unavailable in this context' : activeSymbol.command)}</p>
                {adapter.previewKind === 'glyph' && <p className="writing-note">Glyph illustration only. This is not compiled Typst output and may not match the document font.</p>}
                {symbolPreview?.error && <p className="writing-note">Preview unavailable. The LaTeX command will still be inserted.</p>}
                {!!symbolPackages.length && <><p className="writing-note">Requires {symbolPackages.map((name) => `\`${name}\``).join(', ')}{symbolPackageState.missing.length === 0 && !symbolPackageState.uncertain ? ' · loaded' : ''}{symbolPackageState.uncertain ? ' · loading could not be verified' : ''}</p>{symbolPackageState.missing.length > 0 && (editorState.canAddPackages && symbolPackageEligibility.eligible && !symbolPackageState.uncertain ? <button type="button" className="writing-link-button" onClick={addSymbolPackages}>Add packages</button> : <><code className="writing-package-source">\usepackage{'{' + symbolPackageState.missing.join(',') + '}'}</code>{onOpenMainFile && <button type="button" className="writing-link-button" onClick={() => restoreAndClose(true, true)}>Open main file</button>}</>)}</>}
              </> : <><CircleHelp size={20} aria-hidden="true" /><p>Select a symbol to preview its syntax.</p></>}
            </aside>
          </div>
          <div className="writing-dialog-footer"><span className="writing-inline-status" role="status">{validation || symbolInsertionResult?.reason || rangeResult.reason}</span><button type="button" className="writing-secondary-button" onClick={() => restoreAndClose()}>Cancel</button><button type="button" className="writing-primary-button" aria-label={activeSymbol ? `Insert ${activeSymbol.name} (${activeSymbol.command})` : 'Insert symbol'} onClick={() => insertSymbol(activeSymbol)} disabled={!activeSymbol || !sessionCurrent || rangeContext === 'blocked' || Boolean(symbolInsertionResult?.reason)}><ArrowDownToLine size={15} />Insert</button></div>
        </div>
      </section>}
      {dialog && dialog !== 'symbols' && createPortal(<div className="writing-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) restoreAndClose(); }}>
        {adapter.language === 'typst' && session && bridge ? <TypstStructureDialog
          kind={dialog}
          session={session}
          bridge={bridge}
          context={context}
          rangeContext={rangeContext}
          parsed={typstEditing ?? undefined}
          sectionRef={(node) => { dialogRef.current = node; }}
          onKeyDown={keyDown}
          onCancel={() => restoreAndClose()}
          onApplied={(result) => restoreAndClose(false, false, result)}
        /> : <section className={`writing-dialog writing-dialog-${dialog}`} role="dialog" aria-modal="true" aria-labelledby="writing-title" ref={dialogRef} onKeyDown={keyDown}>
          <header className="writing-dialog-header">
            <div className="writing-dialog-heading">
              {dialog === 'table' ? <Table2 size={18} aria-hidden="true" /> : <Grid2X2 size={18} aria-hidden="true" />}
              <div><h2 id="writing-title">{dialog === 'table' ? (editing ? 'Edit table' : 'Create a table') : (editing ? 'Edit matrix' : 'Create a matrix')}</h2>
                <p>{sessionCurrent ? `LaTeX · ${context.replace('-', ' ')}` : 'The editor session is no longer current.'}</p></div>
            </div>
            <button type="button" className="writing-icon-button" aria-label="Close writing tools" onClick={() => restoreAndClose()}><X size={17} /></button>
          </header>
          {!sessionCurrent && <p className="writing-alert" role="alert">The editor changed while this panel was open. Close it and retry.</p>}
          <div className="writing-builder-body">
            <div className="writing-builder-tabs" role="tablist" aria-label="Builder view"><button role="tab" aria-selected={!sourceTab} className={!sourceTab ? 'is-active' : ''} onClick={() => setSourceTab(false)}>Build</button><button role="tab" aria-selected={sourceTab} className={sourceTab ? 'is-active' : ''} onClick={() => setSourceTab(true)}>Source</button></div>
            {!sourceTab ? <div className="writing-builder-grid">
              <div className="writing-builder-controls">
                <fieldset className="writing-dimensions"><legend>Dimensions</legend>
                  <label>Rows<input ref={rowsInputRef} type="number" min="1" max={dialog === 'table' ? 20 : 12} value={pendingDimensions?.rows ?? (dialog === 'table' ? table.rows : matrix.rows)} onChange={(event) => changeDimensions(dialog, Number(event.target.value), pendingDimensions?.columns ?? (dialog === 'table' ? table.columns : matrix.columns))} /></label>
                  <label>Columns<input type="number" min="1" max={dialog === 'table' ? 10 : 12} value={pendingDimensions?.columns ?? (dialog === 'table' ? table.columns : matrix.columns)} onChange={(event) => changeDimensions(dialog, pendingDimensions?.rows ?? (dialog === 'table' ? table.rows : matrix.rows), Number(event.target.value))} /></label>
                </fieldset>
                {confirmShrink && <div className="writing-confirm-shrink" role="alert"><span>Reducing dimensions will remove populated cells.</span><button type="button" onClick={() => { setConfirmShrink(false); setPendingDimensions(null); window.requestAnimationFrame(() => rowsInputRef.current?.focus()); }}>Keep cells</button><button type="button" onClick={confirmDimensions}>Confirm reduction</button></div>}
                {dialog === 'table' ? <>
                  <fieldset className="writing-dimensions"><legend>Column alignment</legend><div className="writing-alignment-row">{Array.from({ length: table.columns }, (_, column) => <div className="writing-alignment-field" key={column}><span>Column {column + 1}</span><WritingSelect label={`Column ${column + 1} alignment`} value={table.alignment?.[column] ?? 'l'} options={[{ value: 'l', label: 'Left' }, { value: 'c', label: 'Center' }, { value: 'r', label: 'Right' }]} onValueChange={(value) => setTable((old) => ({ ...old, alignment: old.alignment?.map((current, index) => index === column ? value as 'l' | 'c' | 'r' : current) }))} /></div>)}</div></fieldset>
                  <button type="button" className="writing-more-toggle" aria-expanded={moreOptions} onClick={() => setMoreOptions((value) => !value)}>More options <ChevronDown size={14} className={moreOptions ? 'is-open' : ''} /></button>
                  {moreOptions && <div className="writing-more-options">
                    <div className="writing-select-field"><span>Format</span><WritingSelect label="Format" value={table.format ?? 'plain'} options={[{ value: 'plain', label: 'Plain' }, { value: 'grid', label: 'Grid' }, { value: 'booktabs', label: 'Booktabs' }]} onValueChange={(value) => setTable((old) => ({ ...old, format: value as TableOptions['format'] }))} /></div>
                    <label className="writing-check"><input type="checkbox" checked={table.header ?? false} onChange={(event) => setTable((old) => ({ ...old, header: event.target.checked }))} />Bold header row</label>
                    <label className="writing-check"><input type="checkbox" checked={table.wrapInTable ?? false} onChange={(event) => setTable((old) => ({ ...old, wrapInTable: event.target.checked }))} />Wrap in table environment</label>
                    {table.wrapInTable && <><label>Caption<input value={table.caption ?? ''} onChange={(event) => setTable((old) => ({ ...old, caption: event.target.value }))} placeholder="Optional caption" /></label><label className="writing-check"><input type="checkbox" checked={table.captionLatex ?? false} onChange={(event) => setTable((old) => ({ ...old, captionLatex: event.target.checked }))} />Caption is LaTeX</label><label>Label<input value={table.label ?? ''} onChange={(event) => setTable((old) => ({ ...old, label: event.target.value }))} placeholder="Optional label" /></label></>}
                  </div>}
                </> : <div className="writing-select-field"><span>Matrix delimiters</span><WritingSelect label="Matrix delimiters" value={matrix.environment ?? 'pmatrix'} options={MATRIX_ENVS.map((env) => ({ value: env, label: env }))} onValueChange={(value) => setMatrix((old) => ({ ...old, environment: value as MatrixOptions['environment'] }))} /></div>}
              </div>
              <div className="writing-cell-editor" aria-label="Structure cells">
                {Array.from({ length: dialog === 'table' ? table.rows : matrix.rows }, (_, row) => <div className="writing-cell-row" key={row}>{Array.from({ length: dialog === 'table' ? table.columns : matrix.columns }, (_, column) => {
                  const value = dialog === 'table' ? table.cells[row]?.[column] ?? '' : matrix.cells[row]?.[column] ?? '';
                  const isLatex = dialog === 'matrix' || (table.cellLatex?.[row]?.[column] ?? table.latexCells ?? false);
                  const setCell = (next: string) => dialog === 'table' ? setTable((old) => ({ ...old, cells: old.cells.map((cells, r) => r === row ? cells.map((cell, c) => c === column ? next : cell) : cells) })) : setMatrix((old) => ({ ...old, cells: old.cells.map((cells, r) => r === row ? cells.map((cell, c) => c === column ? next : cell) : cells) }));
                  return <label className={`writing-cell ${dialog === 'table' && table.header && row === 0 ? 'is-header' : ''}`} key={column}><span className="sr-only">Row {row + 1}, column {column + 1}{dialog === 'table' && table.header && row === 0 ? ', header' : ''}</span><input aria-label={`Row ${row + 1}, column ${column + 1}`} value={value} onChange={(event) => setCell(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); (event.currentTarget.closest('.writing-cell')?.nextElementSibling?.querySelector('input') as HTMLInputElement | null)?.focus(); } }} />{dialog === 'table' && <button type="button" className="writing-cell-mode" title={isLatex ? 'Cell source is LaTeX' : 'Cell content is escaped text'} aria-label={`Toggle LaTeX input for row ${row + 1}, column ${column + 1}`} aria-pressed={Boolean(isLatex)} onClick={() => setTable((old) => ({ ...old, cellLatex: old.cells.map((cells, r) => cells.map((_, c) => r === row && c === column ? !(old.cellLatex?.[r]?.[c] ?? old.latexCells ?? false) : (old.cellLatex?.[r]?.[c] ?? old.latexCells ?? false))) }))}><Braces size={12} /></button>}</label>;
                })}</div>)}
                {dialog === 'table' ? <TablePreview options={table} /> : preview?.html ? <div className="writing-preview-math writing-matrix-preview" dangerouslySetInnerHTML={{ __html: preview.html }} /> : <div className="writing-preview-fallback"><code>{matrix.environment}</code></div>}
                {preview?.error && <p className="writing-note" role="status">Preview unavailable: {preview.error}</p>}
              </div>
            </div> : <div className="writing-source-pane"><pre>{generated ?? ''}</pre></div>}
            {requiredPackages.length > 0 && <div className="writing-package-row"><span>Requires {requiredPackages.map((name) => `\`${name}\``).join(', ')}{requiredPackageState.missing.length === 0 && !requiredPackageState.uncertain ? ' · loaded' : ''}{requiredPackageState.uncertain ? ' · loading could not be verified' : ''}</span>{requiredPackageState.missing.length > 0 && packagePlanEligible ? <button type="button" className="writing-link-button" onClick={addPackages}>Add packages</button> : requiredPackageState.missing.length > 0 ? <span className="writing-subfile-note">{packageEligibility.reason ?? 'Open the main file to add packages.'}</span> : null}</div>}
            {requiredPackages.length > 0 && requiredPackageState.missing.length > 0 && !packagePlanEligible && <div className="writing-package-row"><code className="writing-package-source">\usepackage{'{' + requiredPackageState.missing.join(',') + '}'}</code>{onOpenMainFile && <button type="button" className="writing-link-button" onClick={() => restoreAndClose(true, true)}>Open main file</button>}</div>}
            <div className="writing-dialog-footer"><span className="writing-inline-status" role="status">{validation || status || generationError}</span><button type="button" className="writing-secondary-button" onClick={() => restoreAndClose()}>Cancel</button><button type="button" className="writing-primary-button" onClick={insertStructure} disabled={!sessionCurrent || Boolean(generationError) || (!editing && (dialog === 'table' ? rangeContext !== 'text' : rangeContext === 'blocked'))}><ArrowDownToLine size={15} />{editing ? 'Update' : 'Insert'}</button></div>
          </div>
        </section>}
      </div>, document.body)}
    </div>
  );
};

const TablePreview: React.FC<{ options: TableOptions }> = ({ options }) => {
  const format = options.format ?? 'plain';
  const hasHeader = Boolean(options.header);
  const hasRawLatex = options.cells.some((row, rowIndex) => row.some((_, columnIndex) => options.cellLatex?.[rowIndex]?.[columnIndex] ?? options.latexCells ?? false));
  const alignment: Record<'l' | 'c' | 'r', React.CSSProperties['textAlign']> = { l: 'left', c: 'center', r: 'right' };

  return <div className={`writing-table-preview format-${format}${hasHeader && format === 'booktabs' ? ' has-header' : ''}`} aria-label="Table preview">
    <div className="writing-table-preview-scroll" role="region" tabIndex={0} aria-label="Table layout preview">
      <table><tbody>{Array.from({ length: options.rows }, (_, row) => <tr key={row}>{Array.from({ length: options.columns }, (_, column) => <td className={hasHeader && row === 0 ? 'is-header' : undefined} style={{ textAlign: alignment[options.alignment?.[column] ?? 'l'] }} key={column}>{options.cells[row]?.[column] ?? ''}</td>)}</tr>)}</tbody></table>
    </div>
    <p className="writing-table-preview-note">Layout preview. Final size and font depend on the LaTeX document.{hasRawLatex ? ' LaTeX cells are shown as source.' : ''}</p>
  </div>;
};

export default WritingRibbon;
