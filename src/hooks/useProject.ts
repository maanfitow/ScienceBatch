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
  const activeTabRef = useRef<string | null>(null);
  const activeSourceTabRef = useRef<string | null>(null);
  const fileRequestRef = useRef(0);
  const setTabs = useCallback((next: WorkspaceTab[]) => {
    tabsRef.current = next;
    setTabsState(next);
  }, []);
  const setSourceCode = useCallback((content: string) => {
    setSourceCodeState(content);
    const active = tabsRef.current.find(tab => tab.id === activeTabRef.current);
    const targetId = active?.kind === 'source' ? active.id : activeSourceTabRef.current;
    if (targetId) setTabs(tabsRef.current.map(tab => tab.id === targetId && tab.kind === 'source' ? { ...tab, content, preview: false } : tab));
  }, [setTabs]);
  const activateTab = useCallback((id: string) => {
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
    setTabs(tabsRef.current.map(tab => tab.id === id ? { ...tab, preview: false } : tab));
  }, [setTabs]);
  const resetTabs = useCallback((path: string | null, content: string, tabEngine: EngineType) => {
    fileRequestRef.current++;
    const id = `source:${path || 'scratchpad'}`;
    setTabs([{ id, path, name: path?.split(/[/\\]/).pop() || `Untitled.${tabEngine === 'typst' ? 'typ' : 'tex'}`, kind: 'source', pinned: false, preview: false, content, savedContent: content }]);
    activeTabRef.current = id;
    activeSourceTabRef.current = id;
    setActiveTabId(id);
  }, [setTabs]);
  const closeTabs = useCallback(async (all = false, id = activeTabRef.current, others = false) => {
    const closing = tabsRef.current.filter(tab => all ? !tab.pinned : others ? tab.id !== id && !tab.pinned : tab.id === id);
    if (closing.some(tabIsDirty)) {
      const confirmed = await ask('Discard unsaved changes in the tabs being closed?', { title: 'Unsaved Changes', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Cancel' });
      if (!confirmed) return;
    }
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
    setTabs(tabsRef.current.map(tab => tab.id === id ? { ...tab, pinned: !tab.pinned, preview: tab.pinned ? tab.preview : false } : tab));
  }, [setTabs]);
  const openPreviewTab = useCallback(async (nextTab: WorkspaceTab) => {
    const existing = tabsRef.current.find(tab => tab.id === nextTab.id);
    if (existing) { activateTab(existing.id); return; }
    const request = ++fileRequestRef.current;
    const preview = tabsRef.current.find(tab => tab.preview);
    if (preview && tabIsDirty(preview)) {
      const confirmed = await ask('Discard unsaved changes in the preview tab?', { title: 'Unsaved Changes', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Cancel' });
      if (!confirmed || request !== fileRequestRef.current) return;
    }
    if (request !== fileRequestRef.current) return;
    const latest = tabsRef.current;
    const replace = latest.find(tab => tab.preview);
    const index = replace ? latest.findIndex(tab => tab.id === replace.id) : latest.length;
    const next = latest.filter(tab => tab.id !== replace?.id);
    next.splice(index, 0, nextTab);
    setTabs(next);
    activateTab(nextTab.id);
  }, [activateTab, setTabs]);
  const openDiff = useCallback((path: string) => {
    const id = `diff:${path}`;
    void openPreviewTab({ id, path, name: path.split(/[/\\]/).pop() || path, kind: 'diff', pinned: false, preview: true, content: '', savedContent: '' });
  }, [openPreviewTab]);

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
        const customMacros = new Set<string>();
        for (const rel of clsAndStyFiles) {
          const absPath = `${dir}/${rel}`;
          try {
            const content = await invoke<string>('read_file_content', { path: absPath });
            const extracted = extractMacrosFromSource(content);
            for (const m of extracted) {
              customMacros.add(m);
            }
          } catch (err) {
            console.warn(`Failed to scan macro file ${rel}:`, err);
          }
        }
        setProjectCustomCommands(customMacros);
      } else {
        setProjectCustomCommands(new Set());
      }

      return files;
    } catch (e) {
      console.error('Failed to list project files:', e);
      return [];
    }
  }, []);

  // Save current active file to disk and trigger compilation
  const saveFile = useCallback(async () => {
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
    if (!projectRoot) return;
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
  const openFolder = useCallback(async (forcedPath?: string) => {
    let targetPath = forcedPath;

    if (!targetPath) {
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Open LaTeX or Typst Project Folder',
        });

        if (!selected || typeof selected !== 'string') return;
        targetPath = selected;
      } catch (e) {
        console.error('Failed to open directory dialog:', e);
        return;
      }
    }

    if (tabsRef.current.some(tabIsDirty)) {
      const confirmed = await ask('Discard unsaved changes before opening another project?', { title: 'Unsaved Changes', kind: 'warning', okLabel: 'Discard and Open', cancelLabel: 'Cancel' });
      if (!confirmed) return;
    }

    clearCompilationAndDiagnostics();

    try {
      const files = await refreshProjectFiles(targetPath);
      const name = targetPath.split('/').filter(Boolean).pop() || 'Project';

      // Check for .sciencebatch.json config
      let detectedEngine: EngineType = 'latex';
      let detectedMain = 'main.tex';

      try {
        const configPath = `${targetPath}/.sciencebatch.json`;
        const configRaw = await invoke<string>('read_file_content', { path: configPath });
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


    } catch (err) {
      try {
        const valid: string[] = await invoke('validate_recent_paths', { paths: [targetPath] });
        if (valid.length === 0) {
          toast.error('Project folder not found', {
            description: `The folder "${targetPath}" no longer exists on disk. Removed from recent projects.`,
          });
          removeRecentProject(targetPath);
          return;
        }
      } catch {}
      toast.error('Failed to open project folder');
      console.error(err);
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
    clearCompilationAndDiagnostics();
    setProjectRoot(null);
    projectRootRef.current = null;
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
  const closeProject = useCallback(async () => {
    if (tabsRef.current.some(tabIsDirty)) {
      const confirmed = await ask('Discard unsaved changes and close this project?', { title: 'Unsaved Changes', kind: 'warning', okLabel: 'Discard and Close', cancelLabel: 'Cancel' });
      if (!confirmed) return;
    }
    setTabs([]);
    activeTabRef.current = null;
    activeSourceTabRef.current = null;
    setActiveTabId(null);
    fileRequestRef.current++;
    setProjectRoot(null);
    projectRootRef.current = null;
    setProjectName('');
    setActiveFilePath(null);
    activeFilePathRef.current = null;
    setMainFilePath(null);
    mainFilePathRef.current = null;
    setProjectFiles([]);
    setGlobalProjectFiles([]);
    setProjectCustomCommands(new Set());
    clearCompilationAndDiagnostics();
    onEnterWelcomeMode?.();
  }, [clearCompilationAndDiagnostics, onEnterWelcomeMode, setTabs]);

  // File tree operations
  const selectFile = useCallback(async (filePath: string, permanent = false) => {
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
      const content = kind === 'source' ? await invoke<string>('read_file_content', { path: filePath }) : '';
      if (request !== fileRequestRef.current || root !== projectRootRef.current) return;
      await openPreviewTab({ id, path: filePath, name: filePath.split(/[/\\]/).pop() || filePath, kind, pinned: false, preview: !permanent, content, savedContent: content });
    } catch (e) {
      toast.error('Unable to open file', { description: String(e) });
    }
  }, [activateTab, openPreviewTab, promoteTab]);

  const setMainFile = useCallback(async (filePath: string) => {
    if (!projectRoot) return;
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
      await invoke('write_file_content', {
        path: configPath,
        content: JSON.stringify(configJson, null, 2),
      });
      toast.success(`Main entrypoint set to ${relName}`);
    } catch (e) {
      console.error('Failed to update project config:', e);
    }
  }, [projectRoot, projectName, engine]);

  const createFile = useCallback(async (parentDir: string, name: string) => {
    try {
      const fullPath = `${parentDir}/${name}`;
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
    try {
      const fullPath = `${parentDir}/${name}`;
      await invoke('write_file_content', { path: `${fullPath}/.gitkeep`, content: '' });
      if (projectRoot) await refreshProjectFiles(projectRoot);
      toast.success(`Created folder ${name}`);
    } catch (e) {
      toast.error('Failed to create folder');
      console.error(e);
    }
  }, [projectRoot, refreshProjectFiles]);

  const deleteFile = useCallback(async (_path: string) => {
    toast.info('File deletion: please remove file via system file explorer for safety.');
  }, []);

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
    setEngine,
    saveFile,
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
  };
}
