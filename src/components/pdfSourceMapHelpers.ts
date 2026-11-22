import type { PdfSourceBox, PdfSourceMap } from '../types/compiler';

const CONTAINMENT_TOLERANCE_PT = 2;
const MAX_PROXIMITY_DISTANCE_PT = 24;

export interface PdfPoint {
  xPt: number;
  yPt: number;
}

export interface SourceHit {
  file: string;
  line: number;
  column?: number;
}

/**
 * Converts viewport client coordinates relative to a rendered PDF page's
 * bounding rect into PDF point coordinates using the page's display scale.
 */
export function clientPointToPdfPoint(
  rect: { left: number; top: number },
  clientX: number,
  clientY: number,
  scale: number,
): PdfPoint {
  if (!Number.isFinite(scale) || scale <= 0) {
    return { xPt: 0, yPt: 0 };
  }

  return {
    xPt: (clientX - rect.left) / scale,
    yPt: (clientY - rect.top) / scale,
  };
}

function boxArea(box: PdfSourceBox): number {
  return Math.max(0, box.w) * Math.max(0, box.h);
}

function levelRank(level: number): number {
  return level === 0 ? 0 : 1;
}

function containsPoint(box: PdfSourceBox, xPt: number, yPt: number, tolerance: number): boolean {
  return (
    xPt >= box.x - tolerance &&
    xPt <= box.x + box.w + tolerance &&
    yPt >= box.y - tolerance &&
    yPt <= box.y + box.h + tolerance
  );
}

function distanceToBox(box: PdfSourceBox, xPt: number, yPt: number): number {
  const dx = xPt < box.x ? box.x - xPt : xPt > box.x + box.w ? xPt - (box.x + box.w) : 0;
  const dy = yPt < box.y ? box.y - yPt : yPt > box.y + box.h ? yPt - (box.y + box.h) : 0;
  return Math.hypot(dx, dy);
}

function isPreferredContainingBox(candidate: PdfSourceBox, currentBest: PdfSourceBox): boolean {
  const candidateRank = levelRank(candidate.level);
  const bestRank = levelRank(currentBest.level);
  if (candidateRank !== bestRank) {
    return candidateRank < bestRank;
  }
  return boxArea(candidate) < boxArea(currentBest);
}

/**
 * Finds the best matching source location for a point `(xPt, yPt)` on `pageNum`.
 * Prefers level-0 containing boxes with smallest area, then level-1 containing
 * boxes, and falls back to the nearest box within 24 pt.
 */
export function findSourceLocation(
  sourceMap: PdfSourceMap | null | undefined,
  pageNum: number,
  xPt: number,
  yPt: number,
): SourceHit | null {
  if (!sourceMap || !Array.isArray(sourceMap.pages) || !Array.isArray(sourceMap.files)) {
    return null;
  }

  const page = sourceMap.pages.find((entry) => entry.page === pageNum);
  if (!page || !Array.isArray(page.boxes) || page.boxes.length === 0) {
    return null;
  }

  let bestContaining: PdfSourceBox | null = null;
  for (const box of page.boxes) {
    const file = sourceMap.files[box.fileIdx];
    if (typeof file !== 'string') continue;
    if (!containsPoint(box, xPt, yPt, CONTAINMENT_TOLERANCE_PT)) continue;
    if (!bestContaining || isPreferredContainingBox(box, bestContaining)) {
      bestContaining = box;
    }
  }

  let selectedBox = bestContaining;

  if (!selectedBox) {
    let bestDistance = Infinity;
    for (const box of page.boxes) {
      const file = sourceMap.files[box.fileIdx];
      if (typeof file !== 'string') continue;
      const distance = distanceToBox(box, xPt, yPt);
      if (distance > MAX_PROXIMITY_DISTANCE_PT) continue;

      if (
        !selectedBox ||
        distance < bestDistance - 1e-6 ||
        (Math.abs(distance - bestDistance) <= 1e-6 && isPreferredContainingBox(box, selectedBox))
      ) {
        selectedBox = box;
        bestDistance = distance;
      }
    }
  }

  if (!selectedBox) {
    return null;
  }

  const file = sourceMap.files[selectedBox.fileIdx];
  if (typeof file !== 'string') {
    return null;
  }

  return {
    file,
    line: selectedBox.line,
    ...(selectedBox.column ? { column: selectedBox.column } : {}),
  };
}
