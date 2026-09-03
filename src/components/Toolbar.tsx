import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, 
  Square,
  Loader2, 
  Download, 
  ZoomIn, 
  ZoomOut, 
  Maximize2, 
  FileText, 
  FileCode,
  CheckCircle2, 
  AlertCircle,
  Sidebar,
  RefreshCw,
  Archive,
  Globe,
  ChevronDown
} from 'lucide-react';

interface ToolbarProps {
  onCompile: () => void;
  onCancelCompile?: () => void;
  isCompiling: boolean;
  compilationStatus: 'idle' | 'compiling' | 'success' | 'error';
  statusMessage: string;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onFitWidth: () => void;
  onDownloadPdf: () => void;
  onExportZip: () => void;
  onExportMarkdown: () => void;
  onExportHtml: () => void;
  hasPdf: boolean;
  engine: 'latex' | 'typst';
  onSwitchEngine: (engine: 'latex' | 'typst') => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  hasOpenProject: boolean;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  onCompile,
  onCancelCompile,
  isCompiling,
  compilationStatus,
  statusMessage,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onFitWidth,
  onDownloadPdf,
  onExportZip,
  onExportMarkdown,
  onExportHtml,
  hasPdf,
  engine,
  onSwitchEngine,
  sidebarOpen,
  onToggleSidebar,
  hasOpenProject,
}) => {
  const [isExportOpen, setIsExportOpen] = useState(false);
  const exportDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (exportDropdownRef.current && !exportDropdownRef.current.contains(e.target as Node)) {
        setIsExportOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  return (
    <header className="toolbar">
      <div className="toolbar-left">
        {/* Toggle Sidebar Button when project is open */}
        {hasOpenProject && (
          <button
            className={`btn btn-icon ${sidebarOpen ? 'btn-sidebar-active' : ''}`}
            onClick={onToggleSidebar}
            title="Toggle File Explorer (Ctrl + B)"
          >
            <Sidebar size={16} />
          </button>
        )}

        {/* Brand Logo & Subtitle Badge */}
        <div className="app-logo">
          {engine === 'typst' ? (
            <FileCode className="logo-icon text-cyan-400" size={20} />
          ) : (
            <FileText className="logo-icon text-blue-500" size={20} />
          )}
          <span className="logo-text">ScienceBatch</span>
          <span className="logo-badge">Studio</span>
        </div>

        {/* Engine Switcher Pill Button */}
        <button
          className="btn btn-secondary btn-sm engine-toggle-btn"
          onClick={() => onSwitchEngine(engine === 'latex' ? 'typst' : 'latex')}
          title={`Click to switch typesetting engine (Currently: ${engine === 'latex' ? 'LaTeX' : 'Typst'})`}
        >
          {engine === 'typst' ? (
            <>
              <FileCode size={13} className="text-cyan-400" />
              <span>Engine: Typst</span>
            </>
          ) : (
            <>
              <FileText size={13} className="text-blue-400" />
              <span>Engine: LaTeX</span>
            </>
          )}
          <RefreshCw size={11} className="text-muted ml-1" />
        </button>

        {/* Primary Compile / Stop Action Button */}
        {isCompiling ? (
          <button
            className="btn btn-compile btn-stop"
            onClick={onCancelCompile}
            title="Cancel compilation (Stop)"
            aria-label="Stop compilation"
          >
            <Square size={13} fill="currentColor" className="text-rose-300" />
            <span>Stop</span>
          </button>
        ) : (
          <button
            className="btn btn-compile"
            onClick={onCompile}
            title="Compile Document (Ctrl + S)"
          >
            <Play size={16} fill="currentColor" />
            <span>Compile</span>
            <kbd className="shortcut-badge">Ctrl+S</kbd>
          </button>
        )}

        {/* Compilation Status Indicator */}
        <div className="status-indicator">
          {compilationStatus === 'compiling' && (
            <span className="status-badge status-compiling">
              <Loader2 className="animate-spin" size={13} />
              {statusMessage || 'Processing document...'}
            </span>
          )}
          {compilationStatus === 'success' && (
            <span className="status-badge status-success">
              <CheckCircle2 size={13} />
              {statusMessage || 'Ready'}
            </span>
          )}
          {compilationStatus === 'error' && (
            <span className="status-badge status-error" title={statusMessage}>
              <AlertCircle size={13} />
              Compilation error
            </span>
          )}
        </div>
      </div>

      <div className="toolbar-right">
        {/* PDF Zoom Controls */}
        <div className="zoom-controls">
          <button
            className="btn btn-icon"
            onClick={onZoomOut}
            title="Zoom out"
            disabled={!hasPdf}
          >
            <ZoomOut size={16} />
          </button>
          <button
            className="btn btn-zoom-level"
            onClick={onZoomReset}
            title="Reset zoom to 100%"
            disabled={!hasPdf}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="btn btn-icon"
            onClick={onZoomIn}
            title="Zoom in"
            disabled={!hasPdf}
          >
            <ZoomIn size={16} />
          </button>
          <button
            className="btn btn-icon"
            onClick={onFitWidth}
            title="Fit to width"
            disabled={!hasPdf}
          >
            <Maximize2 size={16} />
          </button>
        </div>

        {/* Multi-Format Export Dropdown */}
        <div className="export-dropdown-wrapper" ref={exportDropdownRef}>
          <button
            className={`btn btn-secondary export-btn ${isExportOpen ? 'btn-active' : ''}`}
            onClick={() => setIsExportOpen(!isExportOpen)}
            title="Export document in various formats"
          >
            <Download size={15} />
            <span>Export</span>
            <ChevronDown size={13} className={`export-caret ${isExportOpen ? 'export-caret-open' : ''}`} />
          </button>

          {isExportOpen && (
            <div className="toolbar-dropdown-menu">
              <button
                className={`toolbar-dropdown-item ${!hasPdf ? 'item-disabled' : ''}`}
                onClick={() => {
                  if (hasPdf) {
                    onDownloadPdf();
                    setIsExportOpen(false);
                  }
                }}
                disabled={!hasPdf}
                title={hasPdf ? "Export compiled PDF document (Ctrl+Shift+E)" : "Compile document first to export PDF"}
              >
                <div className="toolbar-item-left">
                  <FileText size={15} className="text-blue-400 shrink-0" />
                  <div className="toolbar-item-text">
                    <span className="toolbar-item-title">Download as PDF</span>
                    <span className="toolbar-item-desc">Formatted document (.pdf)</span>
                  </div>
                </div>
                <kbd className="shortcut-badge">Ctrl+Shift+E</kbd>
              </button>

              <button
                className="toolbar-dropdown-item"
                onClick={() => {
                  onExportZip();
                  setIsExportOpen(false);
                }}
                title="Package all project source files and assets into a ZIP archive (Ctrl+Shift+Z)"
              >
                <div className="toolbar-item-left">
                  <Archive size={15} className="text-amber-400 shrink-0" />
                  <div className="toolbar-item-text">
                    <span className="toolbar-item-title">Download as Source</span>
                    <span className="toolbar-item-desc">Complete project archive (.zip)</span>
                  </div>
                </div>
                <kbd className="shortcut-badge">Ctrl+Shift+Z</kbd>
              </button>

              <div className="dropdown-divider" />

              <button
                className="toolbar-dropdown-item"
                onClick={() => {
                  onExportMarkdown();
                  setIsExportOpen(false);
                }}
                title="Export document structure to clean Markdown (.md)"
              >
                <div className="toolbar-item-left">
                  <FileCode size={15} className="text-emerald-400 shrink-0" />
                  <div className="toolbar-item-text">
                    <span className="toolbar-item-title">Export as Markdown</span>
                    <span className="toolbar-item-desc">Clean structured text (.md)</span>
                  </div>
                </div>
              </button>

              <button
                className="toolbar-dropdown-item"
                onClick={() => {
                  onExportHtml();
                  setIsExportOpen(false);
                }}
                title="Export to standalone HTML with KaTeX math rendering (.html)"
              >
                <div className="toolbar-item-left">
                  <Globe size={15} className="text-cyan-400 shrink-0" />
                  <div className="toolbar-item-text">
                    <span className="toolbar-item-title">Export as HTML</span>
                    <span className="toolbar-item-desc">Standalone page with KaTeX (.html)</span>
                  </div>
                </div>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
