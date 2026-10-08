import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, ask } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { FileItem, EngineType } from '../types';
import { 
  setProjectFiles as setGlobalProjectFiles,
  setProjectCustomCommands,
  extractMacrosFromSource
} from '../editor/projectContext';
import { DEFAULT_LATEX_SOURCE } from '../editor/latexData';
import { DEFAULT_TYPST_SOURCE } from '../editor/typstData';
import { WorkspaceTab, isProjectAsset, tabIsDirty } from '../types/workspace';
import type { GitRepositoryInfo } from '../types/git';
import { reloadWorkspaceTabs } from './gitWorkspaceRefresh';
import { WorkspaceExportLease } from '../editor/workspaceExportLease';

interface UseProjectOptions {
  compile: (source: string, engine: EngineType, projectDir?: string | null, mainFile?: string | null) => Promise<void>;
  clearCompilationAndDiagnostics: () => void;
  recordRecentProject: (path: string, name: string, eng: EngineType) => void;
  removeRecentProject: (path: string) => void;
  onEnterEditorMode?: () => void;
  onEnterWelcomeMode?: () => void;
}

const flattenFilePaths = (items: FileItem[], base: string): string[] => {
  const result: string[] = [];
  for (const item of items) {
    const rel = item.path.startsWith(base) ? item.path.slice(base.length).replace(/^[/\\]/, '') : item.name;
    if (item.is_dir && item.children) {
      result.push(...flattenFilePaths(item.children, base));
    } else if (!item.is_dir) {
      result.push(rel);
    }
  }
  return result;
};

const collectProjectMacros = (diskSources: Map<string, string>, tabs: WorkspaceTab[]): Set<string> => {
  const sources = new Map(diskSources);
  for (const tab of tabs) {
    if (tab.kind === 'source' && tab.path && /\.(cls|sty)$/i.test(tab.path)) sources.set(tab.path, tab.content);
  }
  const commands = new Set<string>();
  for (const source of sources.values()) for (const command of extractMacrosFromSource(source)) commands.add(command);
  return commands;
};

const sameOpenStyleSources = (left: WorkspaceTab[], right: WorkspaceTab[]): boolean => {
  const styleSources = (tabs: WorkspaceTab[]) => new Map(tabs.flatMap(tab =>
    tab.kind === 'source' && tab.path && /\.(cls|sty)$/i.test(tab.path) ? [[tab.path, tab.content] as const] : [],
  ));
  const leftSources = styleSources(left);
  const rightSources = styleSources(right);
  return leftSources.size === rightSources.size
    && Array.from(leftSources).every(([path, content]) => rightSources.get(path) === content);
};

