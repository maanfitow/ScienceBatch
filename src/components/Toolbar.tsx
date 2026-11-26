import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
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
  hasPdf,
  engine,
  onSwitchEngine,
  sidebarOpen,
  onToggleSidebar,
  hasOpenProject,
}) => {
  const { t } = useTranslation(['menu', 'common']);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const exportDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (exportDropdownRef.current && !exportDropdownRef.current.contains(e.target as Node)) {
        setIsExportOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsExportOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const engineLabel = t(engine === 'latex' ? 'common:engines.latex' : 'common:engines.typst');
  const zoomPercent = Math.round(zoom * 100);

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        {/* Toggle Sidebar Button when project is open */}
        {hasOpenProject && (
          <button
            type="button"
            className={`btn btn-icon ${sidebarOpen ? 'btn-sidebar-active' : ''}`}
            onClick={onToggleSidebar}
            title={t('menu:toolbar.toggleExplorerTooltip')}
            aria-label={t('menu:toolbar.toggleExplorerAria')}
            aria-pressed={sidebarOpen}
          >
            <Sidebar size={16} />
          </button>
        )}

        {/* Brand Logo & Subtitle Badge */}
        <div className="app-logo">
          {engine === 'typst' ? (
            <FileCode className="logo-icon icon-typst" size={20} />
          ) : (
            <FileText className="logo-icon icon-latex" size={20} />
          )}
          <span className="logo-text">ScienceBatch</span>
          <span className="logo-badge">Studio</span>
        </div>

        {/* Primary Compile / Stop Action Button */}
        {isCompiling ? (
          <button
            type="button"
            className="btn btn-compile btn-stop"
            onClick={onCancelCompile}
            title={t('menu:toolbar.stopTooltip')}
            aria-label={t('menu:toolbar.stopAria')}
          >
            <Square size={13} fill="currentColor" className="icon-stop" />
            <span>{t('common:actions.stop')}</span>
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-compile"
            onClick={onCompile}
            title={t('menu:toolbar.compileTooltip')}
          >
            <Play size={16} fill="currentColor" />
            <span>{t('common:actions.compile')}</span>
            <kbd className="shortcut-badge">Ctrl+S</kbd>
          </button>
        )}

        {/* Compilation Status Indicator */}
        <div className="status-indicator">
          {compilationStatus === 'compiling' && (
            <span className="status-badge status-compiling">
              <Loader2 className="animate-spin" size={13} />
              {statusMessage || t('menu:toolbar.processingDocument')}
            </span>
          )}
          {compilationStatus === 'success' && (
            <span className="status-badge status-success">
              <CheckCircle2 size={13} />
              {statusMessage || t('menu:toolbar.ready')}
            </span>
          )}
          {compilationStatus === 'error' && (
            <span className="status-badge status-error" title={statusMessage}>
              <AlertCircle size={13} />
              {t('menu:toolbar.compilationError')}
            </span>
          )}
        </div>
      </div>

      <div className="toolbar-right">
        {/* Engine Switcher Pill Button */}
        <button
          type="button"
          className="btn btn-secondary btn-sm engine-toggle-btn"
          onClick={() => onSwitchEngine(engine === 'latex' ? 'typst' : 'latex')}
          title={t('menu:toolbar.switchEngineTooltip', { engine: engineLabel })}
        >
          {engine === 'typst' ? (
            <>
              <FileCode size={13} className="icon-typst" />
              <span>{t('menu:toolbar.engineLabel', { engine: engineLabel })}</span>
            </>
          ) : (
            <>
              <FileText size={13} className="icon-latex" />
              <span>{t('menu:toolbar.engineLabel', { engine: engineLabel })}</span>
            </>
          )}
          <RefreshCw size={11} className="text-muted ml-1" />
        </button>

        {/* PDF Zoom Controls */}
        <div className="zoom-controls">
          <button
            type="button"
            className="btn btn-icon"
            onClick={onZoomOut}
            title={t('menu:toolbar.zoomOut')}
            aria-label={t('menu:toolbar.zoomOut')}
            disabled={!hasPdf}
          >
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            className="btn btn-zoom-level"
            onClick={onZoomReset}
            title={t('menu:toolbar.zoomResetTooltip')}
            aria-label={t('menu:toolbar.zoomLevelAria', { percent: zoomPercent })}
            disabled={!hasPdf}
          >
            {zoomPercent}%
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={onZoomIn}
            title={t('menu:toolbar.zoomIn')}
            aria-label={t('menu:toolbar.zoomIn')}
            disabled={!hasPdf}
          >
            <ZoomIn size={16} />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={onFitWidth}
            title={t('menu:toolbar.fitWidth')}
            aria-label={t('menu:toolbar.fitWidth')}
            disabled={!hasPdf}
          >
            <Maximize2 size={16} />
          </button>
        </div>

        {/* Multi-Format Export Dropdown */}
        <div className="export-dropdown-wrapper" ref={exportDropdownRef}>
          <button
            type="button"
            className={`btn btn-secondary export-btn ${isExportOpen ? 'btn-active' : ''}`}
            onClick={() => setIsExportOpen(!isExportOpen)}
            title={t('menu:toolbar.exportTooltip')}
            aria-haspopup="menu"
            aria-expanded={isExportOpen}
          >
            <Download size={15} />
            <span>{t('common:actions.export')}</span>
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
                title={
                  hasPdf
                    ? t('menu:file.exportPdfTooltipReady')
                    : t('menu:file.exportPdfTooltipDisabled')
                }
              >
                <div className="toolbar-item-left">
                  <FileText size={15} className="icon-latex shrink-0" />
                  <div className="toolbar-item-text">
                    <span className="toolbar-item-title">{t('menu:toolbar.downloadPdfTitle')}</span>
                    <span className="toolbar-item-desc">{t('menu:toolbar.downloadPdfDesc')}</span>
                  </div>
                </div>
              </button>

              <button
                className="toolbar-dropdown-item"
                onClick={() => {
                  onExportZip();
                  setIsExportOpen(false);
                }}
                title={t('menu:toolbar.downloadZipTooltip')}
              >
                <div className="toolbar-item-left">
                  <Archive size={15} className="icon-archive shrink-0" />
                  <div className="toolbar-item-text">
                    <span className="toolbar-item-title">{t('menu:toolbar.downloadZipTitle')}</span>
                    <span className="toolbar-item-desc">{t('menu:toolbar.downloadZipDesc')}</span>
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
