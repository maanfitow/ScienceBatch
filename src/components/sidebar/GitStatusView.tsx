import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Download, FileCode2, GitBranch, Image as ImageIcon, Minus, Plus, RotateCw, Search, X } from 'lucide-react';
import { GitBranchListResult, GitBranchSwitchResult, GitStatusResult, GitFileChange } from '../../types/git';
import { ContextMenu, ContextMenuAction } from '../ContextMenu';
import { GitWorkflowControls } from './GitWorkflowControls';
import { translateBackendError } from '../../i18n/backendMessages';

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

export const GitStatusView: React.FC<GitStatusViewProps> = ({ projectRoot, projectName, onSelectFile, onOpenDiff, onBranchChanged, onWorktreeUpdateBusyChange, hasUnsavedChanges = false, onClose }) => {
  const { t } = useTranslation(['git', 'common']);
  const displayProjectName = projectName ?? t('git:status.defaultProjectName');
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
      if (mounted.current && id === statusRequest.current) setError(translateBackendError(reason));
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
    } catch (reason) { setError(translateBackendError(reason)); }
    finally { if (mounted.current) setWorking(false); }
  };

  const switchBranch = async (branch: string, create = false) => {
    if (!projectRoot || actionsBlocked || !branch.trim()) return;
    const targetRoot = projectRoot;
    const reloadProject = onBranchChanged;
    if (hasUnsavedChanges) { setError(t('git:status.unsavedSwitchError')); return; }
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
      const failureMessage = translateBackendError(reason);
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
    catch (reason) { setError(translateBackendError(reason)); }
  };

  const confirmInitialize = async () => {
    if (!projectRoot || actionsBlocked) return;
    const targetRoot = projectRoot;
    const confirmed = await ask(
      t('git:status.initializeConfirmMessage', { path: targetRoot }),
      {
        title: t('git:status.initializeConfirmTitle'),
        kind: 'info',
        okLabel: t('git:status.initializeConfirmOk'),
        cancelLabel: t('common:actions.cancel'),
      },
    );
    if (!confirmed || !mounted.current || currentProjectRoot.current !== targetRoot) return;
    setWorking(true); setError(null);
    try {
      const next = await invoke<GitStatusResult>('initialize_git_repository', { projectPath: targetRoot });
      if (!mounted.current || currentProjectRoot.current !== targetRoot) return;
      setStatus(next);
      if (next.isGitRepo) await refresh(true); else setError(next.error ? translateBackendError(next.error) : t('git:status.initializeFailed'));
    } catch (reason) { setError(translateBackendError(reason)); }
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
          <span>{group === 'staged' ? t('git:status.stagedChanges') : t('git:status.changes')}</span><span className="git-group-count">{changes.length}</span>
        </button>
        <button className="btn-git-group-action" title={!repositoryRoot ? t('git:status.resolvingRoot') : group === 'staged' ? t('git:status.unstageAll') : t('git:status.stageAll')} aria-label={group === 'staged' ? t('git:status.unstageAll') : t('git:status.stageAll')} disabled={!repositoryRoot || actionsBlocked || allPaths.length === 0} onClick={() => void runFileAction(group === 'staged' ? 'unstage_git_files' : 'stage_git_files', allPaths)}>
          {group === 'staged' ? <Minus size={15} /> : <Plus size={15} />}
        </button>
      </div>
      {!isCollapsed && (changes.length === 0 ? <div className="git-group-empty">{group === 'staged' ? t('git:status.noStagedFiles') : t('git:status.noUnstagedFiles')}</div> : changes.map(change => {
        const parts = change.path.split('/');
        const name = parts.pop() || change.path;
        return <div key={`${group}:${change.path}`} className="git-change-row" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setFileMenu({ x: event.clientX, y: event.clientY, change, group }); }}>
          <span className={`git-status-badge git-status-${change.status}`}>{getBadgeText(change)}</span>
          <button className="git-change-open" title={!repositoryRoot ? t('git:status.resolvingRoot') : isImagePath(change.path) ? t('git:status.openImage') : t('git:status.openDiffInEditor')} disabled={!repositoryRoot || actionsBlocked} onClick={() => openDiff(change.path)}>
            <span className="git-file-name truncate">{name}</span>{parts.length > 0 && <span className="git-dir-path truncate">{parts.join('/')}</span>}
          </button>
          {onSelectFile && <button className="btn-git-row-action" title={!repositoryRoot ? t('git:status.resolvingRoot') : isImagePath(change.path) ? t('git:status.openImageTitle') : t('git:status.openFileInEditor')} aria-label={isImagePath(change.path) ? t('git:status.openImageAria', { path: change.path }) : t('git:status.openFileAria', { path: change.path })} disabled={!repositoryRoot || actionsBlocked} onClick={() => void openOriginal(change.path)}>{isImagePath(change.path) ? <ImageIcon size={14} /> : <FileCode2 size={14} />}</button>}
          <button className="btn-git-row-action git-stage-row-action" title={!repositoryRoot ? t('git:status.resolvingRoot') : group === 'staged' ? t('git:status.unstageChange') : t('git:status.stageChange')} aria-label={group === 'staged' ? t('git:status.unstageAria', { path: change.path }) : t('git:status.stageAria', { path: change.path })} disabled={!repositoryRoot || actionsBlocked} onClick={() => void runFileAction(group === 'staged' ? 'unstage_git_files' : 'stage_git_files', [change.path])}>{group === 'staged' ? <Minus size={14} /> : <Plus size={14} />}</button>
        </div>;
      }))}
    </div>;
  };

  const fileActions: ContextMenuAction[] = fileMenu ? [
    { label: isImagePath(fileMenu.change.path) ? t('git:status.openImageTitle') : t('git:status.openDiff'), onSelect: () => openDiff(fileMenu.change.path), disabled: !repositoryRoot || actionsBlocked },
    ...(!isImagePath(fileMenu.change.path) ? [{ label: t('git:status.openFile'), onSelect: () => { void openOriginal(fileMenu.change.path); }, disabled: !repositoryRoot || actionsBlocked }] : []),
    { label: fileMenu.group === 'staged' ? t('git:status.unstageChange') : t('git:status.stageChange'), onSelect: () => void runFileAction(fileMenu.group === 'staged' ? 'unstage_git_files' : 'stage_git_files', [fileMenu.change.path]), separatorBefore: true, disabled: !repositoryRoot || actionsBlocked },
  ] : [];
  const currentBranch = branches?.currentBranch || status?.branch || '';
  const branchActions: ContextMenuAction[] = (branches?.branches || []).map(branch => ({
    label: branch,
    checked: branch === currentBranch,
    onSelect: () => { if (branch !== currentBranch) void switchBranch(branch); },
    disabled: actionsBlocked || hasUnsavedChanges || branch === currentBranch,
  }));
  branchActions.push({ label: t('git:status.createBranch'), separatorBefore: true, onSelect: () => { setNewBranch(true); setBranchName(''); }, disabled: actionsBlocked });

  return <div className="git-status-view-container">
    <div className="git-status-view-header">
      <div className="git-header-left"><span className="git-view-title">{t('git:status.title')}</span></div>
      <div className="git-view-header-actions">
        {status?.isGitRepo && <button className={`btn-git-header-action ${refreshing ? 'animate-spin' : ''}`} onClick={() => void refresh(true)} title={t('git:status.refreshTitle')} disabled={refreshing || actionsBlocked}><RotateCw size={13} /></button>}
        {onClose && <button className="btn-git-header-action" onClick={onClose} title={t('git:status.closeTitle')}><X size={14} /></button>}
      </div>
    </div>
    {status?.isGitRepo && <div className="git-branch-controls">
      <button type="button" className="git-branch-menu-trigger" ref={branchTriggerRef} aria-label={t('git:status.currentBranchAria', { branch: currentBranch || t('git:status.unknownBranch') })} aria-haspopup="menu" aria-expanded={Boolean(branchMenu)} disabled={actionsBlocked || hasUnsavedChanges} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setBranchMenu(current => current ? null : { x: rect.left, y: rect.bottom }); }}>
        <GitBranch size={14} /><span>{status.detached ? t('git:status.detachedBranch', { branch: currentBranch }) : currentBranch || t('git:status.loadingBranch')}</span><ChevronDown size={13} />
      </button>
      {hasUnsavedChanges && <span className="git-branch-hint" title={t('git:status.unsavedTabsTitle')}>{t('git:status.unsavedTabs')}</span>}
    </div>}
    {newBranch && <form className="git-new-branch" onSubmit={event => { event.preventDefault(); void switchBranch(branchName, true); }}><input autoFocus value={branchName} onChange={event => setBranchName(event.target.value)} placeholder={t('git:status.newBranchPlaceholder')} aria-label={t('git:status.newBranchAria')} /><button type="submit" disabled={actionsBlocked || !branchName.trim()}>{t('common:actions.create')}</button><button type="button" onClick={() => { setNewBranch(false); setBranchName(''); }}>{t('common:actions.cancel')}</button></form>}
    <div className="git-status-view-body">
      {loading ? <div className="git-state-empty"><RotateCw size={20} className="animate-spin" /><p className="git-state-desc">{t('git:status.checkingStatus')}</p></div>
        : !projectRoot ? <div className="git-state-empty"><p className="git-state-title">{t('git:status.noProjectTitle')}</p><p className="git-state-desc">{t('git:status.noProjectDesc')}</p></div>
        : status?.error ? <div className="git-state-empty"><AlertCircle size={26} /><p className="git-state-title">{t('git:status.errorTitle')}</p><p className="git-state-desc">{translateBackendError(status.error)}</p><div className="git-state-actions"><button type="button" className="git-retry-btn" onClick={() => void refresh(true)}>{t('common:actions.retry')}</button></div>{error && <p className="git-onboarding-error" role="alert">{error}</p>}</div>
        : status && !status.gitAvailable ? <div className="git-state-empty"><AlertCircle size={28} /><p className="git-state-title">{t('git:status.gitNotInstalledTitle')}</p><p className="git-state-desc">{t('git:status.gitNotInstalledDesc')}</p><div className="git-state-actions"><button type="button" className="git-initialize-btn" onClick={() => void openGitDownloads()}><Download size={14} />{t('git:status.getGit')}</button><button type="button" className="git-secondary-btn" onClick={() => void refresh(true)}>{t('git:status.retryDetection')}</button></div>{error && <p className="git-onboarding-error" role="alert">{error}</p>}</div>
        : status && !status.isGitRepo ? <div className="git-state-empty"><GitBranch size={28} /><p className="git-state-title">{t('git:status.notRepoTitle')}</p><p className="git-state-desc">{t('git:status.notRepoDesc', { name: displayProjectName })}</p><p className="git-state-hint">{t('git:status.notRepoHint', { version: status.gitVersion?.replace(/^git version /, '') || t('git:status.gitReadyFallback') })}</p><div className="git-state-actions"><button type="button" className="git-initialize-btn" disabled={working} onClick={() => void confirmInitialize()}><GitBranch size={14} />{t('git:status.initializeGit')}</button></div>{error && <p className="git-onboarding-error" role="alert">{error}</p>}</div>
        : !status ? (error ? <div className="git-state-empty"><AlertCircle size={26} /><p className="git-state-title">{t('git:status.errorTitle')}</p><p className="git-onboarding-error" role="alert">{error}</p><div className="git-state-actions"><button type="button" className="git-secondary-btn" onClick={() => void refresh(true)}>{t('common:actions.retry')}</button></div></div> : null) : <div className="git-changes-panel">
          {projectRoot && <GitWorkflowControls key={projectRoot} projectRoot={projectRoot} hasUnsavedChanges={hasUnsavedChanges} disabled={working} onRefresh={() => refresh(true)} onBranchChanged={onBranchChanged} onRepositoryRootChange={reportRepositoryRoot} onWorktreeUpdateBusyChange={onWorktreeUpdateBusyChange} onOperationBusyChange={setWorkflowBusy} />}
          {workspaceRefreshError && <p className="git-workflow-error" role="alert">{t('git:status.workspaceRefreshError')}</p>}
          <div className="git-filter-wrapper"><Search size={13} className="git-filter-icon" /><input className="git-filter-input" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('git:status.filterPlaceholder')} />{query && <button className="git-filter-clear" onClick={() => setQuery('')} title={t('git:status.clearFilterTitle')}><X size={12} /></button>}</div>
          <div className="git-changes-list">
            {status.changes.length === 0 ? <div className="git-clean-state"><CheckCircle2 size={24} /><p className="git-state-title">{t('git:status.workingTreeClean')}</p></div> : filtered.length === 0 ? <div className="git-no-matches">{t('git:status.noMatchingFiles', { query })}</div> : <>{renderChanges(staged, 'staged')}{renderChanges(unstaged, 'changes')}</>}
          </div>
          {error && <p className="git-onboarding-error" role="alert">{error}</p>}
        </div>}
    </div>
    {branchMenu && <ContextMenu x={branchMenu.x} y={branchMenu.y} actions={branchActions} triggerRef={branchTriggerRef} onClose={() => setBranchMenu(null)} />}
    {fileMenu && <ContextMenu x={fileMenu.x} y={fileMenu.y} actions={fileActions} onClose={() => setFileMenu(null)} />}
  </div>;
};
