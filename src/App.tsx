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
import { useWorkspaceAutomation } from './hooks/useWorkspaceAutomation';
import { ViewMode } from './types';
import { tabIsDirty, type WorkspaceTab } from './types/workspace';
import type { WritingEditorBridge, WritingEditorState } from './types/writing';
import { inspectPackageEligibility } from './editor/writing';
import { validateWorkspaceEdit } from './editor/workspaceAutomationBridge';
import type { AutomationEditorBridge, WorkspaceAutomationReply, WorkspaceAutomationRequest } from './types/automation';
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

const engineForMainFile = (projectRoot: string | null, mainFilePath: string | null, fallback: 'latex' | 'typst'): 'latex' | 'typst' => {
  if (!projectRoot || !mainFilePath) return fallback;
  return /\.typ$/i.test(mainFilePath) ? 'typst' : 'latex';
};

const waitForRenderTurn = () => new Promise<void>(resolve => {
  let finished = false;
  let frame = 0;
  let timer = 0;
  const finish = () => {
    if (finished) return;
    finished = true;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    resolve();
  };
  timer = window.setTimeout(finish, 50);
  frame = window.requestAnimationFrame(finish);
});

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
  const projectRef = React.useRef(project);
  projectRef.current = project;
  const compilerRef = React.useRef(compiler);
  compilerRef.current = compiler;
  const automationEditorBridgeRef = React.useRef<AutomationEditorBridge | null>(null);
  const handleAutomationEditorBridgeChange = useCallback((bridge: AutomationEditorBridge | null) => {
    automationEditorBridgeRef.current = bridge;
  }, []);

  const handleWorkspaceAutomationRequest = useCallback(async (request: WorkspaceAutomationRequest): Promise<WorkspaceAutomationReply> => {
    const current = projectRef.current;
    const args = request.args ?? {};
    const respond = (data: unknown): WorkspaceAutomationReply => ({ schemaVersion: 1, id: request.id, ok: true, data });
    const reject = (code: string, message: string, details?: unknown): WorkspaceAutomationReply => ({ schemaVersion: 1, id: request.id, ok: false, error: { code, message, details } });
    const stringArg = (key: string) => typeof args[key] === 'string' ? args[key] as string : null;
    const numberArg = (key: string) => typeof args[key] === 'number' && Number.isInteger(args[key]) ? args[key] as number : null;
    const allowedRoots = Array.isArray(args.allowedRoots) ? args.allowedRoots.filter((item): item is string => typeof item === 'string') : [];
    const currentRoot = current.projectRoot;
    const currentGeneration = current.getProjectGeneration();
    const checkExpectedContext = () => {
      if (!Object.prototype.hasOwnProperty.call(args, 'expectedProjectRoot') || args.expectedProjectRoot !== currentRoot
        || numberArg('workspaceGeneration') !== currentGeneration) {
        return reject('conflict.project', 'The workspace project changed since it was inspected.', { projectRoot: currentRoot, workspaceGeneration: currentGeneration });
      }
      if (current.getWorkspaceExportLeaseId() && ['workspace.openProject', 'workspace.openFile', 'workspace.activate', 'workspace.apply', 'workspace.save', 'workspace.close', 'workspace.compile'].includes(request.operation)) {
        return reject('workspace.busy', 'A PDF export is finalizing the current workspace snapshot.');
      }
      if (current.worktreeUpdateBusy) return reject('git.locked', 'A Git worktree update is in progress.');
      return null;
    };
    const authorizeCurrentRoot = async (): Promise<string | null | WorkspaceAutomationReply> => {
      if (!currentRoot) return null;
      try { return await invoke<string>('workspace_validate_root', { projectRoot: currentRoot, allowedRoots }); }
      catch (error) { return reject('path.outside_roots', String(error)); }
    };
    const contextStillCurrent = () => projectRef.current.projectRoot === currentRoot
      && projectRef.current.getProjectGeneration() === currentGeneration;
    const documentInfo = (tab: WorkspaceTab, includeContent = false) => ({
      id: tab.id,
      path: tab.path && currentRoot ? tab.path.replace(`${currentRoot}/`, '').replace(/\\/g, '/') : tab.path,
      name: tab.name,
      ...(includeContent ? { content: tab.content } : {}),
      saved: tab.content === tab.savedContent,
      revision: current.getDocumentRevision(tab.id),
    });
    try {
      switch (request.operation) {
        case 'workspace.inspect':
          return respond({
            instance: 'current',
            projectRoot: currentRoot,
            projectName: current.projectName,
            engine: current.engine,
            mainFile: current.mainFilePath,
            workspaceGeneration: currentGeneration,
            documents: current.tabs.filter(tab => tab.kind === 'source').map(tab => documentInfo(tab)),
          });
        case 'workspace.read': {
          const conflict = checkExpectedContext();
          if (conflict) return conflict;
          const authorizedRoot = await authorizeCurrentRoot();
          if (authorizedRoot && typeof authorizedRoot !== 'string') return authorizedRoot;
          if (!contextStillCurrent()) return reject('conflict.project', 'The project changed while access was being checked.');
          const id = stringArg('documentId');
          const tab = id ? current.tabs.find(item => item.id === id && item.kind === 'source') : undefined;
          if (tab) return contextStillCurrent() ? respond(documentInfo(tab, true)) : reject('conflict.project', 'The project changed while the document was being read.');
          const path = stringArg('path');
          if (!path || !authorizedRoot || typeof authorizedRoot !== 'string') return reject('document.unavailable', 'Select an open document or provide a project-relative path.');
          const fullPath = path.startsWith(authorizedRoot) ? path : `${authorizedRoot}/${path}`;
          const normalized = normalizeWorkspacePath(fullPath);
          const normalizedRoot = normalizeWorkspacePath(authorizedRoot);
          if (normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}/`)) return reject('path.outside_project', 'The requested file is outside the open project.');
          const openDocument = current.tabs.find(item => item.kind === 'source' && item.path && normalizeWorkspacePath(item.path) === normalized);
          if (openDocument) return respond(documentInfo(openDocument, true));
          const relativeFile = normalized.slice(normalizedRoot.length + 1);
          const result = await invoke<{ content: string }>('workspace_read_disk', { projectRoot: authorizedRoot, file: relativeFile, allowedRoots });
          const content = result.content;
          if (!contextStillCurrent()) return reject('conflict.project', 'The project changed while the file was being read.');
          return respond({ path: relativeFile, content, saved: true, revision: null });
        }
        case 'workspace.openProject': {
          const conflict = checkExpectedContext();
          if (conflict) return conflict;
          const path = stringArg('path');
          if (!path) return reject('argument.invalid', 'A project path is required.');
          let authorizedTarget: string;
          try { authorizedTarget = await invoke<string>('workspace_validate_root', { projectRoot: path, allowedRoots }); }
          catch (error) { return reject('path.outside_roots', String(error)); }
          if (!contextStillCurrent()) return reject('conflict.project', 'The workspace changed while project access was being checked.');
          if (current.tabs.some(tabIsDirty)) return reject('conflict.dirty', 'Unsaved documents must be saved before switching projects.');
          const opened = await current.openFolder(authorizedTarget, true);
          if (opened && projectRef.current.projectRoot !== authorizedTarget) return reject('conflict.project', 'The workspace changed while the project was opening.');
          return opened ? respond({ projectRoot: projectRef.current.projectRoot, workspaceGeneration: projectRef.current.getProjectGeneration() }) : reject('project.open', 'The requested project could not be opened.');
        }
        case 'workspace.openFile': {
          const conflict = checkExpectedContext();
          if (conflict) return conflict;
          const authorizedRoot = await authorizeCurrentRoot();
          if (authorizedRoot && typeof authorizedRoot !== 'string') return authorizedRoot;
          if (!authorizedRoot) return reject('project.unavailable', 'Open a project before opening a project file.');
          if (!contextStillCurrent()) return reject('conflict.project', 'The project changed while access was being checked.');
          const requestedPath = stringArg('path');
          if (!requestedPath) return reject('argument.invalid', 'A project-relative file path is required.');
          const fullPath = requestedPath.startsWith(authorizedRoot) ? requestedPath : `${authorizedRoot}/${requestedPath}`;
          const normalized = normalizeWorkspacePath(fullPath);
          const normalizedRoot = normalizeWorkspacePath(authorizedRoot);
          if (normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}/`)) return reject('path.outside_project', 'The requested file is outside the open project.');
          const relativeFile = fullPath.replace(/\\/g, '/').slice(normalizedRoot.length + 1);
          const opened = await invoke<{ content: string }>('workspace_read_disk', { projectRoot: authorizedRoot, file: relativeFile, allowedRoots });
          if (projectRef.current.projectRoot !== currentRoot || current.getProjectGeneration() !== currentGeneration) return reject('conflict.project', 'The project changed while the file was being opened.');
          await current.selectFile(fullPath, true, opened.content);
          if (projectRef.current.projectRoot !== currentRoot || projectRef.current.getProjectGeneration() !== currentGeneration) return reject('conflict.project', 'The project changed while the file was being opened.');
          const tabId = `source:${fullPath}`;
          let latest = projectRef.current;
          for (let attempt = 0; attempt < 30 && !latest.tabs.some(item => item.id === tabId); attempt++) {
            await waitForRenderTurn();
            if (!contextStillCurrent()) return reject('conflict.project', 'The workspace changed while the file was opening.');
            latest = projectRef.current;
          }
          if (!contextStillCurrent()) return reject('conflict.project', 'The workspace changed while the file was opening.');
          const tab = latest.tabs.find(item => item.id === tabId);
          return tab ? respond({ document: documentInfo(tab), activeDocumentId: projectRef.current.activeTabId }) : reject('file.open', 'The requested file could not be opened as a source document.');
        }
        case 'workspace.activate': {
          const conflict = checkExpectedContext();
          if (conflict) return conflict;
          const id = stringArg('documentId');
          if (!id || !current.tabs.some(tab => tab.id === id)) return reject('document.unavailable', 'The requested workspace document is not open.');
          current.activateTab(id);
          return respond({ documentId: id, active: true });
        }
        case 'workspace.apply': {
          const conflict = checkExpectedContext();
          if (conflict) return conflict;
          const authorizedRoot = await authorizeCurrentRoot();
          if (authorizedRoot && typeof authorizedRoot !== 'string') return authorizedRoot;
          if (!contextStillCurrent()) return reject('conflict.project', 'The project changed while access was being checked.');
          const documentId = stringArg('documentId');
          const expectedRevision = numberArg('expectedRevision');
          const start = numberArg('start');
          const end = numberArg('end');
          const text = stringArg('text');
          if (!documentId || expectedRevision === null || start === null || end === null || text === null) return reject('argument.invalid', 'A document ID, expected revision, edit range, and replacement text are required.');
          const tab = current.tabs.find(item => item.id === documentId && item.kind === 'source');
          if (!tab) return reject('document.unavailable', 'The requested source document is not open.');
          if (current.getDocumentRevision(documentId) !== expectedRevision) return reject('conflict.revision', 'The document changed since the requested revision.', { currentRevision: current.getDocumentRevision(documentId) });
          current.activateTab(documentId);
          let editor = automationEditorBridgeRef.current;
          for (let attempt = 0; attempt < 30 && editor?.getDocumentId() !== documentId; attempt++) {
            await waitForRenderTurn();
            editor = automationEditorBridgeRef.current;
          }
          if (!editor || editor.getDocumentId() !== documentId) return reject('document.inactive', 'The requested document could not be activated in the editor.');
          const latest = projectRef.current;
          const liveTab = latest.tabs.find(item => item.id === documentId && item.kind === 'source');
          if (!liveTab || latest.projectRoot !== currentRoot || latest.getProjectGeneration() !== currentGeneration
            || latest.getDocumentRevision(documentId) !== expectedRevision) {
            return reject('conflict.revision', 'The project or document changed while the edit was being prepared.', { currentRevision: latest.getDocumentRevision(documentId) });
          }
          const editError = validateWorkspaceEdit(liveTab.content, start, end, text);
          if (editError === 'range.splits_surrogate') return reject('argument.invalid_range', 'Edit offsets must not split a Unicode character. Offsets use UTF-16 code units.');
          if (editError === 'range.invalid') return reject('argument.invalid_range', 'The edit range is outside the current document.');
          if (editError === 'text.invalid_unicode') return reject('argument.invalid_text', 'Replacement text contains an invalid Unicode surrogate.');
          if (editError === 'document.too_large') return reject('limit.text_bytes', 'The edited document would exceed the 8 MiB text limit.');
          const leaseId = `${request.id}:apply`;
          try {
            await invoke('acquire_workspace_repository_lock', { projectRoot: authorizedRoot, leaseId });
            const beforeApply = projectRef.current;
            if (beforeApply.projectRoot !== currentRoot || beforeApply.getProjectGeneration() !== currentGeneration
              || beforeApply.getDocumentRevision(documentId) !== expectedRevision) {
              return reject('conflict.revision', 'The project or document changed before the edit was applied.', { currentRevision: beforeApply.getDocumentRevision(documentId) });
            }
            let nextRevision: number | null = null;
            for (let attempt = 0; attempt < 30 && nextRevision === null; attempt++) {
              const latest = projectRef.current;
              const latestTab = latest.tabs.find(item => item.id === documentId && item.kind === 'source');
              if (!latestTab || latest.projectRoot !== currentRoot || latest.getProjectGeneration() !== currentGeneration
                || latest.getDocumentRevision(documentId) !== expectedRevision) {
                return reject('conflict.revision', 'The project or document changed while the edit was being applied.', { currentRevision: latest.getDocumentRevision(documentId) });
              }
              const currentEditor = automationEditorBridgeRef.current;
              if (currentEditor?.getDocumentId() === documentId) {
                nextRevision = currentEditor.apply({ documentId, expectedRevision, start, end, text });
              }
              if (nextRevision === null) await waitForRenderTurn();
            }
            if (nextRevision === null) return reject('conflict.revision', 'The editor changed while the edit was being applied.', { currentRevision: projectRef.current.getDocumentRevision(documentId) });
            return respond({ documentId, revision: nextRevision, undoAvailable: true });
          } catch (error) {
            const message = String(error);
            return reject(message.includes('git.locked') ? 'git.locked' : 'workspace.operation_failed', message);
          } finally {
            await invoke('release_workspace_repository_lock', { leaseId }).catch(() => undefined);
          }
        }
        case 'workspace.save': {
          const conflict = checkExpectedContext();
          if (conflict) return conflict;
          const authorizedRoot = await authorizeCurrentRoot();
          if (authorizedRoot && typeof authorizedRoot !== 'string') return authorizedRoot;
          if (!contextStillCurrent()) return reject('conflict.project', 'The project changed while access was being checked.');
          const documentId = stringArg('documentId');
          const expectedRevision = numberArg('expectedRevision');
          if (!documentId || expectedRevision === null) return reject('argument.invalid', 'A document ID and expected revision are required.');
          if (current.getDocumentRevision(documentId) !== expectedRevision) return reject('conflict.revision', 'The document changed since the requested revision.', { currentRevision: current.getDocumentRevision(documentId) });
          const result = await current.saveDocument(documentId, expectedRevision, currentGeneration, allowedRoots);
          if (!result.ok) return reject(result.code, result.message);
          return respond(result);
        }
        case 'workspace.close': {
          const conflict = checkExpectedContext();
          if (conflict) return conflict;
          const authorizedRoot = await authorizeCurrentRoot();
          if (authorizedRoot && typeof authorizedRoot !== 'string') return authorizedRoot;
          if (!contextStillCurrent()) return reject('conflict.project', 'The project changed while access was being checked.');
          const documentId = stringArg('documentId');
          if (documentId) {
            const tab = current.tabs.find(item => item.id === documentId);
            if (!tab) return reject('document.unavailable', 'The requested workspace document is not open.');
            if (tabIsDirty(tab)) return reject('conflict.dirty', 'The document has unsaved changes. Save it before closing.');
            await current.closeTabs(false, documentId);
            let latest = projectRef.current;
            for (let attempt = 0; attempt < 30 && latest.tabs.some(item => item.id === documentId); attempt++) {
              await waitForRenderTurn();
              if (!contextStillCurrent()) return reject('conflict.project', 'The workspace changed while the document was closing.');
              latest = projectRef.current;
            }
            if (!contextStillCurrent() || latest.tabs.some(item => item.id === documentId)) return reject('conflict.project', 'The workspace changed while the document was closing.');
          } else {
            if (current.tabs.some(tabIsDirty)) return reject('conflict.dirty', 'The workspace has unsaved documents. Save them before closing the project.');
            await current.closeProject(true);
            let latest = projectRef.current;
            for (let attempt = 0; attempt < 30 && latest.projectRoot !== null; attempt++) {
              await waitForRenderTurn();
              latest = projectRef.current;
            }
            if (projectRef.current.projectRoot !== null) return reject('conflict.project', 'The workspace changed while the project was closing.');
          }
          return respond({ closed: true, documentId: documentId ?? null });
        }
        case 'workspace.compile': {
          const conflict = checkExpectedContext();
          if (conflict) return conflict;
          const authorizedRoot = await authorizeCurrentRoot();
          if (authorizedRoot && typeof authorizedRoot !== 'string') return authorizedRoot;
          if (!contextStillCurrent()) return reject('conflict.project', 'The project changed while access was being checked.');
          const root = current.projectRoot;
          const mainFile = current.mainFilePath ?? `main.${current.engine === 'typst' ? 'typ' : 'tex'}`;
          const engine = engineForMainFile(root, current.mainFilePath, current.engine);
          const relativeMain = root && mainFile.startsWith(root) ? mainFile.slice(root.length).replace(/^[/\\]/, '') : mainFile;
          const overlays: Record<string, string> = {};
          const documents = current.tabs.filter(tab => tab.kind === 'source');
          for (const tab of documents) {
            const path = tab.path && root ? (tab.path.startsWith(root) ? tab.path.slice(root.length).replace(/^[/\\]/, '') : tab.path) : relativeMain;
            overlays[path.replace(/\\/g, '/')] = tab.content;
          }
          if (!Object.keys(overlays).length) return reject('document.unavailable', 'There is no source document to compile.');
          const documentIdentity = JSON.stringify(documents.map(tab => [tab.id, tab.path, current.getDocumentRevision(tab.id)]).sort(([left], [right]) => String(left).localeCompare(String(right))));
          const selectedMainPath = current.mainFilePath;
          const isSnapshotCurrent = () => {
            const latest = projectRef.current;
            const latestDocuments = latest.tabs.filter(tab => tab.kind === 'source');
            const latestIdentity = JSON.stringify(latestDocuments.map(tab => [tab.id, tab.path, latest.getDocumentRevision(tab.id)]).sort(([left], [right]) => String(left).localeCompare(String(right))));
            return latest.projectRoot === root && latest.getProjectGeneration() === currentGeneration
              && latest.mainFilePath === selectedMainPath
              && engineForMainFile(latest.projectRoot, latest.mainFilePath, latest.engine) === engine
              && latestIdentity === documentIdentity;
          };
          const timeoutSeconds = numberArg('timeoutSeconds') ?? 120;
          if (timeoutSeconds < 1 || timeoutSeconds > 900) return reject('argument.invalid', 'Compilation timeout must be between 1 and 900 seconds.');
          const jobId = stringArg('jobId') ?? request.id;
          const result = await compilerRef.current.compileWorkspace({ jobId, engine, projectRoot: authorizedRoot, mainFile: relativeMain, overlays, timeoutSeconds, allowedRoots }, isSnapshotCurrent);
          if (!result || !isSnapshotCurrent()) {
            return reject('conflict.stale_result', 'The workspace changed during compilation; the result was not applied to the preview.');
          }
          if (result.error) return reject(result.error.code, result.error.message);
          if (!result.success) {
            return reject('compile.document_failed', 'The workspace document failed to compile.', {
              jobId,
              errors: result.errors,
              warnings: result.warnings,
            });
          }
          const outputPath = stringArg('outputPath');
          let pdfWritten = false;
          if (outputPath && result.success) {
            if (!isSnapshotCurrent()) {
              return reject('conflict.stale_result', 'The workspace changed before the requested PDF could be exported.');
            }
            const leaseId = `${request.id}:pdf-export`;
            const latestProject = projectRef.current;
            if (!latestProject.acquireWorkspaceExportLease(leaseId)) return reject('workspace.busy', 'Another workspace operation is in progress.');
            const activeEditor = automationEditorBridgeRef.current;
            activeEditor?.setReadOnly(true);
            try {
              if (!isSnapshotCurrent()) return reject('conflict.stale_result', 'The workspace changed before the requested PDF could be exported.');
              await invoke('workspace_export_pdf', {
                outputPath,
                pdfBytes: result.pdfBytes,
                overwrite: args.overwrite === true,
                allowedRoots,
              });
              if (!isSnapshotCurrent()) return reject('conflict.stale_result', 'The workspace changed during PDF export.');
              pdfWritten = true;
            } finally {
              activeEditor?.setReadOnly(false);
              projectRef.current.releaseWorkspaceExportLease(leaseId);
            }
          }
          return respond({ jobId, success: result.success, errors: result.errors, warnings: result.warnings, outputPath: pdfWritten ? outputPath : null, pdfWritten });
        }
        case 'workspace.cancel': {
          const conflict = checkExpectedContext();
          if (conflict) return conflict;
          const jobId = stringArg('jobId');
          if (!jobId) return reject('argument.invalid', 'A workspace compilation job ID is required.');
          await compilerRef.current.cancelWorkspaceCompilation(jobId);
          return respond({ jobId, cancelled: true });
        }
        default:
          return reject('operation.unsupported', `Unsupported workspace operation: ${request.operation}`);
      }
    } catch (error) {
      const message = String(error);
      const code = message.match(/^([a-z][a-z0-9_.-]+):/)?.[1] ?? 'workspace.operation_failed';
      return reject(code, message);
    }
  }, []);
  useWorkspaceAutomation(handleWorkspaceAutomationRequest, jobId => {
    void compilerRef.current.cancelWorkspaceCompilation(jobId);
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
        onUndo={() => automationEditorBridgeRef.current?.undo()}
        onRedo={() => automationEditorBridgeRef.current?.redo()}
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
                onAutomationBridgeChange={handleAutomationEditorBridgeChange}
                getDocumentRevision={project.getDocumentRevision}
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
