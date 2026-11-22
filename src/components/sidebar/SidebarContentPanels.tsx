import React from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FileItem } from '../../types';
import { SidebarToolId } from '../../types/sidebar';
import { FileTree } from '../FileTree';
import { GlobalSearchView } from './GlobalSearchView';
import { DocumentOutlineView } from './DocumentOutlineView';
import { GitStatusView } from './GitStatusView';
import { DependenciesPanel } from './DependenciesPanel';
import type { useProjectResources } from '../../hooks/useProjectResources';

interface SidebarContentPanelsProps {
  activeTopTool: SidebarToolId | null;
  activeBottomTool: SidebarToolId | null;
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
  onCloseTool: (slot: 'top' | 'bottom') => void;

  // FileTree Props
  files: FileItem[];
  activeFilePath: string | null;
  mainFilePath: string | null;
  onSelectFile: (path: string, permanent?: boolean) => Promise<void> | void;
  onSetMainFile: (path: string) => void;
  onCreateFile: (parentDir: string, name: string) => void;
  onCreateFolder: (parentDir: string, name: string) => void;
  onDeleteFile: (path: string) => void;
  onViewImage?: (path: string, name: string) => void;
  onImportFiles?: (targetDir?: string) => void;
  onRenamePath?: (oldPath: string, newName: string) => Promise<boolean> | boolean;
  onMovePath?: (srcPath: string, destDir: string) => Promise<boolean> | boolean;
  onDeletePath?: (path: string, isDir?: boolean) => Promise<boolean> | boolean;
  onDuplicatePath?: (path: string, isDir?: boolean) => Promise<string | null> | void;
  onRevealInFileManager?: (path: string) => Promise<void> | void;
  onRefreshFiles?: () => Promise<void> | void;
  projectRoot: string | null;
  projectName: string;
  engine: 'latex' | 'typst';

  // Editor & Search Props
  sourceCode: string;
  activeCursorLine?: number | null;
  onUpdateSourceCode: (code: string) => void;
  onSelectLine: (line: number, file?: string | null) => void;
  onOpenDiff?: (path: string, repositoryRoot: string) => void;
  onBranchChanged?: () => Promise<void | boolean> | void | boolean;
  onWorktreeUpdateBusyChange?: (busy: boolean) => void;
  hasUnsavedChanges?: boolean;
  resources: ReturnType<typeof useProjectResources>;
}

export const SidebarContentPanels: React.FC<SidebarContentPanelsProps> = ({
  activeTopTool,
  activeBottomTool,
  splitRatio,
  onSplitRatioChange,
  onCloseTool,
  files,
  activeFilePath,
  mainFilePath,
  onSelectFile,
  onSetMainFile,
  onCreateFile,
  onCreateFolder,
  onDeleteFile,
  onViewImage,
  onImportFiles,
  onRenamePath,
  onMovePath,
  onDeletePath,
  onDuplicatePath,
  onRevealInFileManager,
  onRefreshFiles,
  projectRoot,
  projectName,
  engine,
  sourceCode,
  activeCursorLine,
  onUpdateSourceCode,
  onSelectLine,
  onOpenDiff,
  onBranchChanged,
  onWorktreeUpdateBusyChange,
  hasUnsavedChanges,
  resources,
}) => {
  const isSplit = Boolean(activeTopTool && activeBottomTool);

  const renderTool = (toolId: SidebarToolId, slot: 'top' | 'bottom') => {
    switch (toolId) {
      case 'files':
        return (
          <div className="sidebar-tool-panel-content">
            <FileTree
              files={files}
              activeFilePath={activeFilePath}
              mainFilePath={mainFilePath}
              onSelectFile={onSelectFile}
              onSetMainFile={onSetMainFile}
              onCreateFile={onCreateFile}
              onCreateFolder={onCreateFolder}
              onDeleteFile={onDeleteFile}
              onViewImage={onViewImage}
              onImportFiles={onImportFiles}
              onRenamePath={onRenamePath}
              onMovePath={onMovePath}
              onDeletePath={onDeletePath}
              onDuplicatePath={onDuplicatePath}
              onRevealInFileManager={onRevealInFileManager}
              onRefreshFiles={onRefreshFiles}
              projectRoot={projectRoot || ''}
              projectName={projectName}
              engine={engine}
              onClose={() => onCloseTool(slot)}
            />
          </div>
        );

      case 'search':
        return (
          <div className="sidebar-tool-panel-content">
            <GlobalSearchView
              projectFiles={files}
              projectRoot={projectRoot}
              activeFilePath={activeFilePath}
              sourceCode={sourceCode}
              onUpdateSourceCode={onUpdateSourceCode}
              onSelectFile={onSelectFile}
              onSelectLine={onSelectLine}
              onClose={() => onCloseTool(slot)}
            />
          </div>
        );

      case 'outline':
        return (
          <div className="sidebar-tool-panel-content">
            <DocumentOutlineView
              engine={engine}
              sourceCode={sourceCode}
              activeFilePath={activeFilePath}
              activeCursorLine={activeCursorLine}
              mainFilePath={mainFilePath}
              projectRoot={projectRoot}
              onSelectFile={onSelectFile}
              onSelectLine={onSelectLine}
              onClose={() => onCloseTool(slot)}
            />
          </div>
        );

      case 'git':
        return (
          <div className="sidebar-tool-panel-content">
            <GitStatusView
              projectRoot={projectRoot}
              projectName={projectName}
              onSelectFile={onSelectFile}
              onOpenDiff={onOpenDiff}
              onBranchChanged={onBranchChanged}
              onWorktreeUpdateBusyChange={onWorktreeUpdateBusyChange}
              hasUnsavedChanges={hasUnsavedChanges}
              onClose={() => onCloseTool(slot)}
            />
          </div>
        );

      case 'dependencies':
        return (
          <div className="sidebar-tool-panel-content">
            <DependenciesPanel
              resources={resources}
              onClose={() => onCloseTool(slot)}
              onSelectLine={onSelectLine}
              engine={engine}
            />
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="jetbrains-sidebar-panels">
      {isSplit && activeTopTool && activeBottomTool ? (
        <PanelGroup
          direction="vertical"
          onLayout={(sizes) => {
            if (sizes && sizes.length >= 2 && sizes[0] > 0) {
              onSplitRatioChange(Math.round(sizes[0]));
            }
          }}
        >
          <Panel defaultSize={splitRatio} minSize={15} maxSize={85}>
            {renderTool(activeTopTool, 'top')}
          </Panel>
          <PanelResizeHandle className="resize-handle-horizontal" />
          <Panel defaultSize={100 - splitRatio} minSize={15} maxSize={85}>
            {renderTool(activeBottomTool, 'bottom')}
          </Panel>
        </PanelGroup>
      ) : activeTopTool ? (
        renderTool(activeTopTool, 'top')
      ) : activeBottomTool ? (
        renderTool(activeBottomTool, 'bottom')
      ) : null}
    </div>
  );
};
