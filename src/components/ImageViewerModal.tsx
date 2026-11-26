import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { X, Image as ImageIcon, FileText, Copy, Check, Info } from 'lucide-react';
import { toast } from 'sonner';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import i18n from '../i18n';
import { ContextMenu } from './ContextMenu';
import {
  canvasRegionToClipboardImage,
  copyTextToClipboard,
  imageElementToClipboardImage,
  shouldIgnorePdfShortcut,
} from './pdfClipboard';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

interface ImageViewerModalProps {
  isOpen: boolean;
  filePath: string | null;
  fileName: string | null;
  relPath: string | null;
  onClose: () => void;
}

export const ImageViewerModal: React.FC<ImageViewerModalProps> = ({
  isOpen,
  filePath,
  fileName,
  relPath,
  onClose,
}) => {
  const { t } = useTranslation(['menu', 'common']);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [fileSizeBytes, setFileSizeBytes] = useState<number | null>(null);
  const [copiedLatex, setCopiedLatex] = useState(false);
  const [copiedTypst, setCopiedTypst] = useState(false);
  const [copiedImage, setCopiedImage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const modalRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const isPdf = fileName?.toLowerCase().endsWith('.pdf') ?? false;

  useEffect(() => {
    setCopiedImage(false);
    setContextMenu(null);
  }, [isOpen, filePath]);

  const handleCopyImage = useCallback(async () => {
    try {
      if (isPdf) {
        if (!canvasRef.current || canvasRef.current.width === 0 || canvasRef.current.height === 0) {
          throw new Error(t('menu:imageViewerModal.pdfNotRendered'));
        }
        await canvasRegionToClipboardImage(canvasRef.current);
      } else {
        if (!imgRef.current) {
          throw new Error(t('menu:imageViewerModal.imageNotLoaded'));
        }
        await imageElementToClipboardImage(imgRef.current);
      }
      setCopiedImage(true);
      toast.success(t('menu:imageViewerModal.copyImageSuccess'));
      setTimeout(() => setCopiedImage(false), 2000);
    } catch (err: unknown) {
      const details = err instanceof Error ? err.message : String(err);
      toast.error(t('menu:imageViewerModal.copyImageError'), { description: details });
    }
  }, [isPdf, t]);

  useEffect(() => {
    if (!isOpen || !filePath) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'c') return;
      if (shouldIgnorePdfShortcut(document.activeElement)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().length > 0) return;
      if (loading || (!isPdf && !imageUrl)) return;

      e.preventDefault();
      void handleCopyImage();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, filePath, loading, isPdf, imageUrl, handleCopyImage]);

  useEffect(() => {
    if (!isOpen || !filePath) {
      setImageUrl(null);
      setDimensions(null);
      setPageCount(null);
      setFileSizeBytes(null);
      return;
    }

    let activeUrl: string | null = null;
    let cancelled = false;
    setLoading(true);

    const loadAsset = async () => {
      try {
        const bytes = await invoke<number[]>('read_binary_file', { path: filePath });
        if (cancelled) return;

        const uint8 = new Uint8Array(bytes);
        setFileSizeBytes(uint8.byteLength);

        if (isPdf) {
          const loadingTask = pdfjsLib.getDocument({
            data: uint8,
            cMapUrl: '/cmaps/',
            cMapPacked: true,
          });
          const pdfDoc = await loadingTask.promise;
          if (cancelled) return;

          setPageCount(pdfDoc.numPages);
          const page = await pdfDoc.getPage(1);
          if (cancelled) return;

          const unscaledViewport = page.getViewport({ scale: 1.0 });
          setDimensions({
            width: Math.round(unscaledViewport.width),
            height: Math.round(unscaledViewport.height),
          });

          // Render first page to canvas with crisp DPI
          setTimeout(async () => {
            if (cancelled || !canvasRef.current) return;
            const canvas = canvasRef.current;
            const pixelRatio = window.devicePixelRatio || 1;
            const fitScale = Math.min(620 / unscaledViewport.width, 380 / unscaledViewport.height, 2.0);
            const viewport = page.getViewport({ scale: fitScale * pixelRatio });

            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.style.width = `${viewport.width / pixelRatio}px`;
            canvas.style.height = `${viewport.height / pixelRatio}px`;

            const ctx = canvas.getContext('2d', { alpha: false });
            if (ctx) {
              await page.render({ canvasContext: ctx, viewport }).promise;
            }
          }, 60);
        } else {
          const ext = fileName?.split('.').pop()?.toLowerCase() || 'png';
          const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
          const blob = new Blob([uint8], { type: mime });
          activeUrl = URL.createObjectURL(blob);
          setImageUrl(activeUrl);
        }
      } catch (err) {
        toast.error(i18n.t('menu:imageViewerModal.loadPreviewError'), { description: String(err) });
      } finally {
        setLoading(false);
      }
    };

    loadAsset();

    return () => {
      cancelled = true;
      if (activeUrl) {
        URL.revokeObjectURL(activeUrl);
      }
    };
  }, [isOpen, filePath, fileName, isPdf]);

  if (!isOpen || !filePath) return null;

  const targetPath = relPath || fileName || (isPdf ? 'figure.pdf' : 'image.png');
  const cleanName = (fileName || 'figure').replace(/\.[^/.]+$/, '');
  const labelId = cleanName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

  const latexSnippet = `\\begin{figure}[htbp]
  \\centering
  \\includegraphics[width=0.8\\textwidth]{${targetPath}}
  \\caption{${cleanName}}
  \\label{fig:${labelId}}
\\end{figure}`;

  const typstSnippet = `#figure(
  image("${targetPath}", width: 80%),
  caption: [${cleanName}],
) <fig:${labelId}>`;

  const handleCopyLatex = async () => {
    try {
      await copyTextToClipboard(latexSnippet);
      setCopiedLatex(true);
      toast.success(t('menu:imageViewerModal.copyLatexSuccess'));
      setTimeout(() => setCopiedLatex(false), 2000);
    } catch {
      toast.error(t('menu:imageViewerModal.copyClipboardError'));
    }
  };

  const handleCopyTypst = async () => {
    try {
      await copyTextToClipboard(typstSnippet);
      setCopiedTypst(true);
      toast.success(t('menu:imageViewerModal.copyTypstSuccess'));
      setTimeout(() => setCopiedTypst(false), 2000);
    } catch {
      toast.error(t('menu:imageViewerModal.copyClipboardError'));
    }
  };

  const handleStageContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (loading || (!isPdf && !imageUrl)) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} className="modal-container image-viewer-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-group">
            {isPdf ? (
              <FileText className="file-icon-pdf" size={20} />
            ) : (
              <ImageIcon className="icon-success" size={20} />
            )}
            <div>
              <h3>{fileName}</h3>
              <p className="modal-subtitle">{targetPath}</p>
            </div>
          </div>
          <button
            type="button"
            className="modal-btn-close"
            aria-label={t('common:actions.close')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body image-viewer-body">
          <div className="image-preview-stage" onContextMenu={handleStageContextMenu}>
            {loading && <div className="image-loading">{t('menu:imageViewerModal.loadingPreview')}</div>}
            {isPdf ? (
              <canvas ref={canvasRef} className="project-image-view" />
            ) : (
              imageUrl && (
                <img
                  ref={imgRef}
                  src={imageUrl}
                  alt={fileName || t('menu:imageViewerModal.imageAltFallback')}
                  className="project-image-view"
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
                  }}
                />
              )
            )}
          </div>

          <div className="image-info-bar">
            <div className="image-meta">
              <Info size={15} />
              {pageCount !== null && (
                <span>{t('menu:imageViewerModal.pagesLabel')} <strong>{pageCount}</strong></span>
              )}
              {dimensions && (
                <span>{t('menu:imageViewerModal.dimensionsLabel')} <strong>{dimensions.width} &times; {dimensions.height} pt</strong></span>
              )}
              {fileSizeBytes !== null && (
                <span>{t('menu:imageViewerModal.sizeLabel')} <strong>{formatSize(fileSizeBytes)}</strong></span>
              )}
            </div>

            <div className="image-actions">
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleCopyImage}
                disabled={loading || (!isPdf && !imageUrl)}
              >
                {copiedImage ? <Check size={14} className="icon-success" /> : <Copy size={14} />}
                <span>{copiedImage ? t('menu:imageViewerModal.copiedImage') : t('menu:imageViewerModal.copyImage')}</span>
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleCopyLatex}>
                {copiedLatex ? <Check size={14} className="icon-success" /> : <Copy size={14} />}
                <span>{t('menu:imageViewerModal.copyLatexSnippet')}</span>
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleCopyTypst}>
                {copiedTypst ? <Check size={14} className="icon-success" /> : <Copy size={14} />}
                <span>{t('menu:imageViewerModal.copyTypstSnippet')}</span>
              </button>
            </div>
          </div>
        </div>
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            actions={[
              {
                label: t('menu:imageViewerModal.copyImage'),
                onSelect: () => {
                  void handleCopyImage();
                },
              },
            ]}
            onClose={() => setContextMenu(null)}
          />
        )}
      </div>
    </div>
  );
};
