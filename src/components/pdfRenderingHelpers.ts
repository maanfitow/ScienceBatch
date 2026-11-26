import * as pdfjsLib from 'pdfjs-dist';

export interface TextLayerTask {
  cancel: () => void;
}

export type TextLayerConstructorParams = ConstructorParameters<typeof pdfjsLib.TextLayer>[0];

export interface TextLayerInstance {
  render: () => Promise<unknown>;
  cancel: () => void;
}

export type AnnotationLayerConstructorParams = ConstructorParameters<typeof pdfjsLib.AnnotationLayer>[0];
export type AnnotationLayerRenderParams = Parameters<pdfjsLib.AnnotationLayer['render']>[0];
export type PdfLinkService = AnnotationLayerRenderParams['linkService'];

export interface AnnotationLayerInstance {
  render: (params: AnnotationLayerRenderParams) => Promise<void>;
}

export interface CreatePdfLinkServiceOptions {
  onExternalLink?: (url: string) => void;
  onInternalDestination: (pageNum: number) => void;
  linkTitlePrefix?: string;
}

export interface PdfLinkServiceAdapter extends PdfLinkService {
  readonly externalLinkEnabled: boolean;
}

export interface RenderPageTextLayerOptions {
  page: pdfjsLib.PDFPageProxy;
  wrapper: HTMLElement;
  scale: number;
  isCancelled: () => boolean;
  targetContainer?: HTMLElement | null;
  registerTextLayerTask?: (task: TextLayerTask) => void;
  unregisterTextLayerTask?: (task: TextLayerTask) => void;
  createTextLayer?: (params: TextLayerConstructorParams) => TextLayerInstance;
}

export interface RenderPageAnnotationLayerOptions {
  page: pdfjsLib.PDFPageProxy;
  wrapper: HTMLElement;
  scale: number;
  isCancelled: () => boolean;
  linkService: PdfLinkService;
  linkTitlePrefix?: string;
  targetContainer?: HTMLElement | null;
  createAnnotationLayer?: (params: AnnotationLayerConstructorParams) => AnnotationLayerInstance;
}

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
  enableTextLayer?: boolean;
  registerTextLayerTask?: (task: TextLayerTask) => void;
  unregisterTextLayerTask?: (task: TextLayerTask) => void;
  createTextLayer?: (params: TextLayerConstructorParams) => TextLayerInstance;
  enableAnnotationLayer?: boolean;
  linkService?: PdfLinkService;
  linkTitlePrefix?: string;
  createAnnotationLayer?: (params: AnnotationLayerConstructorParams) => AnnotationLayerInstance;
}

export interface RenderPagesOutcome {
  success: boolean;
  cancelled: boolean;
  error?: unknown;
  renderedPages: number;
}

function isCancellationError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) {
    return false;
  }
  const name = (error as { name: string }).name;
  return name === 'AbortException' || name === 'RenderingCancelledException';
}

/**
 * Returns the platform-appropriate primary modifier key label (`Cmd` or `Ctrl`).
 */
export function getPdfModifierLabel(): 'Cmd' | 'Ctrl' {
  if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)) {
    return 'Cmd';
  }
  return 'Ctrl';
}

function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

/**
 * Creates a PDF.js `IPDFLinkService` adapter that validates external URLs and
 * resolves internal named/explicit destinations via `pdfDoc`.
 */