export function useProject({
  compile,
  clearCompilationAndDiagnostics,
  recordRecentProject,
  removeRecentProject,
  onEnterEditorMode,
  onEnterWelcomeMode,
}: UseProjectOptions) {
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>('');
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [mainFilePath, setMainFilePath] = useState<string | null>(null);
  const [projectFiles, setProjectFiles] = useState<FileItem[]>([]);
  const [engine, setEngine] = useState<EngineType>('latex');
  const [sourceCode, setSourceCodeState] = useState<string>(DEFAULT_LATEX_SOURCE);
  const [tabs, setTabsState] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tabsRef = useRef<WorkspaceTab[]>([]);
  const documentRevisionsRef = useRef<Map<string, number>>(new Map());
  const projectGenerationRef = useRef(0);
  const scratchpadSequenceRef = useRef(0);
  const activeTabRef = useRef<string | null>(null);
  const activeSourceTabRef = useRef<string | null>(null);
  const fileRequestRef = useRef(0);
  const worktreeUpdateBusyRef = useRef(false);
  const workspaceExportLeaseRef = useRef<WorkspaceExportLease | null>(null);
  if (!workspaceExportLeaseRef.current) workspaceExportLeaseRef.current = new WorkspaceExportLease();
  const [workspaceExportBusy, setWorkspaceExportBusy] = useState(false);
  const projectConfigRawRef = useRef<string | null>(null);
  const projectDiskMacrosRef = useRef<Set<string>>(new Set());
  const projectDiskStyleSourcesRef = useRef<Map<string, string>>(new Map());
  const [worktreeUpdateBusy, setWorktreeUpdateBusyState] = useState(false);
  const workspaceOperationBusy = () => worktreeUpdateBusyRef.current || workspaceExportLeaseRef.current?.active === true;
  const setWorktreeUpdateBusy = useCallback((busy: boolean) => {
    worktreeUpdateBusyRef.current = busy;
    setWorktreeUpdateBusyState(busy || workspaceExportLeaseRef.current?.active === true);
  }, []);
  const acquireWorkspaceExportLease = useCallback((leaseId: string) => {
    if (!workspaceExportLeaseRef.current?.acquire(leaseId, worktreeUpdateBusyRef.current)) return false;
    setWorkspaceExportBusy(true);
    setWorktreeUpdateBusyState(true);
    return true;
  }, []);
  const releaseWorkspaceExportLease = useCallback((leaseId: string) => {
    if (!workspaceExportLeaseRef.current?.release(leaseId)) return false;
    setWorkspaceExportBusy(false);
    setWorktreeUpdateBusyState(worktreeUpdateBusyRef.current);
    return true;
  }, []);
  const setTabs = useCallback((next: WorkspaceTab[]) => {
    const previous = tabsRef.current;
    tabsRef.current = next;
    setTabsState(next);
    if (!sameOpenStyleSources(previous, next)) {
      setProjectCustomCommands(collectProjectMacros(projectDiskStyleSourcesRef.current, next));
    }
  }, []);
  const setSourceCode = useCallback((content: string) => {
    if (workspaceOperationBusy()) return;
    setSourceCodeState(content);
    const active = tabsRef.current.find(tab => tab.id === activeTabRef.current);
    const targetId = active?.kind === 'source' ? active.id : activeSourceTabRef.current;
    if (targetId) {
      documentRevisionsRef.current.set(targetId, (documentRevisionsRef.current.get(targetId) ?? 0) + 1);
      const nextTabs = tabsRef.current.map(tab => tab.id === targetId && tab.kind === 'source' ? { ...tab, content, preview: false } : tab);
      setTabs(nextTabs);
    }
  }, [setTabs]);
  const activateTab = useCallback((id: string) => {
    if (workspaceOperationBusy()) return;
    const tab = tabsRef.current.find(item => item.id === id);
    if (!tab) return;
    fileRequestRef.current++;
    activeTabRef.current = id;
    setActiveTabId(id);
    if (tab.kind === 'source') {
      activeSourceTabRef.current = tab.id;
      activeFilePathRef.current = tab.path;
      setActiveFilePath(tab.path);
      setSourceCodeState(tab.content);
      if (tab.path?.endsWith('.typ')) setEngine('typst');
      else if (tab.path?.endsWith('.tex')) setEngine('latex');
    }
  }, []);
  const promoteTab = useCallback((id: string) => {
    if (workspaceOperationBusy()) return;
    setTabs(tabsRef.current.map(tab => tab.id === id ? { ...tab, preview: false } : tab));
  }, [setTabs]);
  const resetTabs = useCallback((path: string | null, content: string, tabEngine: EngineType) => {
    fileRequestRef.current++;
    const id = path ? `source:${path}` : `source:scratchpad:${++scratchpadSequenceRef.current}`;
    setTabs([{ id, path, name: path?.split(/[/\\]/).pop() || `Untitled.${tabEngine === 'typst' ? 'typ' : 'tex'}`, kind: 'source', pinned: false, preview: false, content, savedContent: content }]);
    if (!documentRevisionsRef.current.has(id)) documentRevisionsRef.current.set(id, 0);
    activeTabRef.current = id;
    activeSourceTabRef.current = id;
    setActiveTabId(id);
  }, [setTabs]);
  const closeTabs = useCallback(async (all = false, id = activeTabRef.current, others = false) => {
    if (workspaceOperationBusy()) return;
    const closing = tabsRef.current.filter(tab => all ? !tab.pinned : others ? tab.id !== id && !tab.pinned : tab.id === id);
    if (closing.some(tabIsDirty)) {
      const confirmed = await ask('Discard unsaved changes in the tabs being closed?', { title: 'Unsaved Changes', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Cancel' });
      if (!confirmed) return;
    }
    if (workspaceOperationBusy()) return;
    const ids = new Set(closing.map(tab => tab.id));
    const remaining = tabsRef.current.filter(tab => !ids.has(tab.id));
    setTabs(remaining);
    if (activeSourceTabRef.current && ids.has(activeSourceTabRef.current)) {
      const nextSource = [...remaining].reverse().find(tab => tab.kind === 'source') || null;
      activeSourceTabRef.current = nextSource?.id || null;
      activeFilePathRef.current = nextSource?.path || null;
      setActiveFilePath(nextSource?.path || null);
      setSourceCodeState(nextSource?.content || '');
      if (nextSource?.path?.endsWith('.typ')) setEngine('typst');
      else if (nextSource?.path?.endsWith('.tex')) setEngine('latex');
    }
    if (activeTabRef.current && ids.has(activeTabRef.current)) {
      activeTabRef.current = null;
      setActiveTabId(null);
      const preferred = others ? remaining.find(tab => tab.id === id) : null;
      if (preferred) activateTab(preferred.id);
      else if (remaining.length) activateTab(remaining[remaining.length - 1].id);
    }
  }, [activateTab, setTabs]);
  const togglePin = useCallback((id: string) => {
    if (workspaceOperationBusy()) return;
    setTabs(tabsRef.current.map(tab => tab.id === id ? { ...tab, pinned: !tab.pinned, preview: tab.pinned ? tab.preview : false } : tab));
  }, [setTabs]);
  const openPreviewTab = useCallback(async (nextTab: WorkspaceTab) => {
    if (workspaceOperationBusy()) return;
    const existing = tabsRef.current.find(tab => tab.id === nextTab.id);
    if (existing) { activateTab(existing.id); return; }
    const request = ++fileRequestRef.current;
    const preview = tabsRef.current.find(tab => tab.preview);
    if (preview && tabIsDirty(preview)) {
      const confirmed = await ask('Discard unsaved changes in the preview tab?', { title: 'Unsaved Changes', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Cancel' });
      if (!confirmed || request !== fileRequestRef.current) return;
    }
    if (request !== fileRequestRef.current) return;
    if (workspaceOperationBusy()) return;
    const latest = tabsRef.current;
    const replace = latest.find(tab => tab.preview);
    const index = replace ? latest.findIndex(tab => tab.id === replace.id) : latest.length;
    const next = latest.filter(tab => tab.id !== replace?.id);
    next.splice(index, 0, nextTab);
    setTabs(next);
    activateTab(nextTab.id);
  }, [activateTab, setTabs]);
  const openDiff = useCallback((path: string, repositoryRoot = projectRoot || '') => {
    const id = `diff:${repositoryRoot}:${path}`;
    void openPreviewTab({ id, path, repositoryRoot, name: path.split(/[/\\]/).pop() || path, kind: 'diff', pinned: false, preview: true, content: '', savedContent: '' });
  }, [openPreviewTab, projectRoot]);

  // Synchronous refs to prevent React state lag and stale closures during async operations
  const projectRootRef = useRef<string | null>(null);
  const mainFilePathRef = useRef<string | null>(null);
  const activeFilePathRef = useRef<string | null>(null);

  useEffect(() => {
    projectRootRef.current = projectRoot;
  }, [projectRoot]);

  useEffect(() => {
    mainFilePathRef.current = mainFilePath;
  }, [mainFilePath]);

  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
  }, [activeFilePath]);

  // Refresh project file tree from disk
  const refreshProjectFiles = useCallback(async (dir: string) => {
    try {
      const files = await invoke<FileItem[]>('list_project_files', { dirPath: dir });
      setProjectFiles(files);
      const relPaths = flattenFilePaths(files, dir);
      setGlobalProjectFiles(relPaths);

      // Dynamically scan project class and style files (.cls, .sty) for custom macros
      const clsAndStyFiles = relPaths.filter((f) => f.endsWith('.cls') || f.endsWith('.sty'));
      if (clsAndStyFiles.length > 0) {
        const diskStyleSources = new Map<string, string>();
        for (const rel of clsAndStyFiles) {
          const absPath = `${dir}/${rel}`;
          try {
            const content = await invoke<string>('read_file_content', { path: absPath });
            diskStyleSources.set(absPath, content);
          } catch (err) {
            console.warn(`Failed to scan macro file ${rel}:`, err);
          }
        }
        projectDiskStyleSourcesRef.current = diskStyleSources;
        const diskMacros = new Set<string>();
        for (const source of diskStyleSources.values()) for (const macro of extractMacrosFromSource(source)) diskMacros.add(macro);
        projectDiskMacrosRef.current = diskMacros;
        setProjectCustomCommands(collectProjectMacros(diskStyleSources, tabsRef.current));
      } else {
        projectDiskMacrosRef.current = new Set();
        projectDiskStyleSourcesRef.current = new Map();
        setProjectCustomCommands(new Set());
      }

      return files;
    } catch (e) {
      console.error('Failed to list project files:', e);
      return [];
    }
  }, []);

  const refreshAfterGitUpdate = useCallback(async () => {
    const root = projectRootRef.current;
    if (!root) return false;
    if (tabsRef.current.some(tabIsDirty)) {
      toast.error('Cannot refresh after Git update', { description: 'Save or discard unsaved editor changes, then refresh the project.' });
      return false;
    }

    try {
      const files = await invoke<FileItem[]>('list_project_files', { dirPath: root });
      const relPaths = flattenFilePaths(files, root);
      const availablePaths = new Set(relPaths.map(path => path.replace(/\\/g, '/')));
      const gitInfo = await invoke<GitRepositoryInfo>('get_git_repository_info', { projectPath: root });
      const repositoryRoot = gitInfo.repositoryRoot;

      const clsAndStyFiles = relPaths.filter(path => path.endsWith('.cls') || path.endsWith('.sty'));
      const diskStyleSources = new Map<string, string>();
      for (const rel of clsAndStyFiles) {
        try {
          const content = await invoke<string>('read_file_content', { path: `${root}/${rel}` });
          diskStyleSources.set(`${root}/${rel}`, content);
        } catch (error) {
          console.warn(`Failed to scan macro file ${rel}:`, error);
        }
      }
      const tabPaths = tabsRef.current.flatMap(tab => {
        if (!tab.path) return [];
        if (tab.kind === 'diff') return [`${tab.repositoryRoot || repositoryRoot}/${tab.path}`];
        return [tab.path];
      });
      const existingPathsResult = tabPaths.length
        ? await invoke<string[]>('existing_file_paths', { paths: [...new Set(tabPaths)] })
        : [];
      const existingPaths = new Set(existingPathsResult.map(path => path.replace(/\\/g, '/')));

      const reloaded = await reloadWorkspaceTabs({
        tabs: tabsRef.current,
        activeTabId: activeTabRef.current,
        activeSourceTabId: activeSourceTabRef.current,
        existingPaths,
        absolutePathForTab: tab => tab.kind === 'diff' && tab.path
          ? `${tab.repositoryRoot || repositoryRoot}/${tab.path}`
          : tab.path,
        readFile: path => invoke<string>('read_file_content', { path }),
        getCurrentTabs: () => tabsRef.current,
      });
      if (!reloaded.applied) {
        toast.error('Project refresh was interrupted', { description: 'Unsaved editor changes appeared during refresh and were kept. Refresh again after saving them.' });
        return false;
      }

      setProjectFiles(files);
      setGlobalProjectFiles(relPaths);
      projectDiskStyleSourcesRef.current = diskStyleSources;
      const diskMacros = new Set<string>();
      for (const source of diskStyleSources.values()) for (const macro of extractMacrosFromSource(source)) diskMacros.add(macro);
      projectDiskMacrosRef.current = diskMacros;
      for (const tab of reloaded.tabs) {
        if (tab.kind !== 'source') continue;
        const prior = tabsRef.current.find(item => item.id === tab.id);
        if (!documentRevisionsRef.current.has(tab.id)) documentRevisionsRef.current.set(tab.id, 0);
        else if (prior && prior.content !== tab.content) documentRevisionsRef.current.set(tab.id, (documentRevisionsRef.current.get(tab.id) ?? 0) + 1);
      }
      setTabs(reloaded.tabs);
      setProjectCustomCommands(collectProjectMacros(diskStyleSources, reloaded.tabs));
      activeTabRef.current = reloaded.activeTabId;
      setActiveTabId(reloaded.activeTabId);
      activeSourceTabRef.current = reloaded.activeSourceTabId;
      const activeId = reloaded.activeTabId;
      if (activeId && reloaded.tabs.some(tab => tab.id === activeId)) {
        const active = reloaded.tabs.find(tab => tab.id === activeId)!;
        if (active.kind === 'source') {
          activeSourceTabRef.current = active.id;
          activeFilePathRef.current = active.path;
          setActiveFilePath(active.path);
          setSourceCodeState(active.content);
        } else {
          const source = [...reloaded.tabs].reverse().find(tab => tab.kind === 'source');
          activeSourceTabRef.current = source?.id ?? null;
          activeFilePathRef.current = source?.path ?? null;
          setActiveFilePath(source?.path ?? null);
          setSourceCodeState(source?.content ?? (engine === 'typst' ? DEFAULT_TYPST_SOURCE : DEFAULT_LATEX_SOURCE));
        }
      } else {
        const source = [...reloaded.tabs].reverse().find(tab => tab.kind === 'source');
        activeSourceTabRef.current = source?.id ?? null;
        activeFilePathRef.current = source?.path ?? null;
        setActiveFilePath(source?.path ?? null);
        setSourceCodeState(source?.content ?? (engine === 'typst' ? DEFAULT_TYPST_SOURCE : DEFAULT_LATEX_SOURCE));
      }

      // Apply a changed, valid project configuration while retaining the current settings otherwise.
      let configRaw: string | null = null;
      try { configRaw = await invoke<string>('read_file_content', { path: `${root}/.sciencebatch.json` }); } catch {}
      if (projectConfigRawRef.current !== configRaw) {
        projectConfigRawRef.current = configRaw;
        if (configRaw) {
          try {
            const config: unknown = JSON.parse(configRaw);
            if (config && typeof config === 'object') {
              const value = config as { engine?: unknown; mainFile?: unknown };
              if (value.engine === 'latex' || value.engine === 'typst') setEngine(value.engine);
              if (typeof value.mainFile === 'string' && value.mainFile.trim() && availablePaths.has(value.mainFile.replace(/\\/g, '/'))) {
                setMainFilePath(value.mainFile);
                mainFilePathRef.current = value.mainFile;
              }
            }
          } catch {
            // Keep the current engine and entrypoint when configuration is invalid.
          }
        }
      }

      window.dispatchEvent(new Event('sciencebatch:git-worktree-updated'));
      window.dispatchEvent(new Event('sciencebatch:git-status-changed'));
      if (reloaded.deletedNames.length) {
        toast.warning('Some open files were removed by the Git update', { description: reloaded.deletedNames.join(', ') });
      }
      return true;
    } catch (error) {
      toast.error('Unable to refresh project after Git update', { description: 'The project contents could not be read from disk.' });
      console.error('Failed to refresh project after Git update:', error);
      return false;
    }
  }, [engine, setTabs]);

  // Save current active file to disk and trigger compilation
  const saveFile = useCallback(async () => {
    if (workspaceOperationBusy()) return;
    const currentRoot = projectRootRef.current || projectRoot;
    const activeTab = tabsRef.current.find(tab => tab.id === activeTabRef.current);
    const currentActive = activeTab?.kind === 'source' ? activeTab.path : null;
    const currentMain = mainFilePathRef.current || mainFilePath;

    if (currentActive && currentRoot) {
      try {
        await invoke('write_file_content', {
          path: currentActive,
          content: sourceCode,
        });
        setTabs(tabsRef.current.map(tab => tab.path === currentActive && tab.kind === 'source' ? { ...tab, savedContent: sourceCode } : tab));
        toast.success('File saved', { description: currentActive });

        // If a class or style file was modified, re-scan project custom macros
        if (currentActive.endsWith('.cls') || currentActive.endsWith('.sty')) {
          refreshProjectFiles(currentRoot);
        }
      } catch (e) {
        toast.error('Failed to save file to disk');
        console.error(e);
        return;
      }
    }

    // Resolve full path to main file
    let fullMainPath: string | null = null;
    if (currentMain && currentRoot) {
      fullMainPath = currentMain.startsWith(currentRoot)
        ? currentMain
        : `${currentRoot}/${currentMain}`;
    }

    // Overleaf behavior: If editing a secondary file, compile main entrypoint
    if (currentActive && fullMainPath && currentActive !== fullMainPath) {
      try {
        const mainContent = await invoke<string>('read_file_content', { path: fullMainPath });
        compile(mainContent, engine, currentRoot, currentMain);
      } catch {
        compile(sourceCode, engine, currentRoot, currentMain);
      }
    } else {
      compile(sourceCode, engine, currentRoot, currentMain);
    }
  }, [mainFilePath, projectRoot, sourceCode, engine, compile, refreshProjectFiles, setTabs]);

  // Import files into current project folder
  const importFiles = useCallback(async () => {
    if (!projectRoot || workspaceOperationBusy()) return;
    try {
      const selected = await open({
        multiple: true,
        title: 'Select Files or Images to Import into Project',
        filters: [
          {
            name: 'Project Assets & Sources',
            extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp', 'pdf', 'bib', 'cls', 'sty', 'tex', 'typ', 'csv', 'txt'],
          },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      for (const src of paths) {
        if (workspaceOperationBusy()) return;
        await invoke('import_file_to_project', {
          srcPath: src,
          destDir: projectRoot,
        });
      }

      await refreshProjectFiles(projectRoot);
      toast.success(`Imported ${paths.length} file(s) into project`);
    } catch (e) {
      console.error('Import failed:', e);
      toast.error('Failed to import files into project');
    }
  }, [projectRoot, refreshProjectFiles]);

  // Open existing folder as project
  const openFolder = useCallback(async (forcedPath?: string, rejectDirty = false) => {
    if (workspaceOperationBusy()) return false;
    let targetPath = forcedPath;

    if (!targetPath) {
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Open LaTeX or Typst Project Folder',
        });

        if (!selected || typeof selected !== 'string') return false;
        targetPath = selected;
      } catch (e) {
        console.error('Failed to open directory dialog:', e);
        return false;
      }
    }

    if (tabsRef.current.some(tabIsDirty)) {
      if (rejectDirty) return false;
      const confirmed = await ask('Discard unsaved changes before opening another project?', { title: 'Unsaved Changes', kind: 'warning', okLabel: 'Discard and Open', cancelLabel: 'Cancel' });
      if (!confirmed) return false;
    }

    if (workspaceOperationBusy()) return false;

    clearCompilationAndDiagnostics();

    try {
      const files = await refreshProjectFiles(targetPath);
      const name = targetPath.split(/[/\\]/).filter(Boolean).pop() || 'Project';

      // Check for .sciencebatch.json config
      let detectedEngine: EngineType = 'latex';
      let detectedMain = 'main.tex';
      projectConfigRawRef.current = null;

      try {
        const configPath = `${targetPath}/.sciencebatch.json`;
        const configRaw = await invoke<string>('read_file_content', { path: configPath });
        projectConfigRawRef.current = configRaw;
        const config = JSON.parse(configRaw);
        if (config.engine === 'typst' || config.engine === 'latex') {
          detectedEngine = config.engine;
        }
        if (config.mainFile) {
          detectedMain = config.mainFile;
        }
      } catch {
        // Auto-detect by file extensions
        const hasTypst = files.some((f) => f.name.endsWith('.typ'));
        const hasTex = files.some((f) => f.name.endsWith('.tex'));

        if (hasTypst && !hasTex) {
          detectedEngine = 'typst';
          detectedMain = files.find((f) => f.name === 'main.typ')?.name || files.find((f) => f.name.endsWith('.typ'))?.name || 'main.typ';
        } else if (hasTex) {
          detectedEngine = 'latex';
          detectedMain = files.find((f) => f.name === 'main.tex')?.name || files.find((f) => f.name.endsWith('.tex'))?.name || 'main.tex';
        }
      }

      setProjectRoot(targetPath);
      projectRootRef.current = targetPath;
      projectGenerationRef.current += 1;

      setProjectName(name);
      setEngine(detectedEngine);

      setMainFilePath(detectedMain);
      mainFilePathRef.current = detectedMain;

      // Load main file content
      const fullMainPath = `${targetPath}/${detectedMain}`;
      let contentToLoad = detectedEngine === 'typst' ? DEFAULT_TYPST_SOURCE : DEFAULT_LATEX_SOURCE;
      try {
        contentToLoad = await invoke<string>('read_file_content', { path: fullMainPath });
        setActiveFilePath(fullMainPath);
        activeFilePathRef.current = fullMainPath;
      } catch {
        setActiveFilePath(null);
        activeFilePathRef.current = null;
      }

      setSourceCodeState(contentToLoad);
      resetTabs(activeFilePathRef.current, contentToLoad, detectedEngine);
      onEnterEditorMode?.();
      recordRecentProject(targetPath, name, detectedEngine);

      toast.success(`Opened ${name}`, {
        description: `Engine: ${detectedEngine.toUpperCase()} — Main: ${detectedMain}`,
      });


      return true;
    } catch (err) {
      try {
        const valid: string[] = await invoke('validate_recent_paths', { paths: [targetPath] });
        if (valid.length === 0) {
          toast.error('Project folder not found', {
            description: `The folder "${targetPath}" no longer exists on disk. Removed from recent projects.`,
          });
          removeRecentProject(targetPath);
          return false;
        }
      } catch {}
      toast.error('Failed to open project folder');
      console.error(err);
      return false;
    }
  }, [refreshProjectFiles, recordRecentProject, compile, clearCompilationAndDiagnostics, removeRecentProject, onEnterEditorMode]);

  // Create new project from wizard modal
  const createProject = useCallback(async (
    parentDir: string,
    projName: string,
    newEngine: EngineType,
    templateContent: string,
  ) => {
    try {
      const createdFolderPath = await invoke<string>('create_project_folder', {
        parentDir,
        projectName: projName,
        engine: newEngine,
        templateContent,
      });

      await openFolder(createdFolderPath);
    } catch (err) {
      toast.error('Error creating project folder');
      console.error(err);
    }
  }, [openFolder]);

  // Import project from ZIP archive
  const importZip = useCallback(async (forcedZipPath?: string, forcedParentDir?: string, forcedProjectName?: string) => {
    let zipPath = forcedZipPath;
    let parentDir = forcedParentDir;
    let projName = forcedProjectName;

    if (!zipPath) {
      try {
        const selected = await open({
          multiple: false,
          title: 'Select LaTeX or Typst Project ZIP Archive',
          filters: [{ name: 'ZIP Archives (*.zip)', extensions: ['zip'] }],
        });
        if (!selected || typeof selected !== 'string') return;
        zipPath = selected;
      } catch (e) {
        console.error('Error selecting ZIP archive:', e);
        return;
      }
    }

    if (!parentDir) {
      try {
        const selectedFolder = await open({
          directory: true,
          multiple: false,
          title: 'Select Destination Folder to Extract Project',
        });
        if (!selectedFolder || typeof selectedFolder !== 'string') return;
        parentDir = selectedFolder;
      } catch (e) {
        console.error('Error selecting destination directory:', e);
        return;
      }
    }

    if (!projName) {
      const fileName = zipPath.split(/[/\\]/).pop() || '';
      projName = fileName.replace(/\.zip$/i, '') || 'ImportedProject';
    }

    const toastId = toast.loading('Extracting and configuring project archive...');
    try {
      const importedFolderPath = await invoke<string>('import_project_from_zip', {
        zipPath,
        parentDir,
        projectName: projName,
      });

      toast.success('Project imported successfully', { id: toastId });
      await openFolder(importedFolderPath);
    } catch (err: unknown) {
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : 'Failed to extract project';
      toast.error('Import Failed', {
        id: toastId,
        description: msg,
      });
      console.error('Failed to import ZIP:', err);
    }
  }, [openFolder]);

  // Launch instant scratchpad mode
  const quickScratchpad = useCallback((chosenEngine: EngineType) => {
    if (workspaceOperationBusy()) return;
    clearCompilationAndDiagnostics();
    setProjectRoot(null);
    projectRootRef.current = null;
    projectGenerationRef.current += 1;
    setProjectName('Scratchpad');
    setActiveFilePath(null);
    activeFilePathRef.current = null;
    setMainFilePath(null);
    mainFilePathRef.current = null;
    setProjectFiles([]);
    setEngine(chosenEngine);
    const starter = chosenEngine === 'typst' ? DEFAULT_TYPST_SOURCE : DEFAULT_LATEX_SOURCE;
    setSourceCodeState(starter);
    resetTabs(null, starter, chosenEngine);
    onEnterEditorMode?.();

  }, [clearCompilationAndDiagnostics, onEnterEditorMode, resetTabs]);

  // Switch active typesetting engine
  const switchEngine = useCallback((newEngine: EngineType) => {
    if (workspaceOperationBusy()) return;
    if (newEngine === engine) return;
    setEngine(newEngine);

    if (!projectRoot) {
      if (sourceCode === DEFAULT_LATEX_SOURCE || sourceCode === DEFAULT_TYPST_SOURCE) {
        const nextSource = newEngine === 'typst' ? DEFAULT_TYPST_SOURCE : DEFAULT_LATEX_SOURCE;
        setSourceCodeState(nextSource);
        resetTabs(null, nextSource, newEngine);

        return;
      }
    }

    toast.info(`Typesetting engine set to ${newEngine.toUpperCase()}`);

  }, [engine, projectRoot, sourceCode, resetTabs]);

  // Close project and return to Welcome Screen
  const closeProject = useCallback(async (rejectDirty = false) => {
    if (workspaceOperationBusy()) return;
    if (tabsRef.current.some(tabIsDirty)) {
      if (rejectDirty) return false;
      const confirmed = await ask('Discard unsaved changes and close this project?', { title: 'Unsaved Changes', kind: 'warning', okLabel: 'Discard and Close', cancelLabel: 'Cancel' });
      if (!confirmed) return;
    }
    if (workspaceOperationBusy()) return;
    setTabs([]);
    activeTabRef.current = null;
    activeSourceTabRef.current = null;
    setActiveTabId(null);
    fileRequestRef.current++;
    setProjectRoot(null);
    projectRootRef.current = null;
    projectGenerationRef.current += 1;
    setProjectName('');
    setActiveFilePath(null);
    activeFilePathRef.current = null;
    setMainFilePath(null);
    mainFilePathRef.current = null;
    setProjectFiles([]);
    setGlobalProjectFiles([]);
    setProjectCustomCommands(new Set());
    projectDiskMacrosRef.current = new Set();
    projectDiskStyleSourcesRef.current = new Map();
    clearCompilationAndDiagnostics();
    onEnterWelcomeMode?.();
  }, [clearCompilationAndDiagnostics, onEnterWelcomeMode, setTabs]);

  // File tree operations
  const selectFile = useCallback(async (filePath: string, permanent = false, sourceOverride?: string) => {
    if (workspaceOperationBusy()) return;
    const kind = isProjectAsset(filePath) ? 'asset' : 'source';
    const id = `${kind}:${filePath}`;
    if (tabsRef.current.some(tab => tab.id === id)) {
      if (permanent) promoteTab(id);
      activateTab(id);
      return;
    }
    const request = ++fileRequestRef.current;
    const root = projectRootRef.current;
    try {
      const content = kind === 'source' ? (sourceOverride ?? await invoke<string>('read_file_content', { path: filePath })) : '';
      if (request !== fileRequestRef.current || root !== projectRootRef.current) return;
      await openPreviewTab({ id, path: filePath, name: filePath.split(/[/\\]/).pop() || filePath, kind, pinned: false, preview: !permanent, content, savedContent: content });
    } catch (e) {
      toast.error('Unable to open file', { description: String(e) });
    }
  }, [activateTab, openPreviewTab, promoteTab]);

  const setMainFile = useCallback(async (filePath: string) => {
    if (!projectRoot || workspaceOperationBusy()) return;
    const relName = filePath.replace(`${projectRoot}/`, '');
    setMainFilePath(relName);
    mainFilePathRef.current = relName;

    try {
      const configPath = `${projectRoot}/.sciencebatch.json`;
      const configJson = {
        name: projectName,
        engine,
        mainFile: relName,
        updatedAt: new Date().toISOString(),
      };
      const rawConfig = JSON.stringify(configJson, null, 2);
      if (workspaceOperationBusy()) return;
      await invoke('write_file_content', {
        path: configPath,
        content: rawConfig,
      });
      projectConfigRawRef.current = rawConfig;
      toast.success(`Main entrypoint set to ${relName}`);
    } catch (e) {
      console.error('Failed to update project config:', e);
    }
  }, [projectRoot, projectName, engine]);

  const createFile = useCallback(async (parentDir: string, name: string) => {
    if (workspaceOperationBusy()) return;
    try {
      const fullPath = `${parentDir}/${name}`;
      if (workspaceOperationBusy()) return;
      await invoke('write_file_content', { path: fullPath, content: '' });
      if (projectRoot) await refreshProjectFiles(projectRoot);
      selectFile(fullPath);
      toast.success(`Created file ${name}`);
    } catch (e) {
      toast.error('Failed to create file');
      console.error(e);
    }
  }, [projectRoot, refreshProjectFiles, selectFile]);

  const createFolder = useCallback(async (parentDir: string, name: string) => {
    if (workspaceOperationBusy()) return;
    try {
      const fullPath = `${parentDir}/${name}`;
      if (workspaceOperationBusy()) return;
      await invoke('write_file_content', { path: `${fullPath}/.gitkeep`, content: '' });
      if (projectRoot) await refreshProjectFiles(projectRoot);
      toast.success(`Created folder ${name}`);
    } catch (e) {
      toast.error('Failed to create folder');
      console.error(e);
    }
  }, [projectRoot, refreshProjectFiles]);

  const deleteFile = useCallback(async (_path: string) => {
    if (workspaceOperationBusy()) return;
    toast.info('File deletion: please remove file via system file explorer for safety.');
  }, []);

  const saveDocument = useCallback(async (documentId: string, expectedRevision: number, expectedGeneration: number, allowedRoots: string[]) => {
    if (workspaceOperationBusy()) return { ok: false as const, code: 'git.locked', message: 'A Git worktree update is in progress.' };
    const tab = tabsRef.current.find(item => item.id === documentId && item.kind === 'source');
    const root = projectRootRef.current;
    if (!tab || !tab.path || !root) return { ok: false as const, code: 'document.unavailable', message: 'The selected document cannot be saved to disk.' };
    const content = tab.content;
    const revision = documentRevisionsRef.current.get(documentId) ?? 0;
    const generation = projectGenerationRef.current;
    if (revision !== expectedRevision || generation !== expectedGeneration) {
      return { ok: false as const, code: 'conflict.revision', message: 'The document or project changed before the save began.' };
    }
    try {
      const rootPath = root.replace(/\\/g, '/').replace(/\/$/, '');
      const filePath = tab.path.replace(/\\/g, '/');
      const relativeFile = filePath.startsWith(`${rootPath}/`) ? filePath.slice(rootPath.length + 1) : filePath;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tab.savedContent));
      const expectedSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (root !== projectRootRef.current || projectGenerationRef.current !== generation || documentRevisionsRef.current.get(documentId) !== revision
        || !tabsRef.current.some(item => item.id === documentId)) {
        return { ok: false as const, code: 'conflict.revision', message: 'The document changed while the save was being prepared.' };
      }
      await invoke('workspace_apply_disk', { projectRoot: root, file: relativeFile, content, expectedSha256, allowedRoots });
    } catch (error) {
      const message = String(error);
      const code = message.match(/^([a-z][a-z0-9_.-]+):/)?.[1] ?? 'io.write';
      return { ok: false as const, code, message };
    }
    if (root !== projectRootRef.current || projectGenerationRef.current !== generation
      || documentRevisionsRef.current.get(documentId) !== revision || !tabsRef.current.some(item => item.id === documentId)) {
      return { ok: false as const, code: 'conflict.project', message: 'The project changed while the document was being saved.' };
    }
    setTabs(tabsRef.current.map(item => item.id === documentId ? { ...item, savedContent: content } : item));
    if (/\.(cls|sty)$/i.test(tab.path)) {
      projectDiskStyleSourcesRef.current.set(tab.path, content);
      projectDiskMacrosRef.current = collectProjectMacros(projectDiskStyleSourcesRef.current, []);
      setProjectCustomCommands(collectProjectMacros(projectDiskStyleSourcesRef.current, tabsRef.current));
    }
    return { ok: true as const, documentId, path: tab.path, revision, saved: true };
  }, [setTabs]);

  return {
    tabs,
    activeTabId,
    activateTab,
    promoteTab,
    closeTabs,
    togglePin,
    openDiff,
    projectRoot,
    projectName,
    activeFilePath,
    mainFilePath,
    projectFiles,
    engine,
    sourceCode,
    setSourceCode,
    getProjectGeneration: () => projectGenerationRef.current,
    setEngine,
    saveFile,
    saveDocument,
    getDocumentRevision: (id: string) => documentRevisionsRef.current.get(id) ?? 0,
    importFiles,
    openFolder,
    createProject,
    importZip,
    quickScratchpad,
    switchEngine,
    closeProject,
    selectFile,
    setMainFile,
    createFile,
    createFolder,
    deleteFile,
    refreshProjectFiles,
    refreshAfterGitUpdate,
    setWorktreeUpdateBusy,
    worktreeUpdateBusy,
    workspaceExportBusy,
    getWorkspaceExportLeaseId: () => workspaceExportLeaseRef.current?.id ?? null,
    acquireWorkspaceExportLease,
    releaseWorkspaceExportLease,
  };
}
