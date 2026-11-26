export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'untracked'
  | 'renamed'
  | 'copied'
  | 'typechanged';

export interface GitFileChange {
  path: string;
  status: GitFileStatus;
  staged: boolean;
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitBranchListResult {
  branches: string[];
  currentBranch: string | null;
  detached: boolean;
}

export interface GitBranchSwitchResult {
  branch: string;
  created: boolean;
}

export interface GitStatusResult {
  gitAvailable: boolean;
  gitVersion: string | null;
  isGitRepo: boolean;
  branch: string | null;
  changes: GitFileChange[];
  detached: boolean;
  error: string | null;
}

export interface GitDiffResult {
  path: string;
  diff: string;
  isBinary: boolean;
  oversized: boolean;
}

export interface GitRemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitIdentity {
  name: string | null;
  email: string | null;
  valid: boolean;
}

export interface GitRepositoryInfo {
  repositoryRoot: string;
  identity: GitIdentity;
  hasCommits: boolean;
  hasStagedChanges: boolean;
  worktreeClean: boolean;
  branch: string | null;
  detached: boolean;
  remotes: GitRemoteInfo[];
  upstream: string | null;
  upstreamRemote: string | null;
  upstreamBranch: string | null;
  ahead: number | null;
  behind: number | null;
  pushRefreshRequired: boolean;
}

export interface GitOperationError {
  code: string;
  message: string;
  recovery: string | null;
  partialPath: string | null;
  outcomeUnknown: boolean;
}

export interface GitOperationProgressPayload {
  operationId: string;
  repositoryRoot: string | null;
  operation: string;
  status: string;
  message: string;
}

export interface GitOperationResult {
  message: string;
  commitId: string | null;
}

export type GitProvider = 'github' | 'gitlab';

export interface GitAccountStatus {
  provider: GitProvider;
  signedIn: boolean;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  host: string;
  expiresAt: number | null;
  clientIdConfigured: boolean;
}

export interface GitHubDeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface GitHubDevicePollResult {
  status: 'pending' | 'slow_down' | 'authorized' | 'expired' | 'denied';
  account: GitAccountStatus | null;
  interval: number | null;
  error: string | null;
}

export interface GitProviderRepo {
  id: number;
  name: string;
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
  defaultBranch: string | null;
  updatedAt: string | null;
}
