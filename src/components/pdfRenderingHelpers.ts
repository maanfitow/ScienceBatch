import * as pdfjsLib from 'pdfjs-dist';

export interface RenderPagesOptions {
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  pagesContainer: HTMLElement;
  scale: number;
  pixelRatio: number;
  isCancelled: () => boolean;
  onFirstPageDimensions?: (width: number, height: number) => void;
  registerRenderTask?: (task: pdfjsLib.RenderTask) => void;
  unregisterRenderTask?: (task: pdfjsLib.RenderTask) => void;
  createCanvas?: () => HTMLCanvasElement;
}

export interface RenderPagesOutcome {
  success: boolean;
  cancelled: boolean;
  error?: unknown;
  renderedPages: number;
}

/**
 * Renders pages in order and commits each finished page before starting the next.
 * An attached staging canvas renders underneath the current page until it is
 * complete, while bounding extra canvas memory to one page.
 */
export async function renderPdfPagesSequentially(
  options: RenderPagesOptions
): Promise<RenderPagesOutcome> {
  const {
    pdfDoc,
    pagesContainer,
    scale,
    pixelRatio,
    isCancelled,
    onFirstPageDimensions,
    registerRenderTask,
    unregisterRenderTask,
    createCanvas = () => document.createElement('canvas'),
  } = options;

  let renderedPages = 0;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    if (isCancelled()) {
      return { success: false, cancelled: true, renderedPages };
    }

    let stagingCanvas: HTMLCanvasElement | null = null;
    let renderTask: pdfjsLib.RenderTask | null = null;
    let wrapper: HTMLDivElement | null = null;
    let currentCanvas: HTMLCanvasElement | null = null;
    let previousCurrentCanvasPosition = '';
    let previousCurrentCanvasZIndex = '';

    try {
      const page = await pdfDoc.getPage(pageNum);
      if (isCancelled()) {
        return { success: false, cancelled: true, renderedPages };
      }

      if (pageNum === 1 && onFirstPageDimensions) {
        const unscaledViewport = page.getViewport({ scale: 1.0 });
        onFirstPageDimensions(unscaledViewport.width, unscaledViewport.height);
      }

      const viewport = page.getViewport({ scale: scale * pixelRatio });
      const logicalWidth = viewport.width / pixelRatio;
      const logicalHeight = viewport.height / pixelRatio;

      wrapper = pagesContainer.querySelector<HTMLDivElement>(`#pdf-page-${pageNum}`);
      if (!wrapper) {
        wrapper = pagesContainer.ownerDocument.createElement('div');
        wrapper.id = `pdf-page-${pageNum}`;
        wrapper.className = 'pdf-page-wrapper';
        pagesContainer.appendChild(wrapper);
      }

      currentCanvas = wrapper.querySelector('canvas');
      if (!currentCanvas) {
        wrapper.style.width = `${logicalWidth}px`;
        wrapper.style.height = `${logicalHeight}px`;
      } else {
        previousCurrentCanvasPosition = currentCanvas.style.position;
        previousCurrentCanvasZIndex = currentCanvas.style.zIndex;
        currentCanvas.style.position = 'relative';
        currentCanvas.style.zIndex = '1';
      }
      wrapper.style.position = 'relative';

      stagingCanvas = createCanvas();
      stagingCanvas.width = Math.ceil(viewport.width);
      stagingCanvas.height = Math.ceil(viewport.height);
      stagingCanvas.style.width = `${logicalWidth}px`;
      stagingCanvas.style.height = `${logicalHeight}px`;
      stagingCanvas.style.position = 'absolute';
      stagingCanvas.style.left = '0';
      stagingCanvas.style.top = '0';
      stagingCanvas.style.zIndex = currentCanvas ? '0' : '';
      stagingCanvas.style.visibility = 'visible';
      wrapper.appendChild(stagingCanvas);

      const context = stagingCanvas.getContext('2d', { alpha: false });
      if (!context) {
        throw new Error(`Failed to obtain 2D context for page ${pageNum}`);
      }

      context.fillStyle = '#FFFFFF';
      context.fillRect(0, 0, stagingCanvas.width, stagingCanvas.height);

      renderTask = page.render({ canvasContext: context, viewport });
      registerRenderTask?.(renderTask);
      await renderTask.promise;

      if (isCancelled()) {
        stagingCanvas.remove();
        if (currentCanvas) {
          currentCanvas.style.position = previousCurrentCanvasPosition;
          currentCanvas.style.zIndex = previousCurrentCanvasZIndex;
        }
        return { success: false, cancelled: true, renderedPages };
      }

      stagingCanvas.style.position = 'static';
      stagingCanvas.style.left = '';
      stagingCanvas.style.top = '';
      stagingCanvas.style.zIndex = '';
      stagingCanvas.style.visibility = 'visible';
      wrapper.style.width = `${logicalWidth}px`;
      wrapper.style.height = `${logicalHeight}px`;

      if (currentCanvas) {
        wrapper.replaceChild(stagingCanvas, currentCanvas);
      }

      renderedPages++;
    } catch (error: unknown) {
      stagingCanvas?.remove();
      if (currentCanvas) {
        currentCanvas.style.position = previousCurrentCanvasPosition;
        currentCanvas.style.zIndex = previousCurrentCanvasZIndex;
      }
      const isRenderCancellation =
        isCancelled() ||
        (error && typeof error === 'object' && 'name' in error &&
          (error as { name: string }).name === 'RenderingCancelledException');

      if (isRenderCancellation) {
        return { success: false, cancelled: true, renderedPages };
      }

      return { success: false, cancelled: false, error, renderedPages };
    } finally {
      if (renderTask) {
        unregisterRenderTask?.(renderTask);
      }
    }
  }

  if (isCancelled()) {
    return { success: false, cancelled: true, renderedPages };
  }

  const wrappers = pagesContainer.querySelectorAll<HTMLDivElement>('.pdf-page-wrapper');
  wrappers.forEach((pageWrapper) => {
    const match = pageWrapper.id.match(/^pdf-page-(\d+)$/);
    if (match && Number(match[1]) > pdfDoc.numPages) {
      pageWrapper.remove();
    }
  });

  pagesContainer.style.transform = 'none';
  return { success: true, cancelled: false, renderedPages };
}
