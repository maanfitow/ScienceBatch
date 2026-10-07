import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, RotateCw, FileCode2, Image as ImageIcon, FileText, Pin } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import type { RenderTask, PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { EditorView } from './EditorView';
import { WorkspaceTab } from '../types/workspace';
import { GitDiffResult } from '../types/git';
import { ContextMenu, ContextMenuAction } from './ContextMenu';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

interface WorkspaceTabsProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  projectRoot: string | null;
  sourceCode: string;
  engine: 'latex' | 'typst';
  activeFilePath: string | null;
  onChange: (value: string) => void;
  onActivate: (id: string) => void;
  onPromote: (id: string) => void;
  onClose: (all?: boolean, id?: string, others?: boolean) => void;
  onPin: (id: string) => void;
  errors?: React.ComponentProps<typeof EditorView>['errors'];
  warnings?: React.ComponentProps<typeof EditorView>['warnings'];
  jumpToLine?: number | null;
  readOnly?: boolean;
}

export const WorkspaceTabs: React.FC<WorkspaceTabsProps> = ({
  tabs, activeTabId, projectRoot, sourceCode, engine, activeFilePath,
  onChange, onActivate, onPromote, onClose, onPin, errors, warnings, jumpToLine, readOnly,
}) => {
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? null;
  const tabIds = tabs.map(tab => tab.id).join('\u0000');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [hasHorizontalOverflow, setHasHorizontalOverflow] = useState(false);
  const selectedTab = contextMenu ? tabs.find(tab => tab.id === contextMenu.tabId) : null;
  const stripRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;

    const updateOverflow = () => {
      const hasOverflow = strip.scrollWidth > strip.clientWidth;
      setHasHorizontalOverflow(current => current === hasOverflow ? current : hasOverflow);
    };
    updateOverflow();

    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(strip);
    Array.from(strip.children).forEach(tab => resizeObserver.observe(tab));
    return () => resizeObserver.disconnect();
  }, [tabIds]);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      const max = strip.scrollWidth - strip.clientWidth;
      if (max <= 0) return;
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : 1;
      const delta = (event.deltaX !== 0 ? event.deltaX : event.deltaY) * scale;
      const next = Math.max(0, Math.min(max, strip.scrollLeft + delta));
      if (next !== strip.scrollLeft) { event.preventDefault(); strip.scrollLeft = next; }
    };
    strip.addEventListener('wheel', handleWheel, { passive: false });
    return () => strip.removeEventListener('wheel', handleWheel);
  }, []);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activeTabId) return;
    const activeButton = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    const activeTabElement = activeButton?.parentElement;
    if (!activeTabElement) return;

    const stripRect = strip.getBoundingClientRect();
    const tabRect = activeTabElement.getBoundingClientRect();
    const visibleLeft = stripRect.left;
    const visibleRight = visibleLeft + strip.clientWidth;
    if (tabRect.left < visibleLeft) strip.scrollLeft -= visibleLeft - tabRect.left;
    else if (tabRect.right > visibleRight) strip.scrollLeft += tabRect.right - visibleRight;
  }, [activeTabId, tabs.length]);
  const closeActions: ContextMenuAction[] = selectedTab ? [
    { label: selectedTab.pinned ? 'Unpin' : 'Pin', onSelect: () => onPin(selectedTab.id) },
    { label: 'Close', onSelect: () => onClose(false, selectedTab.id), separatorBefore: true },
    { label: 'Close Others', onSelect: () => onClose(false, selectedTab.id, true) },
    { label: 'Close All Unpinned', onSelect: () => onClose(true) },
  ] : [];
  return (
    <section className="workspace-tabs">
      <div className={`workspace-tab-strip${hasHorizontalOverflow ? ' has-horizontal-overflow' : ''}`} ref={stripRef} role="tablist" aria-label="Open files">
        {tabs.map(tab => (
          <div key={tab.id} className={`workspace-tab ${tab.id === activeTabId ? 'active' : ''} ${tab.content !== tab.savedContent && tab.kind === 'source' ? 'dirty' : ''}`} onContextMenu={event => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, tabId: tab.id }); }}>
            <button role="tab" aria-selected={tab.id === activeTabId} className="workspace-tab-select" onClick={() => onActivate(tab.id)} onDoubleClick={() => onPromote(tab.id)} title={`${tab.path || tab.name}${tab.pinned ? '\nPinned tab' : ''}`}>
              {tab.kind === 'diff' ? <FileCode2 size={13} /> : tab.kind === 'asset' ? <ImageIcon size={13} /> : <FileText size={13} />}
              <span>{tab.name}</span>{tab.content !== tab.savedContent && tab.kind === 'source' && <i aria-label="Unsaved changes" />}{tab.pinned && <Pin size={12} className="workspace-tab-pinned-indicator" aria-label="Pinned tab" />}
            </button>
            <button className="workspace-tab-close" aria-label={`Close ${tab.name}`} title={`Close ${tab.name} (Ctrl/Cmd+W)`} onClick={() => onClose(false, tab.id)}><X size={13} aria-hidden="true" focusable="false" /></button>
          </div>
        ))}
      </div>
      {contextMenu && selectedTab && <ContextMenu x={contextMenu.x} y={contextMenu.y} actions={closeActions} onClose={() => setContextMenu(null)} />}
      <div className="workspace-tab-content" key={activeTab?.id || 'empty'}>
        {!activeTab ? <div className="workspace-empty">Open a source file or project asset to get started.</div> : activeTab.kind === 'source' ? (
          <EditorView value={sourceCode} onChange={onChange} errors={errors} warnings={warnings} jumpToLine={jumpToLine} engine={engine} activeFilePath={activeFilePath} readOnly={readOnly} />
        ) : activeTab.kind === 'diff' ? (
          <DiffTab path={activeTab.path || ''} projectRoot={projectRoot} repositoryRoot={activeTab.repositoryRoot || projectRoot} />
        ) : (
          <AssetTab path={activeTab.path || ''} />
        )}
      </div>
    </section>
  );
};

