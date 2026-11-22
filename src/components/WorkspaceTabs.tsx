import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, RotateCw, FileCode2, Image as ImageIcon, FileText, Pin } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import type { RenderTask, PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { toast } from 'sonner';
import { EditorView } from './EditorView';
import { WorkspaceTab } from '../types/workspace';
import { GitDiffResult } from '../types/git';
import { ContextMenu, ContextMenuAction } from './ContextMenu';
import {
  createPdfLinkService,
  getPdfModifierLabel,
  handlePdfAnnotationLinkClickCapture,
  renderPageAnnotationLayer,
  renderPageTextLayer,
  trackTextLayerSelection,
  type TextLayerTask,
} from './pdfRenderingHelpers';
import {
  copySelectionInside,
  hasSelectionInside,
  imageElementToClipboardImage,
  selectAllInside,
  shouldIgnorePdfShortcut,
} from './pdfClipboard';
import {
  copyPdfImageRegionFromCanvas,
  findPdfImageAtPoint,
  getPageImageRects,
  type PdfImageRect,
} from './pdfImageHelpers';
import { clientPointToPdfPoint } from './pdfSourceMapHelpers';
import type { WritingEditorBridge, WritingEditorState } from '../types/writing';
import type { AutomationEditorBridge } from '../types/automation';

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
  jumpRequest?: { line: number; column?: number; seq: number } | null;
  readOnly?: boolean;
  isScratchpad?: boolean;
  canAddPackages?: boolean;
  onWritingBridgeChange?: (bridge: WritingEditorBridge | null, state: WritingEditorState) => void;
  onAutomationBridgeChange?: (bridge: AutomationEditorBridge | null) => void;
  getDocumentRevision?: (documentId: string) => number;
}

