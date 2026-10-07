import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Run `pnpm dev --host 127.0.0.1 --port 1422 --strictPort` first, then run this script.
// PLAYWRIGHT_MODULE, PLAYWRIGHT_CHROMIUM_EXECUTABLE, and SCIENCEBATCH_TEST_URL can override the runtime paths.
const playwrightModule = process.env.PLAYWRIGHT_MODULE || '/home/mauri/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/mauri/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const baseUrl = process.env.SCIENCEBATCH_TEST_URL || 'http://127.0.0.1:1422';
const playwrightSpecifier = playwrightModule.startsWith('/') ? pathToFileURL(playwrightModule).href : playwrightModule;
const { chromium } = await import(playwrightSpecifier);
const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });

const attachRuntimeCapture = page => {
  const errors = [];
  page.on('pageerror', error => errors.push({ kind: 'pageerror', message: error.message, stack: error.stack }));
  return errors;
};
const installTauriMock = async page => page.addInitScript(() => {
  window.__testInvokeCalls = [];
  window.__testUnhandledRejections = [];
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      window.__testInvokeCalls.push({ command, args });
      if (command === 'plugin:event|listen') return 1;
      return null;
    },
    transformCallback: () => 1,
    unregisterCallback: () => {},
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.addEventListener('unhandledrejection', event => {
    window.__testUnhandledRejections.push({ message: event.reason?.message ?? String(event.reason), stack: event.reason?.stack });
  });
});
const exposeAppEditor = async page => page.evaluate(() => {
  const fiberFor = element => element && element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
  let editor = null;
  for (let fiber = fiberFor(document.querySelector('.editor-container')); fiber && !editor; fiber = fiber.return) {
    for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      const candidate = hook.memoizedState?.current;
      if (candidate?.getModel && candidate?.executeEdits) { editor = candidate; break; }
    }
  }
  if (!editor) throw new Error('Could not find the mounted Monaco editor');
  window.__testEditor = editor;
  let appFiber = fiberFor(document.querySelector('.app-layout'));
  while (appFiber && appFiber.type?.name !== 'App') appFiber = appFiber.return;
  const hooks = [];
  for (let hook = appFiber?.memoizedState; hook; hook = hook.next) hooks.push(hook);
  const bridge = hooks.map(hook => hook.memoizedState).find(value =>
    value && ['capture', 'isCurrent', 'apply', 'restore'].every(name => typeof value[name] === 'function'));
  window.__testBridge = bridge ?? null;
  window.__testHooks = hooks;
  return {
    monacoVersion: monaco.version,
    option: editor.getOption(monaco.editor.EditorOption.occurrencesHighlight),
    language: editor.getModel()?.getLanguageId(),
    source: editor.getValue(),
    hasBridge: Boolean(bridge),
    tabs: [...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent.trim()),
  };
});
const openScratchpad = async page => {
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Quick Typst', exact: true }).click();
  await page.waitForSelector('.monaco-editor', { timeout: 60000 });
  await page.waitForFunction(() => Boolean(document.querySelector('.editor-container')?.[Object.keys(document.querySelector('.editor-container')).find(key => key.startsWith('__reactFiber$'))]), null, { timeout: 10000 });
  await page.waitForTimeout(300);
  return exposeAppEditor(page);
};
const waitForAppBridge = async page => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const info = await exposeAppEditor(page);
    if (info.hasBridge) return info;
    await page.waitForTimeout(150);
  }
  throw new Error('The application did not publish a writing editor bridge after mounting.');
};
const zeroRuntimeErrors = async (errors, page, label) => {
  await page.waitForTimeout(100);
  const rejections = await page.evaluate(() => window.__testUnhandledRejections);
  assert.deepEqual(errors, [], `${label} page errors: ${JSON.stringify(errors)}`);
  assert.deepEqual(rejections, [], `${label} unhandled rejections: ${JSON.stringify(rejections)}`);
  return rejections;
};

