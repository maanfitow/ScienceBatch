import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { GitOperationError, GitOperationProgressPayload } from '../types/git';

export type GitOperationKind = 'commit' | 'remote' | 'fetch' | 'pull' | 'push' | 'clone';

export interface GitOperationFailure extends GitOperationError {
  rawMessage?: string;
}

interface GitOperationOptions {
  reportsProgress?: boolean;
}

const normalizeError = (reason: unknown): GitOperationFailure => {
  let value: unknown = reason;
  if (typeof reason === 'string') {
    try { value = JSON.parse(reason); } catch { value = null; }
  }
  if (value && typeof value === 'object' && 'message' in value) {
    const item = value as Partial<GitOperationError>;
    return {
      code: typeof item.code === 'string' ? item.code : 'git_operation_failed',
      message: typeof item.message === 'string' ? item.message : 'Git operation failed.',
      recovery: typeof item.recovery === 'string' ? item.recovery : null,
      partialPath: typeof item.partialPath === 'string' ? item.partialPath : null,
      outcomeUnknown: item.outcomeUnknown === true,
    };
  }
  const message = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'Git operation failed.';
  return { code: 'git_operation_failed', message, recovery: null, partialPath: null, outcomeUnknown: false, rawMessage: message };
};

export const useGitOperation = (repositoryRoot: string | null) => {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<GitOperationProgressPayload | null>(null);
  const [error, setError] = useState<GitOperationFailure | null>(null);
  const mounted = useRef(true);
  const rootRef = useRef(repositoryRoot);
  const requestId = useRef(0);
  const operationIdRef = useRef<string | null>(null);
  const activeUnlisten = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestId.current++; activeUnlisten.current?.(); activeUnlisten.current = null; };
  }, []);

  useEffect(() => {
    rootRef.current = repositoryRoot;
    requestId.current++;
    activeUnlisten.current?.();
    activeUnlisten.current = null;
    operationIdRef.current = null;
    setRunning(false);
    setProgress(null);
    setError(null);
  }, [repositoryRoot]);

  const clearError = useCallback(() => setError(null), []);

  const run = useCallback(async <T,>(kind: GitOperationKind, command: string, args: Record<string, unknown>, options: GitOperationOptions = {}): Promise<T> => {
    if (!repositoryRoot && kind !== 'clone') throw normalizeError('Open a Git repository before running this operation.');
    if (operationIdRef.current) throw normalizeError('Another Git operation is already running.');
    const request = ++requestId.current;
    const operationId = options.reportsProgress === false ? null : crypto.randomUUID();
    const operationToken = operationId || crypto.randomUUID();
    operationIdRef.current = operationToken;
    setRunning(true);
    setProgress(null);
    setError(null);
    let unlisten: UnlistenFn | undefined;
    try {
      if (operationId) {
        unlisten = await listen<GitOperationProgressPayload>('git-operation-progress', event => {
          const payload = event.payload;
          if (payload.operationId === operationId && rootRef.current === repositoryRoot && mounted.current && request === requestId.current) setProgress(payload);
        });
        if (!mounted.current || request !== requestId.current || rootRef.current !== repositoryRoot) {
          unlisten();
          unlisten = undefined;
        } else activeUnlisten.current = unlisten;
      }
      const result = await invoke<T>(command, { ...args, ...(operationId ? { operationId } : {}) });
      if (mounted.current && request === requestId.current && rootRef.current === repositoryRoot) setProgress(null);
      return result;
    } catch (reason) {
      const failure = normalizeError(reason);
      if (mounted.current && request === requestId.current && rootRef.current === repositoryRoot) setError(failure);
      throw failure;
    } finally {
      unlisten?.();
      if (activeUnlisten.current === unlisten) activeUnlisten.current = null;
      if (operationIdRef.current === operationToken && mounted.current && request === requestId.current && rootRef.current === repositoryRoot) {
        operationIdRef.current = null;
        setRunning(false);
        setProgress(null);
      }
    }
  }, [repositoryRoot]);

  return { running, progress, error, run, clearError };
};
