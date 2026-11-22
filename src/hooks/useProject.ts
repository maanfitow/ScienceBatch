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

const replacePathPrefix = (candidate: string, fromPath: string, toPath: string): string | null => {
  const normCandidate = candidate.replace(/[/\\]+$/, '');
  const normFrom = fromPath.replace(/[/\\]+$/, '');
  if (normCandidate === normFrom) return toPath;
  if (normCandidate.startsWith(`${normFrom}/`) || normCandidate.startsWith(`${normFrom}\\`)) {
    return `${toPath}${normCandidate.slice(normFrom.length)}`;
  }
  return null;
};

const pathMatchesOrInside = (candidate: string, target: string): boolean => {
  const normCandidate = candidate.replace(/[/\\]+$/, '');
  const normTarget = target.replace(/[/\\]+$/, '');
  return normCandidate === normTarget
    || normCandidate.startsWith(`${normTarget}/`)
    || normCandidate.startsWith(`${normTarget}\\`);
};

const findSiblingNames = (items: FileItem[], parentDir: string, rootDir: string): Set<string> => {
  const normParent = parentDir.replace(/[/\\]+$/, '');
  const normRoot = rootDir.replace(/[/\\]+$/, '');
  if (normParent === normRoot) {
    return new Set(items.map(item => item.name));
  }
  for (const item of items) {
    if (item.is_dir && item.path.replace(/[/\\]+$/, '') === normParent) {
      return new Set((item.children || []).map(child => child.name));
    }
    if (item.is_dir && item.children) {
      const found = findSiblingNames(item.children, parentDir, rootDir);
      if (found.size > 0) return found;
    }
  }
  return new Set();
};

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
  const [templateAssets, setTemplateAssets] = useState<'starter-latex' | 'starter-typst' | null>(null);
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

    // Compile the configured main entrypoint when editing a secondary file
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

  // Import files into current project folder or target subfolder
  const importFiles = useCallback(async (targetDir?: string) => {
    const root = projectRootRef.current || projectRoot;
    if (!root || workspaceOperationBusy()) return;
    const destDir = typeof targetDir === 'string' && targetDir.trim() ? targetDir : root;
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
          destDir,
        });
      }

      await refreshProjectFiles(root);
      toast.success(`Imported ${paths.length} file(s) into project`);
    } catch (e) {
      console.error('Import failed:', e);
      const message = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
      toast.error('Failed to import files into project', { description: message });
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
      setTemplateAssets(null);
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
    setTemplateAssets(chosenEngine === 'typst' ? 'starter-typst' : 'starter-latex');
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
        setTemplateAssets(newEngine === 'typst' ? 'starter-typst' : 'starter-latex');
        resetTabs(null, nextSource, newEngine);

        return;
      }
      setTemplateAssets(null);
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
    setTemplateAssets(null);
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
    const root = projectRootRef.current || projectRoot;
    if (!root || workspaceOperationBusy()) return;
    const cleanParent = (parentDir || root).replace(/[/\\]+$/, '');
    const cleanName = name.trim().replace(/^[/\\]+|[/\\]+$/g, '');
    if (!cleanName) return;
    const fullPath = `${cleanParent}/${cleanName}`;
    try {
      if (workspaceOperationBusy()) return;
      await invoke('create_project_file', { projectRoot: root, path: fullPath });
      await refreshProjectFiles(root);
      selectFile(fullPath);
      toast.success(`Created file ${cleanName}`);
    } catch (e) {
      const message = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
      toast.error('Failed to create file', { description: message });
      console.error(e);
    }
  }, [projectRoot, refreshProjectFiles, selectFile]);

  const createFolder = useCallback(async (parentDir: string, name: string) => {
    const root = projectRootRef.current || projectRoot;
    if (!root || workspaceOperationBusy()) return;
    const cleanParent = (parentDir || root).replace(/[/\\]+$/, '');
    const cleanName = name.trim().replace(/^[/\\]+|[/\\]+$/g, '');
    if (!cleanName) return;
    const fullPath = `${cleanParent}/${cleanName}`;
    try {
      if (workspaceOperationBusy()) return;
      await invoke('create_project_directory', { projectRoot: root, path: fullPath });
      await refreshProjectFiles(root);
      toast.success(`Created folder ${cleanName}`);
    } catch (e) {
      const message = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
      toast.error('Failed to create folder', { description: message });
      console.error(e);
    }
  }, [projectRoot, refreshProjectFiles]);

  const relocateProjectPath = useCallback(async (
    root: string,
    normalizedOld: string,
    newPath: string,
    successMessage: string,
    errorTitle: string,
  ): Promise<boolean> => {
    try {
      await invoke('rename_project_path', { projectRoot: root, oldPath: normalizedOld, newPath });

      const normalizedRoot = root.replace(/[/\\]+$/, '');
      const toRel = (abs: string) => {
        const norm = abs.replace(/\\/g, '/');
        const normRoot = normalizedRoot.replace(/\\/g, '/');
        return norm.startsWith(`${normRoot}/`) ? norm.slice(normRoot.length + 1) : norm;
      };
      const relOld = toRel(normalizedOld);
      const relNew = toRel(newPath);

      const idRemap = new Map<string, string>();
      const nextTabs = tabsRef.current.map(tab => {
        if (!tab.path) return tab;
        if (tab.kind === 'diff') {
          const remappedRel = replacePathPrefix(tab.path, relOld, relNew)
            ?? replacePathPrefix(tab.path, normalizedOld, newPath);
          if (!remappedRel) return tab;
          const repoRoot = tab.repositoryRoot || root;
          const nextId = `diff:${repoRoot}:${remappedRel}`;
          idRemap.set(tab.id, nextId);
          const oldRev = documentRevisionsRef.current.get(tab.id);
          if (oldRev !== undefined) {
            documentRevisionsRef.current.delete(tab.id);
            documentRevisionsRef.current.set(nextId, oldRev);
          }
          return {
            ...tab,
            id: nextId,
            path: remappedRel,
            name: remappedRel.split(/[/\\]/).pop() || remappedRel,
          };
        }
        const remappedPath = replacePathPrefix(tab.path, normalizedOld, newPath);
        if (!remappedPath) return tab;
        const nextId = `${tab.kind}:${remappedPath}`;
        idRemap.set(tab.id, nextId);
        const oldRev = documentRevisionsRef.current.get(tab.id);
        if (oldRev !== undefined) {
          documentRevisionsRef.current.delete(tab.id);
          documentRevisionsRef.current.set(nextId, oldRev);
        }
        return {
          ...tab,
          id: nextId,
          path: remappedPath,
          name: remappedPath.split(/[/\\]/).pop() || remappedPath,
        };
      });

      setTabs(nextTabs);
      if (activeTabRef.current && idRemap.has(activeTabRef.current)) {
        const nextActiveId = idRemap.get(activeTabRef.current)!;
        activeTabRef.current = nextActiveId;
        setActiveTabId(nextActiveId);
      }
      if (activeSourceTabRef.current && idRemap.has(activeSourceTabRef.current)) {
        activeSourceTabRef.current = idRemap.get(activeSourceTabRef.current)!;
      }
      if (activeFilePathRef.current) {
        const remappedActive = replacePathPrefix(activeFilePathRef.current, normalizedOld, newPath);
        if (remappedActive) {
          activeFilePathRef.current = remappedActive;
          setActiveFilePath(remappedActive);
        }
      }

      const currentMain = mainFilePathRef.current || mainFilePath;
      if (currentMain) {
        const nextMain = replacePathPrefix(currentMain, relOld, relNew)
          ?? replacePathPrefix(currentMain, normalizedOld, newPath);
        if (nextMain) {
          setMainFilePath(nextMain);
          mainFilePathRef.current = nextMain;
          try {
            const configPath = `${normalizedRoot}/.sciencebatch.json`;
            let baseConfig: Record<string, unknown> = { name: projectName, engine };
            try {
              const existingRaw = await invoke<string>('read_file_content', { path: configPath });
              const parsed = JSON.parse(existingRaw);
              if (parsed && typeof parsed === 'object') baseConfig = parsed as Record<string, unknown>;
            } catch {}
            const rawConfig = JSON.stringify({
              ...baseConfig,
              mainFile: nextMain,
              updatedAt: new Date().toISOString(),
            }, null, 2);
            await invoke('write_file_content', { path: configPath, content: rawConfig });
            projectConfigRawRef.current = rawConfig;
          } catch (cfgErr) {
            console.error('Failed to update project config after path relocation:', cfgErr);
          }
        }
      }

      await refreshProjectFiles(root);
      toast.success(successMessage);
      return true;
    } catch (e) {
      const message = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
      toast.error(errorTitle, { description: message });
      console.error(e);
      return false;
    }
  }, [engine, mainFilePath, projectName, refreshProjectFiles, setTabs]);

  const renamePath = useCallback(async (oldPath: string, newName: string): Promise<boolean> => {
    const root = projectRootRef.current || projectRoot;
    if (!root || workspaceOperationBusy()) return false;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..' || /[/\\]/.test(trimmed)) {
      toast.error('Invalid name', {
        description: 'Name cannot be empty, ".", "..", or contain path separators.',
      });
      return false;
    }

    const normalizedOld = oldPath.replace(/[/\\]+$/, '');
    const lastSlash = Math.max(normalizedOld.lastIndexOf('/'), normalizedOld.lastIndexOf('\\'));
    const parentDir = lastSlash >= 0 ? normalizedOld.slice(0, lastSlash) : '';
    const sep = lastSlash >= 0 ? normalizedOld[lastSlash] : '/';
    const newPath = parentDir ? `${parentDir}${sep}${trimmed}` : trimmed;
    if (newPath === normalizedOld) return true;

    return relocateProjectPath(root, normalizedOld, newPath, `Renamed to ${trimmed}`, 'Failed to rename');
  }, [projectRoot, relocateProjectPath]);

  const movePath = useCallback(async (srcPath: string, targetDir: string): Promise<boolean> => {
    const root = projectRootRef.current || projectRoot;
    if (!root || workspaceOperationBusy()) return false;

    const normalizedSrc = srcPath.replace(/[/\\]+$/, '');
    const cleanTargetDir = targetDir.replace(/[/\\]+$/, '');
    const normalizedRoot = root.replace(/[/\\]+$/, '');

    if (!normalizedSrc || !cleanTargetDir) return false;
    if (normalizedSrc === normalizedRoot) return false;
    if (pathMatchesOrInside(cleanTargetDir, normalizedSrc)) return false;

    const lastSlash = Math.max(normalizedSrc.lastIndexOf('/'), normalizedSrc.lastIndexOf('\\'));
    const parentDir = lastSlash >= 0 ? normalizedSrc.slice(0, lastSlash) : '';
    const sep = lastSlash >= 0 ? normalizedSrc[lastSlash] : '/';
    const baseName = lastSlash >= 0 ? normalizedSrc.slice(lastSlash + 1) : normalizedSrc;
    if (!baseName || parentDir === cleanTargetDir) return false;

    const newPath = `${cleanTargetDir}${sep}${baseName}`;
    const normTargetSlash = cleanTargetDir.replace(/\\/g, '/');
    const normRootSlash = normalizedRoot.replace(/\\/g, '/');
    const targetLabel = cleanTargetDir === normalizedRoot
      ? (projectName || normalizedRoot.split(/[/\\]/).pop() || 'project root')
      : (normTargetSlash.startsWith(`${normRootSlash}/`)
        ? normTargetSlash.slice(normRootSlash.length + 1)
        : normTargetSlash);

    return relocateProjectPath(root, normalizedSrc, newPath, `Moved "${baseName}" to ${targetLabel}`, 'Failed to move');
  }, [projectName, projectRoot, relocateProjectPath]);

  const deletePath = useCallback(async (path: string, isDir = false): Promise<boolean> => {
    const root = projectRootRef.current || projectRoot;
    if (!root || workspaceOperationBusy()) return false;
    const normalizedPath = path.replace(/[/\\]+$/, '');
    const itemName = normalizedPath.split(/[/\\]/).pop() || normalizedPath;

    const resolveTabPath = (tab: WorkspaceTab) => {
      if (!tab.path) return null;
      if (tab.kind === 'diff' && !tab.path.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(tab.path)) {
        return `${(tab.repositoryRoot || root).replace(/[/\\]+$/, '')}/${tab.path}`;
      }
      return tab.path;
    };

    const hasDirtyAffected = tabsRef.current.some(tab => {
      if (!tabIsDirty(tab)) return false;
      const resolved = resolveTabPath(tab);
      return Boolean(resolved && pathMatchesOrInside(resolved, normalizedPath));
    });

    const basePrompt = isDir
      ? `Move folder "${itemName}" and its contents to Trash? You can restore it from your system Trash.`
      : `Move "${itemName}" to Trash? You can restore it from your system Trash.`;
    const message = hasDirtyAffected
      ? `${basePrompt}\n\nUnsaved changes in open editor tabs for this ${isDir ? 'folder' : 'file'} will be discarded.`
      : basePrompt;

    const confirmed = await ask(message, {
      title: isDir ? 'Move Folder to Trash' : 'Move File to Trash',
      kind: hasDirtyAffected ? 'warning' : 'info',
      okLabel: 'Move to Trash',
      cancelLabel: 'Cancel',
    });
    if (!confirmed || workspaceOperationBusy()) return false;

    try {
      await invoke('delete_project_path', { projectRoot: root, path: normalizedPath });

      const affectedIds = new Set(
        tabsRef.current
          .filter(tab => {
            const resolved = resolveTabPath(tab);
            return Boolean(resolved && pathMatchesOrInside(resolved, normalizedPath));
          })
          .map(tab => tab.id)
      );

      for (const affectedId of affectedIds) {
        documentRevisionsRef.current.delete(affectedId);
      }

      const remaining = tabsRef.current.filter(tab => !affectedIds.has(tab.id));
      setTabs(remaining);

      if (activeSourceTabRef.current && affectedIds.has(activeSourceTabRef.current)) {
        const nextSource = [...remaining].reverse().find(tab => tab.kind === 'source') || null;
        activeSourceTabRef.current = nextSource?.id || null;
        activeFilePathRef.current = nextSource?.path || null;
        setActiveFilePath(nextSource?.path || null);
        setSourceCodeState(nextSource?.content || '');
        if (nextSource?.path?.endsWith('.typ')) setEngine('typst');
        else if (nextSource?.path?.endsWith('.tex')) setEngine('latex');
      }

      if (activeTabRef.current && affectedIds.has(activeTabRef.current)) {
        activeTabRef.current = null;
        setActiveTabId(null);
        if (remaining.length) {
          activateTab(remaining[remaining.length - 1].id);
        } else {
          activeFilePathRef.current = null;
          setActiveFilePath(null);
        }
      } else if (activeFilePathRef.current && pathMatchesOrInside(activeFilePathRef.current, normalizedPath)) {
        activeFilePathRef.current = null;
        setActiveFilePath(null);
      }

      const currentMain = mainFilePathRef.current || mainFilePath;
      if (currentMain) {
        const normalizedRoot = root.replace(/[/\\]+$/, '');
        const isAbsoluteMain = currentMain === normalizedRoot
          || currentMain.startsWith(`${normalizedRoot}/`)
          || currentMain.startsWith(`${normalizedRoot}\\`);
        const resolvedMain = isAbsoluteMain ? currentMain : `${normalizedRoot}/${currentMain}`;
        if (pathMatchesOrInside(resolvedMain, normalizedPath)) {
          setMainFilePath(null);
          mainFilePathRef.current = null;
        }
      }

      await refreshProjectFiles(root);
      toast.success(`Moved "${itemName}" to Trash`);
      return true;
    } catch (e) {
      const errMsg = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
      toast.error('Failed to move to Trash', { description: errMsg });
      console.error(e);
      return false;
    }
  }, [activateTab, mainFilePath, projectRoot, refreshProjectFiles, setTabs]);

  const deleteFile = useCallback((path: string) => deletePath(path, false), [deletePath]);

  const duplicatePath = useCallback(async (path: string, isDir = false): Promise<string | null> => {
    const root = projectRootRef.current || projectRoot;
    if (!root || workspaceOperationBusy()) return null;

    const normalized = path.replace(/[/\\]+$/, '');
    const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
    const parentDir = lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
    const sep = lastSlash >= 0 ? normalized[lastSlash] : '/';
    const baseName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;

    const dotIdx = isDir ? -1 : baseName.lastIndexOf('.');
    const stem = dotIdx > 0 ? baseName.slice(0, dotIdx) : baseName;
    const ext = dotIdx > 0 ? baseName.slice(dotIdx) : '';

    const siblingNames = findSiblingNames(projectFiles, parentDir || root, root);
    let candidate = `${stem} copy${ext}`;
    let counter = 2;
    let destPath = parentDir ? `${parentDir}${sep}${candidate}` : candidate;

    for (let attempt = 0; attempt < 1000; attempt += 1) {
      if (!siblingNames.has(candidate)) {
        if (isDir) break;
        try {
          const existing = await invoke<string[]>('existing_file_paths', { paths: [destPath] });
          if (existing.length === 0) break;
        } catch {
          break;
        }
      }
      candidate = `${stem} copy ${counter}${ext}`;
      destPath = parentDir ? `${parentDir}${sep}${candidate}` : candidate;
      counter += 1;
    }

    if (workspaceOperationBusy()) return null;

    try {
      await invoke('duplicate_project_path', {
        projectRoot: root,
        srcPath: normalized,
        destPath,
      });
      await refreshProjectFiles(root);
      if (!isDir) {
        await selectFile(destPath);
      }
      toast.success(`Duplicated as ${destPath.split(/[/\\]/).pop() || candidate}`);
      return destPath;
    } catch (e) {
      const message = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
      toast.error('Failed to duplicate', { description: message });
      console.error(e);
      return null;
    }
  }, [projectFiles, projectRoot, refreshProjectFiles, selectFile]);

  const revealInFileManager = useCallback(async (path: string): Promise<void> => {
    try {
      await invoke('reveal_in_file_manager', { path });
    } catch (e) {
      const message = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
      toast.error('Failed to reveal in file manager', { description: message });
      console.error(e);
    }
  }, []);

  const refreshFiles = useCallback(async (): Promise<void> => {
    const root = projectRootRef.current || projectRoot;
    if (!root) return;
    await refreshProjectFiles(root);
  }, [projectRoot, refreshProjectFiles]);

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
    templateAssets,
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
    renamePath,
    movePath,
    deletePath,
    deleteFile,
    duplicatePath,
    revealInFileManager,
    refreshFiles,
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