export const WorkspaceTabs: React.FC<WorkspaceTabsProps> = ({
  tabs, activeTabId, projectRoot, sourceCode, engine, activeFilePath,
  onChange, onActivate, onPromote, onClose, onPin, errors, warnings, jumpRequest, readOnly,
  isScratchpad, canAddPackages, onWritingBridgeChange, onAutomationBridgeChange, getDocumentRevision,
}) => {
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? null;
  const tabIds = tabs.map(tab => tab.id).join('\u0000');
  const openDocumentIds = useMemo(() => tabs.filter(tab => tab.kind === 'source').map(tab => tab.id), [tabIds]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [hasHorizontalOverflow, setHasHorizontalOverflow] = useState(false);
  const selectedTab = contextMenu ? tabs.find(tab => tab.id === contextMenu.tabId) : null;
  const stripRef = useRef<HTMLDivElement>(null);
  const writingBridgeRef = useRef<WritingEditorBridge | null>(null);
  const handleWritingBridgeChange = useCallback((bridge: WritingEditorBridge | null, state: WritingEditorState, releasedBridge?: WritingEditorBridge) => {
    if (!bridge) {
      if (writingBridgeRef.current !== releasedBridge) return;
      writingBridgeRef.current = null;
      onWritingBridgeChange?.(null, {
        language: engine,
        editable: false,
        available: false,
        reason: engine === 'typst' ? 'Select an editable Typst source file.' : 'Select an editable LaTeX source file.',
        source: '',
        cursorOffset: 0,
        canAddPackages: false,
      });
      return;
    } else {
      writingBridgeRef.current = bridge;
    }
    onWritingBridgeChange?.(writingBridgeRef.current, state);
  }, [engine, onWritingBridgeChange]);
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
      <div className="workspace-tab-content">
        {!activeTab ? <div className="workspace-empty">Open a source file or project asset to get started.</div> : activeTab.kind === 'source' ? (
          <EditorView value={sourceCode} onChange={onChange} errors={errors} warnings={warnings} jumpRequest={jumpRequest} engine={engine} activeFilePath={activeFilePath} readOnly={readOnly} documentId={activeTab.id} openDocumentIds={openDocumentIds} openDocumentIdsKey={tabIds} isScratchpad={isScratchpad} canAddPackages={canAddPackages} onWritingBridgeChange={handleWritingBridgeChange} onAutomationBridgeChange={onAutomationBridgeChange} getDocumentRevision={getDocumentRevision} />
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
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    kind: 'pdf' | 'image';
    hasSelection: boolean;
    imageHit: {
      rect: PdfImageRect;
      pageWidthPt: number;
      pageHeightPt: number;
      canvas: HTMLCanvasElement;
    } | null;
  } | null>(null);
  const assetContainerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pdfPageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const annotationLayerRef = useRef<HTMLDivElement>(null);
  const activePdfPageRef = useRef<pdfjs.PDFPageProxy | null>(null);
  const activePdfSizeRef = useRef<{ widthPt: number; heightPt: number } | null>(null);
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const bypassLinkModifierRef = useRef<boolean>(false);
  const textSelectionCleanupRef = useRef<(() => void) | null>(null);
  const contextMenuSeqRef = useRef<number>(0);
  const isAssetActiveRef = useRef<boolean>(false);
  const isPdf = /\.pdf$/i.test(path);

  const openExternalUrl = useCallback((externalUrl: string) => {
    void invoke('open_external_url', { url: externalUrl }).catch((err: unknown) => {
      const details = err instanceof Error ? err.message : String(err);
      toast.error('Failed to open link', { description: details });
    });
  }, []);

  const handleCopySelection = useCallback(async () => {
    try {
      await copySelectionInside(pdfPageRef.current);
    } catch (err: unknown) {
      const details = err instanceof Error ? err.message : String(err);
      toast.error('Copy failed', { description: details });
    }
  }, []);

  const handleCopyImageElement = useCallback(async () => {
    if (!imgRef.current) return;
    try {
      await imageElementToClipboardImage(imgRef.current);
      toast.success('Image copied to clipboard');
    } catch (err: unknown) {
      const details = err instanceof Error ? err.message : String(err);
      toast.error('Failed to copy image', { description: details });
    }
  }, []);

  useEffect(() => {
    setPageNumber(1);
    contextMenuSeqRef.current++;
    setContextMenu(null);
  }, [path]);

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
    let textLayerTask: TextLayerTask | undefined;
    let pdfDocument: PDFDocumentProxy | null = null;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;
    textLayerRef.current?.replaceChildren();
    annotationLayerRef.current?.replaceChildren();
    activePdfPageRef.current = null;
    activePdfSizeRef.current = null;
    contextMenuSeqRef.current++;
    setContextMenu(null);

    const draw = async () => {
      try {
        const document = await pdfjs.getDocument(url).promise;
        pdfDocument = document;
        if (cancelled) { await document.destroy(); return; }
        setPdfPages(document.numPages);
        if (pageNumber > document.numPages) {
          setPageNumber(document.numPages);
          return;
        }
        const page = await document.getPage(pageNumber);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const containerWidth = pdfPageRef.current?.parentElement?.clientWidth || 900;
        const scale = Math.min(Math.max(containerWidth - 40, 240) / base.width, 1.8);
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
        if (cancelled) return;

        activePdfPageRef.current = page;
        activePdfSizeRef.current = { widthPt: base.width, heightPt: base.height };

        if (pdfPageRef.current && textLayerRef.current) {
          try {
            await renderPageTextLayer({
              page,
              wrapper: pdfPageRef.current,
              scale,
              isCancelled: () => cancelled,
              targetContainer: textLayerRef.current,
              registerTextLayerTask: (task) => {
                textLayerTask = task;
              },
              unregisterTextLayerTask: () => {
                textLayerTask = undefined;
              },
            });
          } catch (textErr) {
            if (!cancelled) {
              console.warn('Failed to render AssetTab PDF text layer:', textErr);
            }
          }
        }

        if (!cancelled && pdfPageRef.current && annotationLayerRef.current) {
          try {
            const linkTitlePrefix = `${getPdfModifierLabel()}+Click to follow link`;
            const linkService = createPdfLinkService(document, {
              onExternalLink: openExternalUrl,
              onInternalDestination: (targetPage) => setPageNumber(targetPage),
              linkTitlePrefix,
            });
            await renderPageAnnotationLayer({
              page,
              wrapper: pdfPageRef.current,
              scale,
              isCancelled: () => cancelled,
              linkService,
              linkTitlePrefix,
              targetContainer: annotationLayerRef.current,
            });
          } catch (annotationErr) {
            if (!cancelled) {
              console.warn('Failed to render AssetTab PDF annotation layer:', annotationErr);
            }
          }
        }

        if (!cancelled) setLoading(false);
      } catch (reason) {
        if (!cancelled) {
          setError(String(reason));
          setLoading(false);
        }
      }
    };
    draw();
    return () => {
      cancelled = true;
      textSelectionCleanupRef.current?.();
      textSelectionCleanupRef.current = null;
      activePdfPageRef.current = null;
      activePdfSizeRef.current = null;
      renderTask?.cancel();
      textLayerTask?.cancel();
      void pdfDocument?.destroy();
    };
  }, [isPdf, url, pageNumber, openExternalUrl]);

  useEffect(() => {
    const handleGlobalMouseDown = (e: MouseEvent) => {
      if (isPdf) {
        isAssetActiveRef.current = Boolean(
          pdfPageRef.current && pdfPageRef.current.contains(e.target as Node),
        );
      } else {
        isAssetActiveRef.current = Boolean(
          assetContainerRef.current && assetContainerRef.current.contains(e.target as Node),
        );
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (shouldIgnorePdfShortcut(document.activeElement)) return;

      const key = e.key.toLowerCase();
      if (isPdf) {
        if (key === 'c' && hasSelectionInside(pdfPageRef.current)) {
          e.preventDefault();
          void handleCopySelection();
        } else if (
          key === 'a' &&
          (isAssetActiveRef.current || hasSelectionInside(pdfPageRef.current))
        ) {
          e.preventDefault();
          selectAllInside(textLayerRef.current);
        }
      } else if (key === 'c' && url && isAssetActiveRef.current && imgRef.current) {
        e.preventDefault();
        void handleCopyImageElement();
      }
    };
    window.addEventListener('mousedown', handleGlobalMouseDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleGlobalMouseDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPdf, url, handleCopySelection, handleCopyImageElement]);

  const handlePdfCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (isPdf && hasSelectionInside(pdfPageRef.current)) {
      e.preventDefault();
      void handleCopySelection();
    }
  };

  const handlePdfContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const seq = ++contextMenuSeqRef.current;
    const menuX = e.clientX;
    const menuY = e.clientY;
    setContextMenu({
      x: menuX,
      y: menuY,
      kind: 'pdf',
      hasSelection: hasSelectionInside(pdfPageRef.current),
      imageHit: null,
    });

    const page = activePdfPageRef.current;
    const pageSize = activePdfSizeRef.current;
    const wrapper = pdfPageRef.current;
    const canvas = canvasRef.current;
    if (!page || !pageSize || !wrapper || !canvas) return;

    void (async () => {
      try {
        const rects = await getPageImageRects(page);
        if (contextMenuSeqRef.current !== seq) return;
        const wrapperRect = wrapper.getBoundingClientRect();
        const effectiveScale =
          pageSize.widthPt > 0 && wrapperRect.width > 0
            ? wrapperRect.width / pageSize.widthPt
            : 1;
        const { xPt, yPt } = clientPointToPdfPoint(wrapperRect, menuX, menuY, effectiveScale);
        const rect = findPdfImageAtPoint(rects, xPt, yPt);
        if (!rect || contextMenuSeqRef.current !== seq) return;
        setContextMenu((prev) =>
          prev && prev.x === menuX && prev.y === menuY && prev.kind === 'pdf'
            ? {
                ...prev,
                imageHit: {
                  rect,
                  pageWidthPt: pageSize.widthPt,
                  pageHeightPt: pageSize.heightPt,
                  canvas,
                },
              }
            : prev
        );
      } catch {
        // Ignore image hit inspection failures
      }
    })();
  };

  const handleImageContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    if (isPdf || !url) return;
    e.preventDefault();
    e.stopPropagation();
    contextMenuSeqRef.current++;
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      kind: 'image',
      hasSelection: false,
      imageHit: null,
    });
  };

  const handlePdfClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    handlePdfAnnotationLinkClickCapture({
      event: e,
      pointerDownPos: pointerDownPosRef.current,
      bypassModifierRef: bypassLinkModifierRef,
      onOpenExternalUrl: openExternalUrl,
      showInfoToast: (message, options) => {
        toast.info(message, options);
      },
    });
    pointerDownPosRef.current = null;
  };

  const contextMenuActions: ContextMenuAction[] = contextMenu
    ? contextMenu.kind === 'image'
      ? [
          {
            label: 'Copy Image',
            onSelect: () => {
              void handleCopyImageElement();
            },
          },
        ]
      : [
          {
            label: 'Copy',
            disabled: !contextMenu.hasSelection,
            onSelect: () => {
              void handleCopySelection();
            },
          },
          ...(contextMenu.imageHit
            ? [
                {
                  label: 'Copy Image',
                  onSelect: () => {
                    const imageHit = contextMenu.imageHit;
                    if (!imageHit) return;
                    void copyPdfImageRegionFromCanvas(
                      imageHit.canvas,
                      imageHit.rect,
                      imageHit.pageWidthPt,
                      imageHit.pageHeightPt,
                    )
                      .then(() => {
                        toast.success('Image copied to clipboard');
                      })
                      .catch((err: unknown) => {
                        const details = err instanceof Error ? err.message : String(err);
                        toast.error('Failed to copy image', { description: details });
                      });
                  },
                },
              ]
            : []),
          {
            label: 'Select All',
            onSelect: () => {
              selectAllInside(textLayerRef.current);
            },
          },
        ]
    : [];

  return <div
    ref={assetContainerRef}
    tabIndex={-1}
    style={{ outline: 'none' }}
    className="workspace-asset"
    onCopy={handlePdfCopy}
    onContextMenu={!isPdf && url ? handleImageContextMenu : undefined}
  >
    {loading && <div className="workspace-notice"><RotateCw className="spin" size={20} /> Loading preview…</div>}
    {error && <div className="workspace-notice">Unable to preview this file: {error}</div>}
    {url && !isPdf && <img ref={imgRef} src={url} alt={path.split('/').pop() || 'Project image'} />}
    {url && isPdf && <>
      <div
        ref={pdfPageRef}
        tabIndex={-1}
        style={{ outline: 'none' }}
        className="workspace-pdf-page"
        onMouseDown={(e) => {
          pointerDownPosRef.current = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
          if (e.button === 0) {
            textSelectionCleanupRef.current?.();
            textSelectionCleanupRef.current = trackTextLayerSelection(e.target);
          }
        }}
        onClickCapture={handlePdfClickCapture}
        onContextMenu={handlePdfContextMenu}
      >
        <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />
        <div ref={textLayerRef} className="textLayer" />
        <div ref={annotationLayerRef} className="annotationLayer" />
      </div>
      {pdfPages && <div className="workspace-pdf-controls"><button disabled={pageNumber <= 1} onClick={() => setPageNumber(n => n - 1)}>Previous</button><span>Page {pageNumber} of {pdfPages}</span><button disabled={pageNumber >= pdfPages} onClick={() => setPageNumber(n => n + 1)}>Next</button></div>}
    </>}
    {contextMenu && (
      <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        actions={contextMenuActions}
        onClose={() => {
          contextMenuSeqRef.current++;
          setContextMenu(null);
        }}
      />
    )}
  </div>;
};
