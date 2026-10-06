import React, { useState, useEffect, useCallback } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useHotkeys } from 'react-hotkeys-hook';
import { Toaster } from 'sonner';
import { invoke } from '@tauri-apps/api/core';

import { MenuBar } from './components/MenuBar';
import { Toolbar } from './components/Toolbar';
import { PdfView } from './components/PdfView';
import { WelcomeScreen } from './components/WelcomeScreen';
import { NewProjectModal } from './components/NewProjectModal';
import { CloneRepositoryModal } from './components/CloneRepositoryModal';
import { WorkspaceTabs } from './components/WorkspaceTabs';
import { SidebarActivityBar, SidebarContentPanels } from './components/sidebar';
import { WritingRibbon } from './components/writing/WritingRibbon';

import { useRecentProjects, useCompiler, useExport, useProject, useSidebar } from './hooks';
import { useGitOperation } from './hooks/useGitOperation';
import { ViewMode } from './types';
import { tabIsDirty } from './types/workspace';
import type { WritingEditorBridge, WritingEditorState } from './types/writing';
import { inspectPackageEligibility } from './editor/writing';
import './App.css';

const normalizeWorkspacePath = (path: string): string => {
  const value = path.replace(/\\/g, '/');
  const drive = value.match(/^[A-Za-z]:/)?.[0] ?? '';
  const isAbsolute = value.startsWith('/') || Boolean(drive);
  const parts = value.slice(drive.length).split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..' && normalized.length && normalized[normalized.length - 1] !== '..') normalized.pop();
    else if (part !== '..' || !isAbsolute) normalized.push(part);
  }
  const prefix = drive ? `${drive}/` : value.startsWith('/') ? '/' : '';
  return `${prefix}${normalized.join('/')}` || prefix || '.';
};

const resolveMainFilePath = (projectRoot: string, mainFilePath: string): string => {
  const path = mainFilePath.replace(/\\/g, '/');
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path) ? path : `${projectRoot}/${path}`;
};