export function createPdfLinkService(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  options: CreatePdfLinkServiceOptions,
): PdfLinkServiceAdapter {
  const { onInternalDestination, linkTitlePrefix = `${getPdfModifierLabel()}+Click to follow link` } = options;
  let currentPage = 1;
  let currentRotation = 0;

  return {
    get pagesCount() {
      return pdfDoc.numPages;
    },
    get page() {
      return currentPage;
    },
    set page(value: number) {
      currentPage = value;
    },
    get rotation() {
      return currentRotation;
    },
    set rotation(value: number) {
      currentRotation = value;
    },
    get isInPresentationMode() {
      return false;
    },
    get externalLinkEnabled() {
      return true;
    },
    set externalLinkEnabled(_value: boolean) {
      // External links are always enabled and mediated by click handlers
    },
    addLinkAttributes(link: HTMLAnchorElement, url: string, _newWindow?: boolean) {
      if (!isAllowedExternalUrl(url)) {
        link.removeAttribute('href');
        delete link.dataset.pdfExternalUrl;
        return;
      }
      link.href = url;
      link.rel = 'noopener noreferrer';
      link.draggable = false;
      link.dataset.pdfExternalUrl = url;
      link.title = `${linkTitlePrefix} (${url})`;
    },
    getDestinationHash(dest: unknown): string {
      if (!dest) return '#';
      if (typeof dest === 'string') {
        return `#${encodeURIComponent(dest)}`;
      }
      return '#dest';
    },
    getAnchorUrl(hash: unknown): string {
      if (typeof hash === 'string' && hash.startsWith('#')) {
        return hash;
      }
      return hash ? `#${String(hash)}` : '#';
    },
    async goToDestination(dest: string | unknown[]): Promise<void> {
      try {
        const explicitDest =
          typeof dest === 'string'
            ? await pdfDoc.getDestination(dest)
            : Array.isArray(dest)
              ? dest
              : null;
        if (!explicitDest || explicitDest.length === 0) return;

        const targetRef = explicitDest[0];
        let pageIndex: number | null = null;
        if (typeof targetRef === 'object' && targetRef !== null) {
          pageIndex = await pdfDoc.getPageIndex(
            targetRef as Parameters<pdfjsLib.PDFDocumentProxy['getPageIndex']>[0],
          );
        } else if (typeof targetRef === 'number' && Number.isInteger(targetRef)) {
          pageIndex = targetRef;
        }

        if (pageIndex !== null && pageIndex >= 0 && pageIndex < pdfDoc.numPages) {
          onInternalDestination(pageIndex + 1);
        }
      } catch (err: unknown) {
        console.warn('Failed to navigate to PDF destination:', err);
      }
    },
    goToPage(val: number | string): void {
      const pageNum = typeof val === 'number' ? val : Number.parseInt(val, 10);
      if (Number.isInteger(pageNum) && pageNum >= 1 && pageNum <= pdfDoc.numPages) {
        onInternalDestination(pageNum);
      }
    },
    executeNamedAction(action: string): void {
      if (action === 'FirstPage') {
        onInternalDestination(1);
      } else if (action === 'LastPage') {
        onInternalDestination(pdfDoc.numPages);
      } else if (action === 'PrevPage') {
        onInternalDestination(Math.max(1, currentPage - 1));
      } else if (action === 'NextPage') {
        onInternalDestination(Math.min(pdfDoc.numPages, currentPage + 1));
      }
    },
    executeSetOCGState(_action: object): void {},
    setHash(_hash: string): void {},
  };
}

export interface PdfLinkClickMessages {
  followExternalLink?: string;
  openLabel?: string;
  jumpInternalDestination?: string;
  jumpLabel?: string;
}

export interface PdfLinkClickCoordinationOptions {
  event: {
    target: EventTarget | null;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    clientX: number;
    clientY: number;
    preventDefault: () => void;
    stopPropagation: () => void;
  };
  pointerDownPos: { x: number; y: number } | null;
  isPanning?: boolean;
  isSpaceDown?: boolean;
  bypassModifierRef: { current: boolean };
  onOpenExternalUrl: (url: string) => void;
  showInfoToast: (
    message: string,
    options: {
      description?: string;
      duration: number;
      action: { label: string; onClick: () => void };
    },
  ) => void;
  messages?: PdfLinkClickMessages;
}

/**
 * Coordinates clicks on PDF.js `.annotationLayer a` elements so plain clicks
 * prompt with a toast action while `Ctrl/Cmd + Click` follows the link.
 */
export function handlePdfAnnotationLinkClickCapture(options: PdfLinkClickCoordinationOptions): boolean {
  const {
    event,
    pointerDownPos,
    isPanning = false,
    isSpaceDown = false,
    bypassModifierRef,
    onOpenExternalUrl,
    showInfoToast,
    messages,
  } = options;

  const targetEl = event.target as HTMLElement | null;
  const anchor = targetEl?.closest<HTMLAnchorElement>('.annotationLayer a') ?? null;
  if (!anchor) {
    return false;
  }

  if (bypassModifierRef.current) {
    bypassModifierRef.current = false;
    return true;
  }

  if (isPanning || isSpaceDown) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  if (pointerDownPos && Math.hypot(event.clientX - pointerDownPos.x, event.clientY - pointerDownPos.y) > 4) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  const externalUrl = anchor.dataset.pdfExternalUrl;
  const href = anchor.getAttribute('href');
  const isInternal = Boolean(!externalUrl && href && href.startsWith('#'));

  if (!externalUrl && !isInternal) {
    return false;
  }

  const hasModifier = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
  if (hasModifier) {
    if (externalUrl) {
      event.preventDefault();
      event.stopPropagation();
      onOpenExternalUrl(externalUrl);
    }
    return true;
  }

  event.preventDefault();
  event.stopPropagation();
  const modLabel = getPdfModifierLabel();

  if (externalUrl) {
    showInfoToast(messages?.followExternalLink ?? `Hold ${modLabel} + Click to follow link`, {
      description: externalUrl,
      duration: 2500,
      action: {
        label: messages?.openLabel ?? 'Open',
        onClick: () => {
          onOpenExternalUrl(externalUrl);
        },
      },
    });
  } else {
    showInfoToast(messages?.jumpInternalDestination ?? `Hold ${modLabel} + Click to jump to destination`, {
      duration: 2200,
      action: {
        label: messages?.jumpLabel ?? 'Jump',
        onClick: () => {
          bypassModifierRef.current = true;
          anchor.click();
        },
      },
    });
  }

  return true;
}

