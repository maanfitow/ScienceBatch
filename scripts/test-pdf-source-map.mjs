import assert from 'node:assert';
import { clientPointToPdfPoint, findSourceLocation } from '../src/components/pdfSourceMapHelpers.ts';

function runTests() {
  console.log('=== Running PDF source map helper tests ===');

  // 1. clientPointToPdfPoint maps client coordinates at arbitrary rect offsets and zoom scales
  {
    const pt = clientPointToPdfPoint({ left: 100, top: 50 }, 250, 200, 1.5);
    assert(Math.abs(pt.xPt - 100) < 1e-6);
    assert(Math.abs(pt.yPt - 100) < 1e-6);

    const zeroScale = clientPointToPdfPoint({ left: 10, top: 20 }, 50, 60, 0);
    assert.deepStrictEqual(zeroScale, { xPt: 0, yPt: 0 });
    console.log('  [PASS] clientPointToPdfPoint converts client coordinates accurately.');
  }

  const sampleSourceMap = {
    files: ['main.tex', 'sections/intro.tex'],
    pages: [
      {
        page: 1,
        widthPt: 595.28,
        heightPt: 841.89,
        boxes: [
          // Large block box (level 1)
          { x: 50, y: 100, w: 400, h: 120, fileIdx: 0, line: 10, level: 1 },
          // Finer span box (level 0) inside the block
          { x: 72, y: 110, w: 120, h: 14, fileIdx: 1, line: 24, column: 8, level: 0 },
          // Overlapping smaller level-0 box inside the previous span
          { x: 90, y: 112, w: 30, h: 10, fileIdx: 1, line: 25, column: 14, level: 0 },
          // Separate level-1 box used for proximity fallback tests
          { x: 100, y: 300, w: 80, h: 20, fileIdx: 0, line: 42, level: 1 },
          // Adjacent level-0 box at equal distance to (195, 310) -> distance 5 vs 15, or let's make an exact tie at (200, 310):
          // box1 ends at x=180 (dist 20), box2 starts at x=220 (dist 20)
          { x: 220, y: 300, w: 60, h: 20, fileIdx: 1, line: 50, column: 3, level: 0 },
        ],
      },
    ],
  };

  // 2. Null / missing source map and out-of-range page return null
  {
    assert.strictEqual(findSourceLocation(null, 1, 100, 115), null);
    assert.strictEqual(findSourceLocation(undefined, 1, 100, 115), null);
    assert.strictEqual(findSourceLocation(sampleSourceMap, 2, 100, 115), null);
    console.log('  [PASS] Missing sourceMap or out-of-range page returns null.');
  }

  // 3. Prefers level 0 over level 1 and picks smallest area among level-0 candidates
  {
    const hitInner = findSourceLocation(sampleSourceMap, 1, 100, 116);
    assert.deepStrictEqual(hitInner, {
      file: 'sections/intro.tex',
      line: 25,
      column: 14,
    });

    const hitOuterSpan = findSourceLocation(sampleSourceMap, 1, 75, 116);
    assert.deepStrictEqual(hitOuterSpan, {
      file: 'sections/intro.tex',
      line: 24,
      column: 8,
    });

    const hitBlockOnly = findSourceLocation(sampleSourceMap, 1, 300, 180);
    assert.deepStrictEqual(hitBlockOnly, {
      file: 'main.tex',
      line: 10,
    });
    assert(!('column' in hitBlockOnly), 'column should be omitted when absent');
    console.log('  [PASS] Containment prefers level 0 over level 1 and smallest box area.');
  }

  // 4. Containment tolerance (2 pt) catches clicks right at the edge
  {
    const hitEdge = findSourceLocation(sampleSourceMap, 1, 70.5, 116);
    assert.deepStrictEqual(hitEdge, {
      file: 'sections/intro.tex',
      line: 24,
      column: 8,
    });
    console.log('  [PASS] Containment tolerance (2 pt) matches near-boundary clicks.');
  }

  // 5. Proximity fallback within 24 pt prefers nearest box and breaks ties with level 0
  {
    // Equidistant (20 pt) from level-1 box (x=100..180) and level-0 box (x=220..280)
    const hitTie = findSourceLocation(sampleSourceMap, 1, 200, 310);
    assert.deepStrictEqual(hitTie, {
      file: 'sections/intro.tex',
      line: 50,
      column: 3,
    });

    // Nearest to level-1 box at (100, 330) -> distance 10 pt
    const hitNear = findSourceLocation(sampleSourceMap, 1, 120, 330);
    assert.deepStrictEqual(hitNear, {
      file: 'main.tex',
      line: 42,
    });

    // Beyond 24 pt max distance -> null
    const missFar = findSourceLocation(sampleSourceMap, 1, 120, 360);
    assert.strictEqual(missFar, null);
    console.log('  [PASS] Proximity fallback within 24 pt and tie-breaking work as expected.');
  }

  console.log('=== All PDF source map helper tests passed ===');
}

runTests();
