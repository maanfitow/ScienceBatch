import * as pdfjsLib from 'pdfjs-dist';

const IMAGE_HIT_TOLERANCE_PT = 2;
const MIN_IMAGE_DIMENSION_PT = 2;

export interface PdfImageRect {
  xPt: number;
  yPt: number;
  wPt: number;
  hPt: number;
}

export interface PdfOpsLike {
  save: number;
  restore: number;
  transform: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageXObjectRepeat: number;
  paintImageMaskXObjectRepeat: number;
  paintFormXObjectBegin?: number;
  paintFormXObjectEnd?: number;
}

const pageImageRectsCache = new WeakMap<pdfjsLib.PDFPageProxy, Promise<PdfImageRect[]>>();

function isMatrix6(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function multiplyMatrix(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function transformPoint(m: number[], x: number, y: number): [number, number] {
  return [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ];
}

function unitSquareToRect(matrix: number[]): PdfImageRect | null {
  const corners: Array<[number, number]> = [
    transformPoint(matrix, 0, 0),
    transformPoint(matrix, 1, 0),
    transformPoint(matrix, 0, 1),
    transformPoint(matrix, 1, 1),
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [cx, cy] of corners) {
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      return null;
    }
    if (cx < minX) minX = cx;
    if (cy < minY) minY = cy;
    if (cx > maxX) maxX = cx;
    if (cy > maxY) maxY = cy;
  }

  const wPt = maxX - minX;
  const hPt = maxY - minY;
  if (wPt < MIN_IMAGE_DIMENSION_PT || hPt < MIN_IMAGE_DIMENSION_PT) {
    return null;
  }

  return { xPt: minX, yPt: minY, wPt, hPt };
}

function isImagePaintOp(fn: number, ops: PdfOpsLike): boolean {
  return (
    fn === ops.paintImageXObject ||
    fn === ops.paintInlineImageXObject ||
    fn === ops.paintImageXObjectRepeat ||
    fn === ops.paintImageMaskXObjectRepeat
  );
}

/**
 * Walks a PDF.js operator list and extracts top-left PDF point bounding boxes
 * for all painted image XObjects and inline images.
 */
export function extractPdfImageRectsFromOps(
  fnArray: number[],
  argsArray: unknown[],
  baseViewportTransform: number[],
  ops: PdfOpsLike,
): PdfImageRect[] {
  if (!isMatrix6(baseViewportTransform)) {
    return [];
  }

  const rects: PdfImageRect[] = [];
  const stack: number[][] = [];
  let ctm = [1, 0, 0, 1, 0, 0];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const arg = argsArray[i];

    if (fn === ops.save) {
      stack.push(ctm.slice());
    } else if (fn === ops.restore) {
      const previous = stack.pop();
      if (previous) {
        ctm = previous;
      }
    } else if (fn === ops.transform) {
      if (isMatrix6(arg)) {
        ctm = multiplyMatrix(ctm, arg);
      }
    } else if (ops.paintFormXObjectBegin !== undefined && fn === ops.paintFormXObjectBegin) {
      stack.push(ctm.slice());
      const formMatrix = Array.isArray(arg) ? arg[0] : null;
      if (isMatrix6(formMatrix)) {
        ctm = multiplyMatrix(ctm, formMatrix);
      }
    } else if (ops.paintFormXObjectEnd !== undefined && fn === ops.paintFormXObjectEnd) {
      const previous = stack.pop();
      if (previous) {
        ctm = previous;
      }
    } else if (isImagePaintOp(fn, ops)) {
      const combined = multiplyMatrix(baseViewportTransform, ctm);
      const rect = unitSquareToRect(combined);
      if (rect) {
        rects.push(rect);
      }
    }
  }

  return rects;
}

/**
 * Returns the smallest-area image rectangle containing `(xPt, yPt)` within 2 pt tolerance.
 */
export function findPdfImageAtPoint(
  rects: PdfImageRect[],
  xPt: number,
  yPt: number,
): PdfImageRect | null {
  let best: PdfImageRect | null = null;
  let bestArea = Infinity;

  for (const rect of rects) {
    const inside =
      xPt >= rect.xPt - IMAGE_HIT_TOLERANCE_PT &&
      xPt <= rect.xPt + rect.wPt + IMAGE_HIT_TOLERANCE_PT &&
      yPt >= rect.yPt - IMAGE_HIT_TOLERANCE_PT &&
      yPt <= rect.yPt + rect.hPt + IMAGE_HIT_TOLERANCE_PT;

    if (!inside) continue;

    const area = rect.wPt * rect.hPt;
    if (area < bestArea) {
      best = rect;
      bestArea = area;
    }
  }

  return best;
}

/**
 * Extracts and caches painted image rectangles for a PDF.js page proxy.
 */
export function getPageImageRects(page: pdfjsLib.PDFPageProxy): Promise<PdfImageRect[]> {
  const cached = pageImageRectsCache.get(page);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const [opList, viewport] = await Promise.all([
      page.getOperatorList(),
      Promise.resolve(page.getViewport({ scale: 1 })),
    ]);
    return extractPdfImageRectsFromOps(
      opList.fnArray,
      opList.argsArray,
      viewport.transform,
      pdfjsLib.OPS,
    );
  })().catch((err) => {
    pageImageRectsCache.delete(page);
    throw err;
  });

  pageImageRectsCache.set(page, promise);
  return promise;
}

/**
 * Crops an embedded PDF image region from a rendered page canvas and copies it to the clipboard.
 */
export async function copyPdfImageRegionFromCanvas(
  canvas: HTMLCanvasElement,
  rect: PdfImageRect,
  pageWidthPt: number,
  pageHeightPt: number,
): Promise<void> {
  if (pageWidthPt <= 0 || pageHeightPt <= 0 || canvas.width <= 0 || canvas.height <= 0) {
    throw new Error('Invalid PDF page dimensions for image copy.');
  }

  const scaleX = canvas.width / pageWidthPt;
  const scaleY = canvas.height / pageHeightPt;
  const { canvasRegionToClipboardImage } = await import('./pdfClipboard');

  await canvasRegionToClipboardImage(
    canvas,
    rect.xPt * scaleX,
    rect.yPt * scaleY,
    rect.wPt * scaleX,
    rect.hPt * scaleY,
  );
}