/**
 * Adds `.selecting` to the active `.textLayer` during drag selection so
 * `.annotationLayer` links do not intercept pointer drag events.
 */
export function trackTextLayerSelection(target: EventTarget | null): () => void {
  const textLayer = (target as HTMLElement | null)?.closest<HTMLElement>('.textLayer') ?? null;
  if (!textLayer || typeof window === 'undefined') {
    return () => {};
  }

  textLayer.classList.add('selecting');
  const clear = () => {
    textLayer.classList.remove('selecting');
    window.removeEventListener('mouseup', clear);
    window.removeEventListener('blur', clear);
  };

  window.addEventListener('mouseup', clear);
  window.addEventListener('blur', clear);
  return clear;
}

/**
 * Renders a PDF page's selectable text layer into a staging container and
 * commits it atomically once complete so prior layers remain intact on cancel.
 */
export async function renderPageTextLayer(
  options: RenderPageTextLayerOptions
): Promise<{ cancelled: boolean }> {
  const {
    page,
    wrapper,
    scale,
    isCancelled,
    targetContainer,
    registerTextLayerTask,
    unregisterTextLayerTask,
    createTextLayer = (params) => new pdfjsLib.TextLayer(params),
  } = options;

  if (isCancelled()) {
    return { cancelled: true };
  }

  if (typeof page.streamTextContent !== 'function') {
    return { cancelled: false };
  }

  const textViewport = page.getViewport({ scale });
  wrapper.style.setProperty?.('--scale-factor', String(scale));

  const stagingTextLayer = wrapper.ownerDocument.createElement('div');
  stagingTextLayer.className = 'textLayer';
  stagingTextLayer.style.setProperty?.('--scale-factor', String(scale));
  stagingTextLayer.style.zIndex = '2';

  let task: TextLayerTask | null = null;

  try {
    const textLayer = createTextLayer({
      textContentSource: page.streamTextContent(),
      container: stagingTextLayer,
      viewport: textViewport,
    });
    task = { cancel: () => textLayer.cancel() };
    registerTextLayerTask?.(task);

    await textLayer.render();

    if (isCancelled()) {
      stagingTextLayer.remove();
      return { cancelled: true };
    }

    if (targetContainer) {
      targetContainer.style.setProperty?.('--scale-factor', String(scale));
      targetContainer.style.zIndex = '2';
      targetContainer.style.width = stagingTextLayer.style.width;
      targetContainer.style.height = stagingTextLayer.style.height;
      targetContainer.replaceChildren(...Array.from(stagingTextLayer.childNodes));
    } else {
      const existingTextLayer = wrapper.querySelector('.textLayer');
      if (existingTextLayer) {
        wrapper.replaceChild(stagingTextLayer, existingTextLayer);
      } else {
        wrapper.appendChild(stagingTextLayer);
      }
    }

    return { cancelled: false };
  } catch (error: unknown) {
    stagingTextLayer.remove();
    if (isCancelled() || isCancellationError(error)) {
      return { cancelled: true };
    }
    throw error;
  } finally {
    if (task) {
      unregisterTextLayerTask?.(task);
    }
  }
}

/**
 * Renders a PDF page's interactive link/annotation layer into a staging container
 * and commits it atomically once complete.
 */