try {
  // Real-runtime positive control: changing models while WordHighlighter is enabled must reproduce Canceled.
  const positivePage = await browser.newPage();
  const positiveErrors = attachRuntimeCapture(positivePage);
  await installTauriMock(positivePage);
  const positiveInfo = await openScratchpad(positivePage);
  const runtimeScriptUrl = await positivePage.evaluate(() => performance.getEntriesByType('resource').find(entry => /\/vs\/editor\/editor\.main\.js/.test(entry.name))?.name ?? 'unknown');
  await positivePage.evaluate(() => window.__testEditor.updateOptions({ occurrencesHighlight: 'singleFile' }));
  await positivePage.waitForTimeout(120);
  for (let index = 0; index < 5; index += 1) {
    await positivePage.evaluate(index => {
      const editor = window.__testEditor;
      const next = monaco.editor.createModel('alpha beta alpha', 'typst', monaco.Uri.parse(`inmemory://sciencebatch-positive/${index}.typ`));
      editor.focus();
      editor.setPosition({ lineNumber: 1, column: editor.getPosition().column === 2 ? 3 : 2 });
      editor.setModel(next);
    }, index);
    await positivePage.waitForTimeout(150);
  }
  assert(positiveErrors.every(error => error.message === 'Canceled'), `Positive control had unrelated runtime errors: ${JSON.stringify(positiveErrors)}`);
  const positiveRejections = await positivePage.evaluate(() => window.__testUnhandledRejections);
  assert(positiveRejections.every(error => error.message === 'Canceled'), `Positive control had unrelated unhandled rejections: ${JSON.stringify(positiveRejections)}`);
  assert(positiveErrors.some(error => error.message === 'Canceled') || positiveRejections.some(error => error.message === 'Canceled'), 'Expected the positive control to surface a Canceled runtime error.');
  await positivePage.close();

  // Mitigation control: run the same rapid model replacement sequence with the product option.
  const mitigationPage = await browser.newPage();
  const mitigationErrors = attachRuntimeCapture(mitigationPage);
  await installTauriMock(mitigationPage);
  const mitigationInfo = await openScratchpad(mitigationPage);
  assert.equal(mitigationInfo.option, 'off', `Product option was ${mitigationInfo.option}, expected off`);
  for (let index = 0; index < 5; index += 1) {
    await mitigationPage.evaluate(index => {
      const editor = window.__testEditor;
      const next = monaco.editor.createModel(`mitigated alpha ${index}`, 'typst', monaco.Uri.parse(`inmemory://sciencebatch-mitigated/${index}.typ`));
      editor.focus();
      editor.setPosition({ lineNumber: 1, column: editor.getPosition().column === 2 ? 3 : 2 });
      editor.setModel(next);
    }, index);
    await mitigationPage.waitForTimeout(100);
  }
  const mitigationRejections = await zeroRuntimeErrors(mitigationErrors, mitigationPage, 'Mitigated rapid model changes');
  await mitigationPage.close();

  // Real App / Toolbar / WorkspaceTabs path with a transparently mocked Tauri boundary.
  const appPage = await browser.newPage();
  const appErrors = attachRuntimeCapture(appPage);
  await installTauriMock(appPage);
  const appInfo = await openScratchpad(appPage);
  await appPage.waitForTimeout(350);
  const initialOption = await appPage.evaluate(() => window.__testEditor.getOption(monaco.editor.EditorOption.occurrencesHighlight));
  assert.equal(initialOption, 'off', 'The mounted application editor must keep occurrence highlighting disabled.');

  const source = '#let original = 7\n$original + 2$\n';
  await appPage.evaluate(() => window.__testEditor.focus());
  await appPage.keyboard.press('Control+A');
  await appPage.keyboard.insertText(source);
  await appPage.waitForFunction(expected => window.__testEditor.getValue() === expected, source, { timeout: 10000 });
  const actualSource = await appPage.evaluate(() => window.__testEditor.getValue());
  assert.equal(actualSource, source, 'Typing into the real Monaco editor must update the exact source string.');

  const initialSession = await appPage.evaluate(() => window.__testBridge?.capture());
  assert(initialSession, 'The real application must publish a current writing session.');
  const applyResult = await appPage.evaluate(session => window.__testBridge.apply(session, {
    start: session.source.length,
    end: session.source.length,
    text: '// writing bridge edit\n',
  }), initialSession);
  assert(applyResult, 'A current writing session must accept an edit.');
  const editedSource = `${source}// writing bridge edit\n`;
  await appPage.waitForFunction(expected => window.__testEditor.getValue() === expected, editedSource, { timeout: 10000 });
  const focusedAfterApply = await appPage.evaluate(() => Boolean(document.activeElement?.closest('.monaco-editor')));
  assert(focusedAfterApply, 'Applying a writing edit must return focus to Monaco.');
  await appPage.evaluate(() => window.__testEditor.trigger('test', 'undo'));
  await appPage.waitForFunction(expected => window.__testEditor.getValue() === expected, source, { timeout: 10000 });
  await appPage.evaluate(() => window.__testEditor.trigger('test', 'redo'));
  await appPage.waitForFunction(expected => window.__testEditor.getValue() === expected, editedSource, { timeout: 10000 });

  const staleBeforeEngineSwitch = await appPage.evaluate(() => window.__testBridge.capture());
  assert(staleBeforeEngineSwitch, 'Expected a current Typst session before engine switch.');
  await appPage.locator('.engine-toggle-btn').click();
  await appPage.waitForFunction(() => document.querySelector('.engine-toggle-btn')?.getAttribute('title')?.includes('Currently: LaTeX'), null, { timeout: 10000 });
  await appPage.waitForFunction(() => window.__testEditor.getModel()?.getLanguageId() === 'latex', null, { timeout: 10000 });
  assert.equal(await appPage.evaluate(() => window.__testEditor.getValue()), editedSource, 'Engine switching must preserve the exact edited source.');
  const rejectedEngineSession = await appPage.evaluate(session => window.__testBridge.isCurrent(session), staleBeforeEngineSwitch);
  assert.equal(rejectedEngineSession, false, 'The previous session must be rejected after the engine context changes.');
  const rejectedEngineApply = await appPage.evaluate(session => window.__testBridge.apply(session, { start: session.source.length, end: session.source.length, text: '// stale edit' }), staleBeforeEngineSwitch);
  assert.equal(rejectedEngineApply, null, 'A stale engine session must not apply an edit.');
  assert.equal(await appPage.evaluate(() => window.__testEditor.getValue()), editedSource, 'Rejecting a stale engine session must leave source unchanged.');
  await appPage.locator('.engine-toggle-btn').click();
  await appPage.waitForFunction(() => document.querySelector('.engine-toggle-btn')?.getAttribute('title')?.includes('Currently: Typst'), null, { timeout: 10000 });
  await appPage.waitForFunction(() => window.__testEditor.getModel()?.getLanguageId() === 'typst', null, { timeout: 10000 });
  assert.equal(await appPage.evaluate(() => window.__testEditor.getValue()), editedSource, 'Switching back must preserve the exact edited source.');
  assert.equal(await appPage.evaluate(session => window.__testBridge.isCurrent(session), staleBeforeEngineSwitch), false, 'The old session must remain invalid after switching back.');
  assert.equal(await appPage.evaluate(session => window.__testBridge.apply(session, { start: session.source.length, end: session.source.length, text: '// stale after round-trip' }), staleBeforeEngineSwitch), null, 'The invalidated engine session must remain unable to edit after switching back.');
  assert.equal(await appPage.evaluate(() => window.__testEditor.getValue()), editedSource, 'Rejecting an old engine session after round-trip must leave source unchanged.');

  // Seed a second test-only workspace tab in App state; switch it through the actual tab buttons and app callback.
  const secondSource = '#let secondary = 99\n$secondary$\n';
  const tabSetup = await appPage.evaluate(content => {
    const fiberFor = element => element && element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
    let appFiber = fiberFor(document.querySelector('.app-layout'));
    while (appFiber && appFiber.type?.name !== 'App') appFiber = appFiber.return;
    const hooks = [];
    for (let hook = appFiber?.memoizedState; hook; hook = hook.next) hooks.push(hook);
    const tabsHook = hooks.find(hook => Array.isArray(hook.memoizedState) && hook.memoizedState.length && hook.memoizedState.every(tab => tab?.id && tab?.kind));
    if (!tabsHook?.queue?.dispatch) throw new Error('Could not locate useProject workspace tab state for test setup');
    const current = tabsHook.memoizedState;
    const tabRefHook = hooks.find(hook => hook.memoizedState?.current === current);
    if (!tabRefHook) throw new Error('Could not locate workspace tab ref for test setup');
    const second = { ...current[0], id: 'source:test-secondary', path: null, name: 'Secondary.typ', content, savedContent: content, pinned: true, preview: false };
    const next = [...current, second];
    tabRefHook.memoizedState.current = next;
    tabsHook.queue.dispatch(next);
    return { names: [...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent.trim()) };
  }, secondSource);
  await appPage.getByRole('tab', { name: /Secondary\.typ/ }).waitFor();
  const testedTabNames = await appPage.locator('[role="tab"]').allTextContents();
  const staleBeforeTabSwitch = await appPage.evaluate(() => window.__testBridge.capture());
  assert(staleBeforeTabSwitch, 'Expected a current session before the tab switch.');
  await appPage.getByRole('tab', { name: /Secondary\.typ/ }).click();
  await appPage.waitForFunction(() => document.querySelector('.workspace-tab.active [role="tab"]')?.textContent?.includes('Secondary.typ'), null, { timeout: 10000 });
  await appPage.waitForTimeout(250);
  const secondaryInfo = await waitForAppBridge(appPage);
  assert.equal(secondaryInfo.source, secondSource, 'The secondary tab must display its exact fixture source.');
  assert.equal(await appPage.evaluate(() => window.__testEditor.getValue()), secondSource, 'The secondary tab must display its exact fixture source.');
  const rejectedTabSession = await appPage.evaluate(session => session && window.__testBridge?.isCurrent(session), staleBeforeTabSwitch);
  assert.equal(rejectedTabSession, false, 'The old tab session must be rejected after switching tabs.');
  const rejectedTabApply = await appPage.evaluate(session => window.__testBridge.apply(session, { start: session.source.length, end: session.source.length, text: '// stale tab edit' }), staleBeforeTabSwitch);
  assert.equal(rejectedTabApply, null, 'A stale tab session must not apply an edit.');
  assert.equal(await appPage.evaluate(() => window.__testEditor.getValue()), secondSource, 'Rejecting a stale tab session must leave the active source unchanged.');
  await appPage.getByRole('tab', { name: /Untitled\.typ/ }).click();
  await appPage.waitForFunction(() => document.querySelector('.workspace-tab.active [role="tab"]')?.textContent?.includes('Untitled.typ'), null, { timeout: 10000 });
  await appPage.waitForTimeout(250);
  const originalTabInfo = await waitForAppBridge(appPage);
  assert.equal(originalTabInfo.source, editedSource, 'Returning to the original tab must preserve its exact source.');
  assert.equal(await appPage.evaluate(session => window.__testBridge.isCurrent(session), staleBeforeTabSwitch), false, 'The old tab session must remain invalid after returning.');
  assert.equal(await appPage.evaluate(session => window.__testBridge.apply(session, { start: session.source.length, end: session.source.length, text: '// stale after tab round-trip' }), staleBeforeTabSwitch), null, 'The invalidated tab session must remain unable to edit after returning.');
  assert.equal(await appPage.evaluate(() => window.__testEditor.getValue()), editedSource, 'Rejecting an old tab session after returning must leave source unchanged.');

  const restoredSession = await appPage.evaluate(() => window.__testBridge.capture());
  assert(restoredSession, 'The restored tab must publish a fresh current session.');
  const restoredEdit = await appPage.evaluate(session => window.__testBridge.apply(session, { start: session.source.length, end: session.source.length, text: '// restored tab edit\n' }), restoredSession);
  assert(restoredEdit, 'A fresh session after tab switching must still edit.');
  const restoredSource = `${editedSource}// restored tab edit\n`;
  await appPage.waitForFunction(expected => window.__testEditor.getValue() === expected, restoredSource, { timeout: 10000 });
  assert(await appPage.evaluate(() => Boolean(document.activeElement?.closest('.monaco-editor'))), 'A fresh edit after tab switching must focus Monaco.');
  await appPage.evaluate(() => window.__testEditor.trigger('test', 'undo'));
  await appPage.waitForFunction(expected => window.__testEditor.getValue() === expected, editedSource, { timeout: 10000 });
  await appPage.evaluate(() => window.__testEditor.trigger('test', 'redo'));
  await appPage.waitForFunction(expected => window.__testEditor.getValue() === expected, restoredSource, { timeout: 10000 });

  const commands = await appPage.evaluate(() => window.__testInvokeCalls.map(call => call.command));
  assert.equal(commands.filter(command => /compile/i.test(command)).length, 0, `UI/editor transitions must not compile: ${commands.join(', ')}`);
  assert.equal(commands.filter(command => /write_file_content|save/i.test(command)).length, 0, `UI/editor transitions must not save or write: ${commands.join(', ')}`);
  await zeroRuntimeErrors(appErrors, appPage, 'Application engine/tab/session workflow');
  const appUnhandledRejections = await appPage.evaluate(() => window.__testUnhandledRejections);
  await appPage.close();

  console.log(JSON.stringify({
    runtime: { monacoVersion: runtimeScriptUrl.match(/monaco-editor@([^/]+)/)?.[1] ?? positiveInfo.monacoVersion ?? 'unknown', source: runtimeScriptUrl },
    positiveControl: { modelChanges: 5, canceledErrors: positiveErrors.filter(error => error.message === 'Canceled').length + positiveRejections.filter(error => error.message === 'Canceled').length, otherRuntimeErrors: positiveErrors.filter(error => error.message !== 'Canceled').length + positiveRejections.filter(error => error.message !== 'Canceled').length },
    mitigation: { modelChanges: 5, runtimeErrors: mitigationErrors.length, unhandledRejections: mitigationRejections.length },
    application: { engineSwitches: 2, tabSwitches: 2, sourcePreserved: true, staleEngineSessionRejected: true, staleTabSessionRejected: true, editorFocusedAfterEdit: focusedAfterApply, undoRedo: true, runtimeErrors: appErrors.length, unhandledRejections: appUnhandledRejections.length, unexpectedCompileOrSaveCalls: 0, tabFixture: testedTabNames.map(name => name.trim()) },
  }, null, 2));
} finally {
  await browser.close();
}
