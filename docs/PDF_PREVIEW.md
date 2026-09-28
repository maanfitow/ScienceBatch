# PDF Preview Rendering

## Current behavior

The desktop preview uses PDF.js to parse the PDF in its worker and paints pages to high-DPI HTML canvases. A zoom change is debounced by 180 ms. Pages then render sequentially at the requested scale and device pixel ratio. For each page, one attached staging canvas is drawn underneath the last complete canvas; the new canvas replaces it only after the PDF.js render task finishes. This bounds extra canvas memory to one page while preserving the visible page during a redraw.

Each render request receives a monotonically increasing sequence number. A newer zoom, document replacement, or component teardown invalidates stale work and cancels active render tasks. The viewer also destroys obsolete document-loading tasks and preserves its scroll position and zoom across recompilation.

## Missing-content investigation

Some PDFs intermittently show blank or missing regions in the Tauri preview after using Fit to width/screen or changing zoom. The same compiled PDF bytes render correctly when exported and in independent PDF renderers, so the defect is currently isolated to the in-app preview path. Reports have occurred at multiple zoom levels, including 82%, 97%, 112%, 115%, and 120%; there is no confirmed fixed zoom interval or root cause.

`PdfView.tsx` currently sets `isOffscreenCanvasSupported: false` when loading the document. This tests PDF.js's standard image-conversion path in place of worker-side `OffscreenCanvas` conversion as a WebKitGTK compatibility measure. It is an experiment and may trade image-processing performance for compatibility; it is not considered a confirmed fix until the affected document is checked in the desktop app.

## Verification

Run the focused helper tests with:

```bash
node scripts/test-pdf-rendering-helpers.mjs
```

The tests cover fractional canvas sizing, the one-page staging bound, cancellation, failed renders, and sequential page commits. They do not validate WebKit's visual output. For that, open a document with embedded PDF figures, use Fit to width/screen, and inspect the affected pages at several zoom levels. Confirm both that content remains visible and that scrolling still tracks the same page after redraws.

## Future source navigation

Page wrappers and canvas-relative hit testing can remain the preview surface for future click-to-source navigation. The canvas does not contain LaTeX or Typst source locations by itself; accurate navigation will need source-position metadata, such as SyncTeX data for LaTeX or an equivalent mapping produced by the Typst pipeline. Keep that mapping separate from the PDF rasterization path so source navigation does not require replacing the lightweight canvas viewer.
