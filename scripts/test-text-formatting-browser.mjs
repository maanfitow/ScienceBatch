import assert from 'node:assert/strict';
import { access, mkdtemp, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';

const playwrightModule = process.env.PLAYWRIGHT_MODULE || '/home/mauri/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/mauri/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const playwrightSpecifier = playwrightModule.startsWith('/') ? pathToFileURL(playwrightModule).href : playwrightModule;
const { chromium } = await import(playwrightSpecifier);
const artifactDirectory = await mkdtemp(join(tmpdir(), 'sciencebatch-text-formatting-'));
const compileWorkerPath = resolve(process.env.SCIENCEBATCH_COMPILE_WORKER || 'src-tauri/target/debug/sciencebatch');
await access(compileWorkerPath, constants.X_OK);
assert.ok((await stat(compileWorkerPath)).isFile(), `Compile worker is not a file: ${compileWorkerPath}`);
const pdfFixtureSource = String.raw`\documentclass{article}
\begin{document}
Retained PDF fixture from explicit isolated compilation.
\end{document}
`;
const pdfFixtureResponse = JSON.parse(execFileSync(compileWorkerPath, ['--compile-worker'], {
  input: JSON.stringify({ engine: 'latex', source: pdfFixtureSource, main_file: null, project_dir: null }),
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
}));
assert.equal(pdfFixtureResponse.success, true, `Retained PDF fixture did not compile: ${JSON.stringify(pdfFixtureResponse.errors ?? [])}`);
assert.ok(Array.isArray(pdfFixtureResponse.pdf_bytes) && pdfFixtureResponse.pdf_bytes.length > 5, 'Compile worker did not return retained-PDF fixture bytes.');
const vite = await createServer({
  configFile: resolve('vite.config.ts'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
let browser;
let activePage;
let activePageErrors = [];

const installTauriMock = async (page) => page.addInitScript((pdfResponse) => {
  window.__testInvokeCalls = [];
  window.__testUnhandledRejections = [];
  window.__testCompileClicked = false;
  window.__testPdfResponse = pdfResponse;
  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button.btn-compile')) window.__testCompileClicked = true;
  }, true);
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      window.__testInvokeCalls.push({ command, args });
      if (command === 'plugin:event|listen') return 1;
      if (command === 'compile_document' && window.__testCompileClicked) return pdfResponse;
      return null;
    },
    transformCallback: () => 1,
    unregisterCallback: () => {},
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.addEventListener('unhandledrejection', (event) => {
    window.__testUnhandledRejections.push({ message: event.reason?.message ?? String(event.reason), stack: event.reason?.stack });
  });
}, pdfFixtureResponse);

function attachRuntimeCapture(page) {
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push({ kind: 'consoleerror', message: message.text() }); });
  page.on('requestfailed', (request) => errors.push({ kind: 'requestfailed', url: request.url(), failure: request.failure()?.errorText }));
  page.on('pageerror', (error) => errors.push({ kind: 'pageerror', message: error.message, stack: error.stack }));
  return errors;
}

async function getMountedEditor(page) {
  return page.evaluate(() => {
    const fiberFor = (element) => element && element[Object.keys(element).find((key) => key.startsWith('__reactFiber$'))];
    let editor = null;
    for (let fiber = fiberFor(document.querySelector('.editor-container')); fiber && !editor; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const candidate = hook.memoizedState?.current;
        if (candidate?.getModel && candidate?.executeEdits) { editor = candidate; break; }
      }
    }
    if (!editor) throw new Error('Could not find the mounted Monaco editor.');
    window.__testEditor = editor;
    let appFiber = fiberFor(document.querySelector('.app-layout'));
    while (appFiber && appFiber.type?.name !== 'App') appFiber = appFiber.return;
    const appHooks = [];
    for (let hook = appFiber?.memoizedState; hook; hook = hook.next) appHooks.push(hook);
    const bridge = appHooks.map((hook) => hook.memoizedState).find((value) =>
      value && ['capture', 'isCurrent', 'apply', 'restore'].every((name) => typeof value[name] === 'function'));
    window.__testBridge = bridge ?? null;
    return {
      language: editor.getModel()?.getLanguageId(),
      source: editor.getValue(),
      bridge: Boolean(bridge),
      tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent.trim()),
    };
  });
}

async function waitForBridge(page) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const mounted = await getMountedEditor(page);
      if (mounted.bridge) return mounted;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Could not find the mounted Monaco editor')) throw error;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('The writing editor bridge did not mount.');
}

async function setDocumentAndSelection(page, source, selected = '', reverse = false) {
  const offsets = await page.evaluate(({ sourceText, selectedText, reverseSelection }) => {
    const editor = window.__testEditor;
    editor.setValue(sourceText);
    const start = selectedText ? sourceText.indexOf(selectedText) : 0;
    if (selectedText && start < 0) throw new Error(`Could not find selected test text: ${selectedText}`);
    const end = selectedText ? start + selectedText.length : start;
    const anchorOffset = reverseSelection ? end : start;
    const activeOffset = reverseSelection ? start : end;
    const anchor = editor.getModel().getPositionAt(anchorOffset);
    const active = editor.getModel().getPositionAt(activeOffset);
    editor.setSelection(new monaco.Selection(anchor.lineNumber, anchor.column, active.lineNumber, active.column));
    editor.focus();
    return { start, end, anchorOffset, activeOffset };
  }, { sourceText: source, selectedText: selected, reverseSelection: reverse });
  await page.waitForFunction(() => Boolean(window.__testEditor?.getModel()));
  return offsets;
}

async function moveCursorInCurrentModel(page, expectedSource, marker, relativeOffset = 0) {
  return page.evaluate(({ sourceText, searchText, delta }) => {
    const editor = window.__testEditor;
    const model = editor.getModel();
    if (!model || model.getValue() !== sourceText) throw new Error('Cursor-context fixture source changed unexpectedly.');
    if (window.__testStructureContextModel && window.__testStructureContextModel !== model) throw new Error('Cursor-context fixture changed Monaco models unexpectedly.');
    window.__testStructureContextModel ??= model;
    const markerOffset = sourceText.indexOf(searchText);
    if (markerOffset < 0) throw new Error(`Could not find cursor-context marker: ${searchText}`);
    const offset = markerOffset + delta;
    editor.setPosition(model.getPositionAt(offset));
    editor.focus();
    return offset;
  }, { sourceText: expectedSource, searchText: marker, delta: relativeOffset });
}

async function waitForRibbonContext(page, expectedOffset, manualEditExpected) {
  await page.waitForFunction(({ offset, manualEdit }) => {
    const editor = window.__testEditor;
    const model = editor?.getModel();
    const hint = document.querySelector('.writing-ribbon-hint');
    if (!model || !hint || model.getOffsetAt(editor.getPosition()) !== offset) return false;
    if (manualEdit) return Boolean(hint.title && /unsupported|directly in the source|manual editing/i.test(`${hint.title} ${hint.textContent}`));
    return !hint.title;
  }, { offset: expectedOffset, manualEdit: manualEditExpected }, { timeout: 5000 });
}

async function waitForWritingStateSettled(page, expectedSource) {
  await page.waitForFunction((sourceText) => {
    const fiberFor = (element) => element && element[Object.keys(element).find((key) => key.startsWith('__reactFiber$'))];
    let root = fiberFor(document.querySelector('.app-layout'));
    while (root && root.type?.name !== 'App') root = root.return;
    const stack = root ? [root] : [];
    let editorFiber;
    let ribbonFiber;
    const seen = new Set();
    while (stack.length && (!editorFiber || !ribbonFiber)) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      const name = fiber.type?.name ?? fiber.elementType?.name ?? fiber.type?.type?.name;
      if (name === 'EditorView') editorFiber = fiber;
      if (name === 'WritingRibbon') ribbonFiber = fiber;
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    const editor = window.__testEditor;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!model || !position || document.querySelector('.writing-dialog')) return false;
    const cursorOffset = model.getOffsetAt(position);
    return editorFiber?.memoizedProps?.value === sourceText
      && ribbonFiber?.memoizedProps?.editorState?.source === sourceText
      && ribbonFiber.memoizedProps.editorState.cursorOffset === cursorOffset;
  }, expectedSource, { timeout: 5000 });
}

