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
