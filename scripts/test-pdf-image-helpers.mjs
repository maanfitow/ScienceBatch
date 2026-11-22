import assert from 'node:assert';
import {
  extractPdfImageRectsFromOps,
  findPdfImageAtPoint,
} from '../src/components/pdfImageHelpers.ts';

const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageXObjectRepeat: 88,
  paintImageMaskXObjectRepeat: 89,
};

function approxEqual(actual, expected, eps = 1e-6) {
  assert(
    Math.abs(actual - expected) <= eps,
    `Expected ${actual} to be within ${eps} of ${expected}`,
  );
}

console.log('=== Running PDF image helper tests ===');

// 1. save / transform / paintImageXObject / restore with top-left viewport transform
{
  const baseViewportTransform = [1, 0, 0, -1, 0, 792];
  const fnArray = [
    OPS.restore, // extra restore on empty stack should be ignored safely
    OPS.save,
    OPS.transform,
    OPS.paintImageXObject,
    OPS.restore,
    OPS.transform,
    OPS.paintInlineImageXObject,
  ];
  const argsArray = [
    [],
    [],
    [200, 0, 0, 100, 50, 500],
    ['Im0'],
    [],
    [80, 0, 0, 40, 300, 100],
    [{}],
  ];

  const rects = extractPdfImageRectsFromOps(fnArray, argsArray, baseViewportTransform, OPS);
  assert.strictEqual(rects.length, 2);

  approxEqual(rects[0].xPt, 50);
  approxEqual(rects[0].yPt, 192);
  approxEqual(rects[0].wPt, 200);
  approxEqual(rects[0].hPt, 100);

  approxEqual(rects[1].xPt, 300);
  approxEqual(rects[1].yPt, 652);
  approxEqual(rects[1].wPt, 80);
  approxEqual(rects[1].hPt, 40);
  console.log('  [PASS] save/restore/transform converts bottom-left PDF space to top-left points.');
}

// 2. paintFormXObjectBegin / paintFormXObjectEnd nesting and repeat/mask ops
{
  const baseViewportTransform = [1, 0, 0, -1, 0, 800];
  const fnArray = [
    OPS.save,
    OPS.transform,
    OPS.paintFormXObjectBegin,
    OPS.paintImageXObjectRepeat,
    OPS.paintFormXObjectEnd,
    OPS.paintImageMaskXObjectRepeat,
    OPS.restore,
  ];
  const argsArray = [
    [],
    [1, 0, 0, 1, 20, 40],
    [[120, 0, 0, 60, 10, 20], [0, 0, 1, 1]],
    ['Im1'],
    [],
    ['Mask1'],
    [],
  ];

  const rects = extractPdfImageRectsFromOps(fnArray, argsArray, baseViewportTransform, OPS);
  // First image inside form: x=20+10=30, yBottom=40+20=60, h=60 -> yTop=800-120=680
  // Second image after paintFormXObjectEnd: CTM restored to [1,0,0,1,20,40], w=1, h=1 -> filtered (< 2 pt)!
  assert.strictEqual(rects.length, 1);
  approxEqual(rects[0].xPt, 30);
  approxEqual(rects[0].yPt, 680);
  approxEqual(rects[0].wPt, 120);
  approxEqual(rects[0].hPt, 60);
  console.log('  [PASS] paintFormXObjectBegin/End scopes matrix and filters sub-2pt rects.');
}

// 3. findPdfImageAtPoint tolerance and smallest-area selection
{
  const outer = { xPt: 40, yPt: 40, wPt: 300, hPt: 200 };
  const inner = { xPt: 100, yPt: 80, wPt: 50, hPt: 40 };
  const rects = [outer, inner];

  assert.strictEqual(findPdfImageAtPoint([], 10, 10), null);
  assert.strictEqual(findPdfImageAtPoint(rects, 37, 50), null);
  assert.strictEqual(findPdfImageAtPoint(rects, 38.5, 50), outer); // within 2 pt tolerance
  assert.strictEqual(findPdfImageAtPoint(rects, 120, 100), inner); // smallest area
  assert.strictEqual(findPdfImageAtPoint(rects, 250, 150), outer);
  console.log('  [PASS] findPdfImageAtPoint respects 2 pt tolerance and smallest-area preference.');
}

console.log('=== All PDF image helper tests passed ===');
