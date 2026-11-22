import type { WorkspaceTab } from '../types/workspace';

interface ReloadWorkspaceTabsOptions {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  activeSourceTabId: string | null;
  existingPaths: Set<string>;
  absolutePathForTab: (tab: WorkspaceTab) => string | null;
  readFile: (path: string) => Promise<string>;
  getCurrentTabs: () => WorkspaceTab[];
}

export interface ReloadWorkspaceTabsResult {
  applied: boolean;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  activeSourceTabId: string | null;
  deletedNames: string[];
}

const isDirtySourceTab = (tab: WorkspaceTab) => tab.kind === 'source' && tab.content !== tab.savedContent;

export const reloadWorkspaceTabs = async ({
  tabs,
  activeTabId,
  activeSourceTabId,
  existingPaths,
  absolutePathForTab,
  readFile,
  getCurrentTabs,
}: ReloadWorkspaceTabsOptions): Promise<ReloadWorkspaceTabsResult> => {
  const results = await Promise.all(tabs.map(async tab => {
    const absolutePath = absolutePathForTab(tab);
    if (!tab.path || !absolutePath) return { tab, kind: 'keep' as const };
    if (!existingPaths.has(absolutePath.replace(/\\/g, '/'))) return { tab, kind: 'deleted' as const };
    if (tab.kind === 'diff') return { tab, kind: 'keep' as const };
    if (tab.kind !== 'source') return { tab, kind: 'keep' as const };
    try {
      return { tab, kind: 'read' as const, content: await readFile(tab.path) };
    } catch {
      return { tab, kind: 'unreadable' as const };
    }
  }));

  // A late editor change must win over disk content returned by an in-flight read.
  const latestTabs = getCurrentTabs();
  if (latestTabs.some(isDirtySourceTab)) {
    return { applied: false, tabs: latestTabs, activeTabId, activeSourceTabId, deletedNames: [] };
  }

  const resultTabs = results.flatMap(result => {
    if (result.kind === 'deleted') return [];
    if (result.kind === 'read') return [{ ...result.tab, content: result.content, savedContent: result.content }];
    return [result.tab];
  });
  const nextActiveTabId = activeTabId && resultTabs.some(tab => tab.id === activeTabId)
    ? activeTabId
    : resultTabs[0]?.id ?? null;
  const nextActiveSourceTabId = activeSourceTabId && resultTabs.some(tab => tab.id === activeSourceTabId && tab.kind === 'source')
    ? activeSourceTabId
    : [...resultTabs].reverse().find(tab => tab.kind === 'source')?.id ?? null;

  return {
    applied: true,
    tabs: resultTabs,
    activeTabId: nextActiveTabId,
    activeSourceTabId: nextActiveSourceTabId,
    deletedNames: results.filter(result => result.kind === 'deleted').map(result => result.tab.name),
  };
};
