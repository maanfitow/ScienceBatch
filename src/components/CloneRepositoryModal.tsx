import React, { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Folder, GitBranch, LoaderCircle, Lock, RefreshCw, Search, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import type {
  GitAccountStatus,
  GitOperationError,
  GitOperationProgressPayload,
  GitProvider,
  GitProviderRepo,
} from '../types/git';
import { GitAccountSection } from './sidebar/GitAccountSection';
import { GitProviderIcon } from './sidebar/GitProviderIcon';
import { translateBackendError, translateGitProgress } from '../i18n/backendMessages';
import './cloneRepository.css';

interface CloneRepositoryModalProps {
  isOpen: boolean;
  running: boolean;
  progress: GitOperationProgressPayload | null;
  error: GitOperationError | null;
  onClose: () => void;
  onOpenExisting: (path: string) => Promise<boolean>;
  onClone: (url: string, parentDir: string, directoryName: string) => Promise<void>;
}

const safeMessage = (value: string) => value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@');

export const CloneRepositoryModal: React.FC<CloneRepositoryModalProps> = ({
  isOpen,
  running,
  progress,
  error,
  onClose,
  onOpenExisting,
  onClone,
}) => {
  const { t } = useTranslation(['git', 'common']);
  const [url, setUrl] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [directoryName, setDirectoryName] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openFailurePath, setOpenFailurePath] = useState<string | null>(null);
  const [signedInAccounts, setSignedInAccounts] = useState<GitAccountStatus[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<GitProvider | null>(null);
  const [reposByProvider, setReposByProvider] = useState<Partial<Record<GitProvider, GitProviderRepo[]>>>({});
  const [loadingProvider, setLoadingProvider] = useState<GitProvider | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [repoFilter, setRepoFilter] = useState('');
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const repoRequestIdRef = useRef(0);
  const busy = running || isSubmitting;

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => urlInputRef.current?.focus());
    return () => previousFocusRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      repoRequestIdRef.current++;
      setSelectedProvider(null);
      setReposByProvider({});
      setLoadingProvider(null);
      setProviderError(null);
      setRepoFilter('');
      setAccountsExpanded(false);
      return;
    }

    let active = true;
    void invoke<GitAccountStatus[]>('get_git_accounts')
      .then(accounts => {
        if (!active) return;
        setSignedInAccounts(accounts.filter(account => account.signedIn));
      })
      .catch(() => {
        if (!active) return;
        setSignedInAccounts([]);
      });
    return () => {
      active = false;
      repoRequestIdRef.current++;
    };
  }, [isOpen]);

  const activeRepos = useMemo(
    () => (selectedProvider ? reposByProvider[selectedProvider] ?? [] : []),
    [reposByProvider, selectedProvider],
  );

  const filteredRepos = useMemo(() => {
    const query = repoFilter.trim().toLowerCase();
    if (!query) return activeRepos;
    return activeRepos.filter(repo =>
      repo.fullName.toLowerCase().includes(query) || repo.name.toLowerCase().includes(query),
    );
  }, [activeRepos, repoFilter]);

  useEffect(() => {
    if (!isOpen || busy) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, busy, onClose]);

  useEffect(() => {
    if (isOpen && busy) dialogRef.current?.focus();
  }, [isOpen, busy]);

  if (!isOpen) return null;

  const providerLabel = (provider: GitProvider) =>
    provider === 'github' ? t('git:providers.github') : t('git:providers.gitlab');

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: t('git:clone.selectParentDialogTitle') });
      if (selected && typeof selected === 'string') setParentDir(selected);
    } catch {
      setSubmitError(t('git:clone.errors.folderPickerFailed'));
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    if (busy) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter(element => !element.hasAttribute('aria-hidden'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || openFailurePath) return;
    const normalizedName = directoryName.trim();
    if (!url.trim() || !parentDir.trim() || !normalizedName) return;
    if (normalizedName === '.' || normalizedName === '..' || /[/\\]/.test(normalizedName)) {
      setSubmitError(t('git:clone.errors.invalidFolderName'));
      return;
    }
    setSubmitError(null);
    setOpenFailurePath(null);
    setIsSubmitting(true);
    try {
      await onClone(url.trim(), parentDir.trim(), normalizedName);
      onClose();
    } catch (reason) {
      const path = reason && typeof reason === 'object' && 'projectPath' in reason && typeof reason.projectPath === 'string'
        ? reason.projectPath
        : null;
      if (path) setOpenFailurePath(path);
      setSubmitError(t('git:clone.errors.cloneFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenExisting = async () => {
    if (!openFailurePath || busy) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const opened = await onOpenExisting(openFailurePath);
      if (opened) onClose();
      else setSubmitError(t('git:clone.errors.openClonedFailed'));
    } catch {
      setSubmitError(t('git:clone.errors.openClonedFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const loadProviderRepositories = async (provider: GitProvider, forceRefresh = false) => {
    if (!forceRefresh && selectedProvider === provider && reposByProvider[provider]) {
      setSelectedProvider(null);
      setProviderError(null);
      return;
    }

    setSelectedProvider(provider);
    setProviderError(null);
    setRepoFilter('');

    if (!forceRefresh && reposByProvider[provider]) {
      return;
    }

    const requestId = ++repoRequestIdRef.current;
    setLoadingProvider(provider);
    try {
      const repos = await invoke<GitProviderRepo[]>('list_git_provider_repositories', { provider });
      if (requestId !== repoRequestIdRef.current) return;
      setReposByProvider(current => ({ ...current, [provider]: repos }));
    } catch (reason) {
      if (requestId !== repoRequestIdRef.current) return;
      const fallback = t('git:clone.errors.loadProviderReposFailed', { provider: providerLabel(provider) });
      const rawMessage = reason && typeof reason === 'object' && 'message' in reason && typeof reason.message === 'string'
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : fallback;
      setProviderError(safeMessage(translateBackendError(rawMessage, null, fallback)));
    } finally {
      if (requestId === repoRequestIdRef.current) {
        setLoadingProvider(null);
      }
    }
  };

  const handleAccountsChange = (nextAccounts: GitAccountStatus[]) => {
    const active = nextAccounts.filter(account => account.signedIn);
    setSignedInAccounts(active);
    if (selectedProvider && !active.some(account => account.provider === selectedProvider)) {
      setSelectedProvider(null);
      setProviderError(null);
    }
  };

  const handleSelectRepo = (repo: GitProviderRepo) => {
    setUrl(repo.cloneUrl);
    setDirectoryName(current => (current.trim() ? current : repo.name));
    setSubmitError(null);
  };

  const safeError = error ? safeMessage(error.message) : null;
  const safeRecovery = error?.recovery ? safeMessage(error.recovery) : null;

  return (
    <div className="modal-overlay clone-repository-overlay" onClick={() => { if (!busy) onClose(); }}>
      <div
        className="modal-card clone-repository-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clone-repository-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={event => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <GitBranch size={18} className="modal-title-icon" />
            <h3 id="clone-repository-title">{t('git:clone.title')}</h3>
          </div>
          <button className="btn-modal-close" type="button" aria-label={t('git:clone.closeAria')} disabled={busy} onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body clone-repository-body">
            <div className="clone-repository-intro-row">
              <p className="clone-repository-help">{t('git:clone.intro')}</p>
              <button
                type="button"
                className="clone-repository-manage-accounts"
                aria-expanded={accountsExpanded}
                disabled={busy}
                onClick={() => setAccountsExpanded(current => !current)}
              >
                {accountsExpanded
                  ? t('git:clone.hideAccounts')
                  : signedInAccounts.length > 0
                    ? t('git:clone.manageAccounts')
                    : t('git:clone.signInPrompt')}
              </button>
            </div>

            {accountsExpanded && (
              <GitAccountSection disabled={busy} onAccountsChange={handleAccountsChange} />
            )}

            {signedInAccounts.length > 0 && (
              <div className="modal-field clone-repository-accounts">
                <div className="clone-repository-accounts-header">
                  <span className="modal-label">{t('git:clone.yourRepositories')}</span>
                  <div className="clone-repository-account-buttons">
                    {signedInAccounts.map(account => {
                      const isActive = selectedProvider === account.provider;
                      const label = providerLabel(account.provider);
                      const handle = account.username ? `@${account.username}` : label;
                      return (
                        <button
                          key={account.provider}
                          type="button"
                          className={`clone-repository-account-button${isActive ? ' is-active' : ''}`}
                          onClick={() => void loadProviderRepositories(account.provider)}
                          disabled={busy}
                          aria-expanded={isActive}
                        >
                          <GitProviderIcon provider={account.provider} />
                          <span>{label}</span>
                          <span className="clone-repository-account-handle">{handle}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {selectedProvider && (
                  <div className="clone-repository-picker">
                    <div className="clone-repository-picker-bar">
                      <div className="clone-repository-filter-wrap">
                        <Search size={13} aria-hidden="true" />
                        <input
                          type="text"
                          className="clone-repository-filter-input"
                          value={repoFilter}
                          onChange={event => setRepoFilter(event.target.value)}
                          placeholder={t('git:clone.filterPlaceholder', { provider: providerLabel(selectedProvider) })}
                          aria-label={t('git:clone.filterAria')}
                          disabled={busy}
                        />
                      </div>
                      <button
                        type="button"
                        className="clone-repository-refresh"
                        onClick={() => void loadProviderRepositories(selectedProvider, true)}
                        disabled={busy || loadingProvider === selectedProvider}
                        title={t('git:clone.refreshTitle')}
                        aria-label={t('git:clone.refreshTitle')}
                      >
                        <RefreshCw size={13} className={loadingProvider === selectedProvider ? 'spin' : undefined} />
                      </button>
                    </div>

                    {loadingProvider === selectedProvider && (
                      <div className="clone-repository-picker-status" role="status">
                        <LoaderCircle size={13} className="spin" />
                        <span>{t('git:clone.loadingRepositories')}</span>
                      </div>
                    )}

                    {providerError && (
                      <div className="clone-repository-error" role="alert">{providerError}</div>
                    )}

                    {loadingProvider !== selectedProvider && !providerError && (
                      filteredRepos.length > 0 ? (
                        <div className="clone-repository-list" role="listbox" aria-label={t('git:clone.availableRepositoriesAria')}>
                          {filteredRepos.map(repo => {
                            const selected = url.trim() === repo.cloneUrl;
                            return (
                              <button
                                key={repo.id}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                className={`clone-repository-item${selected ? ' is-selected' : ''}`}
                                onClick={() => handleSelectRepo(repo)}
                                disabled={busy}
                              >
                                <span className="clone-repository-item-name" title={repo.fullName}>{repo.fullName}</span>
                                <span className="clone-repository-item-meta">
                                  {repo.private && (
                                    <span className="clone-repository-private-badge" title={t('git:clone.privateRepoTitle')}>
                                      <Lock size={10} aria-hidden="true" /> {t('git:clone.privateBadge')}
                                    </span>
                                  )}
                                  {repo.defaultBranch && <span>{repo.defaultBranch}</span>}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="clone-repository-picker-empty">
                          {repoFilter.trim() ? t('git:clone.noMatchingRepos') : t('git:clone.noAccountRepos')}
                        </p>
                      )
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="modal-field">
              <label className="modal-label" htmlFor="clone-repository-url">{t('git:clone.repositoryUrlLabel')}</label>
              <input
                ref={urlInputRef}
                id="clone-repository-url"
                className="modal-input"
                value={url}
                onChange={event => setUrl(event.target.value)}
                placeholder={t('git:clone.repositoryUrlPlaceholder')}
                autoComplete="url"
                required
                disabled={busy}
              />
            </div>

            <div className="modal-field">
              <label className="modal-label" htmlFor="clone-repository-parent">{t('git:clone.parentFolderLabel')}</label>
              <div className="clone-repository-folder-row">
                <input
                  id="clone-repository-parent"
                  className="modal-input folder-path-input truncate"
                  value={parentDir}
                  onChange={event => setParentDir(event.target.value)}
                  placeholder={t('git:clone.parentFolderPlaceholder')}
                  required
                  disabled={busy}
                />
                <button className="clone-repository-browse" type="button" onClick={handleBrowse} disabled={busy} aria-label={t('git:clone.browseAria')}>
                  <Folder size={15} /> {t('git:clone.browse')}
                </button>
              </div>
            </div>

            <div className="modal-field">
              <label className="modal-label" htmlFor="clone-repository-name">{t('git:clone.newFolderNameLabel')}</label>
              <input
                id="clone-repository-name"
                className="modal-input"
                value={directoryName}
                onChange={event => setDirectoryName(event.target.value)}
                placeholder={t('git:clone.newFolderNamePlaceholder')}
                required
                disabled={busy}
              />
              <span className="clone-repository-hint">{t('git:clone.destinationHint')}</span>
            </div>

            {busy && (
              <div className="clone-repository-progress" role="status" aria-live="polite">
                <LoaderCircle size={15} className="spin" />
                <span>{running ? safeMessage(progress ? translateGitProgress(progress) : t('git:clone.startingClone')) : t('git:clone.openingProject')}</span>
              </div>
            )}
            {(submitError || safeError) && (
              <div className="clone-repository-error" role="alert">
                {openFailurePath ? t('git:clone.errors.clonedButOpenFailed') : safeError || submitError}
              </div>
            )}
            {error?.partialPath && (
              <div className="clone-repository-recovery">
                {t('git:clone.partialRetainedPrefix')}
                <code>{error.partialPath}</code>
                {t('git:clone.partialRetainedSuffix')}
                {safeRecovery && <span>{safeRecovery}</span>}
              </div>
            )}
            {openFailurePath && (
              <div className="clone-repository-recovery">
                {t('git:clone.clonedRetainedPrefix')}
                <code>{openFailurePath}</code>
                {t('git:clone.clonedRetainedSuffix')}
                <button type="button" className="clone-repository-open-existing" disabled={busy} onClick={() => void handleOpenExisting()}>{t('git:clone.openExisting')}</button>
              </div>
            )}
            {safeRecovery && !error?.partialPath && <div className="clone-repository-recovery">{safeRecovery}</div>}
          </div>

          <div className="modal-footer clone-repository-footer">
            <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>{t('common:actions.cancel')}</button>
            <button type="submit" className="btn-primary" disabled={busy || !!openFailurePath || !url.trim() || !parentDir.trim() || !directoryName.trim()}>
              {running ? t('git:clone.cloning') : busy ? t('git:clone.opening') : t('git:clone.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
