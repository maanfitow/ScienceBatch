import i18n from './index';
import type { DiagnosticItem, ProgressPayload } from '../types';
import type { GitOperationError, GitOperationProgressPayload } from '../types/git';

export type BackendParams = Record<string, string | number>;

export type CodedGitOperationProgressPayload = GitOperationProgressPayload & {
  code?: string | null;
  params?: BackendParams | null;
};

const NAMESPACED_PREFIX_RE = /^([a-z][a-z0-9_]*\.[a-z][a-z0-9_.-]*):\s*(.*)$/s;

/** Redacts userinfo credentials embedded in URLs before displaying backend messages. */
export function redactSensitiveUrls(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@');
}

function splitPrefixedCode(raw: string): { code: string | null; message: string } {
  let currentCode: string | null = null;
  let currentMessage = raw.trim();

  for (let depth = 0; depth < 3; depth += 1) {
    const match = NAMESPACED_PREFIX_RE.exec(currentMessage);
    if (!match) break;
    currentCode = match[1];
    currentMessage = match[2].trim();
  }

  return { code: currentCode, message: currentMessage };
}

function extractRawErrorInfo(reason: unknown, fallback = ''): { code: string | null; message: string } {
  if (typeof reason === 'string') {
    const trimmed = reason.trim();
    if (!trimmed) return { code: null, message: fallback };
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return extractRawErrorInfo(parsed, fallback);
      }
    } catch {
      // Treat plain string as a direct or prefixed error message.
    }
    return splitPrefixedCode(trimmed);
  }

  if (reason instanceof Error) {
    return splitPrefixedCode(reason.message || fallback);
  }

  if (reason && typeof reason === 'object') {
    const record = reason as Record<string, unknown>;
    const nested = record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : record;
    const rawCode = typeof nested.code === 'string'
      ? nested.code
      : typeof record.code === 'string'
        ? record.code
        : null;
    const rawMsg = typeof nested.message === 'string'
      ? nested.message
      : typeof record.message === 'string'
        ? record.message
        : fallback;
    const parsed = splitPrefixedCode(rawMsg);
    return {
      code: rawCode ?? parsed.code,
      message: parsed.message || rawMsg || fallback,
    };
  }

  const text = reason == null ? '' : String(reason).trim();
  return text ? splitPrefixedCode(text) : { code: null, message: fallback };
}

function localizeEngineLabel(engine: string | number | undefined): string {
  const normalized = String(engine ?? '').trim().toLowerCase();
  if (normalized === 'typst') return i18n.t('common:engines.typst');
  if (normalized === 'latex') return i18n.t('common:engines.latex');
  return String(engine ?? '');
}

function localizeWorkspaceStatus(status: string | number | undefined): string {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (normalized === 'finished' || normalized === 'completed') {
    return i18n.t('editor:compilerProgress.workspaceFinishedStatuses.finished');
  }
  if (normalized === 'cancelled') {
    return i18n.t('editor:compilerProgress.workspaceFinishedStatuses.cancelled');
  }
  if (normalized === 'error') {
    return i18n.t('editor:compilerProgress.workspaceFinishedStatuses.error');
  }
  return String(status ?? '');
}

/** Translates a backend DiagnosticItem suggestion using its structured suggestion_code when available. */
export function translateDiagnosticSuggestion(
  item: Pick<DiagnosticItem, 'suggestion' | 'suggestion_code' | 'suggestion_params'>,
): string | null {
  const code = item.suggestion_code?.trim();
  if (code) {
    const key = `editor:suggestions.${code}`;
    if (i18n.exists(key)) {
      return i18n.t(key as never, {
        lb: '{',
        rb: '}',
        ...(item.suggestion_params ?? {}),
      } as never) as unknown as string;
    }
  }
  return item.suggestion ?? null;
}

