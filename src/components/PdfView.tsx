import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { FileQuestion, RefreshCw, Eye, AlertCircle } from 'lucide-react';
import { DiagnosticsView } from './DiagnosticsView';
import { DiagnosticItem } from '../types';

// Configure pdfjs worker via Vite asset URL loader
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

interface PdfViewProps {
  pdfBytes: Uint8Array | null;
  zoom: number;
  onZoomChange?: (newZoom: number) => void;
  isCompiling: boolean;
  errors: DiagnosticItem[];
  warnings: DiagnosticItem[];
  rawLog: string;
  activeTab: 'preview' | 'diagnostics';
  onTabChange: (tab: 'preview' | 'diagnostics') => void;
  onRetryCompile: () => void;
  onSelectLine?: (line: number, file?: string | null) => void;
  engine?: 'latex' | 'typst';
}

export const PdfView: React.FC<PdfViewProps> = ({
  pdfBytes,
  zoom,
  onZoomChange,
  isCompiling,
  errors,
  warnings,
  rawLog,
  activeTab,
  onTabChange,
  onRetryCompile,
  onSelectLine,
  engine = 'latex',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [isLoadingPdf, setIsLoadingPdf] = useState<boolean>(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const renderTasksRef = useRef<pdfjsLib.RenderTask[]>([]);
  const renderSeqRef = useRef<number>(0);
  const scrollPositionRef = useRef<number>(0);
  const scrollRafRef = useRef<number | null>(null);

  // Zoom ergonomics, focal tracking & HUD state
  const firstPageWidthRef = useRef<number>(595.28);
  const renderedZoomRef = useRef<number>(zoom);
  const targetScrollRef = useRef<{ left: number; top: number } | null>(null);
  const [isHudVisible, setIsHudVisible] = useState<boolean>(false);
  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Active section focus tracking (requires click before gesture zoom)
  const [isViewerActive, setIsViewerActive] = useState<boolean>(false);
  const isViewerActiveRef = useRef<boolean>(false);
  isViewerActiveRef.current = isViewerActive;

  // Multi-modal panning state (Space + Drag or Middle-click Drag)
  const isMouseOverViewerRef = useRef<boolean>(false);
  const isSpaceDownRef = useRef<boolean>(false);
  const [isSpaceDown, setIsSpaceDown] = useState<boolean>(false);
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const panStartRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);

  // Calculate which PDF page is currently most prominent in the viewport
  const updateCurrentPage = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const pageElements = container.querySelectorAll<HTMLDivElement>('.pdf-page-wrapper');
    if (pageElements.length === 0) return;

    // Handle container scroll boundaries
    if (container.scrollTop <= 10) {
      setCurrentPage(1);
      return;
    }
    if (container.scrollHeight - (container.scrollTop + container.clientHeight) <= 15) {
      setCurrentPage(pageElements.length);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    let bestPage = 1;
    let maxVisibleHeight = -1;

    pageElements.forEach((el, index) => {
      const rect = el.getBoundingClientRect();
      const visibleTop = Math.max(rect.top, containerRect.top);
      const visibleBottom = Math.min(rect.bottom, containerRect.bottom);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);

      if (visibleHeight > maxVisibleHeight) {
        maxVisibleHeight = visibleHeight;
        bestPage = index + 1;
      }
    });

    setCurrentPage((prev) => (prev !== bestPage ? bestPage : prev));
  }, []);

  // Save scroll position and update visible page index when user scrolls
  const handleScroll = () => {
    if (containerRef.current) {
      scrollPositionRef.current = containerRef.current.scrollTop;
      if (scrollRafRef.current === null) {
        scrollRafRef.current = requestAnimationFrame(() => {
          scrollRafRef.current = null;
          updateCurrentPage();
        });
      }
    }
  };

  // Render all pages with current zoom scale
  const renderPages = useCallback(async (pdfDoc: pdfjsLib.PDFDocumentProxy, scale: number) => {
    if (!pagesContainerRef.current) return;

    // Assign a monotonically increasing sequence token for this render request
    const currentSeq = ++renderSeqRef.current;

    // Cancel all currently in-flight PDF.js render tasks
    renderTasksRef.current.forEach((task) => {
      try {
        task.cancel();
      } catch {
        // Task might already be finished
      }
    });
    renderTasksRef.current = [];

    const pagesContainer = pagesContainerRef.current;
    const pixelRatio = window.devicePixelRatio || 1;

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      // Abort immediately if a newer render request has arrived
      if (renderSeqRef.current !== currentSeq) {
        return;
      }

      try {
        const page = await pdfDoc.getPage(pageNum);
        if (renderSeqRef.current !== currentSeq) return;

        if (pageNum === 1) {
          const unscaledViewport = page.getViewport({ scale: 1.0 });
          firstPageWidthRef.current = unscaledViewport.width;
        }

        const viewport = page.getViewport({ scale: scale * pixelRatio });

        // 1. Create a fresh, off-DOM canvas (double-buffer)
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = viewport.width;
        offscreenCanvas.height = viewport.height;
        offscreenCanvas.style.width = `${viewport.width / pixelRatio}px`;
        offscreenCanvas.style.height = `${viewport.height / pixelRatio}px`;

        const ctx = offscreenCanvas.getContext('2d', { alpha: false });
        if (!ctx) continue;

        // Ensure clean white background before rendering
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

        const renderContext = {
          canvasContext: ctx,
          viewport: viewport,
        };

        const renderTask = page.render(renderContext);
        renderTasksRef.current.push(renderTask);
        await renderTask.promise;

        // If a newer render sequence arrived while this page was rendering, discard this buffer
        if (renderSeqRef.current !== currentSeq) return;

        // 2. Atomically swap the completed canvas into the DOM without any white flash or artifacts
        let canvasWrapper = pagesContainer.querySelector<HTMLDivElement>(`#pdf-page-${pageNum}`);
        if (!canvasWrapper) {
          canvasWrapper = document.createElement('div');
          canvasWrapper.id = `pdf-page-${pageNum}`;
          canvasWrapper.className = 'pdf-page-wrapper';
          pagesContainer.appendChild(canvasWrapper);
        }

        const existingCanvas = canvasWrapper.querySelector('canvas');
        if (existingCanvas) {
          canvasWrapper.replaceChild(offscreenCanvas, existingCanvas);
        } else {
          canvasWrapper.appendChild(offscreenCanvas);
        }

        if (renderSeqRef.current !== currentSeq) return;
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'RenderingCancelledException') {
          if (renderSeqRef.current !== currentSeq) return;
          continue;
        }
        console.error(`Error rendering page ${pageNum}:`, err);
      }
    }

    // Mark the scale that has now been fully drawn to the canvases
    renderedZoomRef.current = scale;
    if (pagesContainerRef.current) {
      pagesContainerRef.current.style.transform = 'none';
    }

    // Restore preserved scroll position or apply targeted focal scroll position
    if (renderSeqRef.current === currentSeq && containerRef.current) {
      if (targetScrollRef.current) {
        containerRef.current.scrollLeft = targetScrollRef.current.left;
        containerRef.current.scrollTop = targetScrollRef.current.top;
        scrollPositionRef.current = targetScrollRef.current.top;
        targetScrollRef.current = null;
      } else if (scrollPositionRef.current > 0) {
        containerRef.current.scrollTop = scrollPositionRef.current;
      }
      updateCurrentPage();
    }
  }, [updateCurrentPage]);

  // Load PDF document ONLY when pdfBytes change
  useEffect(() => {
    if (!pdfBytes || pdfBytes.length === 0) {
      setNumPages(0);
      setCurrentPage(1);
      pdfDocRef.current = null;
      renderSeqRef.current++;
      renderTasksRef.current.forEach((t) => {
        try { t.cancel(); } catch {}
      });
      renderTasksRef.current = [];
      if (pagesContainerRef.current) {
        pagesContainerRef.current.innerHTML = '';
      }
      return;
    }

    let isSubscribed = true;
    setIsLoadingPdf(true);
    setRenderError(null);

    if (containerRef.current) {
      scrollPositionRef.current = containerRef.current.scrollTop;
    }

    const loadPdf = async () => {
      try {
        const dataCopy = new Uint8Array(pdfBytes);
        const loadingTask = pdfjsLib.getDocument({
          data: dataCopy,
          cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/',
          cMapPacked: true,
        });

        const pdfDoc = await loadingTask.promise;
        if (!isSubscribed) return;

        pdfDocRef.current = pdfDoc;
        setNumPages(pdfDoc.numPages);

        if (pagesContainerRef.current) {
          const wrappers = pagesContainerRef.current.querySelectorAll('.pdf-page-wrapper');
          wrappers.forEach((w, idx) => {
            if (idx >= pdfDoc.numPages) {
              w.remove();
            }
          });
        }

        // Initial render at current zoom
        await renderPages(pdfDoc, zoom);
      } catch (err: unknown) {
        if (!isSubscribed) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Error loading PDF document:', err);
        setRenderError(msg);
      } finally {
        if (isSubscribed) {
          setIsLoadingPdf(false);
        }
      }
    };

    loadPdf();

    return () => {
      isSubscribed = false;
    };
  }, [pdfBytes, renderPages]);

  // Re-render pages smoothly when zoom or tab changes WITHOUT reloading the document
  useEffect(() => {
    if (!pdfDocRef.current || !pdfBytes || activeTab !== 'preview') return;

    const timer = setTimeout(() => {
      if (pdfDocRef.current) {
        renderPages(pdfDocRef.current, zoom);
      }
    }, 180);

    return () => {
      clearTimeout(timer);
    };
  }, [zoom, activeTab, pdfBytes, renderPages]);

  // HUD badge visibility trigger
  const triggerHud = useCallback(() => {
    setIsHudVisible(true);
    if (hudTimerRef.current) {
      clearTimeout(hudTimerRef.current);
    }
    hudTimerRef.current = setTimeout(() => {
      setIsHudVisible(false);
    }, 1200);
  }, []);

  // Show HUD badge on zoom change
  useEffect(() => {
    triggerHud();
  }, [zoom, triggerHud]);

  // Clean up HUD timer and scroll animation frame on unmount
  useEffect(() => {
    return () => {
      if (hudTimerRef.current) {
        clearTimeout(hudTimerRef.current);
      }
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  // Update current page on window or panel resize
  useEffect(() => {
    const handleResize = () => {
      updateCurrentPage();
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [updateCurrentPage]);

  // Listen for toolbar 'Fit to Width' requests
  useEffect(() => {
    const handleFitWidthEvent = () => {
      if (!containerRef.current || !onZoomChange) return;
      const containerWidth = containerRef.current.clientWidth;
      const pageWidth = firstPageWidthRef.current || 595.28;
      const availableWidth = containerWidth - 48;
      if (availableWidth > 0 && pageWidth > 0) {
        const calculated = availableWidth / pageWidth;
        const clamped = Math.min(Math.max(Number(calculated.toFixed(2)), 0.25), 5.0);
        onZoomChange(clamped);
      }
    };

    window.addEventListener('sciencebatch:fit-width', handleFitWidthEvent);
    return () => {
      window.removeEventListener('sciencebatch:fit-width', handleFitWidthEvent);
    };
  }, [onZoomChange]);

  // Track active section focus on click
  useEffect(() => {
    const handleGlobalMouseDown = (e: MouseEvent) => {
      if (containerRef.current && containerRef.current.contains(e.target as Node)) {
        setIsViewerActive(true);
      } else {
        setIsViewerActive(false);
      }
    };

    window.addEventListener('mousedown', handleGlobalMouseDown);
    return () => {
      window.removeEventListener('mousedown', handleGlobalMouseDown);
    };
  }, []);

  // Wheel and pinch-to-zoom anchored on mouse cursor
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();

      // Require active click/focus in PDF preview before zooming
      if (!isViewerActiveRef.current) return;

      if (!onZoomChange) return;

      const centerX = container.clientWidth / 2;
      const centerY = container.clientHeight / 2;

      const delta = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
      // Inverted to match natural touchpad scroll ergonomics: forward/up (delta > 0) zooms in, backward/down (delta < 0) zooms out
      const zoomFactor = Math.exp(delta * 0.0015);
      const oldZoom = zoom;
      const newZoom = Math.min(Math.max(Number((oldZoom * zoomFactor).toFixed(2)), 0.25), 5.0);

      if (newZoom === oldZoom) return;

      const scaleRatio = newZoom / oldZoom;

      // Viewport center anchoring: keeps document centered horizontally and scales vertically from center of view
      let newScrollLeft = 0;
      if (container.scrollWidth > container.clientWidth) {
        newScrollLeft = (container.scrollLeft + centerX) * scaleRatio - centerX;
      }
      const newScrollTop = (container.scrollTop + centerY) * scaleRatio - centerY;

      targetScrollRef.current = {
        left: Math.max(0, newScrollLeft),
        top: Math.max(0, newScrollTop),
      };

      // Apply 60fps CSS transform preview during rapid gestures
      if (pagesContainerRef.current && renderedZoomRef.current > 0) {
        const interimScale = newZoom / renderedZoomRef.current;
        pagesContainerRef.current.style.transform = `scale(${interimScale})`;
        pagesContainerRef.current.style.transformOrigin = 'top center';
      }

      container.scrollLeft = Math.max(0, newScrollLeft);
      container.scrollTop = Math.max(0, newScrollTop);
      scrollPositionRef.current = Math.max(0, newScrollTop);

      onZoomChange(newZoom);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [zoom, onZoomChange]);

  // Spacebar key tracking for pan / hand tool
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.closest('.monaco-editor')
      )) {
        return;
      }

      if (e.code === 'Space' && !e.repeat) {
        if (isMouseOverViewerRef.current) {
          e.preventDefault();
          setIsSpaceDown(true);
          isSpaceDownRef.current = true;
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpaceDown(false);
        isSpaceDownRef.current = false;
        setIsPanning(false);
        panStartRef.current = null;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Mouse pan handlers (Space+Left Click or Middle-Click)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && isSpaceDownRef.current)) {
        e.preventDefault();
        setIsPanning(true);
        panStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          scrollLeft: container.scrollLeft,
          scrollTop: container.scrollTop,
        };
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!panStartRef.current) return;
      e.preventDefault();
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      container.scrollLeft = panStartRef.current.scrollLeft - dx;
      container.scrollTop = panStartRef.current.scrollTop - dy;
      scrollPositionRef.current = container.scrollTop;
    };

    const handleMouseUp = () => {
      if (panStartRef.current) {
        setIsPanning(false);
        panStartRef.current = null;
      }
    };

    const handleMouseEnter = () => {
      isMouseOverViewerRef.current = true;
    };

    const handleMouseLeave = () => {
      isMouseOverViewerRef.current = false;
      if (!panStartRef.current) {
        setIsSpaceDown(false);
        isSpaceDownRef.current = false;
      }
    };

    const handleAuxClick = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
      }
    };

    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('mouseenter', handleMouseEnter);
    container.addEventListener('mouseleave', handleMouseLeave);
    container.addEventListener('auxclick', handleAuxClick);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      container.removeEventListener('mouseenter', handleMouseEnter);
      container.removeEventListener('mouseleave', handleMouseLeave);
      container.removeEventListener('auxclick', handleAuxClick);
    };
  }, []);

  const totalErrors = errors.length;
  const totalWarnings = warnings.length;

  const getContainerCursorClass = () => {
    if (isPanning) return 'cursor-grabbing';
    if (isSpaceDown) return 'cursor-grab';
    return '';
  };

  return (
    <div className="right-panel-wrapper">
      {/* Overleaf-Style Top Tab Bar */}
      <div className="right-panel-tabs">
        <button
          className={`right-tab-btn ${activeTab === 'preview' ? 'right-tab-active' : ''}`}
          onClick={() => onTabChange('preview')}
        >
          <Eye size={15} />
          <span>PDF Preview</span>
        </button>

        <button
          className={`right-tab-btn ${activeTab === 'diagnostics' ? 'right-tab-active' : ''}`}
          onClick={() => onTabChange('diagnostics')}
        >
          <AlertCircle size={15} />
          <span>Logs & Issues</span>

          {(totalErrors > 0 || totalWarnings > 0) && (
            <div className="tab-badge-group">
              {totalErrors > 0 && (
                <span className="tab-badge tab-badge-error">
                  {totalErrors}
                </span>
              )}
              {totalWarnings > 0 && (
                <span className="tab-badge tab-badge-warning">
                  {totalWarnings}
                </span>
              )}
            </div>
          )}
        </button>
      </div>

      {/* Main Tab Content */}
      <div className="right-panel-content">
        {activeTab === 'diagnostics' ? (
          <DiagnosticsView
            errors={errors}
            warnings={warnings}
            rawLog={rawLog}
            onRetryCompile={onRetryCompile}
            isCompiling={isCompiling}
            onSelectLine={onSelectLine}
            engine={engine}
          />
        ) : (
          <div
            ref={containerRef}
            className={`pdf-viewer-container ${getContainerCursorClass()}`}
            onScroll={handleScroll}
          >
            {isLoadingPdf && (
              <div className="pdf-loading-overlay">
                <RefreshCw className="animate-spin" size={24} />
                <span>Rendering PDF pages...</span>
              </div>
            )}

            {renderError && (
              <div className="pdf-error-container">
                <AlertCircle className="text-red-400" size={32} />
                <p>{renderError}</p>
                <button className="btn btn-secondary btn-sm mt-2" onClick={onRetryCompile}>
                  Retry Rendering
                </button>
              </div>
            )}

            {!pdfBytes && !isLoadingPdf && !renderError && (
              <div className="pdf-empty-state">
                <FileQuestion size={48} className="empty-icon" />
                <h3>Document Not Compiled</h3>
                <p>Press <strong>Ctrl + S</strong> or click <strong>Compile</strong> to preview the compiled PDF.</p>
                {isCompiling && (
                  <div className="empty-loading">
                    <RefreshCw className="animate-spin" size={18} />
                    <span>Compiling with {engine === 'typst' ? 'Typst' : 'Tectonic'} in memory...</span>
                  </div>
                )}
              </div>
            )}

            <div ref={pagesContainerRef} className="pdf-pages-wrapper" />

            {/* Floating Zoom HUD Badge */}
            <div className={`pdf-zoom-hud ${isHudVisible ? 'pdf-zoom-hud-visible' : ''}`}>
              <span>{Math.round(zoom * 100)}%</span>
            </div>

            {numPages > 0 && (
              <div
                className="pdf-page-count-badge"
                aria-label={`Page ${currentPage} of ${numPages}`}
                title={`Page ${currentPage} of ${numPages}`}
              >
                {currentPage} / {numPages}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
