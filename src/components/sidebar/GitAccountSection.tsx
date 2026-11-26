import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Copy, ExternalLink, KeyRound, LoaderCircle, LogOut, X } from 'lucide-react';
import type {
  GitAccountStatus,
  GitHubDeviceFlowStart,
  GitHubDevicePollResult,
  GitProvider,
} from '../../types/git';
import { GitProviderIcon } from './GitProviderIcon';
import './gitWorkflows.css';

interface GitAccountSectionProps {
  disabled?: boolean;
  compact?: boolean;
  onAccountsChange?: (accounts: GitAccountStatus[]) => void;
}

interface ActiveDeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAtMs: number;
  intervalSec: number;
  clientId: string | null;
  copied: boolean;
}

const PROVIDERS: GitProvider[] = ['github', 'gitlab'];

const STORAGE_KEYS: Record<GitProvider, string> = {
  github: 'sciencebatch:oauth-client-id:github',
  gitlab: 'sciencebatch:oauth-client-id:gitlab',
};

const PROVIDER_LABELS: Record<GitProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
};

const OAUTH_SETUP_NOTES: Record<GitProvider, string> = {
  github: 'Public GitHub OAuth App with Device Flow enabled (no client secret needed).',
  gitlab: 'Public GitLab Application with http://127.0.0.1/callback, PKCE enabled, and Confidential unchecked.',
};

const defaultAccount = (provider: GitProvider): GitAccountStatus => ({
  provider,
  signedIn: false,
  username: null,
  displayName: null,
  avatarUrl: null,
  host: provider === 'github' ? 'github.com' : 'gitlab.com',
  expiresAt: null,
  clientIdConfigured: false,
});

const normalizeAccounts = (list: GitAccountStatus[] | null | undefined): GitAccountStatus[] =>
  PROVIDERS.map(provider => list?.find(item => item.provider === provider) ?? defaultAccount(provider));

const readStoredClientId = (provider: GitProvider): string => {
  try {
    return window.localStorage.getItem(STORAGE_KEYS[provider])?.trim() || '';
  } catch {
    return '';
  }
};

const writeStoredClientId = (provider: GitProvider, value: string): string => {
  const trimmed = value.trim();
  try {
    if (trimmed) {
      window.localStorage.setItem(STORAGE_KEYS[provider], trimmed);
    } else {
      window.localStorage.removeItem(STORAGE_KEYS[provider]);
    }
  } catch {
    /* Ignore localStorage restrictions. */
  }
  return trimmed;
};

const extractErrorMessage = (reason: unknown, fallback: string): string => {
  if (typeof reason === 'string') {
    try {
      const parsed = JSON.parse(reason) as { message?: unknown };
      if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message;
    } catch {
      if (reason.trim()) return reason;
    }
  }
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
};

