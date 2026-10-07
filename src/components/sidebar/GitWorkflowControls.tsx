import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, GitCommitHorizontal, GitFork, LoaderCircle, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import { GitOperationResult, GitRepositoryInfo } from '../../types/git';
import { GitOperationKind, GitOperationFailure, useGitOperation } from '../../hooks/useGitOperation';
import { GitProviderIcon } from './GitProviderIcon';
import './gitWorkflows.css';

interface GitWorkflowControlsProps {
  projectRoot: string;
  hasUnsavedChanges: boolean;
  disabled?: boolean;
  onRefresh: () => Promise<void>;
  onBranchChanged?: () => Promise<void | boolean> | void | boolean;
  onRepositoryRootChange?: (root: string | null) => void;
  onWorktreeUpdateBusyChange?: (busy: boolean) => void;
  onOperationBusyChange?: (busy: boolean) => void;
}

const asError = (error: unknown): GitOperationFailure => {
  if (error && typeof error === 'object' && 'message' in error) return error as GitOperationFailure;
  return { code: 'git_operation_failed', message: String(error), recovery: null, partialPath: null, outcomeUnknown: false };
};

const safeRemoteLabel = (remoteUrl: string) => {
  try {
    const url = new URL(remoteUrl);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) if (/token|password|secret|auth|key/i.test(key)) url.searchParams.set(key, '[redacted]');
    return url.toString();
  } catch { return remoteUrl.replace(/(https?:\/\/)[^/@\s]+@/i, '$1[redacted]@'); }
};

const getRemoteHost = (remoteUrl: string) => {
  try { return new URL(remoteUrl).hostname.toLowerCase(); }
  catch { return remoteUrl.match(/^(?:[^@]+@)?([^:/]+):/)?.[1]?.toLowerCase() || ''; }
};
const providerForRemoteUrl = (remoteUrl: string): 'github' | 'gitlab' | 'git' => {
  const host = getRemoteHost(remoteUrl);
  return host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : 'git';
};

