import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, GitCommitHorizontal, GitFork, LoaderCircle, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import { GitAccountStatus, GitOperationResult, GitProvider, GitProviderRepo, GitRepositoryInfo } from '../../types/git';
import { GitOperationKind, GitOperationFailure, useGitOperation } from '../../hooks/useGitOperation';
import { GitAccountSection } from './GitAccountSection';
import { GitProviderIcon } from './GitProviderIcon';
import { translateBackendError, translateGitOperationError, translateGitProgress } from '../../i18n/backendMessages';
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
  if (error && typeof error === 'object' && 'message' in error) {
    const item = error as GitOperationFailure;
    return {
      ...item,
      ...translateGitOperationError(item),
    };
  }
  return { code: 'git_operation_failed', message: translateBackendError(error), recovery: null, partialPath: null, outcomeUnknown: false };
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
  const { t } = useTranslation(['git', 'common']);
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
  const [gitAccounts, setGitAccounts] = useState<GitAccountStatus[]>([]);
  const [createRepoOpen, setCreateRepoOpen] = useState(false);
  const [createRepoProvider, setCreateRepoProvider] = useState<GitProvider>('github');
  const [createRepoName, setCreateRepoName] = useState('');
  const [createRepoDescription, setCreateRepoDescription] = useState('');
  const [createRepoPrivate, setCreateRepoPrivate] = useState(true);
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [createdRepoNotice, setCreatedRepoNotice] = useState<string | null>(null);
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
    setCreateRepoOpen(false);
    setCreateRepoName('');
    setCreateRepoDescription('');
    setCreateRepoPrivate(true);
    setCreatingRepo(false);
    setCreatedRepoNotice(null);
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

  useEffect(() => {
    let active = true;
    void invoke<GitAccountStatus[]>('get_git_accounts')
      .then(accounts => {
        if (active && mounted.current) setGitAccounts(accounts);
      })
      .catch(() => { /* Account status is optional in non-Tauri or unconfigured environments. */ });
    return () => { active = false; };
  }, []);

  const selectedRemote = useMemo(() => info?.remotes.find(remote => remote.name === selectedRemoteName), [info?.remotes, selectedRemoteName]);
  const selectedFetchUrl = selectedRemote?.fetchUrl || '';
  const isBlocked = disabled || running || worktreeUpdateBusy || creatingRepo;
  const dialogBusy = running || creatingRepo;
  const remoteOptions = info?.remotes || [];
  const signedInProviders = useMemo(() => gitAccounts.filter(account => account.signedIn), [gitAccounts]);
  const resolvedUpstreamRemote = info?.upstream && info.upstreamRemote && info.upstreamBranch
    ? info.remotes.find(remote => remote.name === info.upstreamRemote && remote.fetchUrl.trim().length > 0)
    : undefined;
  const canPushUpstream = Boolean(info?.upstream && resolvedUpstreamRemote && info?.upstreamBranch?.trim());
  const upstreamDisplay = info?.upstream || (info?.upstreamRemote && info?.upstreamBranch ? `${info.upstreamRemote}/${info.upstreamBranch}` : t('git:workflow.noUpstream'));

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
    setCreatedRepoNotice(null);
    setRepositoryDialogOpen(true);
    void refreshInfo();
  };
  const closeRepositoryDialog = () => {
    if (dialogBusy) return;
    setRepositoryDialogOpen(false);
    setRemoteFormMode(null);
    setCreateRepoOpen(false);
    setCreatedRepoNotice(null);
    window.setTimeout(() => returnFocus.current?.focus(), 0);
  };

  useEffect(() => {
    if (!repositoryDialogOpen) return;
    const dialog = dialogRef.current;
    if (!dialogWasOpen.current) {
      if (dialogBusy) dialog?.focus();
      else dialog?.querySelector<HTMLElement>('[data-dialog-autofocus]')?.focus();
    } else if (dialogBusy && (!dialog?.contains(document.activeElement) || (document.activeElement instanceof HTMLElement && document.activeElement.matches(':disabled')))) {
      dialog?.focus();
    }
    dialogWasOpen.current = true;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !dialogBusy) { event.stopPropagation(); closeRepositoryDialog(); }
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
  }, [repositoryDialogOpen, dialogBusy]);

  useEffect(() => { if (!repositoryDialogOpen) dialogWasOpen.current = false; }, [repositoryDialogOpen]);

  const handleAccountsChange = useCallback((nextAccounts: GitAccountStatus[]) => {
    setGitAccounts(nextAccounts);
    const activeSignedIn = nextAccounts.filter(account => account.signedIn);
    if (activeSignedIn.length === 0) {
      setCreateRepoOpen(false);
    } else if (!activeSignedIn.some(account => account.provider === createRepoProvider)) {
      setCreateRepoProvider(activeSignedIn[0].provider);
    }
  }, [createRepoProvider]);

  const beginAddRemote = () => {
    setCreateRepoOpen(false);
    setCreatedRepoNotice(null);
    setRemoteFormMode('add'); setRemoteName(remoteOptions.some(remote => remote.name === 'origin') ? '' : 'origin'); setRemoteUrl(''); setModalValidation(null);
  };
  const beginEditRemote = () => {
    if (!selectedRemote) return;
    setCreateRepoOpen(false);
    setCreatedRepoNotice(null);
    setRemoteFormMode('edit'); setRemoteName(selectedRemote.name); setRemoteUrl(selectedRemote.fetchUrl); setModalValidation(null);
  };

  const beginCreateRepository = (preferredProvider?: GitProvider) => {
    const chosenProvider = preferredProvider && signedInProviders.some(account => account.provider === preferredProvider)
      ? preferredProvider
      : signedInProviders[0]?.provider || 'github';
    const rootSegment = (info?.repositoryRoot || projectRoot).split(/[/\\]/).filter(Boolean).pop() || '';
    const defaultRepoName = rootSegment.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    setRemoteFormMode(null);
    setModalError(null);
    setModalValidation(null);
    setCreatedRepoNotice(null);
    setCreateRepoProvider(chosenProvider);
    setCreateRepoName(current => current.trim() ? current : defaultRepoName);
    setCreateRepoOpen(true);
  };

  const submitCreateRepository = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = createRepoName.trim();
    if (!trimmedName || isBlocked) return;
    const targetRoot = projectRoot;
    setCreatingRepo(true);
    setModalError(null);
    setCreatedRepoNotice(null);
    try {
      const created = await invoke<GitProviderRepo>('create_git_provider_repository', {
        provider: createRepoProvider,
        name: trimmedName,
        private: createRepoPrivate,
        description: createRepoDescription.trim() || null,
      });
      if (!mounted.current || rootRef.current !== targetRoot) return;
      setCreateRepoOpen(false);
      setCreateRepoName('');
      setCreateRepoDescription('');
      const hasOrigin = remoteOptions.some(remote => remote.name === 'origin');
      if (!hasOrigin) {
        try {
          await runOperation<unknown>('remote', 'set_git_remote', {
            projectPath: projectRoot,
            name: 'origin',
            url: created.cloneUrl,
          });
          if (!mounted.current || rootRef.current !== targetRoot) return;
          setSelectedRemoteName('origin');
          setCreatedRepoNotice(t('git:workflow.dialog.createdLinkedNotice', { name: created.fullName }));
          await refreshAll();
        } catch {
          if (!mounted.current || rootRef.current !== targetRoot) return;
          setRemoteFormMode('add');
          setRemoteName('origin');
          setRemoteUrl(created.cloneUrl);
          setCreatedRepoNotice(t('git:workflow.dialog.createdSaveOriginNotice', { name: created.fullName }));
        }
      } else {
        const fallbackName = remoteOptions.some(remote => remote.name === createRepoProvider) ? '' : createRepoProvider;
        setRemoteFormMode('add');
        setRemoteName(fallbackName);
        setRemoteUrl(created.cloneUrl);
        setCreatedRepoNotice(t('git:workflow.dialog.createdOriginExistsNotice', { name: created.fullName }));
      }
    } catch (reason) {
      if (!mounted.current || rootRef.current !== targetRoot) return;
      setModalError(asError(reason).message);
    } finally {
      if (mounted.current && rootRef.current === targetRoot) setCreatingRepo(false);
    }
  };

  const submitRemote = async (event: FormEvent) => {
    event.preventDefault();
    if (!remoteName.trim() || !remoteUrl.trim() || isBlocked) return;
    if (remoteFormMode === 'add' && remoteOptions.some(remote => remote.name === remoteName.trim())) {
      setModalValidation(t('git:workflow.dialog.duplicateRemoteError')); return;
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
    catch (reason) { setModalError(t('git:workflow.dialog.openBrowserFailed', { message: asError(reason).message })); }
  };

  const providerLabel = (provider: GitProvider) =>
    provider === 'github' ? t('git:providers.github') : t('git:providers.gitlab');

  const pullReason = hasUnsavedChanges ? t('git:workflow.reasons.pullUnsaved') : !info?.worktreeClean ? t('git:workflow.reasons.pullDirty') : !canPushUpstream ? t('git:workflow.reasons.pullNoUpstream') : info.detached ? t('git:workflow.reasons.pullDetached') : '';
  const commitReason = hasUnsavedChanges ? t('git:workflow.reasons.commitUnsaved') : !info?.identity.valid ? t('git:workflow.reasons.commitInvalidIdentity') : !info?.hasStagedChanges ? t('git:workflow.reasons.commitNoStaged') : info.detached ? t('git:workflow.reasons.commitDetached') : '';
  const pushReason = info?.pushRefreshRequired ? t('git:workflow.reasons.pushRefreshRequired') : info?.detached ? t('git:workflow.reasons.pushDetached') : !info?.hasCommits ? t('git:workflow.reasons.pushNoCommits') : !canPushUpstream ? t('git:workflow.reasons.pushNoUpstream') : '';
  const existingRemoteName = remoteFormMode === 'add' && remoteOptions.some(remote => remote.name === remoteName.trim());

  const createButtonLabel = signedInProviders.length === 1
    ? t('git:workflow.dialog.createOnProvider', { provider: providerLabel(signedInProviders[0].provider) })
    : t('git:workflow.dialog.createOnProviders');

  const repositoryDialog = repositoryDialogOpen ? createPortal(<div className="git-repository-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !dialogBusy) closeRepositoryDialog(); }}>
    <section ref={dialogRef} className="git-repository-dialog" role="dialog" aria-modal="true" aria-labelledby="git-repository-dialog-title" tabIndex={-1}>
      <header className="git-repository-dialog-header"><div><h2 id="git-repository-dialog-title">{t('git:workflow.dialog.title')}</h2><p title={safeRemoteLabel(info?.repositoryRoot || projectRoot)}>{info?.repositoryRoot || projectRoot}</p></div><button type="button" className="git-workflow-icon-button" aria-label={t('git:workflow.dialog.closeAria')} onClick={closeRepositoryDialog} disabled={dialogBusy}><X size={17} /></button></header>
      <div className="git-repository-dialog-body">
        {remoteOptions.length > 0 ? <>
          <div className="git-repository-remote-picker"><label htmlFor="git-repository-remote">{t('git:workflow.dialog.remoteLabel')}</label><select id="git-repository-remote" data-dialog-autofocus value={selectedRemoteName} onChange={event => { setSelectedRemoteName(event.target.value); setModalError(null); setModalValidation(null); }} disabled={isBlocked || remoteFormMode === 'edit'}>{remoteOptions.map(remote => <option key={remote.name} value={remote.name}>{remote.name}</option>)}</select>
            {selectedRemote && <div className="git-repository-remote-urls"><span title={safeRemoteLabel(selectedRemote.fetchUrl)}><GitProviderIcon provider={providerForRemoteUrl(selectedRemote.fetchUrl)} /> {t('git:workflow.dialog.fetchPrefix', { url: safeRemoteLabel(selectedRemote.fetchUrl) })}</span>{selectedRemote.pushUrl !== selectedRemote.fetchUrl && <span title={safeRemoteLabel(selectedRemote.pushUrl)}><GitProviderIcon provider={providerForRemoteUrl(selectedRemote.pushUrl)} /> {t('git:workflow.dialog.pushPrefix', { url: safeRemoteLabel(selectedRemote.pushUrl) })}</span>}</div>}
            <div className="git-repository-remote-actions">
              <button type="button" className="git-workflow-secondary" onClick={beginAddRemote} disabled={isBlocked}><Plus size={14} />{t('git:workflow.dialog.linkExistingRepo')}</button>
              <button type="button" className="git-workflow-secondary" onClick={beginEditRemote} disabled={isBlocked || !selectedRemote}>{t('git:workflow.dialog.editFetchUrl')}</button>
              {signedInProviders.length > 0 && <button type="button" className="git-workflow-secondary" onClick={() => beginCreateRepository()} disabled={isBlocked}><Plus size={14} />{createButtonLabel}</button>}
            </div>
          </div>
          {!canPushUpstream && <div className="git-repository-publish"><h3>{t('git:workflow.dialog.publishBranchHeading')}</h3><p>{t('git:workflow.dialog.publishBranchDesc')}</p><label htmlFor="git-publish-branch">{t('git:workflow.dialog.remoteBranchLabel')}</label><input id="git-publish-branch" value={pushBranch} onChange={event => { branchTouched.current = true; setPushBranch(event.target.value); }} placeholder={t('git:workflow.dialog.remoteBranchPlaceholder')} disabled={isBlocked} />
            <button type="button" className="git-workflow-primary" onClick={() => void runPush(selectedRemoteName, pushBranch.trim(), true)} disabled={isBlocked || !selectedRemoteName || !pushBranch.trim() || !info?.hasCommits || info?.pushRefreshRequired || info?.detached}><ArrowUpFromLine size={14} />{t('git:workflow.dialog.publishBranchAction')}</button>
            {!info?.hasCommits && <p className="git-workflow-disabled-reason">{t('git:workflow.dialog.publishNoCommits')}</p>}{info?.detached && <p className="git-workflow-disabled-reason">{t('git:workflow.dialog.publishDetached')}</p>}
          </div>}
          {canPushUpstream && <p className="git-repository-upstream-note">{t('git:workflow.dialog.tracksUpstreamPrefix')}<code>{info?.upstream}</code>{t('git:workflow.dialog.tracksUpstreamSuffix')}</p>}
        </> : <div className="git-repository-empty"><h3>{t('git:workflow.dialog.createRepoHeading')}</h3><p>{t('git:workflow.dialog.createRepoDesc')}</p>
          <div className="git-repository-provider-actions">
            {signedInProviders.length > 0 && <button type="button" className="git-workflow-primary" data-dialog-autofocus onClick={() => beginCreateRepository()} disabled={isBlocked}><Plus size={14} />{createButtonLabel}</button>}
            <button type="button" className="git-workflow-secondary" data-dialog-autofocus={signedInProviders.length === 0 ? true : undefined} onClick={beginAddRemote} disabled={isBlocked}><Plus size={14} />{t('git:workflow.dialog.linkExistingRepo')}</button>
            <a className="git-provider-icon-link" aria-label={t('git:workflow.dialog.createOnGithubAria')} title={t('git:workflow.dialog.createOnGithubAria')} aria-disabled={dialogBusy} tabIndex={dialogBusy ? -1 : 0} href="https://github.com/new" onClick={event => { event.preventDefault(); if (!dialogBusy) void openHelp('https://github.com/new'); }}><GitProviderIcon provider="github" /><ExternalLink size={13} /></a>
            <a className="git-provider-icon-link" aria-label={t('git:workflow.dialog.createOnGitlabAria')} title={t('git:workflow.dialog.createOnGitlabAria')} aria-disabled={dialogBusy} tabIndex={dialogBusy ? -1 : 0} href="https://gitlab.com/projects/new" onClick={event => { event.preventDefault(); if (!dialogBusy) void openHelp('https://gitlab.com/projects/new'); }}><GitProviderIcon provider="gitlab" /><ExternalLink size={13} /></a>
          </div>
          <p className="git-workflow-muted">{t('git:workflow.dialog.createRepoMuted')}</p>
        </div>}

        {createdRepoNotice && <div className="git-workflow-progress" role="status">{createdRepoNotice}</div>}

        {createRepoOpen && signedInProviders.length > 0 && <form className="git-repository-form" onSubmit={event => void submitCreateRepository(event)}>
          <h3>{createButtonLabel}</h3>
          {signedInProviders.length > 1 ? <>
            <label htmlFor="git-create-repo-provider">{t('git:workflow.dialog.providerLabel')}</label>
            <select id="git-create-repo-provider" value={createRepoProvider} onChange={event => setCreateRepoProvider(event.target.value as GitProvider)} disabled={isBlocked}>
              {signedInProviders.map(account => (
                <option key={account.provider} value={account.provider}>
                  {providerLabel(account.provider)}{account.username ? ` (@${account.username})` : ''}
                </option>
              ))}
            </select>
          </> : (
            <div className="git-repository-fixed-name">
              {t('git:workflow.dialog.accountLabel')} <GitProviderIcon provider={signedInProviders[0].provider} />{' '}
              <code>{signedInProviders[0].username ? `@${signedInProviders[0].username}` : signedInProviders[0].host}</code>
            </div>
          )}
          <label htmlFor="git-create-repo-name">{t('git:workflow.dialog.repoNameLabel')}</label>
          <input id="git-create-repo-name" value={createRepoName} onChange={event => setCreateRepoName(event.target.value)} placeholder={t('git:workflow.dialog.repoNamePlaceholder')} required disabled={isBlocked} autoComplete="off" />
          <label htmlFor="git-create-repo-description">{t('git:workflow.dialog.repoDescLabel')}</label>
          <input id="git-create-repo-description" value={createRepoDescription} onChange={event => setCreateRepoDescription(event.target.value)} placeholder={t('git:workflow.dialog.repoDescPlaceholder')} disabled={isBlocked} autoComplete="off" />
          <label className="git-repository-checkbox">
            <input type="checkbox" checked={createRepoPrivate} onChange={event => setCreateRepoPrivate(event.target.checked)} disabled={isBlocked} />
            <span>{t('git:workflow.dialog.privateRepo')}</span>
          </label>
          <div className="git-repository-form-actions">
            <button type="submit" className="git-workflow-primary" disabled={isBlocked || !createRepoName.trim()}>
              {creatingRepo ? <><LoaderCircle size={13} className="animate-spin" />{t('git:workflow.dialog.creating')}</> : t('git:workflow.dialog.createRepoHeading')}
            </button>
            <button type="button" className="git-workflow-quiet" onClick={() => setCreateRepoOpen(false)} disabled={dialogBusy}>{t('common:actions.cancel')}</button>
          </div>
        </form>}

        {remoteFormMode && <form className="git-repository-form" onSubmit={event => void submitRemote(event)}>
          <h3>{remoteFormMode === 'edit' ? t('git:workflow.dialog.editRemoteHeading', { name: selectedRemote?.name || t('git:workflow.dialog.remoteFallback') }) : t('git:workflow.dialog.linkExistingRepo')}</h3>
          {remoteFormMode === 'add' && <><label htmlFor="git-remote-name">{t('git:workflow.dialog.remoteNameLabel')}</label><input id="git-remote-name" value={remoteName} onChange={event => { setRemoteName(event.target.value); setModalValidation(null); }} placeholder={t('git:workflow.dialog.remoteNamePlaceholder')} required disabled={isBlocked} autoComplete="off" />{existingRemoteName && <p className="git-workflow-error" role="alert">{t('git:workflow.dialog.duplicateRemoteError')}</p>}</>}
          {remoteFormMode === 'edit' && <div className="git-repository-fixed-name">{t('git:workflow.dialog.remoteNameLabel')} <code>{remoteName}</code></div>}
          <label htmlFor="git-remote-url">{remoteFormMode === 'edit' ? t('git:workflow.dialog.fetchUrlLabel') : t('git:workflow.dialog.repositoryUrlLabel')}</label><input id="git-remote-url" value={remoteUrl} onChange={event => setRemoteUrl(event.target.value)} placeholder={t('git:workflow.dialog.remoteUrlPlaceholder')} required disabled={isBlocked} autoComplete="url" />
          {remoteFormMode === 'edit' && <p className="git-workflow-muted">{t('git:workflow.dialog.editFetchUrlNote')}</p>}
          {modalValidation && <p className="git-workflow-error" role="alert">{modalValidation}</p>}
          <div className="git-repository-form-actions"><button type="submit" className="git-workflow-primary" disabled={isBlocked || !remoteUrl.trim() || (remoteFormMode === 'add' && (!remoteName.trim() || existingRemoteName))}>{t('git:workflow.dialog.saveRemote')}</button><button type="button" className="git-workflow-quiet" onClick={() => setRemoteFormMode(null)} disabled={dialogBusy}>{t('common:actions.cancel')}</button></div>
        </form>}

        <GitAccountSection disabled={isBlocked} onAccountsChange={handleAccountsChange} />

        {info && <details className="git-repository-author" open={identityDetailsOpen || !info.identity.valid} onToggle={event => setIdentityDetailsOpen(event.currentTarget.open)}><summary tabIndex={dialogBusy ? -1 : undefined}>{t('git:workflow.dialog.gitAuthorSummary')}</summary><p>{info.identity.valid ? `${info.identity.name} <${info.identity.email}>` : t('git:workflow.dialog.invalidAuthor')}</p><p className="git-workflow-muted">{t('git:workflow.dialog.authorNote')}</p>
          {(!info.identity.valid || identityOpen) && <form className="git-repository-form" onSubmit={event => void submitIdentity(event)}>
            <label htmlFor="git-identity-name">{t('git:workflow.dialog.authorNameLabel')}</label><input id="git-identity-name" value={identityName} onChange={event => setIdentityName(event.target.value)} autoComplete="name" required disabled={isBlocked} />
            <label htmlFor="git-identity-email">{t('git:workflow.dialog.authorEmailLabel')}</label><input id="git-identity-email" type="email" value={identityEmail} onChange={event => setIdentityEmail(event.target.value)} autoComplete="email" required disabled={isBlocked} />
            <div className="git-repository-form-actions"><button type="submit" className="git-workflow-secondary" disabled={isBlocked || !identityName.trim() || !/^\S+@\S+\.\S+$/.test(identityEmail.trim())}>{t('git:workflow.dialog.saveAuthor')}</button>{info.identity.valid && <button type="button" className="git-workflow-quiet" onClick={() => setIdentityOpen(false)} disabled={dialogBusy}>{t('common:actions.cancel')}</button>}</div>
          </form>}{info.identity.valid && !identityOpen && <button type="button" className="git-workflow-quiet" onClick={() => setIdentityOpen(true)} disabled={isBlocked}>{t('git:workflow.dialog.editAuthor')}</button>}
        </details>}
        <nav className="git-repository-help" aria-label={t('git:workflow.dialog.credentialHelpAria')}><span>{t('git:workflow.dialog.credentialFallbackLabel')}</span><a href="https://docs.github.com/en/get-started/git-basics/caching-your-github-credentials-in-git" title={t('git:workflow.dialog.githubCredentialTitle')} aria-label={t('git:workflow.dialog.githubCredentialAria')} aria-disabled={dialogBusy} tabIndex={dialogBusy ? -1 : 0} onClick={event => { event.preventDefault(); if (!dialogBusy) void openHelp('https://docs.github.com/en/get-started/git-basics/caching-your-github-credentials-in-git'); }}><GitProviderIcon provider="github" /></a><a href="https://docs.gitlab.com/topics/git/clone/" title={t('git:workflow.dialog.gitlabCredentialTitle')} aria-label={t('git:workflow.dialog.gitlabCredentialAria')} aria-disabled={dialogBusy} tabIndex={dialogBusy ? -1 : 0} onClick={event => { event.preventDefault(); if (!dialogBusy) void openHelp('https://docs.gitlab.com/topics/git/clone/'); }}><GitProviderIcon provider="gitlab" /></a></nav>
        <p className="git-repository-muted">{t('git:workflow.dialog.credentialStoreNote')}</p>
        <div className="git-repository-modal-actions"><button type="button" className="git-workflow-secondary" onClick={() => void runFetch(selectedRemoteName)} disabled={isBlocked || !selectedRemoteName}><RefreshCw size={13} />{t('git:workflow.dialog.fetchSelectedRemote')}</button></div>
        {modalError && <div className="git-workflow-error" role="alert">{modalError}</div>}
        {infoError && <div className="git-workflow-error" role="alert">{infoError}</div>}
        {(running || progress) && <div className="git-workflow-progress" role="status" aria-live="polite"><LoaderCircle size={14} className="animate-spin" /><span>{progress ? translateGitProgress(progress) : t('git:workflow.startingOperation')}</span></div>}
        {error && <div className="git-workflow-error" role="alert"><strong>{error.message}</strong>{error.outcomeUnknown && <p>{t('git:workflow.outcomeUnknown')}</p>}{error.recovery && <p>{error.recovery}</p>}{error.partialPath && <p>{t('git:workflow.partialRemainsPrefix')}<code>{error.partialPath}</code></p>}</div>}
      </div>
      <footer className="git-repository-dialog-footer"><button type="button" className="git-workflow-quiet" onClick={() => void refreshInfo()} disabled={dialogBusy}><RefreshCw size={13} />{t('git:workflow.dialog.refreshStatus')}</button><button type="button" className="git-workflow-secondary" onClick={closeRepositoryDialog} disabled={dialogBusy}>{t('common:actions.done')}</button></footer>
    </section>
  </div>, document.body) : null;

  return <section className="git-workflow-controls" aria-label={t('git:workflow.sectionAria')}>
    {info && <>
      <div className="git-workflow-compact-summary">
        <div className="git-workflow-location"><GitFork size={13} /><span className="git-workflow-root" title={info.repositoryRoot}>{info.repositoryRoot}</span></div>
        <div className="git-workflow-branch-summary"><span className="git-workflow-upstream" title={upstreamDisplay}>{upstreamDisplay}</span><span className="git-workflow-counts" title={t('git:workflow.aheadBehindTitle')}>{info.ahead === null || info.behind === null ? '—' : `↑ ${info.ahead}  ↓ ${info.behind}`}</span></div>
      </div>
      <div className="git-workflow-toolbar" aria-label={t('git:workflow.toolbarAria')}>
        <button type="button" className="git-workflow-icon-button" aria-label={t('git:workflow.fetchFrom', { remote: selectedRemoteName || t('git:workflow.remoteFallback') })} title={t('git:workflow.fetchFrom', { remote: selectedRemoteName || t('git:workflow.remoteFallback') })} onClick={() => void runFetch()} disabled={isBlocked || !selectedRemoteName}><RefreshCw size={15} /></button>
        <button type="button" className="git-workflow-icon-button" aria-label={t('git:workflow.pullAria')} title={pullReason || t('git:workflow.pullDefaultTitle')} onClick={() => void runPull()} disabled={isBlocked || Boolean(pullReason)}><ArrowDownToLine size={15} /></button>
        <button type="button" className="git-workflow-icon-button" aria-label={canPushUpstream ? t('git:workflow.pushTo', { remote: info.upstreamRemote, branch: info.upstreamBranch }) : t('git:workflow.chooseDestination')} title={pushReason || t('git:workflow.pushDefaultTitle')} onClick={() => void runToolbarPush()} disabled={isBlocked || Boolean(info.pushRefreshRequired) || !info.hasCommits || info.detached}><ArrowUpFromLine size={15} /></button>
        <button type="button" className="git-workflow-icon-button git-workflow-settings-button" aria-label={t('git:workflow.repositorySettings')} title={t('git:workflow.repositorySettings')} onClick={openRepositoryDialog} disabled={isBlocked}><Settings2 size={15} /></button>
        {!info.identity.valid && <button type="button" className="git-workflow-author-cta" onClick={() => { setIdentityDetailsOpen(true); setIdentityOpen(true); openRepositoryDialog(); }} disabled={isBlocked}>{t('git:workflow.setGitAuthor')}</button>}
      </div>
      {selectedRemoteName && <div className="git-workflow-fetch-target"><span>{t('git:workflow.fetchRemote')}</span><select aria-label={t('git:workflow.fetchRemote')} value={selectedRemoteName} onChange={event => setSelectedRemoteName(event.target.value)} disabled={isBlocked}>{remoteOptions.map(remote => <option key={remote.name} value={remote.name}>{remote.name}</option>)}</select><span className="git-workflow-fetch-url" title={safeRemoteLabel(selectedFetchUrl)}>{safeRemoteLabel(selectedFetchUrl)}</span></div>}
      <form className="git-workflow-commit" onSubmit={event => void submitCommit(event)}>
        <label htmlFor="git-commit-message">{t('git:workflow.commitMessageLabel')}</label><textarea id="git-commit-message" value={commitMessage} onChange={event => setCommitMessage(event.target.value)} rows={2} placeholder={t('git:workflow.commitMessagePlaceholder')} disabled={isBlocked} />
        <div className="git-workflow-commit-footer"><span title={t('git:workflow.stagedAcrossRepoTitle')}>{t('git:workflow.stagedAcrossRepo')}</span><button type="submit" className="git-workflow-primary" title={commitReason || t('git:workflow.commitDefaultTitle')} disabled={isBlocked || !commitMessage.trim() || !info.identity.valid || !info.hasStagedChanges || hasUnsavedChanges || info.detached}><GitCommitHorizontal size={14} />{t('git:workflow.commit')}</button></div>
      </form>
    </>}
    {(running || progress) && <div className="git-workflow-progress" role="status" aria-live="polite"><LoaderCircle size={14} className="animate-spin" /><span>{progress ? translateGitProgress(progress) : t('git:workflow.startingOperation')}</span></div>}
    {infoError && <p className="git-workflow-error" role="alert">{infoError}</p>}
    {refreshProblem && <p className="git-workflow-error" role="alert">{t('git:workflow.refreshProblem')}</p>}
    {error && <div className="git-workflow-error" role="alert"><strong>{error.message}</strong>{error.outcomeUnknown && <p>{t('git:workflow.outcomeUnknown')}</p>}{error.recovery && <p>{error.recovery}</p>}{error.partialPath && <p>{t('git:workflow.partialRemainsPrefix')}<code>{error.partialPath}</code></p>}</div>}
    {hasUnsavedChanges && <p className="git-workflow-unsaved" role="status">{t('git:workflow.unsavedWarning')}</p>}
    {info?.detached && <p className="git-workflow-warning" role="status">{t('git:workflow.detachedWarning')}</p>}
    {pushReason && info?.pushRefreshRequired && <p className="git-workflow-warning" role="status">{pushReason}</p>}
    {repositoryDialog}
  </section>;
};
