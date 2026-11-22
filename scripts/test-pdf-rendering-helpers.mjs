import assert from 'node:assert';
import {
  createPdfLinkService,
  renderPageAnnotationLayer,
  renderPdfPagesSequentially,
} from '../src/components/pdfRenderingHelpers.ts';

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

class MockStyle {
  transform = '';
  width = '';
  height = '';
  position = '';
  zIndex = '';
  props = {};

  setProperty(name, value) {
    this.props[name] = value;
  }
}

class MockElement {
  id = '';
  className = '';
  tagName = 'div';
  href = '';
  rel = '';
  title = '';
  dataset = {};
  children = [];
  parent = null;
  style = new MockStyle();

  constructor(tagName = 'div') {
    this.tagName = tagName.toLowerCase();
  }

  get childNodes() {
    return this.children;
  }

  get ownerDocument() {
    return mockDocument;
  }

  removeAttribute(name) {
    if (name === 'href') this.href = '';
  }

  querySelector(selector) {
    if (selector === 'canvas') return this.children.find((item) => item instanceof MockCanvas) ?? null;
    if (selector === '.textLayer') return this.children.find((item) => item.className === 'textLayer') ?? null;
    if (selector === '.annotationLayer') return this.children.find((item) => item.className === 'annotationLayer') ?? null;
    if (selector.startsWith('#')) return this.children.find((item) => item.id === selector.slice(1)) ?? null;
    return null;
  }