/** Translates a Rust compilation ProgressPayload (or workspace progress payload) into the active UI language. */
export function translateCompilerProgress(
  payload: Pick<ProgressPayload, 'status' | 'message' | 'code' | 'params'> & { jobId?: string },
): string {
  const code = payload.code?.trim();
  if (code) {
    const key = `editor:compilerProgress.${code}`;
    if (i18n.exists(key)) {
      const params: BackendParams = { ...(payload.params ?? {}) };
      if ('engine' in params) {
        params.engine = localizeEngineLabel(params.engine);
      }
      if (code === 'compiler.workspace_finished' && 'status' in params) {
        params.status = localizeWorkspaceStatus(params.status);
      }
      if ((code === 'compiler.workspace_started' || code === 'compiler.workspace_finished') && params.jobId == null && payload.jobId) {
        params.jobId = payload.jobId;
      }
      return i18n.t(key as never, params as never) as unknown as string;
    }
  }

  const rawMessage = payload.message ?? '';
  if (NAMESPACED_PREFIX_RE.test(rawMessage)) {
    return translateBackendError(rawMessage);
  }

  const startingMatch = /^Starting in-memory (latex|typst) compiler\.\.\.$/i.exec(rawMessage);
  if (startingMatch) {
    return i18n.t('editor:compilerProgress.compiler.starting', {
      engine: localizeEngineLabel(startingMatch[1]),
    });
  }

  const compilingMatch = /^Compiling (latex|typst) document in RAM \(job ([^)]+)\)\.\.\.$/i.exec(rawMessage);
  if (compilingMatch) {
    return i18n.t('editor:compilerProgress.compiler.compiling', {
      engine: localizeEngineLabel(compilingMatch[1]),
      jobId: compilingMatch[2],
    });
  }

  if (rawMessage === 'PDF generated successfully.') {
    return i18n.t('editor:compilerProgress.compiler.completed');
  }
  if (rawMessage === 'Compilation reported errors.') {
    return i18n.t('editor:compilerProgress.compiler.error');
  }
  if (rawMessage === 'Compilation cancelled.') {
    return i18n.t('editor:compilerProgress.compiler.cancelled');
  }

  const wsStartedMatch = /^Compiling current workspace snapshot \(([^)]+)\)$/.exec(rawMessage);
  if (wsStartedMatch) {
    return i18n.t('editor:compilerProgress.compiler.workspace_started', {
      jobId: wsStartedMatch[1],
    });
  }

  const wsFinishedMatch = /^Workspace compilation (finished|cancelled|error) \(([^)]+)\)$/i.exec(rawMessage);
  if (wsFinishedMatch) {
    return i18n.t('editor:compilerProgress.compiler.workspace_finished', {
      status: localizeWorkspaceStatus(wsFinishedMatch[1]),
      jobId: wsFinishedMatch[2],
    });
  }

  return rawMessage;
}

/** Translates a GitOperationProgressPayload into the active UI language, keeping raw Git lines intact. */
export function translateGitProgress(
  payload: Pick<CodedGitOperationProgressPayload, 'status' | 'message' | 'code' | 'params'>,
): string {
  const code = payload.code?.trim();
  if (code === 'git.operation_starting' || payload.message === 'Starting Git operation.') {
    return i18n.t('errors:backend.gitProgress.operation_starting');
  }
  if (code === 'git.operation_completed' || payload.message === 'Git operation completed.') {
    return i18n.t('errors:backend.gitProgress.operation_completed');
  }
  if (payload.status === 'failed') {
    return redactSensitiveUrls(translateBackendError(payload.message));
  }
  return redactSensitiveUrls(payload.message);
}

