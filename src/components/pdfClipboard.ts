import { isTauri } from '@tauri-apps/api/core';
import { Image as TauriImage } from '@tauri-apps/api/image';
import { writeImage, writeText } from '@tauri-apps/plugin-clipboard-manager';

function isNodeInside(container: HTMLElement, node: Node | null): boolean {
  return node !== null && (node === container || container.contains(node));
}

/**
 * Returns true when the current DOM selection is non-empty and belongs to `container`.
 */
export function hasSelectionInside(container: HTMLElement | null): boolean {
  if (!container || typeof window === 'undefined') return false;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  if (selection.toString().length === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  return (
    isNodeInside(container, selection.anchorNode) ||
    isNodeInside(container, selection.focusNode) ||
    isNodeInside(container, range.commonAncestorContainer)
  );
}

/**
 * Returns the selected text inside `container`, or an empty string when no
 * non-collapsed selection resides inside `container`.
 */
export function getSelectedTextInside(container: HTMLElement | null): string {
  if (!hasSelectionInside(container)) return '';
  return window.getSelection()?.toString() ?? '';
}

/**
 * Writes plain text to the system clipboard using Tauri's clipboard plugin
 * with a browser `navigator.clipboard` fallback.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (isTauri()) {
    await writeText(text);
    return;
  }

  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard access is unavailable in this browser context.');
  }

  await navigator.clipboard.writeText(text);
}

/**
 * Copies the active text selection inside `container` to the clipboard.
 * Returns `true` when non-empty text was selected and written.
 */
export async function copySelectionInside(container: HTMLElement | null): Promise<boolean> {
  const text = getSelectedTextInside(container);
  if (!text) return false;
  await copyTextToClipboard(text);
  return true;
}

/**
 * Returns true when keyboard focus resides in an editable element or Monaco
 * editor where PDF viewer shortcuts must not intercept input.
 */
export function shouldIgnorePdfShortcut(activeElement: Element | null): boolean {
  if (!activeElement) return false;
  return (
    activeElement.tagName === 'INPUT' ||
    activeElement.tagName === 'TEXTAREA' ||
    (activeElement as HTMLElement).isContentEditable ||
    Boolean(activeElement.closest('.monaco-editor'))
  );
}

/**
 * Selects all text within rendered `.textLayer` elements inside `container`,
 * keeping the DOM selection scoped to the PDF viewer rather than the whole app.
 * Returns `true` when at least one non-empty text layer was selected.
 */
export function selectAllInside(container: HTMLElement | null): boolean {
  if (!container || typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }

  const rawLayers = container.classList.contains('textLayer')
    ? [container]
    : Array.from(container.querySelectorAll<HTMLElement>('.textLayer'));

  const textLayers = rawLayers.filter(
    (layer) => layer.childNodes.length > 0 && (layer.textContent?.length ?? 0) > 0,
  );
  if (textLayers.length === 0) return false;

  const selection = window.getSelection();
  if (!selection) return false;

  const firstLayer = textLayers[0];
  const lastLayer = textLayers[textLayers.length - 1];
  const range = document.createRange();

  if (textLayers.length === 1 && firstLayer === container) {
    range.selectNodeContents(firstLayer);
  } else {
    range.setStartBefore(firstLayer);
    range.setEndAfter(lastLayer);
  }

  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Writes raw RGBA pixel data (or a PNG blob in browser mode) to the system clipboard.
 */
export async function copyRgbaImageToClipboard(
  rgba: Uint8Array,
  width: number,
  height: number,
  pngBlob?: Blob | null,
): Promise<void> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('Invalid image dimensions for clipboard copy.');
  }
  if (rgba.byteLength !== width * height * 4) {
    throw new Error('Image RGBA buffer size does not match width and height.');
  }

  if (isTauri()) {
    const img = await TauriImage.new(rgba, width, height);
    try {
      await writeImage(img);
    } finally {
      await img.close().catch(() => {});
    }
    return;
  }

  if (
    pngBlob &&
    typeof navigator !== 'undefined' &&
    navigator.clipboard?.write &&
    typeof ClipboardItem !== 'undefined'
  ) {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    return;
  }

  throw new Error('Image clipboard access is unavailable in this browser context.');
}

async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  if (isTauri()) {
    return null;
  }
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

async function copyOffscreenCanvasToClipboard(offscreen: HTMLCanvasElement): Promise<void> {
  const ctx = offscreen.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to create 2D canvas context for image copy.');
  }

  const imageData = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
  const rgba = new Uint8Array(imageData.data);
  const pngBlob = await canvasToPngBlob(offscreen);
  await copyRgbaImageToClipboard(rgba, offscreen.width, offscreen.height, pngBlob);
}

/**
 * Copies a full canvas or a clamped crop region of `canvas` to the system clipboard.
 */
export async function canvasRegionToClipboardImage(
  canvas: HTMLCanvasElement,
  sx = 0,
  sy = 0,
  sw = canvas.width,
  sh = canvas.height,
): Promise<void> {
  if (canvas.width <= 0 || canvas.height <= 0) {
    throw new Error('Canvas has no rendered image data to copy.');
  }

  const startX = Math.max(0, Math.min(canvas.width - 1, Math.floor(sx)));
  const startY = Math.max(0, Math.min(canvas.height - 1, Math.floor(sy)));
  const endX = Math.max(startX + 1, Math.min(canvas.width, Math.ceil(sx + sw)));
  const endY = Math.max(startY + 1, Math.min(canvas.height, Math.ceil(sy + sh)));
  const cropW = Math.max(1, endX - startX);
  const cropH = Math.max(1, endY - startY);

  const offscreen = document.createElement('canvas');
  offscreen.width = cropW;
  offscreen.height = cropH;
  const ctx = offscreen.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to create 2D canvas context for image copy.');
  }

  ctx.drawImage(canvas, startX, startY, cropW, cropH, 0, 0, cropW, cropH);
  await copyOffscreenCanvasToClipboard(offscreen);
}

/**
 * Rasterizes an `HTMLImageElement` onto an offscreen canvas and copies it to the clipboard.
 */
export async function imageElementToClipboardImage(img: HTMLImageElement): Promise<void> {
  if (!img.complete || (img.naturalWidth <= 0 && img.clientWidth <= 0)) {
    throw new Error('Image is not fully loaded yet.');
  }

  const width = img.naturalWidth > 0 ? img.naturalWidth : Math.max(img.clientWidth, 1) * 2;
  const height = img.naturalHeight > 0 ? img.naturalHeight : Math.max(img.clientHeight, 1) * 2;

  const offscreen = document.createElement('canvas');
  offscreen.width = Math.max(1, Math.round(width));
  offscreen.height = Math.max(1, Math.round(height));
  const ctx = offscreen.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to create 2D canvas context for image copy.');
  }

  ctx.drawImage(img, 0, 0, offscreen.width, offscreen.height);
  await copyOffscreenCanvasToClipboard(offscreen);
}