  querySelectorAll(selector) {
    if (selector === '.pdf-page-wrapper') {
      return this.children.filter((item) => item.className === 'pdf-page-wrapper');
    }
    if (selector === 'a[href^="#"]') {
      const results = [];
      const visit = (node) => {
        for (const child of node.children ?? []) {
          if (child.tagName === 'a' && typeof child.href === 'string' && child.href.startsWith('#')) {
            results.push(child);
          }
          visit(child);
        }
      };
      visit(this);
      return results;
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

  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    for (const node of nodes) this.appendChild(node);
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
    return tag === 'canvas' ? new MockCanvas() : new MockElement(tag);
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
          return { width: baseWidth * scale, height: baseHeight * scale, scale };
        },
        streamTextContent() {
          return { pageNum };
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
    enableTextLayer: options.enableTextLayer,
    registerTextLayerTask: options.registerTextLayerTask,
    unregisterTextLayerTask: options.unregisterTextLayerTask,
    createTextLayer: options.createTextLayer,
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

  // enableTextLayer builds a staging .textLayer at logical scale, replaces prior layers, and preserves prior layers on cancel.
  {
    const container = new MockElement();
    const doc = createMockPdfDocument({ numPages: 1, renderDelayMs: 2 });
    const createMockTextLayer = ({ delayMs = 5, onStart = () => {} } = {}) => {
      return ({ container: textContainer, viewport }) => {
        onStart(textContainer, viewport);
        let aborted = false;
        let rejectFn;
        return {
          render() {
            return new Promise((resolve, reject) => {
              rejectFn = reject;
              setTimeout(() => {
                if (aborted) {
                  const err = new Error('TextLayer task cancelled.');
                  err.name = 'AbortException';
                  reject(err);
                } else {
                  const span = mockDocument.createElement('span');
                  span.id = `scale-${viewport.scale}`;
                  textContainer.appendChild(span);
                  resolve();
                }
              }, delayMs);
            });
          },
          cancel() {
            if (aborted) return;
            aborted = true;
            const err = new Error('TextLayer task cancelled.');
            err.name = 'AbortException';
            rejectFn?.(err);
          },
        };
      };
    };

    const first = await render(container, doc, {
      scale: 1,
      pixelRatio: 2,
      enableTextLayer: true,
      createTextLayer: createMockTextLayer({
        onStart(_textContainer, viewport) {
          assert.strictEqual(viewport.scale, 1, 'TextLayer must use logical CSS scale, not pixelRatio');
        },
      }),
    });
    assert(first.success);
    const wrapper = wrappers(container)[0];
    assert.strictEqual(wrapper.style.props['--scale-factor'], '1');
    const initialTextLayer = wrapper.querySelector('.textLayer');
    assert(initialTextLayer, 'Initial textLayer should be attached');
    assert.strictEqual(initialTextLayer.style.zIndex, '2');
    assert.strictEqual(initialTextLayer.children[0].id, 'scale-1');

    // Re-render at zoom 1.5 and cancel mid-textLayer: prior .textLayer must remain intact
    let activeTextTask = null;
    let textRegisteredResolve;
    const textRegistered = new Promise((resolve) => {
      textRegisteredResolve = resolve;
    });
    let cancelled = false;
    const cancelledZoom = render(container, doc, {
      scale: 1.5,
      pixelRatio: 2,
      enableTextLayer: true,
      isCancelled: () => cancelled,
      registerTextLayerTask(task) {
        activeTextTask = task;
        textRegisteredResolve();
      },
      createTextLayer: createMockTextLayer({ delayMs: 25 }),
    });
    await textRegistered;
    cancelled = true;
    activeTextTask.cancel();
    const cancelledOutcome = await cancelledZoom;
    assert.strictEqual(cancelledOutcome.cancelled, true);
    assert.strictEqual(wrapper.querySelector('.textLayer'), initialTextLayer);

    // Complete zoom 2.0: replaces prior .textLayer and keeps exactly one committed canvas
    const canvasBefore = wrapper.querySelector('canvas');
    const second = await render(container, doc, {
      scale: 2,
      pixelRatio: 2,
      enableTextLayer: true,
      createTextLayer: createMockTextLayer(),
    });
    assert(second.success);
    const updatedTextLayer = wrapper.querySelector('.textLayer');
    const updatedCanvas = wrapper.querySelector('canvas');
    assert.notStrictEqual(updatedTextLayer, initialTextLayer);
    assert.strictEqual(updatedTextLayer.children[0].id, 'scale-2');
    assert.strictEqual(wrapper.style.props['--scale-factor'], '2');
    assert(updatedCanvas && updatedCanvas !== canvasBefore);
    assert.strictEqual(updatedCanvas._scale, 4);
    assert.strictEqual(wrapper.children.length, 2);
    console.log('  [PASS] TextLayer renders at logical scale, replaces cleanly, and keeps single committed canvas.');
  }

  // createPdfLinkService validates external URLs and resolves internal destinations.
  {
    const jumpedPages = [];
    const mockPdfDoc = {
      numPages: 5,
      async getDestination(name) {
        return name === 'sec:intro' ? [{ num: 42 }, { name: 'XYZ' }] : null;
      },
      async getPageIndex(ref) {
        return ref.num === 42 ? 2 : 0;
      },
    };
    const linkService = createPdfLinkService(mockPdfDoc, {
      onInternalDestination: (pageNum) => jumpedPages.push(pageNum),
      linkTitlePrefix: 'Ctrl+Click to follow link',
    });

    const validAnchor = mockDocument.createElement('a');
    linkService.addLinkAttributes(validAnchor, 'https://example.org/paper');
    assert.strictEqual(validAnchor.href, 'https://example.org/paper');
    assert.strictEqual(validAnchor.rel, 'noopener noreferrer');
    assert.strictEqual(validAnchor.dataset.pdfExternalUrl, 'https://example.org/paper');
    assert.strictEqual(validAnchor.title, 'Ctrl+Click to follow link (https://example.org/paper)');

    const blockedAnchor = mockDocument.createElement('a');
    linkService.addLinkAttributes(blockedAnchor, 'javascript:alert(1)');
    assert.strictEqual(blockedAnchor.href, '');
    assert.strictEqual(blockedAnchor.dataset.pdfExternalUrl, undefined);

    await linkService.goToDestination('sec:intro');
    await linkService.goToDestination([3, { name: 'Fit' }]);
    linkService.goToPage(5);
    assert.deepStrictEqual(jumpedPages, [3, 4, 5]);
    console.log('  [PASS] createPdfLinkService filters unsafe URLs and resolves internal destinations.');
  }

  // renderPageAnnotationLayer renders links at logical scale, sets internal titles, replaces and cleans up.
  {
    const wrapper = new MockElement('div');
    wrapper.className = 'pdf-page-wrapper';
    let currentAnnotations = [{ id: '1R', subtype: 'Link' }];
    const page = {
      getViewport({ scale }) {
        return { width: 500 * scale, height: 700 * scale, scale };
      },
      async getAnnotations() {
        return currentAnnotations;
      },
    };
    const linkService = createPdfLinkService({ numPages: 2 }, {
      onInternalDestination: () => {},
      linkTitlePrefix: 'Ctrl+Click to follow link',
    });

    const createMockAnnotationLayer = () => ({
      async render({ div }) {
        const section = mockDocument.createElement('section');
        const internalLink = mockDocument.createElement('a');
        internalLink.href = '#sec1';
        section.appendChild(internalLink);
        div.appendChild(section);
      },
    });

    const first = await renderPageAnnotationLayer({
      page,
      wrapper,
      scale: 1.5,
      isCancelled: () => false,
      linkService,
      linkTitlePrefix: 'Ctrl+Click to follow link',
      createAnnotationLayer: createMockAnnotationLayer,
    });
    assert.strictEqual(first.cancelled, false);
    const layer1 = wrapper.querySelector('.annotationLayer');
    assert(layer1, 'AnnotationLayer should be attached');
    assert.strictEqual(layer1.style.zIndex, '3');
    assert.strictEqual(layer1.style.props['--scale-factor'], '1.5');
    assert.strictEqual(layer1.querySelectorAll('a[href^="#"]')[0].title, 'Ctrl+Click to follow link');

    // Empty annotations removes stale .annotationLayer
    currentAnnotations = [];
    const second = await renderPageAnnotationLayer({
      page,
      wrapper,
      scale: 1.5,
      isCancelled: () => false,
      linkService,
      createAnnotationLayer: createMockAnnotationLayer,
    });
    assert.strictEqual(second.cancelled, false);
    assert.strictEqual(wrapper.querySelector('.annotationLayer'), null);
    console.log('  [PASS] renderPageAnnotationLayer attaches z-index 3 layer, sets internal link titles, and removes stale layers.');
  }

  console.log('=== All PDF rendering helper tests passed ===');
}

runAllTests().catch((error) => {
  console.error('[FAIL] PDF rendering helper tests failed:', error);
  process.exit(1);
});
