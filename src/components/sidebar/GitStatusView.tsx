import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Download, FileCode2, GitBranch, Image as ImageIcon, Minus, Plus, RotateCw, Search, X } from 'lucide-react';
import { GitBranchListResult, GitBranchSwitchResult, GitStatusResult, GitFileChange } from '../../types/git';
import { ContextMenu, ContextMenuAction } from '../ContextMenu';
import { GitWorkflowControls } from './GitWorkflowControls';

interface GitStatusViewProps {
  projectRoot: string | null;
  projectName?: string;
  onSelectFile?: (path: string) => Promise<void> | void;
  onOpenDiff?: (path: string, repositoryRoot: string) => void;
  onBranchChanged?: () => Promise<void | boolean> | void | boolean;
  onWorktreeUpdateBusyChange?: (busy: boolean) => void;
  hasUnsavedChanges?: boolean;
  onClose?: () => void;
}

const getBadgeText = (change: GitFileChange) => {
  const state = change.indexStatus !== ' ' && change.indexStatus !== '?' ? change.indexStatus : change.worktreeStatus;
  if (state === '?') return 'U';
  if (state === 'A') return 'A';
  if (state === 'D') return 'D';
  if (state === 'R') return 'R';
  if (state === 'C') return 'C';
  if (state === 'T') return 'T';
  return 'M';
};

const isStaged = (change: GitFileChange) => change.indexStatus ? ![' ', '?'].includes(change.indexStatus) : change.staged;
const isUnstaged = (change: GitFileChange) => change.worktreeStatus ? ![' ', '?'].includes(change.worktreeStatus) || change.indexStatus === '?' : !change.staged || change.status === 'untracked';
const isImagePath = (path: string) => /\.(png|jpe?g|svg|webp|gif|bmp)$/i.test(path);

