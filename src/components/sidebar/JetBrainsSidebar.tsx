import React from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FileItem } from '../../types';
import { SidebarToolId } from '../../types/sidebar';
import { SidebarActivityBar } from './SidebarActivityBar';
import { FileTree } from '../FileTree';
import { GlobalSearchView } from './GlobalSearchView';
import { DocumentOutlineView } from './DocumentOutlineView';
import { GitStatusView } from './GitStatusView';

interface JetBrainsSidebarProps {
  // FileTree Props
  files: FileItem[];
  activeFilePath: string | null;
  mainFilePath: string | null;
  onSelectFile: (path: string) => Promise<void> | void;
  onSetMainFile: (path: string) => void;
  onCreateFile: (parentDir: string, name: string) => void;
  onCreateFolder: (parentDir: string, name: string) => void;
  onDeleteFile: (path: string) => void;
  onViewImage?: (path: string, name: string) => void;
  onImportFiles?: () => void;
  projectRoot: string | null;
  projectName: string;
  engine: 'latex' | 'typst';

  // Editor & Project Props
  sourceCode: string;
  onUpdateSourceCode: (code: string) => void;
  onSelectLine: (line: number, file?: string | null) => void;
  onOpenDiff?: (path: string, repositoryRoot: string) => void;
  onBranchChanged?: () => Promise<void | boolean> | void | boolean;
  onWorktreeUpdateBusyChange?: (busy: boolean) => void;
  hasUnsavedChanges?: boolean;

  // Sidebar State & Actions
  topTools: SidebarToolId[];
  bottomTools: SidebarToolId[];
  activeTopTool: SidebarToolId | null;
  activeBottomTool: SidebarToolId | null;
  isOpen: boolean;
  splitRatio: number;
  onToggleTool: (id: SidebarToolId) => void;
  onMoveTool: (id: SidebarToolId, targetGroup: 'top' | 'bottom', targetIndex?: number) => void;
  onCloseTool: (slot: 'top' | 'bottom') => void;
  onResetToDefaults: () => void;
  onSplitRatioChange: (ratio: number) => void;
}

export const JetBrainsSidebar: React.FC<JetBrainsSidebarProps> = ({
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
  projectRoot,
  projectName,
  engine,
  sourceCode,
  onUpdateSourceCode,
  onSelectLine,
  onOpenDiff,
  onBranchChanged,
  onWorktreeUpdateBusyChange,
  hasUnsavedChanges,
  topTools,
  bottomTools,
  activeTopTool,
  activeBottomTool,
  isOpen,
  splitRatio,
  onToggleTool,
  onMoveTool,
  onCloseTool,
  onResetToDefaults,
  onSplitRatioChange,
}) => {
  const isSplit = Boolean(isOpen && activeTopTool && activeBottomTool);
  const hasActivePanel = Boolean(isOpen && (activeTopTool || activeBottomTool));

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

      default:
        return null;
    }
  };

  return (
    <div className="jetbrains-sidebar-root">
      {/* 1. Left Narrow Activity Icon Bar */}
      <SidebarActivityBar
        topTools={topTools}
        bottomTools={bottomTools}
        activeTopTool={activeTopTool}
        activeBottomTool={activeBottomTool}
        onToggleTool={onToggleTool}
        onMoveTool={onMoveTool}
        onResetToDefaults={onResetToDefaults}
        isOpen={isOpen}
      />

      {/* 2. Tool Content Panels (If open and tool selected) */}
      {hasActivePanel && (
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
      )}
    </div>
  );
};
