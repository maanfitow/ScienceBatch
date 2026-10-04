export type WorkspaceTabKind = 'source' | 'asset' | 'diff';

export interface WorkspaceTab {
  id: string;
  path: string | null;
  name: string;
  kind: WorkspaceTabKind;
  pinned: boolean;
  preview?: boolean;
  content: string;
  savedContent: string;
}

export const isProjectAsset = (path: string) => /\.(png|jpe?g|svg|webp|gif|bmp|pdf)$/i.test(path);
export const tabIsDirty = (tab: WorkspaceTab) => tab.kind === 'source' && tab.content !== tab.savedContent;
