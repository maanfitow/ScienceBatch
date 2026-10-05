import assert from 'node:assert/strict';
import { reloadWorkspaceTabs } from '../src/hooks/gitWorkspaceRefresh.ts';

const source = (id, path, content, extra = {}) => ({
  id, path, name: path.split('/').at(-1), kind: 'source', pinned: false, preview: false,
  content, savedContent: content, ...extra,
});
const asset = (id, path, extra = {}) => ({
  id, path, name: path.split('/').at(-1), kind: 'asset', pinned: false, preview: true,
  content: '', savedContent: '', ...extra,
});
const diff = (id, path, repositoryRoot = '/repo') => ({
  id, path, name: path.split('/').at(-1), kind: 'diff', pinned: true,
  content: '', savedContent: '', repositoryRoot,
});
const absolutePathForTab = tab => tab.kind === 'diff'
  ? `${tab.repositoryRoot}/${tab.path}`.replace(/\\/g, '/')
  : tab.path?.replace(/\\/g, '/') ?? null;

async function run() {
  const originalTabs = [
    source('source:a', '/repo/a.tex', 'old a', { pinned: true }),
    source('source:b', '/repo/b.tex', 'old b', { preview: true }),
    asset('asset:figure', '/repo/figure.png'),
    diff('diff:gone', 'gone.tex'),
  ];
  const result = await reloadWorkspaceTabs({
    tabs: originalTabs,
    activeTabId: 'source:b',
    activeSourceTabId: 'source:b',
    existingPaths: new Set(['/repo/a.tex', '/repo/b.tex', '/repo/figure.png']),
    absolutePathForTab,
    readFile: async path => path.endsWith('a.tex') ? 'new a' : 'new b',
    getCurrentTabs: () => originalTabs,
  });
  assert.equal(result.applied, true);
  assert.deepEqual(result.tabs.map(tab => tab.id), ['source:a', 'source:b', 'asset:figure']);
  assert.equal(result.tabs[0].pinned, true);
  assert.equal(result.tabs[1].preview, true);
  assert.equal(result.tabs[0].content, 'new a');
  assert.equal(result.tabs[0].savedContent, 'new a');
  assert.equal(result.activeTabId, 'source:b');
  assert.equal(result.activeSourceTabId, 'source:b');
  console.log('  [PASS] Reload updates source buffers while preserving tab order, IDs, flags, and selection.');

  const deleted = await reloadWorkspaceTabs({
    tabs: originalTabs,
    activeTabId: 'source:a',
    activeSourceTabId: 'source:a',
    existingPaths: new Set(['/repo/b.tex']),
    absolutePathForTab,
    readFile: async () => 'new b',
    getCurrentTabs: () => originalTabs,
  });
  assert.deepEqual(deleted.deletedNames, ['a.tex', 'figure.png', 'gone.tex']);
  assert.deepEqual(deleted.tabs.map(tab => tab.id), ['source:b']);
  assert.equal(deleted.activeTabId, 'source:b');
  console.log('  [PASS] Removed source and asset tabs close with names available for a warning.');

  const unreadable = await reloadWorkspaceTabs({
    tabs: [source('source:a', '/repo/a.tex', 'keep this')],
    activeTabId: 'source:a',
    activeSourceTabId: 'source:a',
    existingPaths: new Set(['/repo/a.tex']),
    absolutePathForTab,
    readFile: async () => { throw new Error('unreadable'); },
    getCurrentTabs: () => [source('source:a', '/repo/a.tex', 'keep this')],
  });
  assert.equal(unreadable.tabs[0].content, 'keep this');
  assert.equal(unreadable.tabs[0].savedContent, 'keep this');
  console.log('  [PASS] A listed file that cannot be read keeps its existing buffer.');

  const dirtyCurrent = [source('source:a', '/repo/a.tex', 'late edit', { savedContent: 'old disk' })];
  const lateEdit = await reloadWorkspaceTabs({
    tabs: [source('source:a', '/repo/a.tex', 'old disk')],
    activeTabId: 'source:a',
    activeSourceTabId: 'source:a',
    existingPaths: new Set(['/repo/a.tex']),
    absolutePathForTab,
    readFile: async () => 'remote disk',
    getCurrentTabs: () => dirtyCurrent,
  });
  assert.equal(lateEdit.applied, false);
  assert.equal(lateEdit.tabs[0].content, 'late edit');
  console.log('  [PASS] A late dirty edit prevents applying any disk reload.');

  const noSources = await reloadWorkspaceTabs({
    tabs: [source('source:a', '/repo/a.tex', 'old a')],
    activeTabId: 'source:a',
    activeSourceTabId: 'source:a',
    existingPaths: new Set(),
    absolutePathForTab,
    readFile: async () => 'unused',
    getCurrentTabs: () => [source('source:a', '/repo/a.tex', 'old a')],
  });
  assert.equal(noSources.activeTabId, null);
  assert.equal(noSources.activeSourceTabId, null);
  assert.deepEqual(noSources.tabs, []);
  console.log('  [PASS] A project with no remaining open sources returns an empty, safe selection.');

  const nestedRoot = '/repo/packages/latex';
  const nestedSource = source('source:nested', '/repo/packages/latex/nested.tex', 'old nested');
  const outsideSource = source('source:outside', '/repo/shared/macros.sty', 'old macro');
  const rootDiff = diff('diff:root', '.gitignore', '/repo');
  const nestedDiff = diff('diff:nested', '.gitignore', nestedRoot);
  const nestedReload = await reloadWorkspaceTabs({
    tabs: [nestedSource, outsideSource, rootDiff, nestedDiff],
    activeTabId: 'diff:root',
    activeSourceTabId: 'source:nested',
    existingPaths: new Set([
      '/repo/packages/latex/nested.tex', '/repo/shared/macros.sty',
      '/repo/.gitignore', `${nestedRoot}/.gitignore`,
    ]),
    absolutePathForTab,
    readFile: async path => path.endsWith('nested.tex') ? 'new nested' : 'new macro',
    getCurrentTabs: () => [nestedSource, outsideSource, rootDiff, nestedDiff],
  });
  assert.equal(nestedReload.applied, true);
  assert.deepEqual(nestedReload.tabs.map(tab => tab.id), ['source:nested', 'source:outside', 'diff:root', 'diff:nested']);
  assert.equal(nestedReload.tabs[1].content, 'new macro');
  assert.equal(nestedReload.tabs[2].repositoryRoot, '/repo');
  assert.equal(nestedReload.tabs[3].repositoryRoot, nestedRoot);
  console.log('  [PASS] Nested-project refresh reloads outside source tabs and resolves root-bound diffs against their own repository roots.');

  const deletedOutsideAndDiff = await reloadWorkspaceTabs({
    tabs: [outsideSource, rootDiff],
    activeTabId: 'source:outside',
    activeSourceTabId: 'source:outside',
    existingPaths: new Set(),
    absolutePathForTab,
    readFile: async () => 'unused',
    getCurrentTabs: () => [outsideSource, rootDiff],
  });
  assert.deepEqual(deletedOutsideAndDiff.deletedNames, ['macros.sty', '.gitignore']);
  assert.deepEqual(deletedOutsideAndDiff.tabs, []);
  console.log('  [PASS] Deleted outside source and repository-root diff tabs close with their names available for a warning.');
}

run().catch(error => {
  console.error('[FAIL] Git workspace refresh tests failed:', error);
  process.exit(1);
});
