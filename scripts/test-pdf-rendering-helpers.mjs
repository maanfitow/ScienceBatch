import assert from 'node:assert';
import { renderPdfPagesSequentially } from '../src/components/pdfRenderingHelpers.ts';

class MockCanvas {
  width = 0;
  height = 0;
  style = { width: '', height: '', position: '', left: '', top: '', visibility: '', zIndex: '' };
  parent = null;
  _scale = 0;
  fillStyle = '';

  getContext(type) {
    if (type !== '2d') return null;
    return {
      canvas: this,
      set fillStyle(value) { this.canvas.fillStyle = value; },
      get fillStyle() { return this.canvas.fillStyle; },
      fillRect() {},
    };
  }

  remove() {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

class MockElement {
  id = '';
  className = '';
  children = [];
  parent = null;
  style = { transform: '', width: '', height: '', position: '', zIndex: '' };

  get ownerDocument() {
    return mockDocument;
  }

  querySelector(selector) {
    if (selector === 'canvas') return this.children.find((item) => item instanceof MockCanvas) ?? null;
    if (selector.startsWith('#')) return this.children.find((item) => item.id === selector.slice(1)) ?? null;
    return null;
  }

  querySelectorAll(selector) {
    if (selector === '.pdf-page-wrapper') {
      return this.children.filter((item) => item.className === 'pdf-page-wrapper');
    }
    return [];
  }

  appendChild(child) {
    if (child.parent) child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }

  replaceChild(next, previous) {
    if (next.parent) next.remove();
    const index = this.children.indexOf(previous);
    if (index < 0) throw new Error('Cannot replace a child that is not attached');
    next.parent = this;
    previous.parent = null;
    this.children[index] = next;
    return previous;
  }

  remove() {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

const mockDocument = {
  createElement(tag) {
    return tag === 'canvas' ? new MockCanvas() : new MockElement();
  },
};

globalThis.document = mockDocument;

function createMockPdfDocument({
  numPages = 3,
  baseWidth = 595.28,
  baseHeight = 841.89,
  renderDelayMs = 10,
  failPageNum = null,
  onRenderStart = () => {},
} = {}) {
  return {
    numPages,
    async getPage(pageNum) {
      if (pageNum < 1 || pageNum > numPages) throw new Error(`Page ${pageNum} out of bounds`);
      return {
        getViewport({ scale }) {
          return { width: baseWidth * scale, height: baseHeight * scale };
        },
        render({ canvasContext, viewport }) {
          const canvas = canvasContext.canvas;
          onRenderStart(pageNum, canvas);
          let cancelled = false;
          let rejectPromise;
          const promise = new Promise((resolve, reject) => {
            rejectPromise = reject;
            setTimeout(() => {
              if (cancelled) {
                const error = new Error('Rendering cancelled');
                error.name = 'RenderingCancelledException';
                reject(error);
              } else if (failPageNum === pageNum) {
                reject(new Error(`Simulated failure on page ${pageNum}`));
              } else {
                canvas._scale = viewport.scale;
                resolve();
              }
            }, renderDelayMs);
          });
          return {
            promise,
            cancel() {
              if (cancelled) return;
              cancelled = true;
              const error = new Error('Rendering cancelled');
              error.name = 'RenderingCancelledException';
              rejectPromise(error);
            },
          };
        },
      };
    },
  };
}

async function render(container, pdfDoc, options = {}) {
  return renderPdfPagesSequentially({
    pdfDoc,
    pagesContainer: container,
    scale: options.scale ?? 1,
    pixelRatio: options.pixelRatio ?? 1,
    isCancelled: options.isCancelled ?? (() => false),
    registerRenderTask: options.registerRenderTask,
    unregisterRenderTask: options.unregisterRenderTask,
    createCanvas: options.createCanvas ?? (() => new MockCanvas()),
  });
}

function wrappers(container) {
  return container.querySelectorAll('.pdf-page-wrapper');
}

async function runAllTests() {
  console.log('=== Running PDF rendering helper tests ===');

  // Canvas dimensions round up, while CSS dimensions retain the logical fraction.
  {
    const container = new MockElement();
    const outcome = await render(container, createMockPdfDocument({ numPages: 1, baseWidth: 595.2755 }), {
      scale: 0.7,
      pixelRatio: 1.25,
    });
    assert(outcome.success);
    const canvas = wrappers(container)[0].querySelector('canvas');
    const expectedWidth = 595.2755 * 0.7;
    assert.strictEqual(canvas.width, Math.ceil(expectedWidth * 1.25));
    assert(Math.abs(parseFloat(canvas.style.width) - expectedWidth) < 1e-4);
    console.log('  [PASS] Backing dimensions round up and CSS dimensions remain fractional.');
  }

  // A prior canvas stays visible until its replacement finishes; only one new canvas is staged at a time.
  {
    const container = new MockElement();
    let peakStagingCanvases = 0;
    const doc = createMockPdfDocument({
      numPages: 4,
      onRenderStart(_pageNum, canvas) {
        assert.strictEqual(canvas.style.visibility, 'visible');
        assert(canvas.parent, 'Staging canvas must be attached while PDF.js renders it');
        const stagingCount = wrappers(container).flatMap((wrapper) => wrapper.children)
          .filter((child) => child instanceof MockCanvas && child.style.position === 'absolute').length;
        peakStagingCanvases = Math.max(peakStagingCanvases, stagingCount);
      },
    });
    const outcome = await render(container, doc);
    assert(outcome.success);
    assert.strictEqual(peakStagingCanvases, 1);
    assert.strictEqual(wrappers(container).length, 4);
    assert(wrappers(container).every((wrapper) => wrapper.querySelector('canvas')?.style.position === 'static'));
    console.log('  [PASS] Visible attached staging is layered under the old page and bounded to one extra canvas.');
  }

  // On zoom cancellation, the old page stays intact and unfinished staging canvas is discarded.
  {
    const container = new MockElement();
    const doc = createMockPdfDocument({ numPages: 1, renderDelayMs: 5 });
    assert((await render(container, doc, { scale: 1 })).success);
    const oldCanvas = wrappers(container)[0].querySelector('canvas');
    let activeTask;
    let staged;
    let taskRegisteredResolve;
    const taskRegistered = new Promise((resolve) => {
      taskRegisteredResolve = resolve;
    });
    let cancelled = false;
    const nextRender = render(container, doc, {
      scale: 1.5,
      registerRenderTask(task) {
        activeTask = task;
        taskRegisteredResolve();
      },
      createCanvas() {
        staged = new MockCanvas();
        return staged;
      },
      isCancelled: () => cancelled,
    });
    await taskRegistered;
    cancelled = true;
    activeTask?.cancel();
    const outcome = await nextRender;
    assert.strictEqual(outcome.cancelled, true);
    assert.strictEqual(wrappers(container)[0].querySelector('canvas'), oldCanvas);
    assert.strictEqual(staged.parent, null);
    assert.strictEqual(oldCanvas.style.position, 'static');
    assert.strictEqual(oldCanvas.style.zIndex, '');
    console.log('  [PASS] Cancelled zoom preserves the last complete canvas and removes its staging canvas.');
  }

  // A render error keeps the old page and reports the error instead of replacing it with a blank canvas.
  {
    const container = new MockElement();
    const doc = createMockPdfDocument({ numPages: 1 });
    assert((await render(container, doc, { scale: 1 })).success);
    const oldCanvas = wrappers(container)[0].querySelector('canvas');
    const failed = await render(container, createMockPdfDocument({ numPages: 1, failPageNum: 1 }), { scale: 2 });
    assert.strictEqual(failed.success, false);
    assert.match(String(failed.error), /Simulated failure/);
    assert.strictEqual(wrappers(container)[0].querySelector('canvas'), oldCanvas);
    assert.strictEqual(wrappers(container)[0].children.length, 1);
    assert.strictEqual(oldCanvas.style.position, 'static');
    assert.strictEqual(oldCanvas.style.zIndex, '');
    console.log('  [PASS] Failed zoom render reports the error and leaves the existing page visible.');
  }

  // Completed pages are committed before the next page starts, preventing full-document staging.
  {
    const container = new MockElement();
    const starts = [];
    const doc = createMockPdfDocument({
      numPages: 3,
      onRenderStart(pageNum) {
        starts.push(pageNum);
        if (pageNum > 1) {
          assert(wrappers(container)[pageNum - 2].querySelector('canvas'), `Page ${pageNum - 1} should already be committed`);
        }
      },
    });
    const outcome = await render(container, doc);
    assert(outcome.success);
    assert.deepStrictEqual(starts, [1, 2, 3]);
    assert.strictEqual(outcome.renderedPages, 3);
    console.log('  [PASS] Pages commit sequentially before rendering proceeds.');
  }

  console.log('=== All PDF rendering helper tests passed ===');
}

runAllTests().catch((error) => {
  console.error('[FAIL] PDF rendering helper tests failed:', error);
  process.exit(1);
});