export const GitStatusView: React.FC<GitStatusViewProps> = ({ projectRoot, projectName = 'Project', onSelectFile, onOpenDiff, onBranchChanged, onWorktreeUpdateBusyChange, hasUnsavedChanges = false, onClose }) => {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [resolvedRepository, setResolvedRepository] = useState<{ projectPath: string; repositoryRoot: string } | null>(null);
  const [branches, setBranches] = useState<GitBranchListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [workspaceRefreshError, setWorkspaceRefreshError] = useState(false);
  const [newBranch, setNewBranch] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number } | null>(null);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; change: GitFileChange; group: 'staged' | 'changes' } | null>(null);
  const [collapsed, setCollapsed] = useState<{ staged: boolean; changes: boolean }>({ staged: false, changes: false });
  const mounted = useRef(true);
  const statusRequest = useRef(0);
  const currentProjectRoot = useRef(projectRoot);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { currentProjectRoot.current = projectRoot; }, [projectRoot]);
  currentProjectRoot.current = projectRoot;
  const actionsBlocked = working || workflowBusy;
  const repositoryRoot = projectRoot && resolvedRepository?.projectPath === projectRoot ? resolvedRepository.repositoryRoot : null;
  const reportRepositoryRoot = useCallback((root: string | null) => {
    if (!root) { setResolvedRepository(null); return; }
    const targetProject = currentProjectRoot.current;
    if (targetProject) setResolvedRepository({ projectPath: targetProject, repositoryRoot: root });
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    if (!projectRoot) { setStatus(null); setBranches(null); return; }
    const id = ++statusRequest.current;
    if (quiet) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const next = await invoke<GitStatusResult>('get_git_status', { projectPath: projectRoot });
      if (!mounted.current || id !== statusRequest.current) return;
      setStatus(next);
      window.dispatchEvent(new Event('sciencebatch:git-status-changed'));
      if (next.gitAvailable && next.isGitRepo) {
        const branchList = await invoke<GitBranchListResult>('list_git_branches', { projectPath: projectRoot });
        if (mounted.current && id === statusRequest.current) setBranches(branchList);
      } else setBranches(null);
    } catch (reason) {
      if (mounted.current && id === statusRequest.current) setError(String(reason));
    } finally {
      if (mounted.current && id === statusRequest.current) { setLoading(false); setRefreshing(false); }
    }
  }, [projectRoot]);

  useEffect(() => { statusRequest.current++; setStatus(null); setBranches(null); void refresh(); }, [projectRoot, refresh]);
  useEffect(() => { setWorkspaceRefreshError(false); }, [projectRoot]);

  const filtered = useMemo(() => (status?.changes || []).filter(change => change.path.toLowerCase().includes(query.trim().toLowerCase())), [status?.changes, query]);
  const unstaged = useMemo(() => filtered.filter(isUnstaged), [filtered]);
  const staged = useMemo(() => filtered.filter(isStaged), [filtered]);
  const runFileAction = async (action: 'stage_git_files' | 'unstage_git_files', paths: string[]) => {
    if (!repositoryRoot || paths.length === 0 || actionsBlocked) return;
    setWorking(true); setError(null);
    try {
      await invoke(action, { projectPath: repositoryRoot, paths });
      await refresh(true);
    } catch (reason) { setError(String(reason)); }
    finally { if (mounted.current) setWorking(false); }
  };

  const switchBranch = async (branch: string, create = false) => {
    if (!projectRoot || actionsBlocked || !branch.trim()) return;
    const targetRoot = projectRoot;
    const reloadProject = onBranchChanged;
    if (hasUnsavedChanges) { setError('Save or close tabs with unsaved changes before switching branches.'); return; }
    setWorking(true); setError(null);
    onWorktreeUpdateBusyChange?.(true);
    try {
      await invoke<GitBranchSwitchResult>('switch_git_branch', { projectPath: targetRoot, branch: branch.trim(), create });
      const refreshed = reloadProject ? await reloadProject() : true;
      if (!mounted.current || currentProjectRoot.current !== targetRoot) return;
      setNewBranch(false); setBranchName('');
      setWorkspaceRefreshError(refreshed === false);
      if (!mounted.current || currentProjectRoot.current !== targetRoot) return;
      await refresh(true);
    } catch (reason) {
      const failureMessage = String(reason);
      if (mounted.current && currentProjectRoot.current === targetRoot) {
        setError(failureMessage);
      }
      let refreshFailed = false;
      try {
        const refreshed = reloadProject ? await reloadProject() : true;
        refreshFailed = refreshed === false;
      } catch {
        refreshFailed = true;
      }
      if (mounted.current && currentProjectRoot.current === targetRoot) {
        setWorkspaceRefreshError(refreshFailed);
        await refresh(true);
        if (mounted.current && currentProjectRoot.current === targetRoot) setError(failureMessage);
      }
    }
    finally { onWorktreeUpdateBusyChange?.(false); if (mounted.current) setWorking(false); }
  };

  const openGitDownloads = async () => {
    try { await invoke('open_external_url', { url: 'https://git-scm.com/downloads' }); }
    catch (reason) { setError(String(reason)); }
  };

  const confirmInitialize = async () => {
    if (!projectRoot || actionsBlocked) return;
    const targetRoot = projectRoot;
    const confirmed = await ask(`Initialize a local Git repository in this folder?\n\n${targetRoot}\n\nThis creates Git metadata only. Your files are not changed.`, { title: 'Initialize Git Repository', kind: 'info', okLabel: 'Initialize', cancelLabel: 'Cancel' });
    if (!confirmed || !mounted.current || currentProjectRoot.current !== targetRoot) return;
    setWorking(true); setError(null);
    try {
      const next = await invoke<GitStatusResult>('initialize_git_repository', { projectPath: targetRoot });
      if (!mounted.current || currentProjectRoot.current !== targetRoot) return;
      setStatus(next);
      if (next.isGitRepo) await refresh(true); else setError(next.error || 'Git could not initialize this folder.');
    } catch (reason) { setError(String(reason)); }
    finally { if (mounted.current) setWorking(false); }
  };

  const absoluteRepositoryPath = (path: string) => repositoryRoot ? `${repositoryRoot.replace(/[\\/]+$/, '')}/${path}` : null;
  const openOriginal = (path: string) => {
    const fullPath = absoluteRepositoryPath(path);
    if (fullPath) return onSelectFile?.(fullPath);
  };
  const openDiff = (path: string) => { if (repositoryRoot) onOpenDiff?.(path, repositoryRoot); };

  const renderChanges = (changes: GitFileChange[], group: 'staged' | 'changes') => {
    const allPaths = (status?.changes || []).filter(group === 'staged' ? isStaged : isUnstaged).map(change => change.path);
    const isCollapsed = collapsed[group];
    return <div className="git-change-group">
      <div className="git-change-group-heading">
        <button className="git-group-toggle" aria-expanded={!isCollapsed} onClick={() => setCollapsed(value => ({ ...value, [group]: !value[group] }))}>
          {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span>{group === 'staged' ? 'Staged Changes' : 'Changes'}</span><span className="git-group-count">{changes.length}</span>
        </button>
        <button className="btn-git-group-action" title={!repositoryRoot ? 'Resolving repository root…' : group === 'staged' ? 'Unstage All Changes' : 'Stage All Changes'} aria-label={group === 'staged' ? 'Unstage All Changes' : 'Stage All Changes'} disabled={!repositoryRoot || actionsBlocked || allPaths.length === 0} onClick={() => void runFileAction(group === 'staged' ? 'unstage_git_files' : 'stage_git_files', allPaths)}>
          {group === 'staged' ? <Minus size={15} /> : <Plus size={15} />}
        </button>
      </div>
      {!isCollapsed && (changes.length === 0 ? <div className="git-group-empty">{group === 'staged' ? 'No staged files.' : 'No unstaged files.'}</div> : changes.map(change => {
        const parts = change.path.split('/');
        const name = parts.pop() || change.path;
        return <div key={`${group}:${change.path}`} className="git-change-row" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setFileMenu({ x: event.clientX, y: event.clientY, change, group }); }}>
          <span className={`git-status-badge git-status-${change.status}`}>{getBadgeText(change)}</span>
          <button className="git-change-open" title={!repositoryRoot ? 'Resolving repository root…' : isImagePath(change.path) ? 'Open image' : 'Open diff in editor'} disabled={!repositoryRoot || actionsBlocked} onClick={() => openDiff(change.path)}>
            <span className="git-file-name truncate">{name}</span>{parts.length > 0 && <span className="git-dir-path truncate">{parts.join('/')}</span>}
          </button>
          {onSelectFile && <button className="btn-git-row-action" title={!repositoryRoot ? 'Resolving repository root…' : isImagePath(change.path) ? 'Open Image' : 'Open file in editor'} aria-label={`${isImagePath(change.path) ? 'Open image' : 'Open'} ${change.path}`} disabled={!repositoryRoot || actionsBlocked} onClick={() => void openOriginal(change.path)}>{isImagePath(change.path) ? <ImageIcon size={14} /> : <FileCode2 size={14} />}</button>}
          <button className="btn-git-row-action git-stage-row-action" title={!repositoryRoot ? 'Resolving repository root…' : group === 'staged' ? 'Unstage Change' : 'Stage Change'} aria-label={`${group === 'staged' ? 'Unstage' : 'Stage'} ${change.path}`} disabled={!repositoryRoot || actionsBlocked} onClick={() => void runFileAction(group === 'staged' ? 'unstage_git_files' : 'stage_git_files', [change.path])}>{group === 'staged' ? <Minus size={14} /> : <Plus size={14} />}</button>
        </div>;
      }))}
    </div>;
  };

  const fileActions: ContextMenuAction[] = fileMenu ? [
    { label: isImagePath(fileMenu.change.path) ? 'Open Image' : 'Open Diff', onSelect: () => openDiff(fileMenu.change.path), disabled: !repositoryRoot || actionsBlocked },
    ...(!isImagePath(fileMenu.change.path) ? [{ label: 'Open File', onSelect: () => { void openOriginal(fileMenu.change.path); }, disabled: !repositoryRoot || actionsBlocked }] : []),
    { label: fileMenu.group === 'staged' ? 'Unstage Change' : 'Stage Change', onSelect: () => void runFileAction(fileMenu.group === 'staged' ? 'unstage_git_files' : 'stage_git_files', [fileMenu.change.path]), separatorBefore: true, disabled: !repositoryRoot || actionsBlocked },
  ] : [];
  const currentBranch = branches?.currentBranch || status?.branch || '';
  const branchActions: ContextMenuAction[] = (branches?.branches || []).map(branch => ({
    label: branch === currentBranch ? `✓  ${branch}` : branch,
    onSelect: () => { if (branch !== currentBranch) void switchBranch(branch); },
    disabled: actionsBlocked || hasUnsavedChanges || branch === currentBranch,
  }));
  branchActions.push({ label: 'Create Branch', separatorBefore: true, onSelect: () => { setNewBranch(true); setBranchName(''); }, disabled: actionsBlocked });

  return <div className="git-status-view-container">
    <div className="git-status-view-header">
      <div className="git-header-left"><span className="git-view-title">SOURCE CONTROL</span></div>
      <div className="git-view-header-actions">
        {status?.isGitRepo && <button className={`btn-git-header-action ${refreshing ? 'animate-spin' : ''}`} onClick={() => void refresh(true)} title="Refresh status" disabled={refreshing || actionsBlocked}><RotateCw size={13} /></button>}
        {onClose && <button className="btn-git-header-action" onClick={onClose} title="Close panel"><X size={14} /></button>}
      </div>
    </div>
    {status?.isGitRepo && <div className="git-branch-controls">
      <button type="button" className="git-branch-menu-trigger" ref={branchTriggerRef} aria-label={`Current Git branch ${currentBranch || 'Unknown'}`} aria-haspopup="menu" aria-expanded={Boolean(branchMenu)} disabled={actionsBlocked || hasUnsavedChanges} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setBranchMenu(current => current ? null : { x: rect.left, y: rect.bottom }); }}>
        <GitBranch size={14} /><span>{status.detached ? `Detached: ${currentBranch}` : currentBranch || 'Loading branch…'}</span><ChevronDown size={13} />
      </button>
      {hasUnsavedChanges && <span className="git-branch-hint" title="Save or close modified tabs before switching branches">Unsaved tabs</span>}
    </div>}
    {newBranch && <form className="git-new-branch" onSubmit={event => { event.preventDefault(); void switchBranch(branchName, true); }}><input autoFocus value={branchName} onChange={event => setBranchName(event.target.value)} placeholder="New branch name" aria-label="New branch name" /><button type="submit" disabled={actionsBlocked || !branchName.trim()}>Create</button><button type="button" onClick={() => { setNewBranch(false); setBranchName(''); }}>Cancel</button></form>}
    <div className="git-status-view-body">
      {loading ? <div className="git-state-empty"><RotateCw size={20} className="animate-spin" /><p>Checking Git status…</p></div>
        : !projectRoot ? <div className="git-state-empty"><p className="font-semibold">No Project Open</p><p>Open a folder to inspect Git status.</p></div>
        : status?.error ? <div className="git-state-empty"><AlertCircle size={26} /><p>Git Status Error</p><p>{status.error}</p><button className="git-retry-btn" onClick={() => void refresh(true)}>Retry</button></div>
        : status && !status.gitAvailable ? <div className="git-state-empty"><AlertCircle size={28} /><p>Git Is Not Installed</p><p>Install Git to manage local changes.</p><button className="git-initialize-btn" onClick={() => void openGitDownloads()}><Download size={14} />Get Git</button><button className="git-retry-btn" onClick={() => void refresh(true)}>Retry detection</button></div>
        : status && !status.isGitRepo ? <div className="git-state-empty"><GitBranch size={28} /><p className="font-semibold">Not a Git Repository</p><p>The folder {projectName} is not tracked by Git.</p><p className="text-muted text-[11px] text-center">Git {status.gitVersion?.replace(/^git version /, '') || 'is ready'}. Initialize local history here. An online account is not needed.</p><button className="git-initialize-btn" disabled={working} onClick={() => void confirmInitialize()}><GitBranch size={14} />Initialize Git</button></div>
        : !status ? null : <div className="git-changes-panel">
          {projectRoot && <GitWorkflowControls key={projectRoot} projectRoot={projectRoot} hasUnsavedChanges={hasUnsavedChanges} disabled={working} onRefresh={() => refresh(true)} onBranchChanged={onBranchChanged} onRepositoryRootChange={reportRepositoryRoot} onWorktreeUpdateBusyChange={onWorktreeUpdateBusyChange} onOperationBusyChange={setWorkflowBusy} />}
          {workspaceRefreshError && <p className="git-workflow-error" role="alert">The project could not refresh after the Git operation. Close and reopen it to reload its files.</p>}
          <div className="git-filter-wrapper"><Search size={13} className="git-filter-icon" /><input className="git-filter-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter changed files…" />{query && <button className="git-filter-clear" onClick={() => setQuery('')} title="Clear filter"><X size={12} /></button>}</div>
          <div className="git-changes-list">
            {status.changes.length === 0 ? <div className="git-clean-state"><CheckCircle2 size={24} /><p>Working Tree Clean</p></div> : filtered.length === 0 ? <div className="git-no-matches">No files match “{query}”.</div> : <>{renderChanges(staged, 'staged')}{renderChanges(unstaged, 'changes')}</>}
          </div>
          {error && <p className="git-onboarding-error" role="alert">{error}</p>}
        </div>}
      {error && !status?.isGitRepo && <p className="git-onboarding-error" role="alert">{error}</p>}
    </div>
    {branchMenu && <ContextMenu x={branchMenu.x} y={branchMenu.y} actions={branchActions} triggerRef={branchTriggerRef} onClose={() => setBranchMenu(null)} />}
    {fileMenu && <ContextMenu x={fileMenu.x} y={fileMenu.y} actions={fileActions} onClose={() => setFileMenu(null)} />}
  </div>;
};