const EXACT_RAW_MESSAGE_KEYS: Record<string, string> = {
  'Invalid update endpoint URL.': 'errors:backend.codes.updates.invalid_endpoint',
  'Update endpoint HTTPS URL is missing a host.': 'errors:backend.codes.updates.missing_host',
  'GitHub release response is missing tag_name.': 'errors:backend.codes.updates.missing_tag',
  'Update response exceeded the 512 KiB size limit.': 'errors:backend.codes.updates.response_too_large',
  'GitHub device_code cannot be empty.': 'errors:backend.codes.git_auth.missing_device_code',
  'GitLab sign-in timed out after 180 seconds waiting for browser callback.': 'errors:backend.codes.git_auth.callback_timeout',
  'GitLab OAuth callback failed state verification.': 'errors:backend.codes.git_auth.state_mismatch',
  'GitLab OAuth callback did not include an authorization code.': 'errors:backend.codes.git_auth.missing_code',
  'Repository name cannot be empty.': 'errors:backend.codes.git_auth.empty_repo_name',
  'Path traverses above filesystem root.': 'errors:backend.codes.files.path_traversal',
  'Project root must be non-empty and cannot contain NUL bytes.': 'errors:backend.codes.files.empty_path',
  'Target path must be non-empty and cannot contain NUL bytes.': 'errors:backend.codes.files.empty_path',
  'File paths must be non-empty and cannot contain NUL bytes.': 'errors:backend.codes.files.empty_path',
  'Path must be non-empty and cannot contain NUL bytes.': 'errors:backend.codes.files.empty_path',
  'Invalid file name': 'errors:backend.codes.files.invalid_file_name',
  'Project name must be a single safe folder name of at most 100 characters.': 'errors:backend.codes.files.invalid_project_name',
  'Engine must be latex or typst.': 'errors:backend.codes.files.unsupported_engine',
  'Cannot create a file at the project root path.': 'errors:backend.codes.files.cannot_create_at_root',
  'Cannot rename or overwrite the project root directory.': 'errors:backend.codes.files.cannot_rename_root',
  'Cannot move a directory into a subdirectory of itself.': 'errors:backend.codes.files.cannot_move_into_self',
  'Cannot delete the project root directory.': 'errors:backend.codes.files.cannot_delete_root',
  'Cannot duplicate or overwrite the project root directory.': 'errors:backend.codes.files.cannot_duplicate_root',
  'Cannot duplicate a directory into a subdirectory of itself.': 'errors:backend.codes.files.cannot_duplicate_into_self',
  'Project is not a Git repository.': 'errors:backend.codes.git.not_a_repo',
  'Project is not a Git repository': 'errors:backend.codes.git.not_a_repo',
  'Branch name is invalid.': 'errors:backend.codes.git.invalid_branch',
  'Git could not list local branches.': 'errors:backend.codes.git.branch_list_failed',
  'File path cannot be empty': 'errors:backend.codes.git.empty_file_path',
  'Absolute paths are not allowed': 'errors:backend.codes.git.absolute_path_not_allowed',
  "Parent directory traversal ('..') is not allowed": 'errors:backend.codes.git.parent_traversal_not_allowed',
  'Path escapes project directory via symlink': 'errors:backend.codes.git.path_escapes_repo',
  'Path escapes project directory': 'errors:backend.codes.git.path_escapes_repo',
  'Project directory does not exist or is not a directory': 'errors:backend.codes.git.not_a_repo',
  'The application is shutting down': 'errors:backend.codes.operation.shutting_down',
  'Compilation was cancelled': 'errors:backend.codes.operation.interrupted',
  'Workspace compilation was cancelled.': 'errors:backend.codes.operation.interrupted',
  'The selected engine does not match the workspace main file.': 'errors:backend.codes.project.main_engine_mismatch',
  'This document requests an external bibliography tool such as Biber. ScienceBatch supports in-memory BibTeX; use backend=bibtex or provide a compatible bibliography workflow.': 'errors:backend.codes.dependency.external_tool_unsupported',
};

function translateByNamespacedCode(code: string, englishBody: string): string | null {
  // Never replace embedded raw git stderr with a generic translation that hides details.
  if (code === 'git.failed' || code === 'git.command_failed') {
    if (/^Git .+ failed:\s+.+$/s.test(englishBody)) {
      return null;
    }
  }

  if (code === 'updates.http_error') {
    const match = /^Update server returned HTTP (\d+) \(([^)]+)\)\.?$/.exec(englishBody);
    if (match) {
      return i18n.t('errors:backend.codes.updates.http_error_detailed', {
        status: match[1],
        reason: match[2],
      });
    }
  }

  if (code === 'updates.unsupported_endpoint') {
    const match = /^Unsupported update endpoint protocol or host:\s*(.+)$/.exec(englishBody);
    if (match) {
      return i18n.t('errors:backend.codes.updates.unsupported_endpoint_detailed', {
        endpoint: match[1],
      });
    }
  }

  if (code === 'git_auth.unsupported_provider') {
    const match = /^Unsupported Git provider '([^']+)'/.exec(englishBody);
    if (match) {
      return i18n.t('errors:backend.codes.git_auth.unsupported_provider_detailed', {
        provider: match[1],
      });
    }
  }

  if (code === 'git.unknown_remote') {
    const match = /^Git remote '([^']+)' does not exist\.?$/.exec(englishBody);
    if (match) {
      return i18n.t('errors:backend.codes.git.unknown_remote_detailed', {
        remote: match[1],
      });
    }
  }

  const key = `errors:backend.codes.${code}`;
  if (i18n.exists(key)) {
    return i18n.t(key as never) as unknown as string;
  }

  return null;
}

/**
 * Translates backend `"ns.code: English message"` strings and structured error objects.
 * Falls back cleanly to the raw English message when unknown or when raw stderr is embedded.
 */