async function source(page) { return page.evaluate(() => window.__testEditor.getValue()); }
async function noRuntimeErrors(page, pageErrors, label) {
  await page.waitForTimeout(150);
  const rejections = await page.evaluate(() => window.__testUnhandledRejections);
  assert.deepEqual(pageErrors, [], `${label} page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(rejections, [], `${label} unhandled rejections: ${JSON.stringify(rejections)}`);
}

async function waitForStableEditorScroll(page) {
  await page.evaluate(() => { window.__testLastScrollSample = null; });
  await page.waitForFunction(() => {
    const editor = window.__testEditor;
    const current = { top: editor.getScrollTop(), left: editor.getScrollLeft() };
    const previous = window.__testLastScrollSample;
    window.__testLastScrollSample = current;
    return previous?.top === current.top && previous?.left === current.left;
  }, null, { polling: 'raf', timeout: 5000 });
}

async function selectTheme(page, themeName, optionName) {
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await page.getByRole('button', { name: optionName, exact: true }).click();
  await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, themeName);
}

await vite.listen();
const address = vite.httpServer?.address();
assert.ok(address && typeof address !== 'string', 'Vite did not bind an ephemeral localhost port.');
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  const page = activePage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = activePageErrors = attachRuntimeCapture(page);
  await installTauriMock(page);
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Quick Typst', exact: true }).click();
  await page.waitForSelector('.monaco-editor', { timeout: 60000 });
  let mounted = await waitForBridge(page);
  assert.equal(mounted.language, 'typst', 'Quick Typst must mount the real Typst Monaco model.');

  const bold = page.getByRole('button', { name: 'Bold', exact: true });
  const italic = page.getByRole('button', { name: 'Italic', exact: true });
  assert.equal(await bold.getAttribute('aria-pressed'), 'false');
  assert.equal(await italic.getAttribute('aria-pressed'), 'false');

  const results = { languages: {}, guards: [], layout: {}, smoke: {}, runtimeErrors: 0, unhandledRejections: 0 };
  const languageCases = [
    { engine: 'typst', switch: false, plain: 'alpha café beta', bold: 'alpha #strong[café] beta', italic: 'alpha #emph[café] beta', emptyBold: 'before #strong[typed café] after', nested: '#strong[#emph[café]]' },
    { engine: 'latex', switch: true, plain: 'alpha café beta', bold: String.raw`alpha \textbf{café} beta`, italic: String.raw`alpha \textit{café} beta`, emptyBold: String.raw`before \textbf{typed café} after`, nested: String.raw`\textbf{\textit{café}}` },
  ];

  for (const testCase of languageCases) {
    if (testCase.switch) {
      await page.locator('.engine-toggle-btn').click();
      await page.waitForFunction(() => window.__testEditor?.getModel()?.getLanguageId() === 'latex', null, { timeout: 10000 });
      await waitForBridge(page);
    }

    // A pointer activation wraps the selected body, keeps the text selection and announces active state.
    await setDocumentAndSelection(page, testCase.plain, 'café');
    await bold.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Bold"]')?.disabled);
    if (testCase.engine === 'typst') {
      assert.equal(await source(page), testCase.plain, 'The source must remain unchanged before the first formatting activation.');
      assert.equal(await page.locator('.writing-ribbon-hint').textContent(), '', 'Formatting status must be empty before the first formatting activation.');
    }
    await bold.click();
    await page.waitForFunction((expected) => window.__testEditor.getValue() === expected, testCase.bold);
    if (testCase.engine === 'typst') {
      await page.waitForFunction(() => Boolean(document.querySelector('.writing-ribbon-hint')?.textContent?.trim()));
      assert.match(await page.locator('.writing-ribbon-hint').textContent(), /Bold formatting applied/i, 'Formatting status must announce the completed action.');
    }
    assert.equal(await bold.getAttribute('aria-pressed'), 'true', `${testCase.engine} Bold must expose its active source state.`);
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.monaco-editor'))), true, `${testCase.engine} formatting must return focus to Monaco.`);
    const selectedBody = await page.evaluate(() => {
      const selection = window.__testEditor.getSelection();
      return window.__testEditor.getModel().getValueInRange(selection);
    });
    assert.equal(selectedBody, 'café', `${testCase.engine} wrapping must preserve the selected body.`);

    // Select the complete canonical wrapper so the planner can remove it without rewriting a partial format range.
    const completeBoldWrapper = testCase.engine === 'typst' ? '#strong[café]' : String.raw`\textbf{café}`;
    await setDocumentAndSelection(page, testCase.bold, completeBoldWrapper);
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Bold"]')?.disabled);
    await bold.click();
    await page.waitForFunction((expected) => window.__testEditor.getValue() === expected, testCase.plain);
    assert.equal(await bold.getAttribute('aria-pressed'), 'false', `${testCase.engine} unwrapping must clear Bold state.`);

    // Reverse selection plus keyboard activation must retain its direction through one Undo/Redo operation.
    await setDocumentAndSelection(page, testCase.plain, 'café', true);
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Italic"]')?.disabled);
    await italic.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction((expected) => window.__testEditor.getValue() === expected, testCase.italic);
    const wrappedDirection = await page.evaluate(() => {
      const selection = window.__testEditor.getSelection();
      return {
        text: window.__testEditor.getModel().getValueInRange(selection),
      };
    });
    assert.equal(wrappedDirection.text, 'café');
    const selectionOffsets = await page.evaluate(() => {
      const selection = window.__testEditor.getSelection();
      return { anchor: window.__testEditor.getModel().getOffsetAt({ lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn }), active: window.__testEditor.getModel().getOffsetAt({ lineNumber: selection.positionLineNumber, column: selection.positionColumn }) };
    });
    assert.ok(selectionOffsets.anchor > selectionOffsets.active, `${testCase.engine} reverse selection direction must survive formatting.`);
    await page.evaluate(() => window.__testEditor.trigger('text-format-test', 'undo'));
    await page.waitForFunction((expected) => window.__testEditor.getValue() === expected, testCase.plain);
    await page.evaluate(() => window.__testEditor.trigger('text-format-test', 'redo'));
    await page.waitForFunction((expected) => window.__testEditor.getValue() === expected, testCase.italic);
    await page.evaluate(() => window.__testEditor.trigger('text-format-test', 'undo'));
    await page.waitForFunction((expected) => window.__testEditor.getValue() === expected, testCase.plain);

    // Empty selection inserts no placeholder; immediate typing lands inside the native wrapper.
    await setDocumentAndSelection(page, 'before  after');
    const caret = await page.evaluate(() => {
      const editor = window.__testEditor;
      const offset = editor.getValue().indexOf('  ') + 1;
      editor.setPosition(editor.getModel().getPositionAt(offset));
      return offset;
    });
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Bold"]')?.disabled);
    await bold.click();
    const emptyWrapper = testCase.engine === 'typst' ? 'before #strong[] after' : String.raw`before \textbf{} after`;
    await page.waitForFunction((expected) => window.__testEditor.getValue() === expected, emptyWrapper);
    const insertionPoint = await page.evaluate(() => window.__testEditor.getModel().getOffsetAt(window.__testEditor.getPosition()));
    assert.ok(insertionPoint > caret, `${testCase.engine} empty-format caret must land inside its wrapper.`);
    await page.keyboard.insertText('typed café');
    await page.waitForFunction((expected) => window.__testEditor.getValue() === expected, testCase.emptyBold);

    // Canonical nested Bold/Italic compose. Removing the outer Bold preserves inner Italic.
    await setDocumentAndSelection(page, 'café', 'café');
    await bold.click();
    const boldOnly = testCase.engine === 'typst' ? '#strong[café]' : String.raw`\textbf{café}`;
    await page.waitForFunction((expected) => window.__testEditor.getValue() === expected, boldOnly);
    await italic.click();
    await page.waitForFunction((expected) => window.__testEditor.getValue() === expected, testCase.nested);
    assert.equal(await bold.getAttribute('aria-pressed'), 'true');
    assert.equal(await italic.getAttribute('aria-pressed'), 'true');
    const nestedSelection = await page.evaluate(() => {
      const selection = window.__testEditor.getSelection();
      return window.__testEditor.getModel().getValueInRange(selection);
    });
    assert.equal(nestedSelection, 'café');
    const completeOuterWrapper = testCase.engine === 'typst' ? testCase.nested : testCase.nested;
    await setDocumentAndSelection(page, testCase.nested, completeOuterWrapper);
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Bold"]')?.disabled);
    await bold.click();
    const italicOnly = testCase.engine === 'typst' ? '#emph[café]' : String.raw`\textit{café}`;
    await page.waitForFunction((expected) => window.__testEditor.getValue() === expected, italicOnly);
    await italic.click();
    await page.waitForFunction((expected) => window.__testEditor.getValue() === expected, 'café');

    results.languages[testCase.engine] = { pointerBold: true, keyboardItalic: true, reverseSelection: true, emptyCaretAndTyping: true, nestedToggle: true, oneEditUndoRedo: true };
  }

  // Unsupported LaTeX source contexts expose a reason and leave source untouched.
  const latexGuards = [
    { source: '$x + y$', selected: 'x + y', label: 'math' },
    { source: '% comment words', selected: 'comment words', label: 'comment' },
    { source: String.raw`\verb|raw text|`, selected: 'raw text', label: 'raw content' },
    { source: String.raw`\begin{verbatim}raw text\end{verbatim}`, selected: 'raw text', label: 'verbatim content' },
    { source: String.raw`\documentclass{article}`, selected: 'article', label: 'preamble' },
    { source: String.raw`\textbf{formatted word}`, selected: 'formatted', label: 'partial formatted range' },
  ];
  for (const guard of latexGuards) {
    await setDocumentAndSelection(page, guard.source, guard.selected);
    await bold.waitFor();
    await page.waitForFunction(() => document.querySelector('button[aria-label="Bold"]')?.disabled);
    assert.equal(await bold.isDisabled(), true, `Bold must be disabled in ${guard.label}.`);
    assert.ok((await bold.getAttribute('title'))?.trim(), `Disabled ${guard.label} control must explain the restriction.`);
    assert.equal(await source(page), guard.source, `${guard.label} guard must preserve source.`);
    results.guards.push(guard.label);
  }

  const unsupportedLatexEnvironment = String.raw`\begin{tabularx}{\textwidth}{XX}A & B\end{tabularx}`;
  const unsupportedLatexOffset = await setDocumentAndSelection(page, unsupportedLatexEnvironment, 'A');
  await waitForRibbonContext(page, unsupportedLatexOffset.activeOffset, true);
  assert.equal(await page.locator('.writing-ribbon-edit').count(), 0, 'An unsupported LaTeX environment must not expose an Edit source action.');
  assert.match(await page.locator('.writing-ribbon-hint').textContent(), /unsupported|directly in the source/i, 'Unsupported LaTeX source must show an accessible manual-edit reason.');
  assert.match(await page.locator('.writing-ribbon-hint').getAttribute('title'), /unsupported|directly in the source/i, 'Unsupported LaTeX manual-edit reason must also be available as a title.');
  assert.equal(await source(page), unsupportedLatexEnvironment, 'Unsupported LaTeX context inspection must preserve source.');
  results.structureContexts = { latexUnsupported: true };

  // Typst restrictions cover math, comments, raw content, code and string arguments.
  await page.locator('.engine-toggle-btn').click();
  await page.waitForFunction(() => window.__testEditor?.getModel()?.getLanguageId() === 'typst', null, { timeout: 10000 });
  await waitForBridge(page);
  const typstGuards = [
    { source: '$x + y$', selected: 'x + y', label: 'Typst math' },
    { source: '// comment words', selected: 'comment words', label: 'Typst comment' },
    { source: '#raw("raw words")', selected: 'raw words', label: 'Typst raw content' },
    { source: '#let value = "code words"', selected: 'code words', label: 'Typst code string' },
    { source: '#text("string words")', selected: 'string words', label: 'Typst string argument' },
    { source: '*formatted word*', selected: 'formatted', label: 'Typst partial shorthand' },
  ];
  for (const guard of typstGuards) {
    await setDocumentAndSelection(page, guard.source, guard.selected);
    await page.waitForFunction(() => document.querySelector('button[aria-label="Bold"]')?.disabled);
    assert.equal(await bold.isDisabled(), true, `Bold must be disabled in ${guard.label}.`);
    assert.ok((await bold.getAttribute('title'))?.trim(), `Disabled ${guard.label} control must explain the restriction.`);
    assert.equal(await source(page), guard.source, `${guard.label} guard must preserve source.`);
    results.guards.push(guard.label);
  }

  // Cursor movement within one real Monaco model must scope unsupported Typst warnings to the table range.
  const unsupportedTypstFigure = 'Before text\n#figure(table(columns: count, [x]), kind: table)\nAfter text';
  await setDocumentAndSelection(page, unsupportedTypstFigure);
  const beforeOffset = await moveCursorInCurrentModel(page, unsupportedTypstFigure, 'Before text', 3);
  await waitForRibbonContext(page, beforeOffset, false);
  assert.equal(await page.locator('.writing-ribbon-edit').count(), 0, 'Typst prose before an unsupported figure must not show a structural edit action.');
  assert.ok(!/unsupported|directly in the source|manual editing/i.test(await page.locator('.writing-ribbon-hint').textContent()), 'Typst prose before the table range must not inherit its manual-edit warning.');
  assert.equal(await page.locator('.writing-ribbon-hint').getAttribute('title'), null, 'Typst prose before the table range must not retain a manual-edit title.');

  const unsupportedCellOffset = await moveCursorInCurrentModel(page, unsupportedTypstFigure, '[x]', 1);
  await waitForRibbonContext(page, unsupportedCellOffset, true);
  const unsupportedTypstHint = page.locator('.writing-ribbon-hint');
  assert.match(await unsupportedTypstHint.textContent(), /table|unsupported|directly in the source/i, 'The unsupported Typst table cell must explain manual source editing.');
  assert.match(await unsupportedTypstHint.getAttribute('title'), /table|unsupported|directly in the source/i, 'The unsupported Typst table reason must be exposed in the hint title.');
  assert.equal(await page.locator('.writing-ribbon-edit').count(), 0, 'An unsupported Typst table must not expose an editable structure action.');
  assert.equal(await source(page), unsupportedTypstFigure, 'Unsupported Typst table inspection must preserve source.');

  const afterOffset = await moveCursorInCurrentModel(page, unsupportedTypstFigure, 'After text', 3);
  await waitForRibbonContext(page, afterOffset, false);
  assert.equal(await page.locator('.writing-ribbon-edit').count(), 0, 'Typst prose after an unsupported figure must not show a structural edit action.');
  assert.ok(!/unsupported|directly in the source|manual editing/i.test(await page.locator('.writing-ribbon-hint').textContent()), 'Leaving the Typst table range must hide its manual-edit warning.');
  assert.equal(await page.locator('.writing-ribbon-hint').getAttribute('title'), null, 'Leaving the Typst table range must clear its manual-edit title.');
  assert.equal(await source(page), unsupportedTypstFigure, 'Cursor navigation through the Typst fixture must not modify source.');
  results.structureContexts.typstUnsupported = { beforeOffset, unsupportedCellOffset, afterOffset, sameMonacoModel: true, warningScopedToTableRange: true };

  const compatibleTypstTable = '#table(columns: 1, align: (left), inset: 5pt, stroke: none, [A])';
  await setDocumentAndSelection(page, compatibleTypstTable, 'A');
  await page.getByRole('button', { name: 'Edit table', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Edit table', exact: true }).click();
  await page.getByRole('heading', { name: 'Edit table', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.writing-dialog'));
  assert.equal(await source(page), compatibleTypstTable, 'Canceling compatible Typst table editing must preserve exact source.');

  const compatibleTypstMatrix = '$ mat(delim: "(", a, b; c, d) $';
  await setDocumentAndSelection(page, compatibleTypstMatrix, 'a');
  await page.getByRole('button', { name: 'Edit matrix', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Edit matrix', exact: true }).click();
  await page.getByRole('heading', { name: 'Edit matrix', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.writing-dialog'));
  assert.equal(await source(page), compatibleTypstMatrix, 'Canceling compatible Typst matrix editing must preserve exact source.');
  results.structureContexts.typstCompatibleWide = { tableEditCancelPreservesSource: true, matrixEditCancelPreservesSource: true };

  // Monaco multi-selection is real editor state; read-only behavior uses a test-only component fixture.
  await setDocumentAndSelection(page, 'first second', 'first');
  await page.evaluate(() => {
    const editor = window.__testEditor;
    const model = editor.getModel();
    const first = model.getPositionAt(0);
    const secondOffset = model.getValue().indexOf('second');
    const second = model.getPositionAt(secondOffset);
    editor.setSelections([
      new monaco.Selection(first.lineNumber, first.column, first.lineNumber, first.column + 5),
      new monaco.Selection(second.lineNumber, second.column, second.lineNumber, second.column + 6),
    ]);
  });
  await page.waitForFunction(() => document.querySelector('button[aria-label="Bold"]')?.disabled);
  assert.equal(await bold.isDisabled(), true, 'Multiple selections must disable source formatting.');
  results.guards.push('multiple selections');

  await setDocumentAndSelection(page, 'readonly fixture text', 'readonly');
  await waitForWritingStateSettled(page, 'readonly fixture text');
  const writableSessionBeforeLock = await page.evaluate(() => window.__testBridge.capture());
  assert.ok(writableSessionBeforeLock, 'Expected a writable session before simulating the read-only state.');

  await page.evaluate(() => {
    const fiberFor = (element) => element && element[Object.keys(element).find((key) => key.startsWith('__reactFiber$'))];
    let root = fiberFor(document.querySelector('.app-layout'));
    while (root && root.type?.name !== 'App') root = root.return;
    const seen = new Set();
    const stack = root ? [root] : [];
    let editorFiber;
    let ribbonFiber;
    while (stack.length && (!editorFiber || !ribbonFiber)) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      const name = fiber.type?.name ?? fiber.elementType?.name ?? fiber.type?.type?.name;
      if (name === 'EditorView') editorFiber = fiber;
      if (name === 'WritingRibbon') ribbonFiber = fiber;
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    if (!editorFiber) throw new Error('Could not locate the mounted EditorView fiber for the test-only read-only fixture.');
    if (!ribbonFiber || typeof editorFiber.memoizedProps?.onWritingBridgeChange !== 'function') throw new Error('Could not locate the actual WritingRibbon state or EditorView publish callback.');
    const booleanRefs = [];
    for (let hook = editorFiber.memoizedState; hook; hook = hook.next) {
      if (typeof hook.memoizedState?.current === 'boolean') booleanRefs.push(hook.memoizedState);
    }
    if (booleanRefs.length < 2) throw new Error('Could not locate the EditorView readOnlyRef in the mounted hook state.');
    const readOnlyRef = booleanRefs[1]; // EditorView declares awaitingExternalContentRef before readOnlyRef.
    const forceRibbonState = (() => {
      for (let hook = ribbonFiber.memoizedState; hook; hook = hook.next) {
        if (typeof hook.memoizedState === 'boolean' && typeof hook.queue?.dispatch === 'function') return hook;
      }
      return null;
    })();
    if (!forceRibbonState) throw new Error('Could not locate a WritingRibbon state dispatch for its read-only fixture render.');
    const originalBridge = ribbonFiber.memoizedProps.bridge;
    const originalState = ribbonFiber.memoizedProps.editorState;
    if (!originalBridge || !originalState) throw new Error('The mounted WritingRibbon is missing its live bridge/state fixture.');
    let fixtureToggle = false;
    window.__testSetSimulatedReadOnly = (readOnly) => {
      readOnlyRef.current = readOnly;
      window.__testEditor.updateOptions({ readOnly });
      const nextProps = {
        bridge: originalBridge,
        editorState: readOnly
          ? { ...originalState, editable: false, available: false, reason: 'The editor is temporarily read-only.' }
          : originalState,
      };
      for (const fiber of [ribbonFiber, ribbonFiber.alternate].filter(Boolean)) {
        fiber.memoizedProps = { ...fiber.memoizedProps, ...nextProps };
        fiber.pendingProps = { ...fiber.pendingProps, ...nextProps };
      }
      fixtureToggle = !fixtureToggle;
      forceRibbonState.queue.dispatch(fixtureToggle);
    };
    window.__testSetSimulatedReadOnly(true);
  });
  await page.waitForFunction(() => window.__testEditor.getOption(monaco.editor.EditorOption.readOnly));
  const lockedState = await page.evaluate((session) => ({
    capture: window.__testBridge.capture(),
    staleApply: window.__testBridge.apply(session, { start: session.start, end: session.end, text: '#strong[stale]' }),
  }), writableSessionBeforeLock);
  assert.equal(lockedState.capture, null, 'Read-only EditorView must not capture an editable writing session.');
  assert.equal(lockedState.staleApply, null, 'A live pre-lock session must be rejected after read-only mode is enabled.');
  assert.equal(await source(page), 'readonly fixture text', 'Read-only session rejection must preserve source.');
  assert.equal(await bold.isDisabled(), true, 'Simulated EditorView read-only state must disable formatting controls.');
  results.guards.push('simulated EditorView readOnlyRef + Monaco option + direct WritingRibbon state fixture (not a prop transition or real Git operation)');
  await page.evaluate(() => window.__testSetSimulatedReadOnly(false));
  await page.waitForFunction(() => !window.__testEditor.getOption(monaco.editor.EditorOption.readOnly));
  assert.ok(await page.evaluate(() => window.__testBridge.capture()), 'Unlocking the simulated read-only state must produce a fresh editable session.');

  // Stale session rejection across real engine and workspace-tab switches uses the actual bridge.
  await setDocumentAndSelection(page, 'fresh source', 'fresh');
  const stale = await page.evaluate(() => window.__testBridge.capture());
  assert.ok(stale, 'Expected a live Typst session before engine switch.');
  await page.locator('.engine-toggle-btn').click();
  await page.waitForFunction(() => window.__testEditor.getModel()?.getLanguageId() === 'latex');
  const activeLatexSource = await source(page);
  assert.equal(await page.evaluate((session) => window.__testBridge.isCurrent(session), stale), false, 'Old engine session must become stale.');
  assert.equal(await page.evaluate((session) => window.__testBridge.apply(session, { start: session.start, end: session.end, text: String.raw`\textbf{fresh}` }), stale), null, 'Stale engine session must reject a formatting-shaped edit.');
  assert.equal(await source(page), activeLatexSource, 'Stale session rejection must not mutate the active LaTeX source.');
  await page.locator('.engine-toggle-btn').click();
  await page.waitForFunction(() => window.__testEditor.getModel()?.getLanguageId() === 'typst');
  assert.equal(await source(page), 'fresh source', 'Round-trip engine switch must preserve the original source.');
  results.staleEngineSessionRejected = true;

  const staleBeforeTabSwitch = await page.evaluate(() => window.__testBridge.capture());
  const originalTabName = (await page.locator('[role="tab"]').allTextContents()).find((name) => name.trim().length)?.trim();
  assert.ok(staleBeforeTabSwitch && originalTabName, 'Expected a current session and original workspace tab before adding a test tab.');
  const secondSource = 'secondary tab source';
  await page.evaluate((content) => {
    const fiberFor = (element) => element && element[Object.keys(element).find((key) => key.startsWith('__reactFiber$'))];
    let appFiber = fiberFor(document.querySelector('.app-layout'));
    while (appFiber && appFiber.type?.name !== 'App') appFiber = appFiber.return;
    const hooks = [];
    for (let hook = appFiber?.memoizedState; hook; hook = hook.next) hooks.push(hook);
    const tabsHook = hooks.find((hook) => Array.isArray(hook.memoizedState) && hook.memoizedState.length && hook.memoizedState.every((tab) => tab?.id && tab?.kind));
    if (!tabsHook?.queue?.dispatch) throw new Error('Could not locate App workspace tab state for the test-only second tab.');
    const current = tabsHook.memoizedState;
    const tabRefHook = hooks.find((hook) => hook.memoizedState?.current === current);
    if (!tabRefHook) throw new Error('Could not locate the current workspace tabs ref.');
    const second = { ...current[0], id: 'source:formatting-secondary', path: null, name: 'FormattingSecondary.typ', content, savedContent: content, pinned: true, preview: false };
    const next = [...current, second];
    tabRefHook.memoizedState.current = next;
    tabsHook.queue.dispatch(next);
  }, secondSource);
  const secondTab = page.getByRole('tab', { name: /FormattingSecondary\.typ/ });
  await secondTab.waitFor();
  await secondTab.click();
  await page.waitForFunction(() => document.querySelector('.workspace-tab.active [role="tab"]')?.textContent?.includes('FormattingSecondary.typ'), null, { timeout: 10000 });
  mounted = await waitForBridge(page);
  assert.equal(mounted.source, secondSource, 'Actual workspace tab switch must load the secondary fixture source.');
  assert.equal(await page.evaluate((session) => window.__testBridge.isCurrent(session), staleBeforeTabSwitch), false, 'The previous workspace tab session must become stale.');
  assert.equal(await page.evaluate((session) => window.__testBridge.apply(session, { start: session.start, end: session.end, text: '#strong[stale]' }), staleBeforeTabSwitch), null, 'The previous tab session must reject formatting changes.');
  assert.equal(await source(page), secondSource, 'Rejected stale-tab formatting must leave the active tab unchanged.');
  await page.getByRole('tab', { name: /Untitled\.typ/ }).click();
  await page.waitForFunction(() => document.querySelector('.workspace-tab.active [role="tab"]')?.textContent?.includes('Untitled.typ'), null, { timeout: 10000 });
  await waitForBridge(page);
  assert.equal(await source(page), 'fresh source', 'Returning to the original tab must preserve its exact source.');
  assert.equal(await page.evaluate((session) => window.__testBridge.isCurrent(session), staleBeforeTabSwitch), false, 'The previous tab session must remain stale after returning.');
  results.staleTabSessionRejected = true;

  const shortScrollSource = Array.from({ length: 80 }, (_, index) => `line ${index} ${index === 45 ? 'target' : 'sample'}`).join('\n');
  await setDocumentAndSelection(page, shortScrollSource, 'target');
  await page.evaluate(() => window.__testEditor.revealPositionInCenter(window.__testEditor.getPosition(), monaco.editor.ScrollType.Immediate));
  await waitForStableEditorScroll(page);
  const beforeShortScroll = await page.evaluate(() => ({
    top: window.__testEditor.getScrollTop(),
    left: window.__testEditor.getScrollLeft(),
    wordWrap: window.__testEditor.getOption(monaco.editor.EditorOption.wordWrap),
    selection: window.__testEditor.getModel().getValueInRange(window.__testEditor.getSelection()),
  }));
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Bold"]')?.disabled);
  await bold.click();
  await page.waitForFunction(() => window.__testEditor.getValue().includes('#strong[target]'));
  await waitForStableEditorScroll(page);
  const afterShortScroll = await page.evaluate(() => ({ top: window.__testEditor.getScrollTop(), left: window.__testEditor.getScrollLeft() }));
  assert.ok(beforeShortScroll.top > 0, 'Short-document scroll fixture must start on a visible middle line.');
  assert.equal(beforeShortScroll.wordWrap, 'on', 'Scroll regressions must retain the real application word-wrap setting.');
  assert.equal(beforeShortScroll.selection, 'target');
  assert.ok(Math.abs(afterShortScroll.top - beforeShortScroll.top) <= 2, `Formatting must preserve the visible vertical scroll for a short line (${beforeShortScroll.top} -> ${afterShortScroll.top}).`);
  assert.equal(beforeShortScroll.left, 0, 'Horizontal scrolling is unavailable under the application word-wrap setting.');
  assert.equal(afterShortScroll.left, beforeShortScroll.left, 'Formatting must retain the zero horizontal offset with wordWrap=on.');

  const longScrollSource = Array.from({ length: 80 }, (_, index) => `line ${index} ${index === 45 ? `${'horizontal-content '.repeat(80)}target ${'trailing-content '.repeat(80)}` : 'sample'}`).join('\n');
  await setDocumentAndSelection(page, longScrollSource, 'target');
  await page.evaluate(() => window.__testEditor.revealPositionInCenter(window.__testEditor.getPosition(), monaco.editor.ScrollType.Immediate));
  await waitForStableEditorScroll(page);
  const beforeLongScroll = await page.evaluate(() => {
    const editor = window.__testEditor;
    const selection = editor.getSelection();
    const model = editor.getModel();
    const start = { lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn };
    const end = { lineNumber: selection.positionLineNumber, column: selection.positionColumn };
    return {
      top: editor.getScrollTop(),
      left: editor.getScrollLeft(),
      lineHeight: editor.getOption(monaco.editor.EditorOption.lineHeight),
      contentHeight: editor.getContentHeight(),
      selectionStartY: editor.getScrolledVisiblePosition(start)?.top ?? null,
      selectionEndY: editor.getScrolledVisiblePosition(end)?.top ?? null,
      selectedText: model.getValueInRange(selection),
    };
  });
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Bold"]')?.disabled);
  await bold.click();
  await page.waitForFunction(() => window.__testEditor.getValue().includes('#strong[target]'));
  await waitForStableEditorScroll(page);
  const afterLongScroll = await page.evaluate(() => {
    const editor = window.__testEditor;
    const selection = editor.getSelection();
    const model = editor.getModel();
    const start = { lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn };
    const end = { lineNumber: selection.positionLineNumber, column: selection.positionColumn };
    return {
      top: editor.getScrollTop(),
      left: editor.getScrollLeft(),
      contentHeight: editor.getContentHeight(),
      selectionStartY: editor.getScrolledVisiblePosition(start)?.top ?? null,
      selectionEndY: editor.getScrolledVisiblePosition(end)?.top ?? null,
      selectedText: model.getValueInRange(selection),
    };
  });
  assert.ok(beforeLongScroll.top > 0, 'Wrapped long-line scroll fixture must start on a visible middle line.');
  assert.equal(beforeLongScroll.selectedText, 'target');
  assert.equal(afterLongScroll.selectedText, beforeLongScroll.selectedText, 'Formatting must preserve the exact selected body across long-line reflow.');
  assert.ok(beforeLongScroll.selectionStartY !== null && beforeLongScroll.selectionEndY !== null && afterLongScroll.selectionStartY !== null && afterLongScroll.selectionEndY !== null, 'Both selection endpoints must remain visible through long-line formatting.');
  assert.ok(Math.abs(afterLongScroll.selectionStartY - beforeLongScroll.selectionStartY) <= 2 && Math.abs(afterLongScroll.selectionEndY - beforeLongScroll.selectionEndY) <= 2, 'Formatting must keep both selected endpoints anchored in the viewport when a long line reflows.');
  const scrollTopDrift = afterLongScroll.top - beforeLongScroll.top;
  const contentHeightDrift = afterLongScroll.contentHeight - beforeLongScroll.contentHeight;
  assert.ok(Math.abs(scrollTopDrift) <= beforeLongScroll.lineHeight * 2, `Wrapped source reflow must keep vertical scroll movement within two line heights (${scrollTopDrift}px).`);
  assert.ok(Math.abs(scrollTopDrift) <= Math.abs(contentHeightDrift) + beforeLongScroll.lineHeight, `Long-line scroll drift must be bounded by the source reflow (${scrollTopDrift}px vs ${contentHeightDrift}px content change).`);
  assert.equal(beforeLongScroll.left, 0, 'Horizontal scrolling stays unavailable while application wordWrap is on.');
  assert.equal(afterLongScroll.left, beforeLongScroll.left, 'Wrapped source must retain the zero horizontal offset.');
  results.scrollPreserved = {
    wordWrap: 'on',
    shortLine: { before: beforeShortScroll, after: afterShortScroll, numericScrollTopUnchanged: true },
    longWrappedLine: { before: beforeLongScroll, after: afterLongScroll, scrollTopReflowPixels: scrollTopDrift, contentHeightReflowPixels: contentHeightDrift, selectionViewportAnchored: true },
    horizontal: 'not active under the default wordWrap=on editor configuration',
  };

  // Existing insertion tools still open and cancel through the actual app ribbon.
  for (const name of ['Symbols', 'Table', 'Matrix']) {
    await page.getByRole('button', { name, exact: true }).click();
    const dialog = page.locator('.writing-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.getByRole('button', { name: name === 'Symbols' ? 'Close writing tools' : 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    results.smoke[name.toLowerCase()] = 'opened and canceled';
  }

  // A real Compile button click accepts a separately compiled in-memory fixture from mocked Tauri IPC.
  await page.locator('.engine-toggle-btn').click();
  await page.waitForFunction(() => window.__testEditor.getModel()?.getLanguageId() === 'latex');
  await setDocumentAndSelection(page, pdfFixtureSource);
  const compileButton = page.getByRole('button', { name: /Compile/ }).first();
  await compileButton.click();
  await page.waitForFunction(() => window.__testInvokeCalls.filter((call) => call.command === 'compile_document').length === 1, null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => window.__testCompileClicked), true, 'PDF fixture may enter the UI only after an actual Compile button click.');
  assert.equal(await page.evaluate((fixture) => window.__testInvokeCalls.find((call) => call.command === 'compile_document')?.args?.source, pdfFixtureSource), pdfFixtureSource, 'Compile button must send the current document source through mocked IPC.');
  await page.waitForFunction(() => Boolean(document.querySelector('#pdf-page-1 canvas')) && document.querySelector('#pdf-page-1 canvas').width > 0, null, { timeout: 30000 });
  const initialPdfCanvasWidth = await page.locator('#pdf-page-1 canvas').first().evaluate((canvas) => canvas.width);
  const zoomLevel = page.locator('.zoom-controls .btn-zoom-level');
  const zoomBefore = (await zoomLevel.textContent())?.trim();
  assert.ok(zoomBefore && /^\d+%$/.test(zoomBefore), `PDF zoom control is missing its current value: ${zoomBefore}`);
  const zoomButton = page.getByTitle('Zoom in', { exact: true });
  await zoomButton.click();
  await page.waitForFunction((previousZoom) => document.querySelector('.zoom-controls .btn-zoom-level')?.textContent?.trim() !== previousZoom, zoomBefore, { timeout: 10000 });
  const zoomAfterButton = (await zoomLevel.textContent())?.trim();
  await page.waitForFunction((priorWidth) => {
    const pageCanvases = document.querySelectorAll('#pdf-page-1 canvas');
    return pageCanvases.length === 1 && pageCanvases[0].width > priorWidth * 1.05;
  }, initialPdfCanvasWidth, { timeout: 15000 });
  const pdfBeforeFormatting = await page.evaluate(() => {
    const canvas = document.querySelector('#pdf-page-1 canvas');
    return { data: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, zoom: document.querySelector('.zoom-controls .btn-zoom-level')?.textContent?.trim() };
  });
  const retainedSource = String.raw`\documentclass{article}
\begin{document}
Retained PDF fixture from explicit isolated compilation.
\end{document}
`;
  await setDocumentAndSelection(page, retainedSource, 'Retained');
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Bold"]')?.disabled);
  await bold.click();
  await page.waitForFunction(() => window.__testEditor.getValue().includes(String.raw`\textbf{Retained}`));
  await page.waitForTimeout(250);
  const pdfAfterFormatting = await page.evaluate(() => {
    const canvas = document.querySelector('#pdf-page-1 canvas');
    return { data: canvas?.toDataURL('image/png'), width: canvas?.width, height: canvas?.height, zoom: document.querySelector('.zoom-controls .btn-zoom-level')?.textContent?.trim() };
  });
  assert.ok(pdfAfterFormatting.data, 'PDF canvas must remain visible after formatting.');
  assert.deepEqual(pdfAfterFormatting, pdfBeforeFormatting, 'Formatting must preserve retained PDF pixels, dimensions and zoom until explicit compilation.');
  results.retainedPdf = { compileOnlyAfterButtonClick: true, retainedCanvas: true, zoomBefore: zoomBefore, zoomAfterExplicitZoomClick: zoomAfterButton, zoomAfterFormatting: pdfAfterFormatting.zoom, mockedPdfBytes: pdfFixtureResponse.pdf_bytes.length, fixtureCompiledBy: 'sciencebatch --compile-worker before browser startup; response delivered only after the in-app Compile button click' };

  // Wide pressed state and all three themes retain visible, keyboard-focused controls.
  await page.setViewportSize({ width: 1280, height: 800 });
  await setDocumentAndSelection(page, 'wide café', 'café');
  await bold.click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Bold"]')?.getAttribute('aria-pressed') === 'true');
  const wideMainGap = await page.evaluate(() => {
    const main = document.querySelector('.writing-ribbon-main');
    const lastMainControl = main?.querySelector('.writing-ribbon-edit') ?? main?.querySelector('button.writing-ribbon-button:last-of-type');
    const format = document.querySelector('button[aria-label="Bold"]');
    if (!lastMainControl || !format) return null;
    return { lastControl: lastMainControl.getAttribute('aria-label') ?? lastMainControl.textContent.trim(), gap: format.getBoundingClientRect().left - lastMainControl.getBoundingClientRect().right };
  });
  assert.ok(wideMainGap && wideMainGap.gap >= 0 && wideMainGap.gap <= 16, `Wide Matrix-to-Bold gap must be 0–16px: ${JSON.stringify(wideMainGap)}`);
  results.layout.wideMainGap = wideMainGap;

  // A compatible existing matrix exposes Edit matrix as the final main control on wide layouts.
  const matrixSource = String.raw`$\begin{pmatrix}a & b \\ c & d\end{pmatrix}$`;
  await setDocumentAndSelection(page, matrixSource, 'a');
  const editMatrix = page.getByRole('button', { name: 'Edit matrix', exact: true });
  await editMatrix.waitFor({ state: 'visible' });
  const wideEditGap = await page.evaluate(() => {
    const edit = document.querySelector('.writing-ribbon-main .writing-ribbon-edit');
    const format = document.querySelector('button[aria-label="Bold"]');
    if (!edit || !format) return null;
    return { lastControl: edit.textContent.trim(), gap: format.getBoundingClientRect().left - edit.getBoundingClientRect().right };
  });
  assert.ok(wideEditGap && wideEditGap.gap >= 0 && wideEditGap.gap <= 16, `Wide compatible Edit matrix-to-Bold gap must be 0–16px: ${JSON.stringify(wideEditGap)}`);
  results.layout.wideEditGap = wideEditGap;

  await setDocumentAndSelection(page, 'wide café', 'café');
  await bold.click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Bold"]')?.getAttribute('aria-pressed') === 'true');
  await bold.focus();
  await page.keyboard.press('Tab');
  assert.equal(await italic.evaluate((element) => document.activeElement === element), true, 'Tab must visibly focus the adjacent formatting control.');
  assert.ok(await italic.evaluate((element) => getComputedStyle(element).outlineStyle !== 'none'), 'Keyboard focus must have a visible outline.');
  const wideBox = await bold.boundingBox();
  assert.ok(wideBox && wideBox.x >= 0 && wideBox.x + wideBox.width <= 1280 && wideBox.y >= 0 && wideBox.y + wideBox.height <= 800, 'Wide Bold control must stay inside the viewport.');
  const wideScreenshot = join(artifactDirectory, 'wide-bold-pressed.png');
  await page.screenshot({ path: wideScreenshot, fullPage: false });

  for (const [name, theme, menuName] of [['dark', 'dark', 'Dark (Default)'], ['light', 'light', 'Light'], ['monokai', 'monokai', 'Monokai']]) {
    await selectTheme(page, theme, menuName);
    const styles = await bold.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      color: getComputedStyle(element).color,
      bodyColor: getComputedStyle(document.body).color,
      pressed: element.getAttribute('aria-pressed'),
      visible: element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0,
    }));
    assert.equal(styles.pressed, 'true', `${name} theme must retain source-derived aria-pressed state.`);
    assert.equal(styles.visible, true, `${name} theme must keep Bold visible.`);
    assert.notEqual(styles.background, 'rgba(0, 0, 0, 0)', `${name} pressed state must have a visible active background.`);
    assert.notEqual(styles.color, styles.bodyColor, `${name} active control must be visually differentiated from body text.`);
    results.layout[name] = { pressed: styles.pressed, visible: styles.visible, background: styles.background, color: styles.color };
  }

  // Exercise Monaco's real LaTeX tokenizer and rendered command colors in every theme.
  const latexTokenSource = String.raw`\section{Heading}
\textbf{Bold}
\textit{Italic}
\emph{Function}
% \textbf{Comment}
\begin{verbatim}
\textbf{Verbatim}
\end{verbatim}
$\textbf{Math}$`;
  const latexTokensByTheme = {};
  for (const [name, theme, menuName] of [['dark', 'dark', 'Dark (Default)'], ['light', 'light', 'Light'], ['monokai', 'monokai', 'Monokai']]) {
    await selectTheme(page, theme, menuName);
    await setDocumentAndSelection(page, latexTokenSource);
    await page.waitForFunction(() => {
      const editor = window.__testEditor;
      if (editor.getModel()?.getLanguageId() !== 'latex') return false;
      const rows = Array.from(editor.getDomNode().querySelectorAll('.view-lines .view-line')).map((row) => row.textContent ?? '');
      const lines = editor.getValue().split('\n');
      if (!rows.some((row) => row.includes(lines[0])) || !rows.some((row) => row.includes(lines[1]))) return false;
      const commandStart = editor.getScrolledVisiblePosition({ lineNumber: 2, column: 2 });
      const commandEnd = editor.getScrolledVisiblePosition({ lineNumber: 2, column: 8 });
      const bodyStart = editor.getScrolledVisiblePosition({ lineNumber: 1, column: 10 });
      const bodyEnd = editor.getScrolledVisiblePosition({ lineNumber: 1, column: 17 });
      if (!commandStart || !commandEnd || !bodyStart || !bodyEnd) return false;
      const rect = editor.getDomNode().getBoundingClientRect();
      const colorAt = (start, end) => {
        const element = document.elementFromPoint(rect.left + (start.left + end.left) / 2, rect.top + start.top + start.height / 2);
        return element ? getComputedStyle(element).color : null;
      };
      const commandColor = colorAt(commandStart, commandEnd);
      return Boolean(commandColor && colorAt(bodyStart, bodyEnd) && commandColor !== colorAt(bodyStart, bodyEnd));
    }, null, { timeout: 5000 });
    const tokenSnapshot = await page.evaluate(() => {
      const lines = window.__testEditor.getValue().split('\n');
      const tokenLines = monaco.editor.tokenize(window.__testEditor.getValue(), 'latex');
      const tokenAt = (lineNumber, needle) => {
        const line = lines[lineNumber - 1];
        const offset = line.indexOf(needle);
        const tokens = tokenLines[lineNumber - 1] ?? [];
        const tokenIndex = tokens.findIndex((token, index) => token.offset <= offset && (tokens[index + 1]?.offset ?? line.length) > offset);
        if (offset < 0 || tokenIndex < 0) return null;
        return { type: tokens[tokenIndex].type, language: tokens[tokenIndex].language };
      };
      const renderedColor = (lineNumber, needle) => {
        const line = lines[lineNumber - 1];
        const offset = line.indexOf(needle);
        const start = window.__testEditor.getScrolledVisiblePosition({ lineNumber, column: offset + 1 });
        const end = window.__testEditor.getScrolledVisiblePosition({ lineNumber, column: offset + needle.length + 1 });
        if (!start || !end) return null;
        const rect = window.__testEditor.getDomNode().getBoundingClientRect();
        const element = document.elementFromPoint(rect.left + (start.left + end.left) / 2, rect.top + start.top + start.height / 2);
        return element ? { color: getComputedStyle(element).color, text: element.textContent, className: element.className } : null;
      };
      return {
        language: window.__testEditor.getModel().getLanguageId(), theme: document.documentElement.dataset.theme,
        renderedLines: Array.from(window.__testEditor.getDomNode().querySelectorAll('.view-lines .view-line')).map((row) => row.textContent ?? ''),
        textbf: tokenAt(2, '\\textbf'), textit: tokenAt(3, '\\textit'), section: tokenAt(1, '\\section'),
        function: tokenAt(4, '\\emph'), comment: tokenAt(5, '\\textbf'), verbatim: tokenAt(7, '\\textbf'), math: tokenAt(9, '\\textbf'),
        rendered: {
          textbf: renderedColor(2, '\\textbf'), textit: renderedColor(3, '\\textit'), section: renderedColor(1, '\\section'), body: renderedColor(1, 'Heading'),
        },
      };
    });
    assert.equal(tokenSnapshot.language, 'latex', `${name}: visual token check must use the actual LaTeX editor model.`);
    assert.ok(tokenSnapshot.renderedLines.some((line) => line.includes(String.raw`\section{Heading}`)), `${name}: Monaco DOM must render the visible keyword line from the actual model.`);
    assert.ok(tokenSnapshot.renderedLines.some((line) => line.includes(String.raw`\textbf{Bold}`)), `${name}: Monaco DOM must render the visible formatting command line from the actual model.`);
    assert.equal(tokenSnapshot.textbf?.type, 'keyword.latex', `${name}: \\textbf in normal text must tokenize as keyword.latex.`);
    assert.equal(tokenSnapshot.textit?.type, 'keyword.latex', `${name}: \\textit in normal text must tokenize as keyword.latex.`);
    assert.equal(tokenSnapshot.section?.type, 'keyword.latex', `${name}: \\section must remain a known keyword reference.`);
    assert.equal(tokenSnapshot.function?.type, 'support.function.latex', `${name}: unrelated \\emph must remain a support.function token.`);
    assert.equal(tokenSnapshot.comment?.type, 'comment.latex', `${name}: \\textbf inside a comment must remain a comment.`);
    assert.equal(tokenSnapshot.verbatim?.type, 'string.verbatim.latex', `${name}: \\textbf inside verbatim must remain verbatim text.`);
    assert.equal(tokenSnapshot.math?.type, 'keyword.math.latex', `${name}: \\textbf inside math must remain a math command.`);
    for (const key of ['textbf', 'textit', 'section', 'body']) assert.ok(tokenSnapshot.rendered[key], `${name}: Monaco must render ${key} in the DOM.`);
    assert.equal(tokenSnapshot.rendered.textbf.color, tokenSnapshot.rendered.section.color, `${name}: rendered \\textbf must match the known keyword \\section color.`);
    assert.equal(tokenSnapshot.rendered.textit.color, tokenSnapshot.rendered.section.color, `${name}: rendered \\textit must match the known keyword \\section color.`);
    assert.notEqual(tokenSnapshot.rendered.textbf.color, tokenSnapshot.rendered.body.color, `${name}: rendered formatting command color must differ from ordinary body text: ${JSON.stringify(tokenSnapshot)}`);
    latexTokensByTheme[name] = tokenSnapshot;
  }
  results.latexTokensByTheme = latexTokensByTheme;

  // Compact screenshot verifies Bold/Italic stay alongside Insert at the required viewport.
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForTimeout(100);
  results.layout.compact = {};
  results.screenshots = { wideScreenshot };
  for (const [name, theme, menuName] of [['dark', 'dark', 'Dark (Default)'], ['light', 'light', 'Light'], ['monokai', 'monokai', 'Monokai']]) {
    await selectTheme(page, theme, menuName);
    await setDocumentAndSelection(page, '$x + y$', 'x + y');
    await page.waitForFunction(() => document.querySelector('button[aria-label="Bold"]')?.disabled);
    const disabledTitle = await bold.getAttribute('title');
    assert.ok(disabledTitle && /math|unavailable|cannot|directly/i.test(disabledTitle), `${name} compact disabled Bold control must explain the protected context.`);
    await setDocumentAndSelection(page, 'compact café', 'café');
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Bold"]')?.disabled);
    await bold.click();
    await page.waitForFunction(() => document.querySelector('button[aria-label="Bold"]')?.getAttribute('aria-pressed') === 'true');
    await bold.focus();
    await page.keyboard.press('Tab');
    assert.equal(await italic.evaluate((element) => document.activeElement === element), true, `${name} compact mode must keep both formatting controls keyboard reachable.`);
    assert.ok(await italic.evaluate((element) => getComputedStyle(element).outlineStyle !== 'none'), `${name} compact Italic keyboard focus must stay visible.`);
    const compactLayout = await page.evaluate(() => {
      const bounds = (selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect ? { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
      };
      return { bold: bounds('button[aria-label="Bold"]'), italic: bounds('button[aria-label="Italic"]'), insert: bounds('.writing-ribbon-compact > button'), ribbon: bounds('.writing-ribbon') };
    });
    for (const control of ['bold', 'italic', 'insert']) {
      const box = compactLayout[control];
      assert.ok(box && box.width > 0 && box.height > 0, `Compact ${name} ${control} control must remain visible.`);
      assert.ok(box.x >= 0 && box.right <= 900 && box.y >= 0 && box.bottom <= 600, `Compact ${name} ${control} must stay inside 900×600 viewport bounds.`);
    }
    assert.equal(await bold.getAttribute('aria-pressed'), 'true', `Compact ${name} Bold state must remain source-derived.`);
    const compactScreenshot = join(artifactDirectory, `compact-900x600-${name}.png`);
    await page.screenshot({ path: compactScreenshot, fullPage: false });
    results.layout.compact[name] = compactLayout;
    results.screenshots[name] = compactScreenshot;
  }

  // The compact Insert menu must retain compatible editors and omit unsupported source actions.
  await page.locator('.engine-toggle-btn').click();
  await page.waitForFunction(() => window.__testEditor.getModel()?.getLanguageId() === 'typst', null, { timeout: 10000 });
  await waitForBridge(page);
  await page.evaluate(() => { delete window.__testStructureContextModel; });
  await setDocumentAndSelection(page, compatibleTypstTable, 'A');
  const insertTrigger = page.getByRole('button', { name: /Insert/ });
  await insertTrigger.click();
  const compactMenu = page.getByRole('menu');
  await compactMenu.waitFor({ state: 'visible' });
  await compactMenu.getByRole('menuitem', { name: 'Edit table', exact: true }).waitFor({ state: 'visible' });

  // The existing menu remains mounted while the test moves the cursor through the new source fixture.
  // This lets the actual compact menu reflect cursor-dependent actions even when Insert becomes disabled.
  await setDocumentAndSelection(page, unsupportedTypstFigure);
  const compactBeforeOffset = await moveCursorInCurrentModel(page, unsupportedTypstFigure, 'Before text', 3);
  await waitForRibbonContext(page, compactBeforeOffset, false);
  const compactUnsupportedOffset = await moveCursorInCurrentModel(page, unsupportedTypstFigure, '[x]', 1);
  await waitForRibbonContext(page, compactUnsupportedOffset, true);
  assert.match(await page.locator('.writing-ribbon-hint').getAttribute('title'), /table|unsupported|directly in the source/i, 'Compact unsupported Typst table must expose its manual-edit reason.');
  assert.equal(await page.locator('.writing-ribbon-edit').count(), 0, 'Compact unsupported Typst table must not expose an Edit source button.');
  assert.equal(await compactMenu.getByRole('menuitem', { name: /Edit source/i }).count(), 0, 'Compact Insert menu must omit Edit source for unsupported structures.');
  assert.equal(await compactMenu.getByRole('menuitem', { name: 'Edit table', exact: true }).count(), 0, 'Compact Insert menu must omit an edit action for an incompatible table.');
  await page.locator('.editor-container').click({ position: { x: 20, y: 20 } });
  await compactMenu.waitFor({ state: 'hidden' });
  assert.equal(await source(page), unsupportedTypstFigure, 'Opening and closing the compact menu must preserve unsupported Typst source.');

  for (const [kind, fixture, marker] of [
    ['table', compatibleTypstTable, 'A'],
    ['matrix', compatibleTypstMatrix, 'a'],
  ]) {
    await setDocumentAndSelection(page, fixture, marker);
    const trigger = page.getByRole('button', { name: /Insert/ });
    await trigger.click();
    const menu = page.getByRole('menu');
    await menu.waitFor({ state: 'visible' });
    const editItem = menu.getByRole('menuitem', { name: `Edit ${kind}`, exact: true });
    await editItem.waitFor({ state: 'visible' });
    await editItem.click();
    await page.getByRole('heading', { name: `Edit ${kind}`, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.writing-dialog'));
    assert.equal(await source(page), fixture, `Compact Edit ${kind} cancel must preserve exact source.`);
  }
  results.structureContexts.typstCompact = { unsupportedMenuOmitsEditSource: true, tableAndMatrixEditMenuItemsRetained: true, canceledEditsPreserveSource: true };

  const calls = await page.evaluate(() => window.__testInvokeCalls);
  const commands = calls.map((call) => call.command);
  assert.equal(calls.filter((call) => call.command === 'compile_document').length, 1, `Exactly one compile should occur from the explicit Compile button: ${commands.join(', ')}`);
  assert.equal(calls.filter((call) => /write_file_content|save/i.test(call.command)).length, 0, `Formatting UI must not save or write source: ${commands.join(', ')}`);
  await noRuntimeErrors(page, pageErrors, 'Text formatting browser regression');
  results.runtimeErrors = pageErrors.length;
  results.unhandledRejections = await page.evaluate(() => window.__testUnhandledRejections.length);
  results.ipc = { explicitCompileCalls: 1, formattingSaveOrWriteCalls: 0, mockBoundary: 'Tauri invoke/event IPC only; no native GTK/WebKit, clipboard, or compiler invocation from formatting actions' };
  const monacoRuntime = await page.evaluate(() => {
    const source = performance.getEntriesByType('resource').find((entry) => /\/vs\/editor\/editor\.main\.js/.test(entry.name))?.name ?? 'unknown';
    return { version: source.match(/monaco-editor@([^/]+)/)?.[1] ?? 'unknown', source };
  });
  results.testFixtures = { app: 'real App, EditorView, and WritingRibbon; Quick Typst scratchpad', monacoRuntime, workspaceReadOnly: 'simulated EditorView readOnlyRef and Monaco option with direct WritingRibbon state fixture; does not simulate a Git operation or parent prop transition', browser: 'headless Chromium through Playwright; Tauri invoke/event mocked; Vite server started and closed by the script on an owned available localhost port' };
  results.screenshots.directory = artifactDirectory;
  console.log(JSON.stringify({ status: 'passed', ...results }, null, 2));
} catch (error) {
  const unhandledRejections = activePage?.isClosed() ? [] : await activePage?.evaluate(() => window.__testUnhandledRejections).catch(() => []);
  console.error(JSON.stringify({
    status: 'failed',
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    capturedBrowserErrors: activePageErrors,
    capturedUnhandledRejections: unhandledRejections,
  }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await vite.close();
}
