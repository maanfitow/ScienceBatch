import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';

const outputDirectory = process.env.PROJECT_RESOURCES_SCREENSHOT_DIR || await mkdtemp(join(tmpdir(), 'sciencebatch-project-resources-'));
const playwrightModule = process.env.PLAYWRIGHT_MODULE || '/home/mauri/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/mauri/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const playwrightSpecifier = playwrightModule.startsWith('/') ? pathToFileURL(playwrightModule).href : playwrightModule;
const { chromium } = await import(playwrightSpecifier);
const pdf = [...await readFile(resolve('src-tauri/vendor/tectonic/tests/tex-outputs/the_letter_a.pdf'))];
const vite = await createServer({ configFile: resolve('vite.config.ts'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
const failures = [];

try {
  await mkdir(outputDirectory, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: executable });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => failures.push(error.message));
  await page.addInitScript(pdfBytes => {
    localStorage.setItem('sciencebatch_sidebar_state_v1', JSON.stringify({ topTools: ['files', 'search', 'git'], bottomTools: ['outline'], activeTopTool: 'files', activeBottomTool: null, isOpen: true, panelWidth: 22, splitRatio: 50 }));
    window.__resourceCalls = [];
    window.__analysisRequests = [];
    window.__planRequests = [];
    window.__listRequests = [];
    window.__cacheRequests = [];
    window.__cacheRemoveRequests = [];
    window.__prepareRequests = [];
    window.__testInvokeCalls = [];
    window.__activeAnalyzeRequests = 0;
    window.__maxConcurrentAnalyzeRequests = 0;
    window.__delayNextAnalyze = false;
    window.__releaseAnalyze = null;
    window.__pendingPrepare = null;
    window.__prepareImmediately = false;
    window.__failNextPrepare = false;
    window.__failNextCacheRemove = false;
    window.__deferNextResourceList = false;
    window.__releaseResourceList = null;
    window.__cancelCompletesFirst = false;
    window.__deferNextCancel = false;
    window.__pendingCancel = null;
    window.__resolvePendingPrepareReady = () => {
      const pending = window.__pendingPrepare;
      if (!pending) throw new Error('There is no pending resource preparation');
      pending.resolve({ prepared: true, plan: planFor(pending.request, 'ready') });
      window.__pendingPrepare = null;
    };
    window.__scenario = 'cold';
    window.__compileResponse = { pdf_bytes: pdfBytes, success: true, errors: [], warnings: [], raw_log: '' };
    window.__compileError = null;
    window.__delayNextCompile = false;
    window.__releaseCompile = null;
    window.__planSequence = 0;
    window.__constantPlanDigest = null;
    window.__hotCache = false;
    const planFor = (request, scenario = window.__scenario) => {
      const selected = request.selection ?? [];
      const source = request.overlays?.[request.mainFile] ?? '';
      const inputDigest = `input-${btoa(unescape(encodeURIComponent(source))).slice(-18)}`;
      const status = {
        cold: { projectState: 'not_prepared', bundleMetadataState: 'cached_verified', missingResources: 2, invalidResources: 0, estimatedTransferBytes: 14829601, incrementalStorageBytes: 14829601, metadataStorageBytes: 0 },
        metadata: { projectState: 'not_prepared', bundleMetadataState: 'missing', missingResources: 0, invalidResources: 0, estimatedTransferBytes: 0, incrementalStorageBytes: 0, metadataStorageBytes: 5143485 },
        invalidMetadata: { projectState: 'blocked', bundleMetadataState: 'invalid', missingResources: 0, invalidResources: 0, estimatedTransferBytes: 0, incrementalStorageBytes: 0, metadataStorageBytes: 0 },
        invalidBody: { projectState: 'not_prepared', bundleMetadataState: 'cached_verified', missingResources: 0, invalidResources: 1, estimatedTransferBytes: 64, incrementalStorageBytes: 64, metadataStorageBytes: 0 },
        ready: { projectState: 'prepared_known_set', bundleMetadataState: 'cached_verified', missingResources: 0, invalidResources: 0, estimatedTransferBytes: 0, incrementalStorageBytes: 0, metadataStorageBytes: 0 },
      }[scenario];
      const sequence = ++window.__planSequence;
      return {
        resourceSchemaVersion: 1, project: request.workspaceIdentity?.projectName ?? 'scratch', engine: request.engine, mainFile: request.mainFile,
        inputDigest, planDigest: window.__constantPlanDigest ?? `plan-${sequence}-${selected.map(item => item.id).join('-') || 'base'}`, bundleDigest: 'bundle-sha256',
        indexSha256: 'index-sha256', bundleUrl: 'local-qa-capture', catalogSha256: 'catalog-sha256',
        catalogPacks: [{ id: 'latex-basic', label: 'LaTeX Basic' }, { id: 'latex-icons', label: 'Icons' }],
        coverage: 'known', selection: selected, projectState: status.projectState, bundleMetadataState: status.bundleMetadataState,
        summary: { totalResources: 2, resolvedResources: 2, cachedVerifiedResources: scenario === 'cold' || scenario === 'invalidBody' ? 0 : 2,
          missingResources: status.missingResources, invalidResources: status.invalidResources, unresolvedCount: 1, totalIndexedBytes: 64,
          cachedVerifiedBytes: scenario === 'cold' ? 0 : 64, estimatedTransferBytes: status.estimatedTransferBytes,
          incrementalStorageBytes: status.incrementalStorageBytes, metadataStorageBytes: status.metadataStorageBytes },
        unknown: [{ id: 'unknown-1', expression: '\\input{dynamic}', reason: 'Dynamic reference', file: 'main.tex', line: 2, parent: null }],
        unknownOmitted: 0,
      };
    };
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        window.__testInvokeCalls.push({ command, args });
        if (command === 'plugin:event|listen') return 1;
        if (command === 'resources_workspace_operation') {
          const request = args.request;
          window.__resourceCalls.push(request);
          if (request.operation === 'resources.analyze') {
            window.__analysisRequests.push(request);
            window.__activeAnalyzeRequests += 1;
            window.__maxConcurrentAnalyzeRequests = Math.max(window.__maxConcurrentAnalyzeRequests, window.__activeAnalyzeRequests);
            if (window.__delayNextAnalyze) {
              window.__delayNextAnalyze = false;
              await new Promise(resolve => { window.__releaseAnalyze = resolve; });
            }
            await new Promise(resolve => setTimeout(resolve, 0));
            window.__activeAnalyzeRequests -= 1;
            return planFor(request);
          }
          if (request.operation === 'resources.plan') {
            window.__planRequests.push(request);
            const plan = planFor(request);
            window.__latestResourcePlan = plan;
            return plan;
          }
          if (request.operation === 'resources.list') {
            window.__listRequests.push(request);
            if (window.__deferNextResourceList) {
              window.__deferNextResourceList = false;
              await new Promise(resolve => { window.__releaseResourceList = resolve; });
            }
            const sourceMarker = request.overlays?.['main.tex']?.includes('new snapshot') ? 'new' : 'old';
            return {
              resourceSchemaVersion: 1, planDigest: request.expectedPlanDigest, offset: 0, limit: 100, total: 2, nextCursor: null,
              items: [
                { itemType: 'requirement', item: { id: `article-${sourceMarker}.cls`, kind: 'resource', label: `article-${sourceMarker}.cls`, path: `article-${sourceMarker}.cls`, provider: 'tectonic_bundle', resolution: 'indexed', availability: window.__hotCache ? 'cached_verified' : 'missing', mandatory: true, evidence: [{ kind: 'detected', file: 'main.tex', line: 1, parent: null }], parents: [], indexedBytes: 32, sha256: 'pinned-hash' } },
                { itemType: 'requirement', item: { id: 'base.sty', kind: 'file', label: 'Base package', path: 'base.sty', provider: 'tectonic_bundle', resolution: 'indexed', availability: 'cached_verified', mandatory: true, evidence: [{ kind: 'package_dependency', file: 'class.cls', line: 8, parent: 'article.cls' }], parents: ['article.cls'], indexedBytes: 48, sha256: 'base-hash' } },
                { itemType: 'unknown', item: { id: 'unknown-1', expression: '\\input{dynamic}', reason: 'Dynamic reference', file: 'main.tex', line: 2, parent: null } },
              ],
            };
          }
          if (request.operation === 'resources.cache_list') {
            window.__cacheRequests.push(request);
            if (request.expectedCacheDigest && request.expectedCacheDigest !== 'cache-v1') throw { error: { code: 'resources.cache_stale', message: 'The installed resource inventory changed.' } };
            return {
              cacheDigest: 'cache-v1', bundleDigest: 'bundle-sha256', offset: 0, total: 3, nextCursor: null,
              items: [
                { path: 'tex/latex/protected/current.sty', bytes: 128, requiredByProject: true, removable: false },
                { path: 'tex/latex/installed/removable.sty', bytes: 1024, requiredByProject: false, removable: true },
                { path: 'tex/latex/installed/second.sty', bytes: 2048, requiredByProject: false, removable: true },
              ],
              summary: { installedFiles: 3, installedBytes: 3200, metadataBytes: 256, otherBytes: 64, embeddedFiles: 5, embeddedBytes: 4096 },
            };
          }
          if (request.operation === 'resources.cache_remove') {
            window.__cacheRemoveRequests.push(request);
            if (window.__failNextCacheRemove) { window.__failNextCacheRemove = false; throw { error: { code: 'resources.cache_stale', message: 'The installed resource inventory changed.' } }; }
            return { removedFiles: request.removePaths?.length ?? 0, removedBytes: 1024 };
          }
          if (request.operation === 'resources.prepare_project') {
            window.__prepareRequests.push(request);
            if (window.__failNextPrepare) {
              window.__failNextPrepare = false;
              throw { error: { code: 'resource.download_failed', message: 'The resource download failed.' } };
            }
            if (window.__prepareImmediately) return { prepared: true, plan: planFor(request, 'ready') };
            return await new Promise((resolve, reject) => { window.__pendingPrepare = { request, resolve, reject }; });
          }
          return {};
        }
        if (command === 'cancel_project_resources') {
          if (window.__deferNextCancel) {
            window.__deferNextCancel = false;
            return await new Promise((resolve, reject) => { window.__pendingCancel = { resolve, reject }; });
          }
          if (window.__cancelCompletesFirst) {
            window.__cancelCompletesFirst = false;
            window.__pendingPrepare?.resolve({ prepared: true, plan: planFor(window.__pendingPrepare.request, 'ready') });
            window.__pendingPrepare = null;
            window.__prepareImmediately = true;
            await new Promise(resolve => setTimeout(resolve, 30));
            return true;
          }
          window.__pendingPrepare?.reject({ error: { code: 'job.cancelled', message: 'The resource download was cancelled.' } });
          window.__pendingPrepare = null;
          window.__prepareImmediately = true;
          return true;
        }
        if (command === 'compile_workspace_snapshot') {
          if (window.__delayNextCompile) {
            window.__delayNextCompile = false;
            await new Promise(resolve => { window.__releaseCompile = resolve; });
          }
          if (window.__compileError) throw window.__compileError;
          return window.__compileResponse;
        }
        if (command === 'cancel_workspace_compilation') return true;
        if (command === 'reset_webview_zoom') return null;
        return null;
      },
      transformCallback: () => 1,
      unregisterCallback: () => {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, pdf);

  await page.goto(vite.resolvedUrls.local[0]);
  await page.getByRole('button', { name: 'Quick LaTeX' }).click();
  await page.waitForSelector('.monaco-editor', { timeout: 60000 });
  await page.waitForTimeout(250);
  const editor = await page.evaluate(() => {
    const fiberFor = element => element && element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
    let fiber = fiberFor(document.querySelector('.editor-container'));
    while (fiber) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const candidate = hook.memoizedState?.current;
        if (candidate?.getModel && candidate?.executeEdits) { window.__testEditor = candidate; return true; }
      }
      fiber = fiber.return;
    }
    return false;
  });
  assert.equal(editor, true, 'Monaco editor is mounted');
  assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('sciencebatch_sidebar_state_v1') ?? '{}').topTools.includes('dependencies')),
    'older persisted sidebar state migrates by adding Dependencies');
  const windowsPathSnapshot = await page.evaluate(async () => {
    const { captureProjectSnapshot } = await import('/src/editor/projectResourceSnapshot.ts');
    const root = 'C:\\Research\\Project';
    const tabs = [
      { id: 'main', path: `${root}\\papers\\main.tex`, name: 'main.tex', kind: 'source', pinned: false, preview: false, content: 'main', savedContent: '' },
      { id: 'secondary', path: `${root}\\sections\\intro.tex`, name: 'intro.tex', kind: 'source', pinned: false, preview: false, content: 'secondary', savedContent: '' },
      { id: 'manifest', path: `${root}\\sciencebatch.resources.json`, name: 'sciencebatch.resources.json', kind: 'source', pinned: false, preview: false, content: '{"schemaVersion":1}', savedContent: '' },
    ];
    const state = { projectRoot: root, projectName: 'Windows fixture', mainFilePath: `${root}\\papers\\main.tex`, engine: 'latex', templateAssets: null, tabs, getProjectGeneration: () => 4, getDocumentRevision: () => 1 };
    const absolute = captureProjectSnapshot(state);
    const relative = captureProjectSnapshot({ ...state, mainFilePath: 'papers/main.tex' });
    return { absolute, relative };
  });
  assert.equal(windowsPathSnapshot.absolute.mainFile, 'papers/main.tex', 'Windows absolute main paths become project-relative');
  assert.ok(windowsPathSnapshot.absolute.overlays['sections/intro.tex'], 'Windows absolute secondary paths become project-relative');
  assert.ok(windowsPathSnapshot.absolute.overlays['sciencebatch.resources.json'], 'an unsaved resource manifest is included as a source overlay');
  assert.equal(windowsPathSnapshot.relative.mainFile, 'papers/main.tex', 'nested project-relative main paths remain relative');

  await page.evaluate(() => { window.__resourceScenario = 'cold'; window.__delayNextAnalyze = true; });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Project Resources…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Project Resources' });
  await dialog.waitFor();
  await page.waitForFunction(() => window.__analysisRequests.length === 1 && typeof window.__releaseAnalyze === 'function');
  assert.equal(await dialog.getByText('Advanced', { exact: true }).count(), 0, 'the dialog has no Advanced section');
  assert.equal(await dialog.locator('.project-resources-primary').count(), 1, 'the basic view presents one primary action');
  assert.equal(await dialog.getByRole('tab', { name: 'Project', selected: true }).count(), 1, 'Project tab is active by default');
  assert.equal(await dialog.getByRole('tab', { name: 'Shared Cache', selected: false }).count(), 1, 'Shared Cache tab is available');
  assert.equal(await page.evaluate(() => window.__listRequests.length), 0, 'opening and analyzing never fetches the resource list');
  assert.equal(await page.evaluate(() => window.__cacheRequests.length), 0, 'opening the Project tab never fetches the shared cache list');
  assert.equal(await page.evaluate(() => window.__prepareRequests.length), 0, 'opening never prepares or downloads resources');
  assert.equal(await page.evaluate(() => window.__testInvokeCalls.filter(call => call.command === 'compile_workspace_snapshot').length), 0, 'opening never compiles');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close Project Resources', 'dialog receives initial focus');
  assert.ok(await dialog.evaluate(element => Math.abs(element.getBoundingClientRect().width - 580) < 1), 'default dialog width is 580 pixels on a desktop viewport');

  await page.evaluate(() => window.__releaseAnalyze());
  await page.waitForFunction(() => window.__planRequests.length === 1 && !document.querySelector('.project-resources-primary')?.disabled);
  assert.equal(await page.evaluate(() => window.__maxConcurrentAnalyzeRequests), 1, 'opening runs one serialized read-only analysis');
  assert.deepEqual(await page.evaluate(() => window.__analysisRequests.at(-1)?.selection ?? []), [], 'normal analysis discovers project and manifest resources automatically');
  assert.equal(await page.evaluate(() => window.__listRequests.length), 0, 'planning does not fetch resource files');
  assert.equal(await dialog.locator('.project-resources-primary').innerText(), 'Download required files');
  assert.match(await dialog.locator('.project-resources-metrics').innerText(), /14\.1 MiB/, 'cold-cache download estimate is shown in the metrics grid');
  assert.equal(await dialog.getByText('Some dynamic references can only be checked when you compile.', { exact: true }).count(), 1, 'the unknown-dependency caveat is visible in the Project tab');
  assert.equal(await dialog.locator('.project-resources-details').evaluate(element => element.open), false, 'Inspect detected files starts collapsed');
  await dialog.screenshot({ path: `${outputDirectory}/simple-cold-browser.png` });

  await page.evaluate(() => { window.__delayNextAnalyze = true; });
  await page.evaluate(() => {
    const editorInstance = window.__testEditor;
    const model = editorInstance.getModel();
    editorInstance.executeEdits('resource-content-change-a', [{ range: new monaco.Range(model.getLineCount(), model.getLineMaxColumn(model.getLineCount()), model.getLineCount(), model.getLineMaxColumn(model.getLineCount())), text: '\n% resource change a' }]);
  });
  await page.waitForFunction(() => window.__analysisRequests.length === 2 && typeof window.__releaseAnalyze === 'function');
  await page.evaluate(() => {
    const editorInstance = window.__testEditor;
    const model = editorInstance.getModel();
    editorInstance.executeEdits('resource-content-change-b', [{ range: new monaco.Range(model.getLineCount(), model.getLineMaxColumn(model.getLineCount()), model.getLineCount(), model.getLineMaxColumn(model.getLineCount())), text: '\n% resource change b ::selection::' }]);
  });
  assert.equal(await page.evaluate(() => window.__analysisRequests.length), 2, 'workspace edits do not start a concurrent analysis');
  await page.evaluate(() => window.__releaseAnalyze());
  await page.waitForFunction(() => window.__analysisRequests.length === 3 && window.__planRequests.length === 2 && !document.querySelector('.project-resources-primary')?.disabled);
  assert.equal(await page.evaluate(() => window.__maxConcurrentAnalyzeRequests), 1, 'content-change responses stay serialized');
  assert.ok((await page.evaluate(() => window.__analysisRequests.at(-1)?.overlays['main.tex'] ?? '')).includes('resource change b ::selection::'), 'latest content is used even when it contains the old delimiter string');

  assert.equal(await page.getByRole('button', { name: 'Download required files' }).isDisabled(), false, 'cold files require an explicit primary action');
  assert.equal(await page.evaluate(() => window.__prepareRequests.length), 0, 'the explicit download button has not run before user activation');
  const originalProjectLabel = await dialog.locator('#project-resources-description').innerText();
  await page.getByRole('button', { name: 'Download required files' }).click();
  await page.waitForFunction(() => Boolean(window.__pendingPrepare));
  const firstPrepare = await page.evaluate(() => window.__pendingPrepare.request);
  assert.equal(firstPrepare.expectedPlanDigest, await page.evaluate(() => window.__latestResourcePlan.planDigest), 'preparation carries the latest reviewed plan');
  assert.ok(firstPrepare.overlays['main.tex'].includes('resource change b ::selection::'), 'preparation captures current editor content');
  assert.equal(firstPrepare.maxDownloadBytes, 512 * 1024 * 1024, 'desktop keeps the 512 MiB transfer cap');
  assert.equal(firstPrepare.maxStorageBytes, 512 * 1024 * 1024, 'desktop keeps the 512 MiB storage cap');
  assert.equal(await page.evaluate(() => window.__listRequests.length), 0, 'preparation does not fetch resource-list details');
  assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).count(), 1, 'preparation exposes an explicit cancel action');

  await page.getByRole('button', { name: 'Close Project Resources' }).click();
  assert.equal(await page.getByRole('dialog', { name: 'Project Resources' }).count(), 0, 'closing hides the dialog without cancelling preparation');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Tools', 'closing restores focus to the stable menu trigger');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Project Resources…' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__analysisRequests.length), 3, 'reopening during preparation keeps the active job snapshot without reanalysis');
  assert.equal(await dialog.locator('#project-resources-description').innerText(), originalProjectLabel, 'active preparation keeps its original workspace label');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Resume download' }).waitFor();
  assert.equal(await page.evaluate(() => window.__prepareRequests.length), 1, 'cancellation does not start an automatic retry');
  await page.getByRole('button', { name: 'Resume download' }).click();
  await page.waitForFunction(() => window.__prepareRequests.length === 2 && !document.querySelector('.project-resources-cancel'));
  await page.getByText('Detected resources are ready', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done' }).waitFor();
  assert.equal(await page.evaluate(() => window.__listRequests.length), 0, 'a successful prepare does not load the resource list');
  await dialog.screenshot({ path: `${outputDirectory}/simple-ready-browser.png` });

  assert.equal(await dialog.locator('.project-resources-details').evaluate(element => element.open), false, 'Inspect detected files remains collapsed after preparation');
  assert.equal(await dialog.locator('.project-resources-selector-form').count(), 0, 'manual selectors are removed');
  assert.equal(await page.evaluate(() => window.__listRequests.length), 0, 'automatic detection does not request technical resource rows');
  const themeStyles = await page.evaluate(() => {
    const root = document.documentElement;
    const originalTheme = root.getAttribute('data-theme');
    const dialogElement = document.querySelector('.project-resources-dialog');
    const primaryButton = document.querySelector('.project-resources-primary');
    if (!dialogElement || !primaryButton) throw new Error('Project Resources dialog or primary CTA is missing');
    const readTheme = theme => {
      root.setAttribute('data-theme', theme);
      const style = getComputedStyle(dialogElement);
      const primaryStyle = getComputedStyle(primaryButton);
      return {
        scheme: style.colorScheme,
        background: style.backgroundColor,
        color: style.color,
        primaryBg: primaryStyle.backgroundColor,
        primaryFg: primaryStyle.color,
      };
    };
    const styles = {
      dark: readTheme('dark'),
      light: readTheme('light'),
      monokai: readTheme('monokai'),
      'obsidian-pastel': readTheme('obsidian-pastel'),
      'coral-depths': readTheme('coral-depths'),
    };
    if (originalTheme) root.setAttribute('data-theme', originalTheme);
    else root.removeAttribute('data-theme');
    return styles;
  });
  assert.equal(themeStyles.dark.scheme, 'dark', 'dialog uses the dark color scheme');
  assert.equal(themeStyles.light.scheme, 'light', 'dialog follows the light theme');
  assert.equal(themeStyles.monokai.scheme, 'dark', 'dialog follows the Monokai theme');
  assert.equal(themeStyles['obsidian-pastel'].scheme, 'dark', 'dialog follows the Obsidian Pastel theme');
  assert.equal(themeStyles['coral-depths'].scheme, 'dark', 'dialog follows the Coral Depths theme');
  assert.notEqual(themeStyles.dark.background, themeStyles.light.background, 'dark and light dialog surfaces remain distinct');
  assert.notEqual(themeStyles.dark.color, themeStyles.light.color, 'dark and light text remain distinct');
  for (const [themeName, style] of Object.entries(themeStyles)) {
    assert.notEqual(style.primaryBg, style.primaryFg, `${themeName} primary CTA has distinct foreground and background colors`);
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Done', 'Tab moves from Close to the primary action');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close Project Resources', 'Tab cycles from the last action to the close control');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Done', 'Shift+Tab stays within the dialog');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await dialog.evaluate(element => element.getBoundingClientRect().width <= window.innerWidth - 16), 'dialog fits a narrow viewport');
  assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'dialog has no horizontal overflow at narrow width');
  await page.setViewportSize({ width: 1280, height: 900 });

  await dialog.locator('.project-resources-details > summary').click();
  await page.waitForFunction(() => window.__listRequests.length === 1);
  await dialog.getByText('article-old.cls', { exact: true }).waitFor();
  await dialog.getByText('\\input{dynamic}', { exact: true }).waitFor();
  await dialog.getByText(/Supporting resources: 1 transitive file/).waitFor();
  await dialog.locator('.project-resources-details > summary').click();

  await dialog.getByRole('tab', { name: 'Shared Cache' }).click();
  await page.waitForFunction(() => window.__cacheRequests.length === 1);
  await dialog.locator('.project-resources-storage-card').getByText(/Downloaded/).waitFor();
  await dialog.locator('.project-resources-storage-card').getByText(/Built-in starter/).waitFor();
  await dialog.locator('.project-resources-storage-card').getByText(/Metadata & formats/).waitFor();
  const modalInUseRow = dialog.locator('.project-resources-cache-row').filter({ hasText: 'In use' });
  assert.equal(await modalInUseRow.locator('input').isDisabled(), true, 'In use cache entries are protected');
  await dialog.getByLabel('Filter loaded files').fill('removable.sty');
  assert.equal(await dialog.locator('.project-resources-cache-row').count(), 1, 'Shared Cache filter narrows loaded paths');
  await dialog.getByRole('button', { name: 'Clear cache filter' }).click();
  assert.equal(await dialog.locator('.project-resources-cache-row').count(), 3, 'clearing filter restores loaded cache rows');
  await dialog.getByRole('tab', { name: 'Project' }).click();
  await page.evaluate(() => { window.__listRequests = []; window.__cacheRequests = []; });

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => { window.__scenario = 'metadata'; });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Project Resources…' }).click();
  await page.getByText('Bundle setup is needed', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Finish setup' }).isDisabled(), false, 'missing metadata enables explicit setup even with warm resource bodies');
  assert.match(await dialog.locator('.project-resources-metrics').innerText(), /0 B/, 'metadata-only setup requires no resource transfer');
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByRole('button', { name: 'Done' }).waitFor();
  assert.equal(await page.evaluate(() => window.__listRequests.length), 0, 'metadata-only setup does not fetch file details');

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => { window.__scenario = 'invalidMetadata'; });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Project Resources…' }).click();
  await page.getByText('Resource information could not be verified', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Unavailable' }).isDisabled(), true, 'invalid metadata blocks preparation');
  assert.equal(await page.evaluate(() => window.__prepareRequests.length), 3, 'invalid metadata does not start a download');

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => { window.__scenario = 'invalidBody'; });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Project Resources…' }).click();
  await page.getByRole('button', { name: 'Download required files' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Download required files' }).isDisabled(), false, 'invalid resource bodies can be explicitly repaired');
  await page.evaluate(() => { window.__failNextPrepare = true; });
  await page.getByRole('button', { name: 'Download required files' }).click();
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  assert.match(await dialog.locator('.project-resources-friendly-error').innerText(), /You can try again/);
  await page.evaluate(() => { window.__prepareImmediately = true; });
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('button', { name: 'Done' }).waitFor();
  assert.equal(await page.evaluate(() => window.__prepareRequests.length), 5, 'a failed explicit download retries only after the user presses Try again');

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('button.btn-compile:not(.btn-stop)').click();
  await page.waitForFunction(() => window.__testInvokeCalls.some(call => call.command === 'compile_workspace_snapshot'));
  await page.waitForFunction(() => document.querySelector('.pdf-viewer-container canvas'));
  const compileSnapshot = await page.evaluate(() => window.__testInvokeCalls?.find(call => call.command === 'compile_workspace_snapshot')?.args?.request);
  assert.ok(compileSnapshot, 'desktop Compile uses the shared offline workspace snapshot command');
  assert.equal(compileSnapshot.templateAssets, 'starter-latex', 'explicit scratch template grant accompanies the snapshot');
  assert.ok(compileSnapshot.overlays['main.tex'].includes('resource change b'), 'compile uses the live editor buffer');
  assert.ok(compileSnapshot.workspaceIdentity, 'compile binds workspace identity');
  const canvasBeforeEdit = await page.locator('.pdf-viewer-container canvas').count();
  const resourceCallsBeforeEdit = await page.evaluate(() => window.__resourceCalls.length);
  await page.evaluate(() => {
    const editorInstance = window.__testEditor;
    editorInstance.executeEdits('undo-preservation-test', [{ range: new monaco.Range(1, 1, 1, 1), text: '% undo probe\n' }]);
    editorInstance.focus();
    editorInstance.trigger('test', 'undo', null);
  });
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.pdf-viewer-container canvas').count(), canvasBeforeEdit, 'source edits and Undo preserve the existing PDF canvas');
  assert.equal(await page.evaluate(() => window.__resourceCalls.length), resourceCallsBeforeEdit, 'typing and Undo do not automatically prepare resources');
  assert.equal(await page.evaluate(() => window.__testInvokeCalls.filter(call => call.command === 'compile_workspace_snapshot').length), 1, 'typing and Undo do not automatically compile');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.__testInvokeCalls.filter(call => call.command === 'compile_workspace_snapshot').length === 2);
  await page.evaluate(() => {
    window.__compileError = {
      error: { code: 'cache.unavailable_offline', message: 'A project resource may be missing.', details: { missingResources: [{ path: 'tex/latex/example/extra.sty', sha256: 'probe-hash', length: 42 }] } },
      diagnostics: [{ severity: 'error', code: 'tex.error', message: 'File not found', origin: 'tectonic', file: 'main.tex', line: 9, column: 1, suggestion: 'Check resource availability.' }],
    };
  });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.__testInvokeCalls.filter(call => call.command === 'compile_workspace_snapshot').length === 3);
  await page.getByRole('button', { name: 'Project Resources…' }).last().click();
  await page.getByText('Includes possible files identified during the last compile.', { exact: true }).waitFor();
  await page.waitForFunction(() => window.__analysisRequests.at(-1)?.selection?.some(item => item.id === 'tex/latex/example/extra.sty'));
  await page.waitForFunction(() => !document.querySelector('.project-resources-primary')?.disabled);
  await page.getByRole('button', { name: 'Download & Recompile' }).waitFor();
  assert.equal(await page.evaluate(() => window.__prepareRequests.length), 5, 'compile feedback does not trigger downloads');
  assert.equal(await page.evaluate(() => window.__testInvokeCalls.filter(call => call.command === 'compile_workspace_snapshot').length), 3, 'recovery does not automatically retry compilation');

  const analyzesBeforeSnapshotChange = await page.evaluate(() => window.__analysisRequests.length);
  await page.evaluate(() => {
    const editorInstance = window.__testEditor;
    const model = editorInstance.getModel();
    editorInstance.executeEdits('clear-old-recovery', [{ range: new monaco.Range(model.getLineCount(), model.getLineMaxColumn(model.getLineCount()), model.getLineCount(), model.getLineMaxColumn(model.getLineCount())), text: '\n% recovery snapshot changed' }]);
  });
  await page.waitForFunction(count => window.__analysisRequests.length > count && (window.__analysisRequests.at(-1)?.selection?.length ?? 0) === 0, analyzesBeforeSnapshotChange);
  assert.equal(await dialog.getByText('Includes possible files identified during the last compile.', { exact: true }).count(), 0, 'snapshot edits clear old compile candidates');

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => { window.__prepareImmediately = true; });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.__testInvokeCalls.filter(call => call.command === 'compile_workspace_snapshot').length === 4);
  await page.getByRole('button', { name: 'Project Resources…' }).last().click();
  await page.getByRole('button', { name: 'Download & Recompile' }).waitFor();
  await page.evaluate(() => { window.__compileError = null; });
  await page.getByRole('button', { name: 'Download & Recompile' }).click();
  await page.waitForFunction(() => window.__testInvokeCalls.filter(call => call.command === 'compile_workspace_snapshot').length === 5);
  assert.equal(await page.getByRole('dialog', { name: 'Project Resources' }).count(), 0, 'Download & Recompile closes dialog and triggers recompile after preparation');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Project Resources…' }).click();
  await dialog.waitFor();

  await page.evaluate(() => {
    window.__delayNextCompile = true;
    window.__compileError = {
      error: { code: 'cache.unavailable_offline', message: 'A project resource may be missing.', details: { missingResources: [{ path: 'tex/latex/stale/old.sty' }] } },
      diagnostics: [{ severity: 'error', code: 'tex.error', message: 'File not found', origin: 'tectonic' }],
    };
  });
  const priorRecoveryToastCount = await page.getByText('Compilation may need project resources').count();
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => typeof window.__releaseCompile === 'function');
  await page.evaluate(async () => {
    const editorInstance = window.__testEditor;
    const model = editorInstance.getModel();
    editorInstance.executeEdits('make-failed-compile-stale', [{ range: new monaco.Range(model.getLineCount(), model.getLineMaxColumn(model.getLineCount()), model.getLineCount(), model.getLineMaxColumn(model.getLineCount())), text: '\n% make previous compile stale' }]);
    await new Promise(resolve => setTimeout(resolve, 50));
    window.__releaseCompile();
  });
  await page.waitForFunction(() => window.__testInvokeCalls.filter(call => call.command === 'compile_workspace_snapshot').length === 6);
  await page.waitForTimeout(100);
  assert.ok(await page.getByText('Compilation may need project resources').count() <= priorRecoveryToastCount, 'stale compile failures do not add recovery feedback');
  assert.equal(await page.evaluate(() => window.__analysisRequests.at(-1)?.selection?.length ?? 0), 0, 'stale compile misses are not added to resource analysis');

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => { window.__scenario = 'cold'; window.__prepareImmediately = false; });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Project Resources…' }).click();
  await page.getByRole('button', { name: 'Download required files' }).waitFor();
  await page.getByRole('button', { name: 'Download required files' }).click();
  await page.waitForFunction(() => Boolean(window.__pendingPrepare));
  await page.getByRole('button', { name: 'Close Project Resources' }).click();
  await page.evaluate(() => window.__resolvePendingPrepareReady());
  await page.evaluate(() => { window.__scenario = 'ready'; });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Project Resources…' }).click();
  await page.getByRole('button', { name: 'Done' }).waitFor();
  assert.equal(await dialog.locator('.project-resources-error').count(), 0, 'a successful hidden preparation does not surface an input_changed error when reopened');

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => { window.__scenario = 'cold'; window.__prepareImmediately = false; });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Project Resources…' }).click();
  await page.getByRole('button', { name: 'Download required files' }).waitFor();
  await page.evaluate(() => { window.__cancelCompletesFirst = true; });
  await page.getByRole('button', { name: 'Download required files' }).click();
  await page.waitForFunction(() => Boolean(window.__pendingPrepare));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Done' }).waitFor();
  assert.equal(await dialog.locator('.project-resources-note').filter({ hasText: 'compile this project now' }).count(), 1, 'a completed preparation wins the concurrent cancel response');

  await page.evaluate(() => { window.__scenario = 'cold'; window.__prepareImmediately = false; });
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Project Resources…' }).click();
  await page.getByRole('button', { name: 'Download required files' }).waitFor();
  await page.getByRole('button', { name: 'Download required files' }).click();
  await page.waitForFunction(() => Boolean(window.__pendingPrepare));
  await page.evaluate(() => { window.__deferNextCancel = true; });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__pendingCancel));
  await page.waitForFunction(() => document.querySelector('.project-resources-progress-copy strong')?.textContent === 'Stopping the download');
  await page.evaluate(() => window.__resolvePendingPrepareReady());
  await page.getByRole('button', { name: 'Done' }).waitFor();
  await page.evaluate(() => { window.__scenario = 'cold'; window.__prepareImmediately = false; });
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Project Resources…' }).click();
  await page.getByRole('button', { name: 'Download required files' }).waitFor();
  const preparesBeforeDeferredCancel = await page.evaluate(() => window.__prepareRequests.length);
  await page.getByRole('button', { name: 'Download required files' }).click();
  await page.waitForFunction(count => window.__prepareRequests.length === count + 1 && Boolean(window.__pendingPrepare), preparesBeforeDeferredCancel);
  await page.evaluate(() => {
    window.__pendingCancel.reject({ error: { code: 'job.not_found', message: 'The resource preparation is no longer active.' } });
    window.__pendingCancel = null;
  });
  await page.locator('.project-resources-progress-copy strong').getByText('Preparing required files', { exact: true }).waitFor();
  assert.equal(await dialog.locator('.project-resources-friendly-error').count(), 0, 'a stale cancel failure cannot overwrite the active preparation state');
  assert.equal(await dialog.locator('.project-resources-progress-copy strong').innerText(), 'Preparing required files', 'the active job keeps its current progress label');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Resume download' }).waitFor();
  await page.getByRole('button', { name: 'Close Project Resources' }).click();
  assert.equal(await page.evaluate(() => window.__listRequests.length), 0, 'resource details remain lazy until the Dependencies panel is visible');
  await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { DependenciesPanel } = await import('/src/components/sidebar/DependenciesPanel.tsx');
    const { ProjectResourcesDialog } = await import('/src/components/ProjectResourcesDialog.tsx');
    const container = document.createElement('div');
    container.id = 'dependencies-browser-harness';
    container.style.cssText = 'position:fixed;left:20px;top:20px;width:360px;height:780px;z-index:2500;background:var(--bg-primary)';
    document.body.append(container);
    let rerender;
    window.__dependencyPrepareCalls = [];
    window.__dependencyJumpCalls = [];
    const model = {
      isOpen: false,
      modalTab: 'project',
      focusReturnRef: { current: null },
      setIsOpen: value => { model.isOpen = value; rerender(); },
      setModalTab: tab => { model.modalTab = tab; rerender(); },
      isPlanFresh: true, plan: { project: 'Browser fixture', engine: 'latex', planDigest: 'plan-browser', inputDigest: 'input-browser', bundleMetadataState: 'cached_verified', projectState: 'not_prepared', summary: { totalResources: 2, resolvedResources: 2, cachedVerifiedResources: 1, missingResources: 1, invalidResources: 0, unresolvedCount: 1, estimatedTransferBytes: 2048, cachedVerifiedBytes: 48 }, unknown: [{ id: 'unknown', expression: '\\input{dynamic}', reason: 'Unknown', file: 'main.tex', line: 2, parent: null }] },
      isAnalyzing: false, activeJobId: null, progress: null, error: null, errorAction: null, completedPaths: [],
      resourcePage: null, resourcePageError: null, isResourcePageLoading: false, cachePage: null, isCachePageLoading: false, cacheError: null,
      isRemovingResources: false, cacheRemovalResult: null, recoveryPaths: [],
      open: tab => {
        if (document.activeElement instanceof HTMLElement) model.focusReturnRef.current = document.activeElement;
        model.modalTab = tab === 'cache' ? 'cache' : 'project';
        model.isOpen = true;
        rerender();
      },
      prepare: async () => { window.__dependencyPrepareCalls.push('prepare'); model.error = null; model.errorAction = null; model.activeJobId = 'sidebar-job'; model.progress = { jobId: 'sidebar-job', status: 'Started', downloadedBytes: 12, totalResources: 2 }; rerender(); return true; },
      cancel: async () => { model.activeJobId = null; model.progress = { jobId: 'sidebar-job', status: 'Cancelled' }; rerender(); },
      analyze: async () => {},
      loadResourcePage: async () => {
        window.__listRequests.push({ operation: 'resources.list', expectedPlanDigest: 'plan-browser' });
        if (window.__listRequests.length === 1) { model.resourcePageError = { code: 'resources.list_failed' }; rerender(); return; }
        model.resourcePageError = null;
        model.resourcePage = { planDigest: 'plan-browser', total: 2, nextCursor: null, items: [
          { itemType: 'requirement', item: { id: 'article.cls', label: 'article.cls', path: 'article.cls', availability: 'missing', indexedBytes: 32, parents: [], evidence: [{ kind: 'detected', file: 'main.tex', line: 1, parent: null }] } },
          { itemType: 'requirement', item: { id: 'base.tfm', label: 'Base package', path: 'base.tfm', availability: 'cached_verified', indexedBytes: 48, parents: ['article.cls'], evidence: [{ kind: 'package_dependency', file: null, line: null, parent: 'article.cls' }] } },
          { itemType: 'unknown', item: { id: 'unknown', expression: '\\input{dynamic}', reason: 'Unknown', file: 'main.tex', line: 2, parent: null } },
        ] }; rerender();
      },
      loadCachePage: async () => {
        window.__cacheRequests.push({ operation: 'resources.cache_list', limit: 200 });
        model.cachePage = {
          cacheDigest: 'cache-browser',
          summary: { installedFiles: 3, installedBytes: 3200, metadataBytes: 256, otherBytes: 64, embeddedFiles: 5, embeddedBytes: 4096 },
          items: [
            { path: 'protected/current.sty', bytes: 128, requiredByProject: true, removable: false },
            { path: 'protected/app-copy.sty', bytes: 256, requiredByProject: false, removable: false },
            { path: 'installed/removable.sty', bytes: 1024, requiredByProject: false, removable: true },
            { path: 'installed/second.sty', bytes: 2048, requiredByProject: false, removable: true },
          ],
          nextCursor: null,
        };
        rerender();
      },
      removeCachedResources: async paths => {
        window.__cacheRemoveRequests.push({ removePaths: paths, expectedCacheDigest: 'cache-browser', expectedInputDigest: 'input-browser' });
        model.cacheError = { code: 'resources.cache_stale', message: 'The installed resource inventory changed.' };
        model.cachePage = null;
        rerender();
      },
    };
    function Harness() {
      const [, setTick] = React.useState(0); rerender = () => setTick(value => value + 1);
      window.__dependencyModel = model;
      window.__dependencyRerender = rerender;
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(DependenciesPanel, {
          resources: model,
          onClose: () => {},
          onSelectLine: (line, file) => window.__dependencyJumpCalls.push({ line, file }),
          engine: 'latex',
        }),
        React.createElement(ProjectResourcesDialog, {
          resources: model,
          projectName: 'Browser fixture',
          engine: 'latex',
          onClose: () => model.setIsOpen(false),
          onSelectLine: (line, file) => window.__dependencyJumpCalls.push({ line, file }),
        }),
      );
    }
    window.__dependencyRoot = createRoot(container);
    window.__dependencyRoot.render(React.createElement(Harness));
  });
  await page.locator('.dependencies-panel-header').waitFor();
  assert.equal(await page.locator('.dependencies-panel-title').innerText(), 'DEPENDENCIES', 'Dependencies sidebar uses standard uppercase header');
  assert.equal(await page.locator('.dependencies-status-pill').innerText(), '1 missing', 'Dependencies header shows status pill');
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__listRequests.length), 1, 'a failed resource page does not retry in a render loop');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.locator('.dependency-row strong').first().waitFor();
  await page.locator('.dependencies-panel').screenshot({ path: join(outputDirectory, 'dependencies-browser.png') });
  assert.equal(await page.evaluate(() => window.__listRequests.length), 2, 'mounting Dependencies lazily fetches one current detected-resource page and the explicit retry');
  assert.match(await page.locator('.dependency-action-card').innerText(), /download/i, 'the sidebar reports readiness and estimated download state');
  assert.equal(await page.locator('.dependency-group h3').first().innerText(), 'PACKAGES, CLASSES & ASSETS', 'direct dependencies section is clearly titled');
  assert.equal(await page.getByText('\\input{dynamic}', { exact: true }).count(), 1, 'Unresolved References section renders dynamic expressions');
  await page.getByRole('button', { name: 'main.tex:1' }).click();
  await page.getByRole('button', { name: 'main.tex:2' }).click();
  assert.deepEqual(
    await page.evaluate(() => window.__dependencyJumpCalls),
    [{ line: 1, file: 'main.tex' }, { line: 2, file: 'main.tex' }],
    'clickable file:line buttons jump to both direct and unresolved locations',
  );
  const supportingResources = page.locator('.dependency-supporting');
  assert.equal((await supportingResources.locator('summary').innerText()).replace(/\s+/g, ' '), 'Supporting resources 1', 'supporting resources have an accessible count');
  assert.equal(await supportingResources.evaluate(element => element.open), false, 'supporting resources are collapsed until requested');
  assert.equal(await page.getByText('Base package', { exact: true }).isVisible().catch(() => false), false, 'the base engine file list stays out of the initial sidebar view');
  await supportingResources.locator('summary').click();
  assert.equal(await page.getByText('Base package', { exact: true }).isVisible(), true, 'users can expand supporting resources on demand');
  await supportingResources.locator('summary').click();
  await page.getByLabel('Filter dependencies').fill('dynamic');
  assert.equal(await page.locator('.dependency-row').count(), 1, 'sidebar filter narrows detected and unresolved rows');
  await page.getByRole('button', { name: 'Clear dependency filter' }).click();
  await page.getByRole('button', { name: 'Download required files' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__dependencyPrepareCalls.length), 1, 'the sidebar starts preparation directly after explicit activation');
  assert.equal(await page.getByText('Preparing in current batch', { exact: true }).count(), 1, 'missing rows show batch preparation without claiming per-file byte progress');
  assert.match(await page.locator('.dependency-job').innerText(), /12 B downloaded/);
  await page.locator('.dependency-job').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Resume download' }).waitFor();
  await page.evaluate(() => { window.__dependencyModel.errorAction = 'prepare'; window.__dependencyModel.error = { code: 'resource.download_failed', message: 'Internal detail' }; window.__dependencyModel.progress.status = 'Error'; window.__dependencyRerender(); });
  await page.getByRole('button', { name: 'Retry download' }).click();
  await page.locator('.dependency-job').getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__dependencyPrepareCalls.length), 2, 'a failed download retries only after the sidebar action is pressed');
  await page.locator('.dependency-job').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Resume download' }).waitFor();
  await page.getByRole('button', { name: 'Resume download' }).click();
  await page.locator('.dependency-job').getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  await page.locator('.dependency-job').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Resume download' }).waitFor();
  await page.evaluate(() => { window.__dependencyModel.plan.summary.missingResources = 0; window.__dependencyModel.plan.bundleMetadataState = 'missing'; window.__dependencyModel.progress.status = 'Ready'; window.__dependencyRerender(); });
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.locator('.dependency-job').getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  await page.locator('.dependency-job').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Resume download' }).waitFor();
  await page.getByRole('button', { name: 'Manage installed resources' }).click();
  const unifiedCacheDialog = page.getByRole('dialog', { name: 'Project Resources' });
  await unifiedCacheDialog.waitFor();
  assert.equal(await unifiedCacheDialog.getByRole('tab', { name: 'Shared Cache', selected: true }).count(), 1, 'Manage installed resources opens the unified modal directly to Shared Cache');
  assert.equal(await page.evaluate(() => window.__cacheRequests.length), 1, 'shared cache inventory loads only when Shared Cache tab is opened');
  await unifiedCacheDialog.locator('.project-resources-storage-card').getByText(/Metadata & formats/).waitFor();
  await unifiedCacheDialog.getByText('Shared across LaTeX projects. Files used by this project and built-in app resources are protected.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close Project Resources', 'unified modal receives initial focus');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Done', 'Shared Cache modal traps reverse Tab at its final enabled control');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close Project Resources', 'Shared Cache modal wraps Tab to its close control');
  const protectedRow = unifiedCacheDialog.locator('.project-resources-cache-row').filter({ hasText: 'In use' });
  assert.equal(await protectedRow.locator('input').isDisabled(), true, 'In use cache entries cannot be selected for removal');
  const appRow = unifiedCacheDialog.locator('.project-resources-cache-row').filter({ hasText: 'Built-in' });
  assert.equal(await appRow.locator('input').isDisabled(), true, 'Built-in app resources are labeled and protected');
  await unifiedCacheDialog.getByLabel('Filter loaded files').fill('removable.sty');
  assert.equal(await unifiedCacheDialog.locator('.project-resources-cache-row').count(), 1, 'inventory filtering applies only to loaded paths');
  await unifiedCacheDialog.locator('.project-resources-cache-row input').check();
  await page.evaluate(() => { window.__failNextCacheRemove = true; });
  await unifiedCacheDialog.getByRole('button', { name: 'Remove selected', exact: true }).click();
  await unifiedCacheDialog.getByRole('button', { name: 'Remove selected files', exact: true }).click();
  await unifiedCacheDialog.getByText('The installed resource inventory changed.', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.__cacheRemoveRequests.length), 1, 'removal sends one explicit digest-bound selection');
  const removeRequest = await page.evaluate(() => window.__cacheRemoveRequests[0]);
  assert.deepEqual(removeRequest.removePaths, ['installed/removable.sty'], 'removal sends only the selected path');
  assert.equal(removeRequest.expectedCacheDigest, 'cache-browser', 'removal is bound to the displayed cache inventory');
  assert.equal(removeRequest.expectedInputDigest, 'input-browser', 'removal is bound to current project analysis');
  await unifiedCacheDialog.getByRole('button', { name: 'Reload inventory' }).click();
  await unifiedCacheDialog.locator('[title="installed/removable.sty"]').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Manage installed resources' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Manage installed resources', 'closing the unified modal returns focus to its sidebar trigger');
  await page.getByRole('button', { name: 'Manage cache…' }).click();
  await unifiedCacheDialog.waitFor();
  assert.equal(await unifiedCacheDialog.getByRole('tab', { name: 'Shared Cache', selected: true }).count(), 1, 'Manage cache link opens the unified modal to Shared Cache');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    window.__dependencyModel.plan.mainFile = 'main.tex';
    window.__dependencyModel.plan.unknown = [
      { id: 'unknown-proj', expression: '\\input{dynamic}', reason: 'macro_valued_file_reference', file: 'main.tex', line: 2, parent: null },
      { id: 'unknown-ctan-1', expression: '#1', reason: 'macro_valued_catalog_reference', file: 'xparse.sty', line: 120, parent: null },
      { id: 'unknown-ctan-2', expression: 'hyperref.cfg', reason: 'input_not_found_in_project_or_bundle', file: 'hyperref.sty', line: 3973, parent: null },
      { id: 'unknown-ctan-3', expression: '   ', reason: 'bundle_style_not_found', file: 'hyperref.sty', line: 4100, parent: 'hyperref.sty' },
    ];
    window.__dependencyModel.resourcePage = {
      planDigest: 'plan-browser',
      total: 4,
      nextCursor: null,
      items: [
        { itemType: 'requirement', item: { id: 'article.cls', label: 'article.cls', path: 'article.cls', provider: 'pinned_bundle', availability: 'cached_verified', indexedBytes: 32, parents: [], evidence: [{ kind: 'detected', file: 'main.tex', line: 1, parent: null }] } },
        { itemType: 'requirement', item: { id: 'hyperref.sty', label: 'hyperref.sty', path: 'tex/latex/hyperref/hyperref.sty', provider: 'pinned_bundle', availability: 'cached_verified', indexedBytes: 64, parents: [], evidence: [{ kind: 'detected', file: 'main.tex', line: 2, parent: null }] } },
        { itemType: 'requirement', item: { id: 'xparse.sty', label: 'xparse.sty', path: 'tex/latex/l3packages/xparse.sty', provider: 'pinned_bundle', availability: 'cached_verified', indexedBytes: 40, parents: [], evidence: [{ kind: 'detected', file: 'main.tex', line: 3, parent: null }] } },
        { itemType: 'requirement', item: { id: 'base.tfm', label: 'Base package', path: 'base.tfm', provider: 'pinned_bundle', availability: 'cached_verified', indexedBytes: 48, parents: ['article.cls'], evidence: [{ kind: 'package_dependency', file: null, line: null, parent: 'article.cls' }] } },
        ...window.__dependencyModel.plan.unknown.map(item => ({ itemType: 'unknown', item })),
      ],
    };
    window.__dependencyRerender();
  });
  const unresolvedSection = page.locator('.dependency-group', { has: page.locator('h3', { hasText: 'Unresolved References' }) });
  await unresolvedSection.waitFor();
  assert.equal(await unresolvedSection.locator('.dependency-unknown-row').count(), 1, 'CTAN-internal unknowns are excluded from top-level Unresolved References');
  assert.equal(await unresolvedSection.getByText('\\input{dynamic}', { exact: true }).count(), 1, 'user-project unknown remains in Unresolved References');
  assert.equal(await unresolvedSection.getByText('Dynamic file macro', { exact: true }).count(), 1, 'friendly reason label replaces raw snake_case code');
  assert.equal(await unresolvedSection.getByRole('button', { name: 'main.tex:2' }).count(), 1, 'project unknown keeps clickable jump button');
  assert.equal(await page.locator('.dependencies-panel').getByText(/macro_valued_|input_not_found_|bundle_style_not_found/).count(), 0, 'no raw snake_case reason codes leak into DependenciesPanel');
  assert.equal((await supportingResources.locator('> summary').innerText()).replace(/\s+/g, ' '), 'Supporting resources 4', 'supporting resources count includes transitive files and catalog hooks');
  await supportingResources.locator('> summary').click();
  const catalogHooks = supportingResources.locator('.dependency-catalog-unknowns');
  assert.equal((await catalogHooks.locator('> summary').innerText()).replace(/\s+/g, ' '), 'Package-internal dynamic hooks 3', 'catalog unknowns are grouped in a collapsed nested details section');
  assert.equal(await catalogHooks.evaluate(element => element.open), false, 'package-internal dynamic hooks start collapsed');
  await catalogHooks.locator('> summary').click();
  assert.equal(await catalogHooks.getByText('Dynamic macro in package', { exact: true }).count(), 1, 'macro_valued_catalog_reference maps to friendly label');
  assert.equal(await catalogHooks.getByText('Optional or missing input', { exact: true }).count(), 1, 'input_not_found_in_project_or_bundle maps to friendly label');
  assert.equal(await catalogHooks.getByText('Package not found in bundle', { exact: true }).count(), 1, 'bundle_style_not_found maps to friendly label');
  assert.equal(await catalogHooks.getByText('Dynamic expression', { exact: true }).count(), 1, 'empty expression renders safe Dynamic expression fallback');
  assert.equal(await catalogHooks.getByRole('button', { name: 'xparse.sty:120' }).count(), 0, 'bundle file xparse.sty:120 is not rendered as a clickable jump button');
  assert.equal(await catalogHooks.getByRole('button', { name: 'hyperref.sty:3973' }).count(), 0, 'bundle file hyperref.sty:3973 is not rendered as a clickable jump button');
  assert.equal(await catalogHooks.locator('.dependency-location-text', { hasText: 'xparse.sty:120' }).count(), 1, 'bundle location xparse.sty:120 renders as non-interactive text');
  assert.equal(await catalogHooks.locator('.dependency-location-text', { hasText: 'hyperref.sty:3973' }).count(), 1, 'bundle location hyperref.sty:3973 renders as non-interactive text');

  await page.evaluate(() => { window.__dependencyModel.open('project'); });
  await unifiedCacheDialog.waitFor();
  await unifiedCacheDialog.locator('.project-resources-details > summary').click();
  const dialogUnresolvedGroup = unifiedCacheDialog.locator('.project-resources-inspect-group').filter({ hasText: 'Unresolved references' });
  await dialogUnresolvedGroup.waitFor();
  assert.equal(await dialogUnresolvedGroup.locator('.project-resources-inspect-row').count(), 1, 'Inspect detected files excludes CTAN-internal unknowns from Unresolved references');
  assert.equal(await dialogUnresolvedGroup.getByText('Dynamic file macro', { exact: true }).count(), 1, 'Inspect detected files displays friendly reason label');
  assert.equal(await dialogUnresolvedGroup.getByRole('button', { name: 'main.tex:2' }).count(), 1, 'Inspect detected files keeps clickable jump button for main.tex:2');
  assert.equal(await unifiedCacheDialog.getByText('Supporting resources: 1 transitive file · 3 package-internal dynamic hooks', { exact: true }).count(), 1, 'Inspect detected files summarizes catalog hooks alongside supporting files');
  await page.keyboard.press('Escape');

  await page.evaluate(() => { window.__dependencyRoot.unmount(); document.getElementById('dependencies-browser-harness')?.remove(); });

  await page.evaluate(async () => {
    window.__listRequests = [];
    window.__analysisRequests = [];
    window.__planRequests = [];
    window.__resourceCalls = [];
    window.__deferNextResourceList = true;
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { useProjectResources } = await import('/src/hooks/useProjectResources.ts');
    const { DependenciesPanel } = await import('/src/components/sidebar/DependenciesPanel.tsx');
    const container = document.createElement('div');
    container.id = 'resource-hook-browser-harness';
    document.body.append(container);
    const firstSnapshot = { engine: 'latex', projectRoot: '/browser/project', mainFile: 'main.tex', overlays: { 'main.tex': '\\documentclass{article}\n% old snapshot' }, allowedRoots: ['/browser/project'], workspaceIdentity: { projectName: 'Browser fixture', generation: 1 }, templateAssets: null, fingerprint: 'browser-snapshot-old' };
    window.__hookSnapshot = firstSnapshot;
    window.__setDependencySnapshot = null;
    function Harness() {
      const [snapshot, setSnapshot] = React.useState(firstSnapshot);
      window.__setDependencySnapshot = setSnapshot;
      const resources = useProjectResources(snapshot, fingerprint => window.__hookSnapshot?.fingerprint === fingerprint);
      window.__hookResources = resources;
      React.useEffect(() => { window.__hookSnapshot = snapshot; resources.setSidebarVisible(true); }, [resources.setSidebarVisible, snapshot]);
      return React.createElement(DependenciesPanel, { resources, onClose: () => resources.setSidebarVisible(false) });
    }
    window.__resourceHookRoot = createRoot(container);
    window.__resourceHookRoot.render(React.createElement(Harness));
  });
  await page.waitForFunction(() => window.__listRequests.length === 1 && typeof window.__releaseResourceList === 'function');
  await page.evaluate(() => window.__setDependencySnapshot({ engine: 'latex', projectRoot: '/browser/project', mainFile: 'main.tex', overlays: { 'main.tex': '\\documentclass{article}\n% new snapshot' }, allowedRoots: ['/browser/project'], workspaceIdentity: { projectName: 'Browser fixture', generation: 1 }, templateAssets: null, fingerprint: 'browser-snapshot-new' }));
  await page.waitForTimeout(750);
  const staleSourceState = await page.evaluate(() => ({
    listRequests: window.__listRequests.map(request => ({ digest: request.expectedPlanDigest, source: request.overlays?.['main.tex'] })),
    analyses: window.__analysisRequests.length,
    plans: window.__planRequests.length,
    text: document.querySelector('.dependencies-panel')?.innerText,
    resourcePage: window.__hookResources?.resourcePage,
    listError: window.__hookResources?.resourcePageError,
    listLoading: window.__hookResources?.isResourcePageLoading,
    rows: [...document.querySelectorAll('.dependency-row strong')].map(row => row.textContent),
    snapshot: window.__hookSnapshot?.fingerprint,
    analyzing: document.querySelector('.dependency-panel')?.textContent,
  }));
  assert.ok(staleSourceState.listRequests.length >= 2 && staleSourceState.rows.includes('article-new.cls'), `new source snapshot should replace stale list data: ${JSON.stringify(staleSourceState)}`);
  await page.evaluate(() => window.__releaseResourceList());
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.dependency-row strong').first().innerText(), 'article-new.cls', 'a delayed resource page from the previous source snapshot is discarded');
  assert.equal(await page.evaluate(() => window.__analysisRequests.length), 2, 'sidebar source changes serialize a fresh read-only analysis');
  const oldAvailabilityPlanDigest = await page.evaluate(() => window.__hookResources.plan.planDigest);
  await page.evaluate(() => {
    window.__constantPlanDigest = window.__hookResources.plan.planDigest;
    window.__hotCache = true;
    void window.__hookResources.analyze();
  });
  await page.waitForFunction(() => window.__listRequests.length === 3 && document.querySelector('.dependency-row')?.textContent.includes('Ready'));
  assert.equal(await page.evaluate(() => window.__hookResources.plan.planDigest), oldAvailabilityPlanDigest, 'cache availability can change while the stable source plan digest stays the same');
  assert.equal(await page.evaluate(() => window.__listRequests.length), 3, 'a fresh plan object with unchanged digest still refreshes resource rows');
  await page.evaluate(() => { window.__resourceHookRoot.unmount(); document.getElementById('resource-hook-browser-harness')?.remove(); });
  assert.deepEqual(failures, [], `browser errors: ${failures.join('; ')}`);
  await page.close();
  console.log(`Project resource browser checks passed. Screenshots: ${outputDirectory}/simple-cold-browser.png, ${outputDirectory}/simple-ready-browser.png, ${outputDirectory}/dependencies-browser.png`);
} finally {
  await browser?.close();
  await vite.close();
}