export function translateBackendError(reason: unknown, explicitCode?: string | null, fallback = ''): string {
  const extracted = extractRawErrorInfo(reason, fallback);
  const code = explicitCode?.trim() || extracted.code;
  const englishBody = extracted.message;

  if (code) {
    const mapped = translateByNamespacedCode(code, englishBody);
    if (mapped !== null) {
      return redactSensitiveUrls(mapped);
    }
  }

  const exactKey = EXACT_RAW_MESSAGE_KEYS[englishBody];
  if (exactKey && i18n.exists(exactKey)) {
    return redactSensitiveUrls(i18n.t(exactKey as never) as unknown as string);
  }

  const httpMatch = /^Update server returned HTTP (\d+) \(([^)]+)\)\.?$/.exec(englishBody);
  if (httpMatch) {
    return i18n.t('errors:backend.codes.updates.http_error_detailed', {
      status: httpMatch[1],
      reason: httpMatch[2],
    });
  }

  const endpointMatch = /^Unsupported update endpoint protocol or host:\s*(.+)$/.exec(englishBody);
  if (endpointMatch) {
    return i18n.t('errors:backend.codes.updates.unsupported_endpoint_detailed', {
      endpoint: endpointMatch[1],
    });
  }

  return redactSensitiveUrls(englishBody || fallback);
}

const GIT_RECOVERY_KEYS: Record<string, string> = {
  'Wait for it to finish, then refresh the repository status.': 'errors:backend.gitRecovery.busy',
  'Configure OpenSSH as the Git SSH command or use a credential manager.': 'errors:backend.gitRecovery.unsupportedSshCommand',
  'The remote may have received the push. Run Fetch to reconcile repository status before retrying.': 'errors:backend.gitRecovery.timeoutUnknownPush',
  'Retry after checking repository and network status.': 'errors:backend.gitRecovery.timeout',
  'Resolve the history with Git outside ScienceBatch, then fetch and retry.': 'errors:backend.gitRecovery.diverged',
  'Configure an HTTPS credential manager or SSH keys and known hosts outside ScienceBatch, then retry.': 'errors:backend.gitRecovery.authenticationFailed',
  'Check the repository status and configured credentials, then retry.': 'errors:backend.gitRecovery.gitFailed',
  'Switch to a branch before committing.': 'errors:backend.gitRecovery.detachedHeadCommit',
  'Switch to a branch with an upstream before pulling.': 'errors:backend.gitRecovery.detachedHeadPull',
  'Switch to a local branch before publishing commits.': 'errors:backend.gitRecovery.detachedHeadPush',
  'Complete or abort the active operation in Git before committing.': 'errors:backend.gitRecovery.operationInProgressCommit',
  'Complete or abort the active operation in Git before pulling.': 'errors:backend.gitRecovery.operationInProgressPull',
  'Configure valid name and email values in this repository.': 'errors:backend.gitRecovery.invalidIdentity',
  'Stage the files you want to include, then try again.': 'errors:backend.gitRecovery.nothingStaged',
  'Use an HTTPS credential manager or configure SSH authentication outside ScienceBatch.': 'errors:backend.gitRecovery.credentialsInUrl',
  'Commit or discard local changes before pulling.': 'errors:backend.gitRecovery.dirtyWorktree',
  'Configure an upstream branch before pulling.': 'errors:backend.gitRecovery.noUpstreamPull',
  'Enable Set upstream on the first push.': 'errors:backend.gitRecovery.noUpstreamPush',
  'Fetch from the same remote push destination to reconcile the result before retrying.': 'errors:backend.gitRecovery.pushRefreshRequired',
  'Configure one push URL for this remote, then retry.': 'errors:backend.gitRecovery.multiplePushUrls',
};