export const GitAccountSection: React.FC<GitAccountSectionProps> = ({
  disabled = false,
  compact = false,
  onAccountsChange,
}) => {
  const [accounts, setAccounts] = useState<GitAccountStatus[]>(() => normalizeAccounts(null));
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [busyProvider, setBusyProvider] = useState<GitProvider | null>(null);
  const [gitlabWaiting, setGitlabWaiting] = useState(false);
  const [activeDeviceFlow, setActiveDeviceFlow] = useState<ActiveDeviceFlow | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [clientIds, setClientIds] = useState<Record<GitProvider, string>>(() => ({
    github: readStoredClientId('github'),
    gitlab: readStoredClientId('gitlab'),
  }));
  const [draftClientIds, setDraftClientIds] = useState<Record<GitProvider, string>>(() => ({
    github: readStoredClientId('github'),
    gitlab: readStoredClientId('gitlab'),
  }));
  const [openClientConfig, setOpenClientConfig] = useState<Record<GitProvider, boolean>>({
    github: false,
    gitlab: false,
  });
  const [savedNotice, setSavedNotice] = useState<GitProvider | null>(null);

  const mountedRef = useRef(true);
  const pollTimerRef = useRef<number | null>(null);
  const flowSessionRef = useRef(0);
  const clientConfigTouchedRef = useRef<Record<GitProvider, boolean>>({ github: false, gitlab: false });
  const onAccountsChangeRef = useRef(onAccountsChange);
  onAccountsChangeRef.current = onAccountsChange;

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const applyAccounts = useCallback((next: GitAccountStatus[]) => {
    const normalized = normalizeAccounts(next);
    setAccounts(normalized);
    setOpenClientConfig(current => {
      const updated = { ...current };
      for (const account of normalized) {
        if (!clientConfigTouchedRef.current[account.provider]) {
          updated[account.provider] = !account.signedIn && !account.clientIdConfigured && !readStoredClientId(account.provider);
        }
      }
      return updated;
    });
    onAccountsChangeRef.current?.(normalized);
  }, []);

  const refreshAccounts = useCallback(async () => {
    try {
      const next = await invoke<GitAccountStatus[]>('get_git_accounts');
      if (!mountedRef.current) return;
      applyAccounts(next);
    } catch {
      if (!mountedRef.current) return;
      applyAccounts([]);
    } finally {
      if (mountedRef.current) setLoadingAccounts(false);
    }
  }, [applyAccounts]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshAccounts();
    return () => {
      mountedRef.current = false;
      flowSessionRef.current++;
      clearPollTimer();
    };
  }, [clearPollTimer, refreshAccounts]);

  const cancelActiveFlow = useCallback(() => {
    flowSessionRef.current++;
    clearPollTimer();
    setActiveDeviceFlow(null);
    setGitlabWaiting(false);
    setBusyProvider(null);
  }, [clearPollTimer]);

  const resolveClientIdForSignIn = (provider: GitProvider): string | null => {
    const draft = draftClientIds[provider].trim();
    if (draft && draft !== clientIds[provider]) {
      const persisted = writeStoredClientId(provider, draft);
      setClientIds(current => ({ ...current, [provider]: persisted }));
      return persisted || null;
    }
    return clientIds[provider] || draft || null;
  };

  const scheduleGitHubPoll = useCallback((
    session: number,
    deviceCode: string,
    clientId: string | null,
    delaySec: number,
    expiresAtMs: number,
  ) => {
    clearPollTimer();
    const waitMs = Math.max(delaySec, 1) * 1000;
    pollTimerRef.current = window.setTimeout(async () => {
      if (!mountedRef.current || flowSessionRef.current !== session) return;
      if (Date.now() >= expiresAtMs) {
        setActiveDeviceFlow(null);
        setBusyProvider(null);
        setAuthError('GitHub authorization code expired. Try signing in again.');
        return;
      }

      try {
        const result = await invoke<GitHubDevicePollResult>('poll_github_device_flow', {
          deviceCode,
          clientId,
        });
        if (!mountedRef.current || flowSessionRef.current !== session) return;

        if (result.status === 'authorized') {
          clearPollTimer();
          setActiveDeviceFlow(null);
          setBusyProvider(null);
          setAuthError(null);
          if (result.account) {
            setAccounts(current => {
              const merged = normalizeAccounts(
                current.map(item => (item.provider === 'github' ? result.account! : item)),
              );
              onAccountsChangeRef.current?.(merged);
              return merged;
            });
          }
          void refreshAccounts();
          return;
        }

        if (result.status === 'pending' || result.status === 'slow_down') {
          const fallbackDelay = result.status === 'slow_down' ? delaySec + 5 : delaySec;
          const nextDelay = Math.max(result.interval ?? fallbackDelay, result.status === 'slow_down' ? 5 : 1);
          setActiveDeviceFlow(current => (current ? { ...current, intervalSec: nextDelay } : current));
          scheduleGitHubPoll(session, deviceCode, clientId, nextDelay, expiresAtMs);
          return;
        }

        clearPollTimer();
        setActiveDeviceFlow(null);
        setBusyProvider(null);
        setAuthError(
          result.error ||
            (result.status === 'expired'
              ? 'GitHub authorization code expired. Try signing in again.'
              : 'GitHub authorization was denied.'),
        );
      } catch (reason) {
        if (!mountedRef.current || flowSessionRef.current !== session) return;
        clearPollTimer();
        setActiveDeviceFlow(null);
        setBusyProvider(null);
        setAuthError(extractErrorMessage(reason, 'GitHub sign-in polling failed.'));
      }
    }, waitMs);
  }, [clearPollTimer, refreshAccounts]);

  const startGitHubSignIn = async (account: GitAccountStatus) => {
    const effectiveClientId = resolveClientIdForSignIn('github');
    if (!account.clientIdConfigured && !effectiveClientId) {
      setOpenClientConfig(current => ({ ...current, github: true }));
      setAuthError('Enter a public GitHub OAuth App Client ID below before signing in.');
      return;
    }

    cancelActiveFlow();
    const session = ++flowSessionRef.current;
    setAuthError(null);
    setBusyProvider('github');

    try {
      const flow = await invoke<GitHubDeviceFlowStart>('start_github_device_flow', {
        clientId: effectiveClientId,
      });
      if (!mountedRef.current || flowSessionRef.current !== session) return;

      const intervalSec = Math.max(flow.interval || 5, 1);
      const expiresAtMs = Date.now() + Math.max(flow.expiresIn || 600, 30) * 1000;
      setActiveDeviceFlow({
        deviceCode: flow.deviceCode,
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        expiresAtMs,
        intervalSec,
        clientId: effectiveClientId,
        copied: false,
      });
      scheduleGitHubPoll(session, flow.deviceCode, effectiveClientId, intervalSec, expiresAtMs);
    } catch (reason) {
      if (!mountedRef.current || flowSessionRef.current !== session) return;
      setBusyProvider(null);
      setAuthError(extractErrorMessage(reason, 'Could not start GitHub sign-in.'));
    }
  };

  const copyCodeAndOpenGitHub = async () => {
    if (!activeDeviceFlow) return;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(activeDeviceFlow.userCode);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (mountedRef.current && copied) {
      setActiveDeviceFlow(current => (current ? { ...current, copied: true } : current));
    }
    try {
      await invoke('open_external_url', { url: activeDeviceFlow.verificationUri });
    } catch (reason) {
      if (mountedRef.current) {
        setAuthError(extractErrorMessage(reason, 'Could not open GitHub in your browser.'));
      }
    }
  };

  const startGitLabSignIn = async (account: GitAccountStatus) => {
    const effectiveClientId = resolveClientIdForSignIn('gitlab');
    if (!account.clientIdConfigured && !effectiveClientId) {
      setOpenClientConfig(current => ({ ...current, gitlab: true }));
      setAuthError('Enter a public GitLab Application Client ID below before signing in.');
      return;
    }

    cancelActiveFlow();
    const session = ++flowSessionRef.current;
    setAuthError(null);
    setBusyProvider('gitlab');
    setGitlabWaiting(true);

    try {
      const signedAccount = await invoke<GitAccountStatus>('start_gitlab_pkce_flow', {
        clientId: effectiveClientId,
      });
      if (!mountedRef.current || flowSessionRef.current !== session) return;
      setGitlabWaiting(false);
      setBusyProvider(null);
      setAccounts(current => {
        const merged = normalizeAccounts(
          current.map(item => (item.provider === 'gitlab' ? signedAccount : item)),
        );
        onAccountsChangeRef.current?.(merged);
        return merged;
      });
      void refreshAccounts();
    } catch (reason) {
      if (!mountedRef.current || flowSessionRef.current !== session) return;
      setGitlabWaiting(false);
      setBusyProvider(null);
      setAuthError(extractErrorMessage(reason, 'GitLab sign-in failed.'));
    }
  };

  const handleSignOut = async (provider: GitProvider) => {
    cancelActiveFlow();
    setAuthError(null);
    setBusyProvider(provider);
    try {
      await invoke('sign_out_git_account', { provider });
      if (!mountedRef.current) return;
      setAccounts(current => {
        const updated = normalizeAccounts(
          current.map(item =>
            item.provider === provider
              ? { ...defaultAccount(provider), host: item.host, clientIdConfigured: item.clientIdConfigured }
              : item,
          ),
        );
        onAccountsChangeRef.current?.(updated);
        return updated;
      });
      void refreshAccounts();
    } catch (reason) {
      if (!mountedRef.current) return;
      setAuthError(extractErrorMessage(reason, `Could not sign out of ${PROVIDER_LABELS[provider]}.`));
    } finally {
      if (mountedRef.current) setBusyProvider(null);
    }
  };

  const handleSaveClientId = (provider: GitProvider) => {
    const saved = writeStoredClientId(provider, draftClientIds[provider]);
    setClientIds(current => ({ ...current, [provider]: saved }));
    setDraftClientIds(current => ({ ...current, [provider]: saved }));
    setSavedNotice(provider);
    setAuthError(null);
  };

  const handleClearClientId = (provider: GitProvider) => {
    writeStoredClientId(provider, '');
    setClientIds(current => ({ ...current, [provider]: '' }));
    setDraftClientIds(current => ({ ...current, [provider]: '' }));
    setSavedNotice(null);
  };

  const signedInAccounts = accounts.filter(account => account.signedIn);

  if (compact) {
    if (!signedInAccounts.length) return null;
    return (
      <div className="git-accounts-compact" aria-label="Connected Git accounts">
        {signedInAccounts.map(account => {
          const handle = account.username ? `@${account.username}` : account.displayName || account.host;
          return (
            <span
              key={account.provider}
              className="git-accounts-compact-pill"
              title={`${PROVIDER_LABELS[account.provider]} signed in as ${handle}`}
            >
              <GitProviderIcon provider={account.provider} />
              <span>{handle}</span>
            </span>
          );
        })}
      </div>
    );
  }

  const flowBusy = Boolean(busyProvider) || Boolean(activeDeviceFlow) || gitlabWaiting;

  return (
    <section className="git-accounts-section" aria-label="Git accounts">
      <div className="git-accounts-header">
        <h3>Accounts</h3>
        {loadingAccounts && <LoaderCircle size={13} className="animate-spin" aria-label="Loading Git accounts" />}
      </div>

      <div className="git-accounts-list">
        {accounts.map(account => {
          const label = PROVIDER_LABELS[account.provider];
          const hasStoredClientId = Boolean(clientIds[account.provider]);
          const showClientConfig = openClientConfig[account.provider];
          const accountHandle = account.username
            ? `@${account.username}`
            : account.displayName || account.host;

          return (
            <div key={account.provider} className="git-account-card">
              <div className="git-account-row">
                <div className="git-account-identity">
                  <GitProviderIcon provider={account.provider} />
                  <div className="git-account-meta">
                    <span className="git-account-provider">{label}</span>
                    <span className="git-account-status-text">
                      {account.signedIn ? accountHandle : 'Not signed in'}
                    </span>
                  </div>
                </div>

                {account.signedIn ? (
                  <button
                    type="button"
                    className="git-workflow-quiet"
                    onClick={() => void handleSignOut(account.provider)}
                    disabled={disabled || flowBusy}
                  >
                    <LogOut size={12} />
                    {busyProvider === account.provider ? 'Signing out…' : 'Sign out'}
                  </button>
                ) : account.provider === 'github' ? (
                  activeDeviceFlow ? (
                    <button
                      type="button"
                      className="git-workflow-quiet"
                      onClick={cancelActiveFlow}
                      disabled={disabled}
                    >
                      <X size={12} />
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="git-workflow-secondary"
                      onClick={() => void startGitHubSignIn(account)}
                      disabled={disabled || flowBusy}
                    >
                      <GitProviderIcon provider="github" />
                      {busyProvider === 'github' ? 'Starting…' : 'Sign in with GitHub'}
                    </button>
                  )
                ) : gitlabWaiting ? (
                  <button
                    type="button"
                    className="git-workflow-quiet"
                    onClick={cancelActiveFlow}
                    disabled={disabled}
                  >
                    <X size={12} />
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    className="git-workflow-secondary"
                    onClick={() => void startGitLabSignIn(account)}
                    disabled={disabled || flowBusy}
                  >
                    <GitProviderIcon provider="gitlab" />
                    {busyProvider === 'gitlab' ? 'Waiting…' : 'Sign in with GitLab'}
                  </button>
                )}
              </div>

              {account.provider === 'github' && activeDeviceFlow && (
                <div className="git-account-device-flow" role="status" aria-live="polite">
                  <p>Enter this one-time code on GitHub to authorize ScienceBatch:</p>
                  <div className="git-account-code-row">
                    <code className="git-account-user-code">{activeDeviceFlow.userCode}</code>
                    <button
                      type="button"
                      className="git-workflow-primary"
                      onClick={() => void copyCodeAndOpenGitHub()}
                      disabled={disabled}
                    >
                      {activeDeviceFlow.copied ? <Check size={12} /> : <Copy size={12} />}
                      <span>Copy Code &amp; Open GitHub</span>
                      <ExternalLink size={11} />
                    </button>
                  </div>
                  <span className="git-account-polling-note">
                    <LoaderCircle size={12} className="animate-spin" />
                    Waiting for GitHub authorization (checking every {activeDeviceFlow.intervalSec}s)…
                  </span>
                </div>
              )}

              {account.provider === 'gitlab' && gitlabWaiting && (
                <div className="git-account-waiting" role="status" aria-live="polite">
                  <LoaderCircle size={12} className="animate-spin" />
                  <span>Waiting for GitLab sign-in in your browser…</span>
                </div>
              )}

              {!account.signedIn && (
                <details
                  className="git-account-client-config"
                  open={showClientConfig}
                  onToggle={event => {
                    const isOpen = event.currentTarget.open;
                    clientConfigTouchedRef.current[account.provider] = true;
                    setOpenClientConfig(current => ({ ...current, [account.provider]: isOpen }));
                  }}
                >
                  <summary tabIndex={disabled ? -1 : undefined}>
                    <KeyRound size={11} />
                    <span>OAuth App Client ID</span>
                    {(account.clientIdConfigured || hasStoredClientId) && (
                      <span className="git-account-configured-badge">
                        {hasStoredClientId ? 'Custom saved' : 'Built-in'}
                      </span>
                    )}
                  </summary>
                  <div className="git-account-client-body">
                    <p className="git-workflow-muted">{OAUTH_SETUP_NOTES[account.provider]}</p>
                    <div className="git-account-client-row">
                      <input
                        type="text"
                        aria-label={`${label} OAuth App Client ID`}
                        value={draftClientIds[account.provider]}
                        onChange={event => {
                          const value = event.target.value;
                          setDraftClientIds(current => ({ ...current, [account.provider]: value }));
                          if (savedNotice === account.provider) setSavedNotice(null);
                        }}
                        placeholder={account.clientIdConfigured ? 'Optional override Client ID' : `Paste ${label} public Client ID`}
                        disabled={disabled || flowBusy}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="git-workflow-secondary"
                        onClick={() => handleSaveClientId(account.provider)}
                        disabled={disabled || flowBusy || draftClientIds[account.provider].trim() === clientIds[account.provider]}
                      >
                        Save
                      </button>
                      {hasStoredClientId && (
                        <button
                          type="button"
                          className="git-workflow-quiet"
                          onClick={() => handleClearClientId(account.provider)}
                          disabled={disabled || flowBusy}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    {savedNotice === account.provider && (
                      <span className="git-account-saved-note">Client ID saved locally (public identifier only).</span>
                    )}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>

      {authError && (
        <div className="git-workflow-error" role="alert">
          {authError}
        </div>
      )}
    </section>
  );
};