export async function renderPageAnnotationLayer(
  options: RenderPageAnnotationLayerOptions
): Promise<{ cancelled: boolean }> {
  const {
    page,
    wrapper,
    scale,
    isCancelled,
    linkService,
    linkTitlePrefix = `${getPdfModifierLabel()}+Click to follow link`,
    targetContainer,
    createAnnotationLayer = (params) => new pdfjsLib.AnnotationLayer(params),
  } = options;

  if (isCancelled()) {
    return { cancelled: true };
  }

  if (typeof page.getAnnotations !== 'function') {
    return { cancelled: false };
  }

  const annotations = await page.getAnnotations({ intent: 'display' });
  if (isCancelled()) {
    return { cancelled: true };
  }

  if (annotations.length === 0) {
    if (targetContainer) {
      targetContainer.replaceChildren();
    } else {
      wrapper.querySelector('.annotationLayer')?.remove();
    }
    return { cancelled: false };
  }

  const textViewport = page.getViewport({ scale });
  wrapper.style.setProperty?.('--scale-factor', String(scale));

  const stagingAnnotationLayer = wrapper.ownerDocument.createElement('div') as HTMLDivElement;
  stagingAnnotationLayer.className = 'annotationLayer';
  stagingAnnotationLayer.style.setProperty?.('--scale-factor', String(scale));
  stagingAnnotationLayer.style.zIndex = '3';

  try {
    const annotationLayer = createAnnotationLayer({
      div: stagingAnnotationLayer,
      page,
      viewport: textViewport,
      accessibilityManager: null,
      annotationCanvasMap: null,
      annotationEditorUIManager: null,
      structTreeLayer: null,
    });

    await annotationLayer.render({
      viewport: textViewport,
      div: stagingAnnotationLayer,
      annotations,
      page,
      linkService,
      renderForms: false,
    });

    if (isCancelled()) {
      stagingAnnotationLayer.remove();
      return { cancelled: true };
    }

    if (typeof stagingAnnotationLayer.querySelectorAll === 'function') {
      const internalLinks = stagingAnnotationLayer.querySelectorAll<HTMLAnchorElement>('a[href^="#"]');
      internalLinks.forEach((anchor) => {
        anchor.draggable = false;
        if (!anchor.title) {
          anchor.title = linkTitlePrefix;
        }
      });
    }

    if (targetContainer) {
      targetContainer.style.setProperty?.('--scale-factor', String(scale));
      targetContainer.style.zIndex = '3';
      targetContainer.style.width = stagingAnnotationLayer.style.width;
      targetContainer.style.height = stagingAnnotationLayer.style.height;
      targetContainer.replaceChildren(...Array.from(stagingAnnotationLayer.childNodes));
    } else {
      const existingAnnotationLayer = wrapper.querySelector('.annotationLayer');
      if (existingAnnotationLayer) {
        wrapper.replaceChild(stagingAnnotationLayer, existingAnnotationLayer);
      } else {
        wrapper.appendChild(stagingAnnotationLayer);
      }
    }

    return { cancelled: false };
  } catch (error: unknown) {
    stagingAnnotationLayer.remove();
    if (isCancelled() || isCancellationError(error)) {
      return { cancelled: true };
    }
    throw error;
  }
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
    enableTextLayer = false,
    registerTextLayerTask,
    unregisterTextLayerTask,
    createTextLayer,
    enableAnnotationLayer = false,
    linkService,
    linkTitlePrefix,
    createAnnotationLayer,
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

      if (enableTextLayer) {
        try {
          const textOutcome = await renderPageTextLayer({
            page,
            wrapper,
            scale,
            isCancelled,
            registerTextLayerTask,
            unregisterTextLayerTask,
            createTextLayer,
          });
          if (textOutcome.cancelled || isCancelled()) {
            return { success: false, cancelled: true, renderedPages };
          }
        } catch (textError: unknown) {
          if (isCancelled() || isCancellationError(textError)) {
            return { success: false, cancelled: true, renderedPages };
          }
          console.warn(`Failed to render text layer for page ${pageNum}:`, textError);
        }
      }

      if (enableAnnotationLayer && linkService) {
        try {
          const annotationOutcome = await renderPageAnnotationLayer({
            page,
            wrapper,
            scale,
            isCancelled,
            linkService,
            linkTitlePrefix,
            createAnnotationLayer,
          });
          if (annotationOutcome.cancelled || isCancelled()) {
            return { success: false, cancelled: true, renderedPages };
          }
        } catch (annotationError: unknown) {
          if (isCancelled() || isCancellationError(annotationError)) {
            return { success: false, cancelled: true, renderedPages };
          }
          console.warn(`Failed to render annotation layer for page ${pageNum}:`, annotationError);
        }
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
        isCancellationError(error);

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