export const GitWorkflowControls: React.FC<GitWorkflowControlsProps> = ({ projectRoot, hasUnsavedChanges, disabled = false, onRefresh, onBranchChanged, onRepositoryRootChange, onWorktreeUpdateBusyChange, onOperationBusyChange }) => {
  const { running, progress, error, run, clearError } = useGitOperation(projectRoot);
  const [info, setInfo] = useState<GitRepositoryInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [selectedRemoteName, setSelectedRemoteName] = useState('');
  const [remoteName, setRemoteName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteFormMode, setRemoteFormMode] = useState<'add' | 'edit' | null>(null);
  const [identityName, setIdentityName] = useState('');
  const [identityEmail, setIdentityEmail] = useState('');
  const [identityOpen, setIdentityOpen] = useState(false);
  const [pushBranch, setPushBranch] = useState('');
  const [identityDetailsOpen, setIdentityDetailsOpen] = useState(false);
  const [worktreeUpdateBusy, setWorktreeUpdateBusy] = useState(false);
  const [refreshProblem, setRefreshProblem] = useState(false);
  const [repositoryDialogOpen, setRepositoryDialogOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalValidation, setModalValidation] = useState<string | null>(null);
  const rootRef = useRef(projectRoot);
  const mounted = useRef(true);
  const infoRequest = useRef(0);
  const branchDefaults = useRef('');
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogWasOpen = useRef(false);
  const dialogOpenRef = useRef(repositoryDialogOpen);
  const branchTouched = useRef(false);
  const busyCallbacks = useRef({ onOperationBusyChange, onWorktreeUpdateBusyChange });
  busyCallbacks.current = { onOperationBusyChange, onWorktreeUpdateBusyChange };
  rootRef.current = projectRoot;
  dialogOpenRef.current = repositoryDialogOpen;

  const refreshInfo = useCallback(async () => {
    const targetRoot = projectRoot;
    const request = ++infoRequest.current;
    try {
      const next = await invoke<GitRepositoryInfo>('get_git_repository_info', { projectPath: targetRoot });
      if (!mounted.current || rootRef.current !== targetRoot || request !== infoRequest.current) return;
      setInfo(next);
      onRepositoryRootChange?.(next.repositoryRoot);
      setInfoError(null);
      setIdentityName(current => current || next.identity.name || '');
      setIdentityEmail(current => current || next.identity.email || '');
      const preferredRemote = next.remotes.find(remote => remote.name === next.upstreamRemote)?.name || next.remotes.find(remote => remote.name === 'origin')?.name || next.remotes[0]?.name || '';
      setSelectedRemoteName(current => next.remotes.some(remote => remote.name === current) ? current : preferredRemote);
      const preferredBranch = next.upstreamBranch || next.branch || '';
      const branchKey = `${next.branch || ''}\u0000${next.upstream || ''}\u0000${next.upstreamBranch || ''}`;
      if (branchDefaults.current !== branchKey) {
        branchDefaults.current = branchKey;
        branchTouched.current = false;
        setPushBranch(preferredBranch);
      } else if (!branchTouched.current) setPushBranch(preferredBranch);
    } catch (reason) {
      if (mounted.current && rootRef.current === targetRoot && request === infoRequest.current) setInfoError(asError(reason).message);
    }
  }, [onRepositoryRootChange, projectRoot]);

  useEffect(() => {
    rootRef.current = projectRoot;
    infoRequest.current++;
    setInfo(null);
    onRepositoryRootChange?.(null);
    setInfoError(null);
    setCommitMessage('');
    setIdentityName('');
    setIdentityEmail('');
    setRepositoryDialogOpen(false);
    setModalError(null);
    setModalValidation(null);
    setRemoteFormMode(null);
    setIdentityOpen(false);
    setPushBranch('');
    setSelectedRemoteName('');
    branchDefaults.current = '';
    branchTouched.current = false;
    setIdentityDetailsOpen(false);
    clearError();
    void refreshInfo();
  }, [projectRoot, refreshInfo, clearError, onRepositoryRootChange]);

  useEffect(() => { onOperationBusyChange?.(running); }, [running, onOperationBusyChange]);
  useEffect(() => {
    const reload = () => { void refreshInfo(); };
    window.addEventListener('sciencebatch:git-status-changed', reload);
    return () => window.removeEventListener('sciencebatch:git-status-changed', reload);
  }, [refreshInfo]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      infoRequest.current++;
      busyCallbacks.current.onOperationBusyChange?.(false);
      if (dialogOpenRef.current) returnFocus.current?.focus();
    };
  }, []);

  const selectedRemote = useMemo(() => info?.remotes.find(remote => remote.name === selectedRemoteName), [info?.remotes, selectedRemoteName]);
  const selectedFetchUrl = selectedRemote?.fetchUrl || '';
  const isBlocked = disabled || running || worktreeUpdateBusy;
  const remoteOptions = info?.remotes || [];
  const resolvedUpstreamRemote = info?.upstream && info.upstreamRemote && info.upstreamBranch
    ? info.remotes.find(remote => remote.name === info.upstreamRemote && remote.fetchUrl.trim().length > 0)
    : undefined;
  const canPushUpstream = Boolean(info?.upstream && resolvedUpstreamRemote && info?.upstreamBranch?.trim());
  const upstreamDisplay = info?.upstream || (info?.upstreamRemote && info?.upstreamBranch ? `${info.upstreamRemote}/${info.upstreamBranch}` : 'No upstream');

  const refreshAll = useCallback(async () => { await onRefresh(); await refreshInfo(); }, [onRefresh, refreshInfo]);
  const runOperation = useCallback(async <T,>(kind: GitOperationKind, command: string, args: Record<string, unknown>, opts: { reportsProgress?: boolean } = {}) => {
    clearError();
    onOperationBusyChange?.(true);
    try { return await run<T>(kind, command, args, opts); }
    finally { onOperationBusyChange?.(false); }
  }, [clearError, onOperationBusyChange, run]);

  const submitCommit = async (event: FormEvent) => {
    event.preventDefault();
    if (!info || !commitMessage.trim() || !info.identity.valid || !info.hasStagedChanges || hasUnsavedChanges || info.detached || isBlocked) return;
    const targetRoot = projectRoot;
    try {
      await runOperation<GitOperationResult>('commit', 'commit_git_changes', { projectPath: projectRoot, message: commitMessage.trim() });
      if (!mounted.current || rootRef.current !== targetRoot) return;
      setCommitMessage('');
      await refreshAll();
    } catch { /* Preserve the message after a failed commit. */ }
  };

  const openRepositoryDialog = () => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setModalValidation(null);
    setRepositoryDialogOpen(true);
    void refreshInfo();
  };
  const closeRepositoryDialog = () => {
    if (running) return;
    setRepositoryDialogOpen(false);
    setRemoteFormMode(null);
    window.setTimeout(() => returnFocus.current?.focus(), 0);
  };

  useEffect(() => {
    if (!repositoryDialogOpen) return;
    const dialog = dialogRef.current;
    if (!dialogWasOpen.current) {
      if (running) dialog?.focus();
      else dialog?.querySelector<HTMLElement>('[data-dialog-autofocus]')?.focus();
    } else if (running && (!dialog?.contains(document.activeElement) || (document.activeElement instanceof HTMLElement && document.activeElement.matches(':disabled')))) {
      dialog?.focus();
    }
    dialogWasOpen.current = true;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) { event.stopPropagation(); closeRepositoryDialog(); }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]:not([aria-disabled="true"]), summary')].filter(el => el.tabIndex !== -1 && el.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement) || (document.activeElement instanceof HTMLElement && document.activeElement.matches(':disabled'))) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) dialog.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [repositoryDialogOpen, running]);

  useEffect(() => { if (!repositoryDialogOpen) dialogWasOpen.current = false; }, [repositoryDialogOpen]);

  const beginAddRemote = () => {
    setRemoteFormMode('add'); setRemoteName(remoteOptions.some(remote => remote.name === 'origin') ? '' : 'origin'); setRemoteUrl(''); setModalValidation(null);
  };
  const beginEditRemote = () => {
    if (!selectedRemote) return;
    setRemoteFormMode('edit'); setRemoteName(selectedRemote.name); setRemoteUrl(selectedRemote.fetchUrl); setModalValidation(null);
  };

  const submitRemote = async (event: FormEvent) => {
    event.preventDefault();
    if (!remoteName.trim() || !remoteUrl.trim() || isBlocked) return;
    if (remoteFormMode === 'add' && remoteOptions.some(remote => remote.name === remoteName.trim())) {
      setModalValidation('A remote with this name already exists. Edit it instead.'); return;
    }
    const targetRoot = projectRoot;
    try {
      await runOperation<unknown>('remote', 'set_git_remote', { projectPath: projectRoot, name: remoteName.trim(), url: remoteUrl.trim() });
      if (!mounted.current || rootRef.current !== targetRoot) return;
      setSelectedRemoteName(remoteName.trim());
      setRemoteFormMode(null);
      setModalValidation(null);
      await refreshAll();
    } catch { /* The entered URL remains available for correction. */ }
  };

  const submitIdentity = async (event: FormEvent) => {
    event.preventDefault();
    if (!identityName.trim() || !/^\S+@\S+\.\S+$/.test(identityEmail.trim()) || isBlocked) return;
    const targetRoot = projectRoot;
    try {
      await runOperation<unknown>('remote', 'set_git_identity', { projectPath: projectRoot, name: identityName.trim(), email: identityEmail.trim() }, { reportsProgress: false });
      if (!mounted.current || rootRef.current !== targetRoot) return;
      setIdentityOpen(false); await refreshInfo();
    } catch { /* Keep the values available for correction. */ }
  };

  const runFetch = async (remote = selectedRemoteName) => {
    if (!remote || isBlocked) return;
    const targetRoot = projectRoot;
    try {
      await runOperation<unknown>('fetch', 'fetch_git_remote', { projectPath: projectRoot, remote });
      if (!mounted.current || rootRef.current !== targetRoot) return;
      setModalError(null); await refreshAll();
    } catch { /* The shared operation error retains its structured recovery details. */ }
  };

  const runPull = async () => {
    if (!info?.upstream || !info.worktreeClean || hasUnsavedChanges || info.detached || isBlocked) return;
    const targetRoot = projectRoot;
    const reloadProject = onBranchChanged;
    setWorktreeUpdateBusy(true); onWorktreeUpdateBusyChange?.(true);
    try {
      try { await runOperation<unknown>('pull', 'pull_git_remote', { projectPath: projectRoot }); }
      catch { /* Reload even after Git reports failure in case the worktree changed before the failure. */ }
      let refreshFailed = false;
      try { const refreshed = reloadProject ? await reloadProject() : true; refreshFailed = refreshed === false; }
      catch { refreshFailed = true; }
      if (mounted.current && rootRef.current === targetRoot) { setRefreshProblem(refreshFailed); await refreshAll(); }
    } finally {
      if (mounted.current && rootRef.current === targetRoot) setWorktreeUpdateBusy(false);
      onWorktreeUpdateBusyChange?.(false);
    }
  };

  const runPush = async (remote = selectedRemoteName, branch = pushBranch.trim(), setUpstream = !canPushUpstream) => {
    if (!remote || !branch || isBlocked || info?.pushRefreshRequired || !info?.hasCommits || info?.detached) return;
    const targetRoot = projectRoot;
    try {
      await runOperation<unknown>('push', 'push_git_remote', { projectPath: projectRoot, remote, branch, setUpstream });
      if (!mounted.current || rootRef.current !== targetRoot) return;
      setModalError(null); await refreshAll();
    } catch (reason) {
      if (!mounted.current || rootRef.current !== targetRoot) return;
      if (asError(reason).outcomeUnknown) setInfo(current => current ? { ...current, pushRefreshRequired: true } : current);
      await refreshInfo();
    }
  };

  const runToolbarPush = async () => {
    if (info?.pushRefreshRequired || !info?.hasCommits || info?.detached || isBlocked) return;
    if (!canPushUpstream || !info?.upstreamRemote || !info.upstreamBranch?.trim()) { openRepositoryDialog(); return; }
    await runPush(info.upstreamRemote, info.upstreamBranch, false);
  };

  const openHelp = async (url: string) => {
    try { await invoke('open_external_url', { url }); }
    catch (reason) { setModalError(`Could not open the browser: ${asError(reason).message}`); }
  };

  const pullReason = hasUnsavedChanges ? 'Save or close tabs with unsaved changes before pulling.' : !info?.worktreeClean ? 'Pull requires a clean working tree, including staged changes.' : !canPushUpstream ? 'Set a valid remote upstream before pulling.' : info.detached ? 'Switch to a branch before pulling.' : '';
  const commitReason = hasUnsavedChanges ? 'Save or close tabs with unsaved changes before committing.' : !info?.identity.valid ? 'Set a valid Git author name and email.' : !info?.hasStagedChanges ? 'Stage at least one file to commit.' : info.detached ? 'Switch to a branch before committing.' : '';
  const pushReason = info?.pushRefreshRequired ? 'Fetch the remote before retrying; the previous push result may be uncertain.' : info?.detached ? 'Switch to a branch before pushing.' : !info?.hasCommits ? 'Create a commit before pushing.' : !canPushUpstream ? 'Choose a remote and branch in Repository settings.' : '';
  const existingRemoteName = remoteFormMode === 'add' && remoteOptions.some(remote => remote.name === remoteName.trim());

  const repositoryDialog = repositoryDialogOpen ? createPortal(<div className="git-repository-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !running) closeRepositoryDialog(); }}>
    <section ref={dialogRef} className="git-repository-dialog" role="dialog" aria-modal="true" aria-labelledby="git-repository-dialog-title" tabIndex={-1}>
      <header className="git-repository-dialog-header"><div><h2 id="git-repository-dialog-title">Repository</h2><p title={safeRemoteLabel(info?.repositoryRoot || projectRoot)}>{info?.repositoryRoot || projectRoot}</p></div><button type="button" className="git-workflow-icon-button" aria-label="Close Repository settings" onClick={closeRepositoryDialog} disabled={running}><X size={17} /></button></header>
      <div className="git-repository-dialog-body">
        {remoteOptions.length > 0 ? <>
          <div className="git-repository-remote-picker"><label htmlFor="git-repository-remote">Remote</label><select id="git-repository-remote" data-dialog-autofocus value={selectedRemoteName} onChange={event => { setSelectedRemoteName(event.target.value); setModalError(null); setModalValidation(null); }} disabled={isBlocked || remoteFormMode === 'edit'}>{remoteOptions.map(remote => <option key={remote.name} value={remote.name}>{remote.name}</option>)}</select>
            {selectedRemote && <div className="git-repository-remote-urls"><span title={safeRemoteLabel(selectedRemote.fetchUrl)}><GitProviderIcon provider={providerForRemoteUrl(selectedRemote.fetchUrl)} /> Fetch: {safeRemoteLabel(selectedRemote.fetchUrl)}</span>{selectedRemote.pushUrl !== selectedRemote.fetchUrl && <span title={safeRemoteLabel(selectedRemote.pushUrl)}><GitProviderIcon provider={providerForRemoteUrl(selectedRemote.pushUrl)} /> Push: {safeRemoteLabel(selectedRemote.pushUrl)}</span>}</div>}
            <div className="git-repository-remote-actions"><button type="button" className="git-workflow-secondary" onClick={beginAddRemote} disabled={isBlocked}><Plus size={14} />Link Existing Repository</button><button type="button" className="git-workflow-secondary" onClick={beginEditRemote} disabled={isBlocked || !selectedRemote}>Edit fetch URL</button></div>
          </div>
          {!canPushUpstream && <div className="git-repository-publish"><h3>Publish branch</h3><p>Choose the remote and destination branch. Publishing sets this local branch's upstream.</p><label htmlFor="git-publish-branch">Remote branch</label><input id="git-publish-branch" value={pushBranch} onChange={event => { branchTouched.current = true; setPushBranch(event.target.value); }} placeholder="Branch name" disabled={isBlocked} />
            <button type="button" className="git-workflow-primary" onClick={() => void runPush(selectedRemoteName, pushBranch.trim(), true)} disabled={isBlocked || !selectedRemoteName || !pushBranch.trim() || !info?.hasCommits || info?.pushRefreshRequired || info?.detached}><ArrowUpFromLine size={14} />Publish Branch</button>
            {!info?.hasCommits && <p className="git-workflow-disabled-reason">Create a commit before publishing.</p>}{info?.detached && <p className="git-workflow-disabled-reason">Switch to a branch before publishing.</p>}
          </div>}
          {canPushUpstream && <p className="git-repository-upstream-note">Current branch tracks <code>{info?.upstream}</code>. Push from the Source Control toolbar uses this configured destination.</p>}
        </> : <div className="git-repository-empty"><h3>Create Repository</h3><p>For an existing local history, first create an empty repository without a README, license, or .gitignore. Then paste its URL here and link it.</p>
          <div className="git-repository-provider-actions"><a className="git-provider-icon-link" aria-label="Create a repository on GitHub" title="Create a repository on GitHub" aria-disabled={running} tabIndex={running ? -1 : 0} href="https://github.com/new" onClick={event => { event.preventDefault(); if (!running) void openHelp('https://github.com/new'); }}><GitProviderIcon provider="github" /><ExternalLink size={13} /></a><a className="git-provider-icon-link" aria-label="Create a repository on GitLab" title="Create a repository on GitLab" aria-disabled={running} tabIndex={running ? -1 : 0} href="https://gitlab.com/projects/new" onClick={event => { event.preventDefault(); if (!running) void openHelp('https://gitlab.com/projects/new'); }}><GitProviderIcon provider="gitlab" /><ExternalLink size={13} /></a></div>
          <p className="git-workflow-muted">Create an empty project, then return here and paste its clone URL. ScienceBatch opens the provider website; it does not create accounts or repositories.</p>
          <button type="button" className="git-workflow-secondary" data-dialog-autofocus onClick={beginAddRemote} disabled={isBlocked}><Plus size={14} />Link Existing Repository</button>
        </div>}

        {remoteFormMode && <form className="git-repository-form" onSubmit={event => void submitRemote(event)}>
          <h3>{remoteFormMode === 'edit' ? `Edit ${selectedRemote?.name || 'remote'}` : 'Link Existing Repository'}</h3>
          {remoteFormMode === 'add' && <><label htmlFor="git-remote-name">Remote name</label><input id="git-remote-name" value={remoteName} onChange={event => { setRemoteName(event.target.value); setModalValidation(null); }} placeholder="origin" required disabled={isBlocked} autoComplete="off" />{existingRemoteName && <p className="git-workflow-error" role="alert">A remote with this name already exists. Edit it instead.</p>}</>}
          {remoteFormMode === 'edit' && <div className="git-repository-fixed-name">Remote name <code>{remoteName}</code></div>}
          <label htmlFor="git-remote-url">{remoteFormMode === 'edit' ? 'Fetch URL' : 'Repository URL'}</label><input id="git-remote-url" value={remoteUrl} onChange={event => setRemoteUrl(event.target.value)} placeholder="https://host/owner/repository.git or git@host:owner/repository.git" required disabled={isBlocked} autoComplete="url" />
          {remoteFormMode === 'edit' && <p className="git-workflow-muted">Saving changes the fetch URL. A separately configured push URL stays unchanged.</p>}
          {modalValidation && <p className="git-workflow-error" role="alert">{modalValidation}</p>}
          <div className="git-repository-form-actions"><button type="submit" className="git-workflow-primary" disabled={isBlocked || !remoteUrl.trim() || (remoteFormMode === 'add' && (!remoteName.trim() || existingRemoteName))}>Save remote</button><button type="button" className="git-workflow-quiet" onClick={() => setRemoteFormMode(null)} disabled={running}>Cancel</button></div>
        </form>}

        {info && <details className="git-repository-author" open={identityDetailsOpen || !info.identity.valid} onToggle={event => setIdentityDetailsOpen(event.currentTarget.open)}><summary tabIndex={running ? -1 : undefined}>Git author</summary><p>{info.identity.valid ? `${info.identity.name} <${info.identity.email}>` : 'A valid name and email are required to commit.'}</p><p className="git-workflow-muted">Author identity is separate from remote authentication. Changes here are saved to this repository only.</p>
          {(!info.identity.valid || identityOpen) && <form className="git-repository-form" onSubmit={event => void submitIdentity(event)}>
            <label htmlFor="git-identity-name">Author name</label><input id="git-identity-name" value={identityName} onChange={event => setIdentityName(event.target.value)} autoComplete="name" required disabled={isBlocked} />
            <label htmlFor="git-identity-email">Author email</label><input id="git-identity-email" type="email" value={identityEmail} onChange={event => setIdentityEmail(event.target.value)} autoComplete="email" required disabled={isBlocked} />
            <div className="git-repository-form-actions"><button type="submit" className="git-workflow-secondary" disabled={isBlocked || !identityName.trim() || !/^\S+@\S+\.\S+$/.test(identityEmail.trim())}>Save author</button>{info.identity.valid && <button type="button" className="git-workflow-quiet" onClick={() => setIdentityOpen(false)} disabled={running}>Cancel</button>}</div>
          </form>}{info.identity.valid && !identityOpen && <button type="button" className="git-workflow-quiet" onClick={() => setIdentityOpen(true)} disabled={isBlocked}>Edit author</button>}
        </details>}
        <nav className="git-repository-help" aria-label="Git credential help"><span>Use your system Git credentials or SSH key.</span><a href="https://docs.github.com/en/get-started/git-basics/caching-your-github-credentials-in-git" title="GitHub credential setup" aria-label="Open GitHub credential setup guide" aria-disabled={running} tabIndex={running ? -1 : 0} onClick={event => { event.preventDefault(); if (!running) void openHelp('https://docs.github.com/en/get-started/git-basics/caching-your-github-credentials-in-git'); }}><GitProviderIcon provider="github" /></a><a href="https://docs.gitlab.com/topics/git/clone/" title="GitLab SSH and clone setup" aria-label="Open GitLab SSH and clone setup guide" aria-disabled={running} tabIndex={running ? -1 : 0} onClick={event => { event.preventDefault(); if (!running) void openHelp('https://docs.gitlab.com/topics/git/clone/'); }}><GitProviderIcon provider="gitlab" /></a></nav>
        <p className="git-repository-muted">ScienceBatch does not store remote tokens. If Git requests credentials interactively, finish setup in your system Git credential manager or SSH configuration.</p>
        <div className="git-repository-modal-actions"><button type="button" className="git-workflow-secondary" onClick={() => void runFetch(selectedRemoteName)} disabled={isBlocked || !selectedRemoteName}><RefreshCw size={13} />Fetch selected remote</button></div>
        {modalError && <div className="git-workflow-error" role="alert">{modalError}</div>}
        {infoError && <div className="git-workflow-error" role="alert">{infoError}</div>}
        {(running || progress) && <div className="git-workflow-progress" role="status" aria-live="polite"><LoaderCircle size={14} className="animate-spin" /><span>{progress?.message || 'Starting Git operation…'}</span></div>}
        {error && <div className="git-workflow-error" role="alert"><strong>{error.message}</strong>{error.outcomeUnknown && <p>The remote may have received the push. Fetch from its push destination before retrying.</p>}{error.recovery && <p>{error.recovery}</p>}{error.partialPath && <p>Partial repository remains at: <code>{error.partialPath}</code></p>}</div>}
      </div>
      <footer className="git-repository-dialog-footer"><button type="button" className="git-workflow-quiet" onClick={() => void refreshInfo()} disabled={running}><RefreshCw size={13} />Refresh status</button><button type="button" className="git-workflow-secondary" onClick={closeRepositoryDialog} disabled={running}>Done</button></footer>
    </section>
  </div>, document.body) : null;

  return <section className="git-workflow-controls" aria-label="Git source control">
    {info && <>
      <div className="git-workflow-compact-summary">
        <div className="git-workflow-location"><GitFork size={13} /><span className="git-workflow-root" title={info.repositoryRoot}>{info.repositoryRoot}</span></div>
        <div className="git-workflow-branch-summary"><span className="git-workflow-upstream" title={upstreamDisplay}>{upstreamDisplay}</span><span className="git-workflow-counts" title="Ahead and behind counts reflect the last fetch.">{info.ahead === null || info.behind === null ? '—' : `↑ ${info.ahead}  ↓ ${info.behind}`}</span></div>
      </div>
      <div className="git-workflow-toolbar" aria-label="Repository actions">
        <button type="button" className="git-workflow-icon-button" aria-label={`Fetch from ${selectedRemoteName || 'remote'}`} title={`Fetch from ${selectedRemoteName || 'remote'}`} onClick={() => void runFetch()} disabled={isBlocked || !selectedRemoteName}><RefreshCw size={15} /></button>
        <button type="button" className="git-workflow-icon-button" aria-label="Pull from upstream" title={pullReason || 'Pull with fast-forward only'} onClick={() => void runPull()} disabled={isBlocked || Boolean(pullReason)}><ArrowDownToLine size={15} /></button>
        <button type="button" className="git-workflow-icon-button" aria-label={canPushUpstream ? `Push to ${info.upstreamRemote}/${info.upstreamBranch}` : 'Choose a repository destination'} title={pushReason || 'Push to configured upstream'} onClick={() => void runToolbarPush()} disabled={isBlocked || Boolean(info.pushRefreshRequired) || !info.hasCommits || info.detached}><ArrowUpFromLine size={15} /></button>
        <button type="button" className="git-workflow-icon-button git-workflow-settings-button" aria-label="Repository settings" title="Repository settings" onClick={openRepositoryDialog} disabled={isBlocked}><Settings2 size={15} /></button>
        {!info.identity.valid && <button type="button" className="git-workflow-author-cta" onClick={() => { setIdentityDetailsOpen(true); setIdentityOpen(true); openRepositoryDialog(); }} disabled={isBlocked}>Set Git author</button>}
      </div>
      {selectedRemoteName && <div className="git-workflow-fetch-target"><span>Fetch remote</span><select aria-label="Fetch remote" value={selectedRemoteName} onChange={event => setSelectedRemoteName(event.target.value)} disabled={isBlocked}>{remoteOptions.map(remote => <option key={remote.name} value={remote.name}>{remote.name}</option>)}</select><span className="git-workflow-fetch-url" title={safeRemoteLabel(selectedFetchUrl)}>{safeRemoteLabel(selectedFetchUrl)}</span></div>}
      <form className="git-workflow-commit" onSubmit={event => void submitCommit(event)}>
        <label htmlFor="git-commit-message">Commit message</label><textarea id="git-commit-message" value={commitMessage} onChange={event => setCommitMessage(event.target.value)} rows={2} placeholder="Describe the staged changes" disabled={isBlocked} />
        <div className="git-workflow-commit-footer"><span title="Commits include the full repository index, including staged files outside the opened subfolder.">Staged files across repository</span><button type="submit" className="git-workflow-primary" title={commitReason || 'Commit staged changes'} disabled={isBlocked || !commitMessage.trim() || !info.identity.valid || !info.hasStagedChanges || hasUnsavedChanges || info.detached}><GitCommitHorizontal size={14} />Commit</button></div>
      </form>
    </>}
    {(running || progress) && <div className="git-workflow-progress" role="status" aria-live="polite"><LoaderCircle size={14} className="animate-spin" /><span>{progress?.message || 'Starting Git operation…'}</span></div>}
    {infoError && <p className="git-workflow-error" role="alert">{infoError}</p>}
    {refreshProblem && <p className="git-workflow-error" role="alert">The project could not refresh after the Git operation. Close and reopen it to reload its files.</p>}
    {error && <div className="git-workflow-error" role="alert"><strong>{error.message}</strong>{error.outcomeUnknown && <p>The remote may have received the push. Fetch from its push destination before retrying.</p>}{error.recovery && <p>{error.recovery}</p>}{error.partialPath && <p>Partial repository remains at: <code>{error.partialPath}</code></p>}</div>}
    {hasUnsavedChanges && <p className="git-workflow-unsaved" role="status">Save or close modified tabs before committing or pulling.</p>}
    {info?.detached && <p className="git-workflow-warning" role="status">This repository is in detached HEAD state. Switch to a branch before committing or pulling.</p>}
    {pushReason && info?.pushRefreshRequired && <p className="git-workflow-warning" role="status">{pushReason}</p>}
    {repositoryDialog}
  </section>;
};