const DiffTab: React.FC<{ path: string; projectRoot: string | null; repositoryRoot: string | null }> = ({ path, projectRoot, repositoryRoot }) => {
  const [result, setResult] = useState<GitDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('sciencebatch:git-status-changed', refresh);
    return () => window.removeEventListener('sciencebatch:git-status-changed', refresh);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const diffRoot = repositoryRoot || projectRoot;
    if (!diffRoot) { setError('Open a project folder to view this diff.'); setLoading(false); return () => { cancelled = true; }; }
    setLoading(true); setError(null); setResult(null);
    invoke<GitDiffResult>('get_git_diff', { projectPath: diffRoot, filePath: path }).then(value => { if (!cancelled) setResult(value); }).catch(reason => { if (!cancelled) setError(String(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, projectRoot, repositoryRoot, revision]);
  const lines = useMemo(() => result?.diff.split('\n') ?? [], [result]);
  if (loading) return <div className="workspace-notice"><RotateCw className="spin" size={20} /> Loading diff…</div>;
  if (error) return <div className="workspace-notice">{error}</div>;
  if (result?.isBinary || result?.oversized) return <div className="workspace-notice">{result.diff}</div>;
  return <div className="workspace-diff" aria-label={`Diff for ${path}`}><header>{path}</header><pre>{lines.map((line, i) => <span key={i} className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'hunk' : ''}>{line}{'\n'}</span>)}</pre></div>;
};

const AssetTab: React.FC<{ path: string }> = ({ path }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pdfPages, setPdfPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [revision, setRevision] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isPdf = /\.pdf$/i.test(path);

  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('sciencebatch:git-worktree-updated', refresh);
    return () => window.removeEventListener('sciencebatch:git-worktree-updated', refresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setLoading(true); setError(null); setUrl(null); setPdfPages(null);
    invoke<number[]>('read_binary_file', { path }).then(bytes => {
      if (cancelled) return;
      const blob = new Blob([new Uint8Array(bytes)], { type: isPdf ? 'application/pdf' : `image/${path.split('.').pop()?.toLowerCase() === 'svg' ? 'svg+xml' : path.split('.').pop()?.toLowerCase()}` });
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
      if (!isPdf) setLoading(false);
    }).catch(reason => { if (!cancelled) { setError(/\.(png|jpe?g|svg|webp|gif|bmp)$/i.test(path) ? 'This image is deleted or unavailable in the current project.' : String(reason)); setLoading(false); } });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path, isPdf, revision]);

  useEffect(() => {
    if (!isPdf || !url || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let pdfDocument: PDFDocumentProxy | null = null;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;
    const draw = async () => {
      try {
        const document = await pdfjs.getDocument(url).promise;
        pdfDocument = document;
        if (cancelled) { await document.destroy(); return; }
        setPdfPages(document.numPages);
        if (pageNumber > document.numPages) setPageNumber(document.numPages);
        const page = await document.getPage(pageNumber);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min((canvas.parentElement?.clientWidth || 900) / base.width, 1.8);
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width; canvas.height = viewport.height;
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
        if (!cancelled) setLoading(false);
      } catch (reason) { if (!cancelled) { setError(String(reason)); setLoading(false); } }
    };
    draw();
    return () => { cancelled = true; renderTask?.cancel(); void pdfDocument?.destroy(); };
  }, [isPdf, url, pageNumber]);

  return <div className="workspace-asset">
    {loading && <div className="workspace-notice"><RotateCw className="spin" size={20} /> Loading preview…</div>}
    {error && <div className="workspace-notice">Unable to preview this file: {error}</div>}
    {url && !isPdf && <img src={url} alt={path.split('/').pop() || 'Project image'} />}
    {url && isPdf && <><canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />{pdfPages && <div className="workspace-pdf-controls"><button disabled={pageNumber <= 1} onClick={() => setPageNumber(n => n - 1)}>Previous</button><span>Page {pageNumber} of {pdfPages}</span><button disabled={pageNumber >= pdfPages} onClick={() => setPageNumber(n => n + 1)}>Next</button></div>}</>}
  </div>;
};