export const App: React.FC = () => {
  // Navigation & Workspace UI State
  const [viewMode, setViewMode] = useState<ViewMode>('welcome');
  const sidebar = useSidebar();
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState<boolean>(false);
  const [newProjectModalInitialTab, setNewProjectModalInitialTab] = useState<'create' | 'import'>('create');
  const [isCloneRepositoryModalOpen, setIsCloneRepositoryModalOpen] = useState(false);
  const cloneInProgressRef = React.useRef(false);

  // Diagnostics Line Navigation
  const [jumpToLine, setJumpToLine] = useState<number | null>(null);
  const [writingBridge, setWritingBridge] = useState<WritingEditorBridge | null>(null);
  const [writingEditorState, setWritingEditorState] = useState<WritingEditorState>({
    language: 'latex',
    editable: false,
    available: false,
    reason: 'Select an editable LaTeX source file.',
    source: '',
    cursorOffset: 0,
    canAddPackages: false,
  });

  // Modular Domain Hooks
  const {
    recentProjects,
    recordRecentProject,
    removeRecentProject,
  } = useRecentProjects();

  const compiler = useCompiler();
  const exportService = useExport();

  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest('.monaco-editor')) return;
      event.preventDefault();
    };
    window.addEventListener('contextmenu', preventNativeContextMenu, true);
    return () => window.removeEventListener('contextmenu', preventNativeContextMenu, true);
  }, []);

  const project = useProject({
    compile: compiler.compile,
    clearCompilationAndDiagnostics: compiler.clearCompilationAndDiagnostics,
    recordRecentProject,
    removeRecentProject,
    onEnterEditorMode: () => setViewMode('editor'),
    onEnterWelcomeMode: () => setViewMode('welcome'),
  });
  const cloneOperation = useGitOperation(null);
  const handleWritingBridgeChange = useCallback((bridge: WritingEditorBridge | null, state: WritingEditorState) => {
    setWritingBridge(bridge);
    setWritingEditorState(state);
  }, []);
  const activeWorkspaceTab = project.tabs.find(tab => tab.id === project.activeTabId) ?? null;
  const isScratchpad = !project.projectRoot && activeWorkspaceTab?.kind === 'source' && activeWorkspaceTab.path === null;
  const isConfiguredMainFile = Boolean(
    project.projectRoot
    && project.mainFilePath
    && project.activeFilePath
    && normalizeWorkspacePath(project.activeFilePath) === normalizeWorkspacePath(resolveMainFilePath(project.projectRoot, project.mainFilePath)),
  );
  const packageEligibility = project.engine === 'latex'
    ? inspectPackageEligibility(project.sourceCode)
    : { eligible: false, reason: undefined };
  const canAddWritingPackages = project.engine === 'latex' && !project.worktreeUpdateBusy
    && (isScratchpad || isConfiguredMainFile)
    && packageEligibility.eligible;
  const openConfiguredMainFile = useCallback(() => {
    if (!project.projectRoot || !project.mainFilePath || project.worktreeUpdateBusy) return;
    void project.selectFile(resolveMainFilePath(project.projectRoot, project.mainFilePath), true);
  }, [project.mainFilePath, project.projectRoot, project.selectFile, project.worktreeUpdateBusy]);

  const openProjectFolder = (path?: string) => {
    if (cloneInProgressRef.current) return Promise.resolve(false);
    return project.openFolder(path);
  };

  const cloneRepository = async (url: string, parentDir: string, directoryName: string) => {
    cloneInProgressRef.current = true;
    try {
      const result = await cloneOperation.run<{ projectPath: string }>('clone', 'clone_git_repository', {
        url,
        parentDir,
        directoryName,
      });
      const opened = await project.openFolder(result.projectPath);
      if (!opened) {
        throw Object.assign(
          new Error('The repository was cloned, but ScienceBatch could not open the project.'),
          { projectPath: result.projectPath },
        );
      }
    } finally {
      cloneInProgressRef.current = false;
    }
  };

  // Hotkeys
  useHotkeys('ctrl+s, meta+s', (e) => {
    e.preventDefault();
    if (viewMode === 'editor') project.saveFile();
  }, { enableOnFormTags: true, enableOnContentEditable: true }, [project.saveFile, viewMode]);

  useHotkeys('ctrl+w, meta+w', (e) => {
    e.preventDefault();
    if (viewMode === 'editor') project.closeTabs(false);
  }, { enableOnFormTags: true, enableOnContentEditable: true }, [project.closeTabs, viewMode]);

  useHotkeys('ctrl+shift+w, meta+shift+w', (e) => {
    e.preventDefault();
    if (viewMode === 'editor') project.closeTabs(true);
  }, { enableOnFormTags: true, enableOnContentEditable: true }, [project.closeTabs, viewMode]);

  useHotkeys('ctrl+b, meta+b', (e) => {
    e.preventDefault();
    if (viewMode === 'editor') sidebar.toggleSidebar();
  }, { enableOnFormTags: true, enableOnContentEditable: true }, [viewMode, sidebar.toggleSidebar]);

  useHotkeys('ctrl+shift+f, meta+shift+f', (e) => {
    e.preventDefault();
    if (viewMode === 'editor') {
      sidebar.toggleTool('search');
    }
  }, { enableOnFormTags: true, enableOnContentEditable: true }, [viewMode, sidebar.toggleTool]);

  useHotkeys('alt+1', (e) => {
    e.preventDefault();
    if (viewMode === 'editor') {
      sidebar.toggleTool('files');
    }
  }, { enableOnFormTags: true, enableOnContentEditable: true }, [viewMode, sidebar.toggleTool]);

  useHotkeys('alt+7', (e) => {
    e.preventDefault();
    if (viewMode === 'editor') {
      sidebar.toggleTool('outline');
    }
  }, { enableOnFormTags: true, enableOnContentEditable: true }, [viewMode, sidebar.toggleTool]);

  // Listen to IDE commands dispatched from inside Monaco Editor
  useEffect(() => {
    const handleToggleSidebar = () => {
      if (viewMode === 'editor') sidebar.toggleSidebar();
    };
    const handleOpenSearch = () => {
      if (viewMode === 'editor') sidebar.toggleTool('search');
    };
    const handleOpenFiles = () => {
      if (viewMode === 'editor') sidebar.toggleTool('files');
    };
    const handleOpenOutline = () => {
      if (viewMode === 'editor') sidebar.toggleTool('outline');
    };
    const handleCloseActiveTab = () => {
      if (viewMode === 'editor') void project.closeTabs(false);
    };
    const handleCloseUnpinnedTabs = () => {
      if (viewMode === 'editor') void project.closeTabs(true);
    };

    window.addEventListener('sciencebatch:toggle-sidebar', handleToggleSidebar);
    window.addEventListener('sciencebatch:open-search', handleOpenSearch);
    window.addEventListener('sciencebatch:open-files', handleOpenFiles);
    window.addEventListener('sciencebatch:open-outline', handleOpenOutline);
    window.addEventListener('sciencebatch:close-active-tab', handleCloseActiveTab);
    window.addEventListener('sciencebatch:close-unpinned-tabs', handleCloseUnpinnedTabs);

    return () => {
      window.removeEventListener('sciencebatch:toggle-sidebar', handleToggleSidebar);
      window.removeEventListener('sciencebatch:open-search', handleOpenSearch);
      window.removeEventListener('sciencebatch:open-files', handleOpenFiles);
      window.removeEventListener('sciencebatch:open-outline', handleOpenOutline);
      window.removeEventListener('sciencebatch:close-active-tab', handleCloseActiveTab);
      window.removeEventListener('sciencebatch:close-unpinned-tabs', handleCloseUnpinnedTabs);
    };
  }, [viewMode, sidebar.toggleSidebar, sidebar.toggleTool, project.closeTabs]);

  useHotkeys('ctrl+n, meta+n', (e) => {
    e.preventDefault();
    if (cloneInProgressRef.current) return;
    setNewProjectModalInitialTab('create');
    setIsNewProjectModalOpen(true);
  });

  useHotkeys('ctrl+i, meta+i', (e) => {
    e.preventDefault();
    if (cloneInProgressRef.current) return;
    project.importZip();
  });

  useHotkeys('ctrl+o, meta+o', (e) => {
    e.preventDefault();
    void openProjectFolder();
  });

  useHotkeys('ctrl+shift+e, meta+shift+e', (e) => {
    e.preventDefault();
    if (viewMode === 'editor') exportService.downloadPdf(compiler.pdfBytes, project.projectName, project.projectRoot);
  }, [exportService, compiler.pdfBytes, project.projectName, project.projectRoot, viewMode]);

  useHotkeys('ctrl+shift+z, meta+shift+z', (e) => {
    e.preventDefault();
    if (viewMode === 'editor') exportService.exportZip(project.projectRoot, project.projectName, project.sourceCode, project.engine);
  }, [exportService, project.projectRoot, project.projectName, project.sourceCode, project.engine, viewMode]);

  // Context-aware Zoom hotkeys (intercept default webview scaling and delegate)
  useHotkeys(['ctrl+=', 'ctrl+plus', 'meta+=', 'meta+plus'], (e) => {
    e.preventDefault();
    const activeEl = document.activeElement;
    const isInsideMonaco = activeEl?.closest('.monaco-editor');
    if (!isInsideMonaco && viewMode === 'editor' && compiler.pdfBytes) {
      compiler.handleZoomIn();
    }
  }, { enableOnFormTags: true, enableOnContentEditable: true }, [viewMode, compiler.pdfBytes, compiler.handleZoomIn]);

  useHotkeys(['ctrl+-', 'ctrl+minus', 'meta+-', 'meta+minus'], (e) => {
    e.preventDefault();
    const activeEl = document.activeElement;
    const isInsideMonaco = activeEl?.closest('.monaco-editor');
    if (!isInsideMonaco && viewMode === 'editor' && compiler.pdfBytes) {
      compiler.handleZoomOut();
    }
  }, { enableOnFormTags: true, enableOnContentEditable: true }, [viewMode, compiler.pdfBytes, compiler.handleZoomOut]);

  useHotkeys(['ctrl+0', 'meta+0'], (e) => {
    e.preventDefault();
    const activeEl = document.activeElement;
    const isInsideMonaco = activeEl?.closest('.monaco-editor');
    if (!isInsideMonaco && viewMode === 'editor' && compiler.pdfBytes) {
      compiler.handleZoomReset();
    }
  }, { enableOnFormTags: true, enableOnContentEditable: true }, [viewMode, compiler.pdfBytes, compiler.handleZoomReset]);

  // Global safeguard: prevent native browser webview zoom on Ctrl+Wheel, Touchpad Pinch, and Gestures
  useEffect(() => {
    // Reset any lingering webview zoom to 1.0 immediately on mount
    invoke('reset_webview_zoom').catch(() => {});

    // 1. Capture-phase wheel listener: ALWAYS prevent default on ctrlKey
    // Calling e.preventDefault() here stops the browser engine from scaling the window,
    // while allowing child event listeners (PdfView, EditorView) to process the event.
    const handleCaptureWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };

    // 2. WebKit gesture events (pinch-to-zoom on Linux/macOS WebKit)
    const handleCaptureGesture = (e: Event) => {
      e.preventDefault();
    };

    // 3. Multi-touch events (prevent pinch-zoom on touch surfaces)
    const handleCaptureTouch = (e: TouchEvent) => {
      if (e.touches.length > 1) {
        e.preventDefault();
      }
    };

    const options = { capture: true, passive: false };
    window.addEventListener('wheel', handleCaptureWheel, options);
    window.addEventListener('gesturestart', handleCaptureGesture, options);
    window.addEventListener('gesturechange', handleCaptureGesture, options);
    window.addEventListener('gestureend', handleCaptureGesture, options);
    window.addEventListener('touchstart', handleCaptureTouch, options);
    window.addEventListener('touchmove', handleCaptureTouch, options);

    document.addEventListener('wheel', handleCaptureWheel, options);
    document.addEventListener('gesturestart', handleCaptureGesture, options);
    document.addEventListener('gesturechange', handleCaptureGesture, options);
    document.addEventListener('gestureend', handleCaptureGesture, options);
    document.addEventListener('touchstart', handleCaptureTouch, options);
    document.addEventListener('touchmove', handleCaptureTouch, options);

    return () => {
      const rmOptions = { capture: true } as EventListenerOptions;
      window.removeEventListener('wheel', handleCaptureWheel, rmOptions);
      window.removeEventListener('gesturestart', handleCaptureGesture, rmOptions);
      window.removeEventListener('gesturechange', handleCaptureGesture, rmOptions);
      window.removeEventListener('gestureend', handleCaptureGesture, rmOptions);
      window.removeEventListener('touchstart', handleCaptureTouch, rmOptions);
      window.removeEventListener('touchmove', handleCaptureTouch, rmOptions);

      document.removeEventListener('wheel', handleCaptureWheel, rmOptions);
      document.removeEventListener('gesturestart', handleCaptureGesture, rmOptions);
      document.removeEventListener('gesturechange', handleCaptureGesture, rmOptions);
      document.removeEventListener('gestureend', handleCaptureGesture, rmOptions);
      document.removeEventListener('touchstart', handleCaptureTouch, rmOptions);
      document.removeEventListener('touchmove', handleCaptureTouch, rmOptions);
    };
  }, []);

  const handleSelectLine = async (line: number, file?: string | null) => {
    if (file && project.projectRoot) {
      const cleanRel = file.replace(/^\.\//, '');
      const fullPath = file.startsWith('/') ? file : `${project.projectRoot}/${cleanRel}`;
      if (fullPath !== project.activeFilePath) {
        await project.selectFile(fullPath);
        setTimeout(() => {
          setJumpToLine(line);
          setTimeout(() => setJumpToLine(null), 150);
        }, 80);
        return;
      }
    }
    setJumpToLine(line);
    setTimeout(() => setJumpToLine(null), 150);
  };

  const handleCompileCurrent = () => {
    compiler.compile(project.sourceCode, project.engine, project.projectRoot, project.mainFilePath);
  };

  return (
    <div className="app-layout">
      {/* Top Desktop Menu Bar */}
      <MenuBar
        onNewProject={() => {
          if (cloneInProgressRef.current) return;
          setNewProjectModalInitialTab('create');
          setIsNewProjectModalOpen(true);
        }}
        onOpenFolder={() => { void openProjectFolder(); }}
        onImportZip={() => { if (!cloneInProgressRef.current) void project.importZip(); }}
        onSaveFile={project.saveFile}
        onExportPdf={() => exportService.downloadPdf(compiler.pdfBytes, project.projectName, project.projectRoot)}
        onExportZip={() => exportService.exportZip(project.projectRoot, project.projectName, project.sourceCode, project.engine)}
        onExportMarkdown={() => exportService.exportMarkdown(project.projectRoot, project.projectName, project.sourceCode, project.engine, project.mainFilePath)}
        onExportHtml={() => exportService.exportHtml(project.projectRoot, project.projectName, project.sourceCode, project.engine, project.mainFilePath)}
        onCloseProject={project.closeProject}
        onCompile={handleCompileCurrent}
        onCancelCompile={compiler.cancelCompilation}
        isCompiling={compiler.isCompiling}
        activeTab={compiler.activeTab}
        onTabChange={compiler.setActiveTab}
        sidebarOpen={sidebar.state.isOpen}
        onToggleSidebar={sidebar.toggleSidebar}
        engine={project.engine}
        onSwitchEngine={project.switchEngine}
        onZoomIn={compiler.handleZoomIn}
        onZoomOut={compiler.handleZoomOut}
        onZoomReset={compiler.handleZoomReset}
        recentProjects={recentProjects}
        onOpenRecentProject={(path) => openProjectFolder(path)}
        hasOpenProject={viewMode === 'editor'}
      />

      {/* Main Workspace Toolbar (Shown only in editor mode) */}
      {viewMode === 'editor' && (
        <Toolbar
          onCompile={handleCompileCurrent}
          onCancelCompile={compiler.cancelCompilation}
          isCompiling={compiler.isCompiling}
          compilationStatus={compiler.compilationStatus}
          statusMessage={compiler.statusMessage}
          zoom={compiler.zoom}
          onZoomIn={compiler.handleZoomIn}
          onZoomOut={compiler.handleZoomOut}
          onZoomReset={compiler.handleZoomReset}
          onFitWidth={compiler.handleFitWidth}
          onDownloadPdf={() => exportService.downloadPdf(compiler.pdfBytes, project.projectName, project.projectRoot)}
          onExportZip={() => exportService.exportZip(project.projectRoot, project.projectName, project.sourceCode, project.engine)}
          onExportMarkdown={() => exportService.exportMarkdown(project.projectRoot, project.projectName, project.sourceCode, project.engine, project.mainFilePath)}
          onExportHtml={() => exportService.exportHtml(project.projectRoot, project.projectName, project.sourceCode, project.engine, project.mainFilePath)}
          hasPdf={compiler.pdfBytes !== null && compiler.pdfBytes.length > 0}
          engine={project.engine}
          onSwitchEngine={project.switchEngine}
          sidebarOpen={sidebar.state.isOpen}
          onToggleSidebar={sidebar.toggleSidebar}
          hasOpenProject={project.projectRoot !== null}
        />
      )}

      {viewMode === 'editor' && (
        <WritingRibbon
          bridge={writingBridge}
          editorState={{ ...writingEditorState, canAddPackages: canAddWritingPackages }}
          onOpenMainFile={project.projectRoot && project.mainFilePath ? openConfiguredMainFile : undefined}
        />
      )}

      {/* Body: Welcome Screen or Split Panels Workspace */}
      {viewMode === 'welcome' ? (
        <WelcomeScreen
        onNewProject={() => {
          if (cloneInProgressRef.current) return;
            setNewProjectModalInitialTab('create');
            setIsNewProjectModalOpen(true);
          }}
        onOpenFolder={() => { void openProjectFolder(); }}
        onCloneRepository={() => setIsCloneRepositoryModalOpen(true)}
        onImportZip={() => { if (!cloneInProgressRef.current) void project.importZip(); }}
        onQuickScratchpad={(engine) => { if (!cloneInProgressRef.current) project.quickScratchpad(engine); }}
          recentProjects={recentProjects}
          onOpenRecentProject={(path) => openProjectFolder(path)}
          onRemoveRecentProject={removeRecentProject}
        />
      ) : (
        <main className="workspace-container">
          {/* JetBrains Left Activity Icon Bar */}
          {project.projectRoot && (
            <SidebarActivityBar
              topTools={sidebar.state.topTools}
              bottomTools={sidebar.state.bottomTools}
              activeTopTool={sidebar.state.activeTopTool}
              activeBottomTool={sidebar.state.activeBottomTool}
              onToggleTool={sidebar.toggleTool}
              onMoveTool={sidebar.moveTool}
              onResetToDefaults={sidebar.resetToDefaults}
              isOpen={sidebar.state.isOpen}
            />
          )}

          <PanelGroup direction="horizontal">
            {/* Collapsible Tool Window Content Panels */}
            {project.projectRoot && sidebar.state.isOpen && (sidebar.state.activeTopTool || sidebar.state.activeBottomTool) && (
              <>
                <Panel 
                  defaultSize={sidebar.state.panelWidth} 
                  minSize={15} 
                  maxSize={45}
                  onResize={(size) => sidebar.setPanelWidth(Math.round(size))}
                >
                  <SidebarContentPanels
                    activeTopTool={sidebar.state.activeTopTool}
                    activeBottomTool={sidebar.state.activeBottomTool}
                    splitRatio={sidebar.state.splitRatio}
                    onSplitRatioChange={sidebar.setSplitRatio}
                    onCloseTool={sidebar.closeTool}
                    files={project.projectFiles}
                    activeFilePath={project.activeFilePath}
                    mainFilePath={project.mainFilePath}
                    onSelectFile={project.selectFile}
                    onOpenDiff={(path, repositoryRoot) => /\.(png|jpe?g|svg|webp|gif|bmp|pdf)$/i.test(path) ? void project.selectFile(`${repositoryRoot}/${path}`) : project.openDiff(path, repositoryRoot)}
                    onBranchChanged={() => project.refreshAfterGitUpdate()}
                    onWorktreeUpdateBusyChange={project.setWorktreeUpdateBusy}
                    hasUnsavedChanges={project.tabs.some(tabIsDirty)}
                    onSetMainFile={project.setMainFile}
                    onCreateFile={project.createFile}
                    onCreateFolder={project.createFolder}
                    onDeleteFile={project.deleteFile}
                    onViewImage={(path) => project.selectFile(path)}
                    onImportFiles={project.importFiles}
                    projectRoot={project.projectRoot}
                    projectName={project.projectName}
                    engine={project.engine}
                    sourceCode={project.sourceCode}
                    onUpdateSourceCode={project.setSourceCode}
                    onSelectLine={handleSelectLine}
                  />
                </Panel>
                <PanelResizeHandle className="resize-handle" />
              </>
            )}

            {/* Monaco Editor Panel */}
            <Panel 
              defaultSize={project.projectRoot && sidebar.state.isOpen && (sidebar.state.activeTopTool || sidebar.state.activeBottomTool) ? (100 - sidebar.state.panelWidth) / 2 : 50} 
              minSize={25}
            >
              <WorkspaceTabs
                tabs={project.tabs}
                activeTabId={project.activeTabId}
                projectRoot={project.projectRoot}
                sourceCode={project.sourceCode}
                onChange={project.setSourceCode}
                onActivate={project.activateTab}
                onPromote={project.promoteTab}
                onClose={project.closeTabs}
                onPin={project.togglePin}
                errors={compiler.errors}
                warnings={compiler.warnings}
                jumpToLine={jumpToLine}
                engine={project.engine}
                activeFilePath={project.activeFilePath}
                readOnly={project.worktreeUpdateBusy}
                isScratchpad={isScratchpad}
                canAddPackages={canAddWritingPackages}
                onWritingBridgeChange={handleWritingBridgeChange}
              />
            </Panel>

            <PanelResizeHandle className="resize-handle" />

            {/* PDF & Diagnostics Preview Panel */}
            <Panel 
              defaultSize={project.projectRoot && sidebar.state.isOpen && (sidebar.state.activeTopTool || sidebar.state.activeBottomTool) ? (100 - sidebar.state.panelWidth) / 2 : 50} 
              minSize={25}
            >
              <PdfView
                pdfBytes={compiler.pdfBytes}
                zoom={compiler.zoom}
                onZoomChange={compiler.setZoom}
                isCompiling={compiler.isCompiling}
                errors={compiler.errors}
                warnings={compiler.warnings}
                rawLog={compiler.rawLog}
                activeTab={compiler.activeTab}
                onTabChange={compiler.setActiveTab}
                onRetryCompile={handleCompileCurrent}
                onSelectLine={handleSelectLine}
                engine={project.engine}
              />
            </Panel>
          </PanelGroup>
        </main>
      )}

      {/* New Project Assistant Modal */}
      <NewProjectModal
        isOpen={isNewProjectModalOpen}
        onClose={() => setIsNewProjectModalOpen(false)}
        onCreateProject={project.createProject}
        onImportZipProject={project.importZip}
        initialTab={newProjectModalInitialTab}
      />

      <CloneRepositoryModal
        isOpen={isCloneRepositoryModalOpen}
        running={cloneOperation.running}
        progress={cloneOperation.progress}
        error={cloneOperation.error}
        onClose={() => { if (!cloneOperation.running) setIsCloneRepositoryModalOpen(false); }}
        onOpenExisting={path => project.openFolder(path)}
        onClone={cloneRepository}
      />

      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
};

export default App;