function translateGitOperationMessage(code: string, message: string): string {
  const cleanMsg = redactSensitiveUrls(message);

  switch (code) {
    case 'Busy':
      return i18n.t('errors:backend.gitErrors.Busy');
    case 'UnsupportedSSHCommand':
      return i18n.t('errors:backend.gitErrors.UnsupportedSSHCommand');
    case 'EmptyMessage':
      return i18n.t('errors:backend.gitErrors.EmptyMessage');
    case 'OperationInProgress':
      return i18n.t('errors:backend.gitErrors.OperationInProgress');
    case 'NothingStaged':
      return i18n.t('errors:backend.gitErrors.NothingStaged');
    case 'Diverged':
      return i18n.t('errors:backend.gitErrors.Diverged');
    case 'AuthenticationFailed':
      return i18n.t('errors:backend.gitErrors.AuthenticationFailed');
    case 'PushRefreshRequired':
      return i18n.t('errors:backend.gitErrors.PushRefreshRequired');
    case 'DirtyWorktree':
      return i18n.t('errors:backend.gitErrors.DirtyWorktree');
    case 'NoCommits':
      return i18n.t('errors:backend.gitErrors.NoCommits');
    case 'MultiplePushUrls':
      return i18n.t('errors:backend.gitErrors.MultiplePushUrls');
    case 'InvalidRemote':
      return i18n.t('errors:backend.gitErrors.InvalidRemote');
    case 'InvalidBranch':
      return i18n.t('errors:backend.gitErrors.InvalidBranch');
    case 'CredentialsInUrl':
      return i18n.t('errors:backend.gitErrors.CredentialsInUrl');
    case 'DetachedHead':
      if (cleanMsg.includes('Commits are disabled')) return i18n.t('errors:backend.gitErrors.DetachedHeadCommit');
      if (cleanMsg.includes('Pull requires')) return i18n.t('errors:backend.gitErrors.DetachedHeadPull');
      if (cleanMsg.includes('Push requires')) return i18n.t('errors:backend.gitErrors.DetachedHeadPush');
      return i18n.t('errors:backend.gitErrors.DetachedHeadCommit');
    case 'InvalidIdentity':
      if (cleanMsg.includes('non-empty name')) return i18n.t('errors:backend.gitErrors.InvalidIdentityInput');
      return i18n.t('errors:backend.gitErrors.InvalidIdentityConfig');
    case 'NoUpstream':
      if (cleanMsg.includes('no configured upstream')) return i18n.t('errors:backend.gitErrors.NoUpstreamPull');
      return i18n.t('errors:backend.gitErrors.NoUpstreamPush');
    case 'InvalidRemoteUrl':
      if (cleanMsg.includes('without a password')) return i18n.t('errors:backend.gitErrors.InvalidRemoteUrlSsh');
      if (cleanMsg.includes('Only HTTPS and SSH')) return i18n.t('errors:backend.gitErrors.InvalidRemoteUrlProtocol');
      return i18n.t('errors:backend.gitErrors.InvalidRemoteUrl');
    case 'Timeout': {
      const match = /^Git ([a-zA-Z]+) timed out after five minutes\.?$/.exec(cleanMsg);
      if (match) {
        return i18n.t('errors:backend.gitErrors.TimeoutWithOp', { operation: match[1] });
      }
      return i18n.t('errors:backend.gitErrors.Timeout');
    }
    case 'UnknownRemote': {
      const match = /^Git remote '([^']+)' does not exist\.?$/.exec(cleanMsg);
      if (match) {
        return i18n.t('errors:backend.gitErrors.UnknownRemoteNamed', { remote: match[1] });
      }
      if (cleanMsg.includes('does not have a fetch URL')) {
        return i18n.t('errors:backend.gitErrors.UnknownRemoteNoFetchUrl');
      }
      return cleanMsg;
    }
    case 'InvalidDestination':
      if (cleanMsg.includes('without path separators')) return i18n.t('errors:backend.gitErrors.InvalidDestinationFolderName');
      if (cleanMsg.includes('parent folder does not exist')) return i18n.t('errors:backend.gitErrors.InvalidDestinationParentMissing');
      return cleanMsg;
    case 'RepositoryUnavailable':
      if (cleanMsg === 'Project is not a Git repository.') {
        return i18n.t('errors:backend.codes.git.not_a_repo');
      }
      return cleanMsg;
    case 'GitFailed': {
      // Preserve messages with embedded raw Git stderr cleanly.
      const noStderrMatch = /^Git ([a-zA-Z ]+) failed\.?$/.exec(cleanMsg);
      if (noStderrMatch) {
        return i18n.t('errors:backend.gitErrors.GitFailedNoDetail', { operation: noStderrMatch[1] });
      }
      if (cleanMsg === 'Git could not inspect repository changes.') {
        return i18n.t('errors:backend.gitErrors.GitInspectChangesFailed');
      }
      return cleanMsg;
    }
    default:
      return translateBackendError(cleanMsg, code.includes('.') ? code : null, cleanMsg);
  }
}

/** Translates a structured GitOperationError (`code`, `message`, `recovery`) into the active UI language. */
export function translateGitOperationError(error: GitOperationError): GitOperationError {
  const translatedMessage = translateGitOperationMessage(error.code, error.message);
  let translatedRecovery = error.recovery;
  if (error.recovery) {
    const recoveryKey = GIT_RECOVERY_KEYS[error.recovery.trim()];
    if (recoveryKey && i18n.exists(recoveryKey)) {
      translatedRecovery = i18n.t(recoveryKey as never) as unknown as string;
    } else {
      translatedRecovery = redactSensitiveUrls(translateBackendError(error.recovery));
    }
  }
  return {
    ...error,
    message: translatedMessage,
    recovery: translatedRecovery,
  };
}
