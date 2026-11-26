import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  ProjectResourceFailure,
  ProjectResourceProgress,
  ProjectResourceRequest,
  ProjectResourceSnapshot,
  ResourcePlanSummary,
  ResourceSelector,
  ResourceListPage,
  InstalledResourcePage,
} from '../types/projectResources';
import i18n from '../i18n';

const RESOURCE_BUDGET = 512 * 1024 * 1024;
type ResourceWorkspaceLabel = { projectName: string };
type AnalysisTarget = { workspace: ProjectResourceSnapshot; selection: ResourceSelector[]; selectionKey: string; key: string };

function labelFor(workspace: ProjectResourceSnapshot): ResourceWorkspaceLabel {
  return {
    projectName: typeof workspace.workspaceIdentity.projectName === 'string'
      ? workspace.workspaceIdentity.projectName
      : i18n.t('editor:resources.untitledWorkspace'),
  };
}

function failureFrom(error: unknown): ProjectResourceFailure {
  const defaultFailureMessage = i18n.t('errors:resources.operationFailed');
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const nested = value.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : null;
    if (nested) {
      return {
        code: typeof nested.code === 'string' ? nested.code : 'resources.operation_failed',
        message: typeof nested.message === 'string' ? nested.message : defaultFailureMessage,
        ...((nested.details ?? value.details) !== undefined ? { details: nested.details ?? value.details } : {}),
        ...(Array.isArray(nested.diagnostics ?? value.diagnostics) ? { diagnostics: (nested.diagnostics ?? value.diagnostics) as unknown[] } : {}),
      };
    }
    if (typeof value.code === 'string' || typeof value.message === 'string') {
      return {
        code: typeof value.code === 'string' ? value.code : 'resources.operation_failed',
        message: typeof value.message === 'string' ? value.message : defaultFailureMessage,
        ...(value.details !== undefined ? { details: value.details } : {}),
        ...(Array.isArray(value.diagnostics) ? { diagnostics: value.diagnostics } : {}),
      };
    }
  }

  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : defaultFailureMessage;
  const match = message.match(/^([a-z][a-z0-9_.-]+):\s*(.*)$/s);
  return { code: match?.[1] ?? 'resources.operation_failed', message: match?.[2] || message };
}

function unwrapResult<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'ok' in value) {
    const envelope = value as { ok?: unknown; data?: unknown; error?: unknown };
    if (envelope.ok === false) throw envelope.error ?? value;
    if (envelope.ok === true && 'data' in envelope) return envelope.data as T;
  }
  return value as T;
}

function makeJobId() {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `resources-${id}`;
}

export function useProjectResources(
  snapshot: ProjectResourceSnapshot | null,
  isSnapshotCurrent: (fingerprint: string) => boolean,
) {
  const [isOpen, setIsOpen] = useState(false);
  const [modalTab, setModalTab] = useState<'project' | 'cache'>('project');
  const [plan, setPlan] = useState<ResourcePlanSummary | null>(null);
  const [recovery, setRecovery] = useState<{ fingerprint: string; paths: string[] } | null>(null);
  const [plannedFingerprint, setPlannedFingerprint] = useState<string | null>(null);
  const [plannedSelection, setPlannedSelection] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProjectResourceProgress | null>(null);
  const [activeWorkspaceLabel, setActiveWorkspaceLabel] = useState<ResourceWorkspaceLabel | null>(null);
  const [error, setError] = useState<ProjectResourceFailure | null>(null);
  const [errorAction, setErrorAction] = useState<'check' | 'prepare' | null>(null);
  const [isSidebarVisible, setIsSidebarVisible] = useState(false);
  const [resourcePage, setResourcePage] = useState<ResourceListPage | null>(null);
  const [isResourcePageLoading, setIsResourcePageLoading] = useState(false);
  const [resourcePageError, setResourcePageError] = useState<ProjectResourceFailure | null>(null);
  const [cachePage, setCachePage] = useState<InstalledResourcePage | null>(null);
  const [isCachePageLoading, setIsCachePageLoading] = useState(false);
  const [cacheError, setCacheError] = useState<ProjectResourceFailure | null>(null);
  const [isRemovingResources, setIsRemovingResources] = useState(false);
  const [cacheRemovalResult, setCacheRemovalResult] = useState<{ removedFiles: number; removedBytes: number } | null>(null);
  const [completedPaths, setCompletedPaths] = useState<string[]>([]);
  const activeJobRef = useRef<string | null>(null);
  const completedJobRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef<string | null>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen || isSidebarVisible;
  const currentSnapshotRef = useRef(snapshot);
  currentSnapshotRef.current = snapshot;
  const currentPlanRef = useRef(plan);
  currentPlanRef.current = plan;
  const resourceListAttemptRef = useRef<string | null>(null);
  const resourceListRequestRef = useRef(0);
  const cacheListRequestRef = useRef(0);
  const cacheRemovalRef = useRef(false);
  const analysisQueueRef = useRef<{ running: boolean; desired: AnalysisTarget | null; promise: Promise<void> | null }>({ running: false, desired: null, promise: null });
  const analyzeRef = useRef<() => Promise<void>>(async () => undefined);
  const lastAutomaticTargetRef = useRef<string | null>(null);
  const lastAutomaticOpenRevisionRef = useRef(-1);
  const refreshAfterJobRef = useRef(false);
  const [openRevision, setOpenRevision] = useState(0);
  const workspaceContextKey = snapshot ? JSON.stringify({
    projectRoot: snapshot.projectRoot,
    projectName: snapshot.workspaceIdentity.projectName,
    generation: snapshot.workspaceIdentity.generation,
    engine: snapshot.engine,
    mainFile: snapshot.mainFile,
    templateAssets: snapshot.templateAssets,
  }) : 'no-workspace';
  const lastWorkspaceContextRef = useRef(workspaceContextKey);

  useEffect(() => {
    if (lastWorkspaceContextRef.current === workspaceContextKey) return;
    lastWorkspaceContextRef.current = workspaceContextKey;
    setRecovery(null);
    setPlan(null);
    setPlannedFingerprint(null);
    setPlannedSelection('');
    setResourcePage(null);
    setCachePage(null);
  }, [workspaceContextKey]);

  useEffect(() => {
    if (recovery && recovery.fingerprint !== snapshot?.fingerprint) setRecovery(null);
  }, [recovery, snapshot?.fingerprint]);

  const recoveryPaths = useMemo(
    () => recovery && recovery.fingerprint === snapshot?.fingerprint ? recovery.paths : [],
    [recovery, snapshot?.fingerprint],
  );
  const selection: ResourceSelector[] = useMemo(() => recoveryPaths.map(id => ({ kind: 'resource', id })), [recoveryPaths]);
  const selectionKey = JSON.stringify(selection.slice().sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)));
  const currentSelectionKeyRef = useRef(selectionKey);
  currentSelectionKeyRef.current = selectionKey;
  const isPlanFresh = Boolean(
    snapshot && plan && plannedFingerprint === snapshot.fingerprint && plannedSelection === selectionKey,
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    const setup = async () => {
      try {
        const stop = await listen<ProjectResourceProgress>('project-resources-progress', event => {
          if (event.payload.jobId !== activeJobRef.current) return;
          setProgress({ ...event.payload, status: event.payload.phase, message: event.payload.phase });
          if (event.payload.resourcePath && /publishing|published|complete|ready/i.test(event.payload.phase ?? '')) {
            setCompletedPaths(current => current.includes(event.payload.resourcePath!) ? current : [...current, event.payload.resourcePath!]);
          }
        });
        if (disposed) stop(); else unlisten = stop;
      } catch {
        // The hook also runs in browser-based frontend QA without a Tauri runtime.
      }
    };
    void setup();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (plan && (plannedFingerprint !== snapshot?.fingerprint || plannedSelection !== selectionKey)) {
      setPlan(null);
    }
  }, [plan, plannedFingerprint, plannedSelection, selectionKey, snapshot?.fingerprint]);

  useLayoutEffect(() => {
    setResourcePage(null);
    setResourcePageError(null);
    setIsResourcePageLoading(false);
    resourceListAttemptRef.current = null;
    resourceListRequestRef.current += 1;
  }, [plan]);

  useLayoutEffect(() => {
    setCachePage(null);
    setCacheError(null);
    setCacheRemovalResult(null);
    setIsCachePageLoading(false);
    cacheListRequestRef.current += 1;
  }, [plan, selectionKey, snapshot?.fingerprint]);

  const requestFor = useCallback((
    workspace: ProjectResourceSnapshot,
    operation: ProjectResourceRequest['operation'],
    extras: Partial<ProjectResourceRequest> = {},
  ): ProjectResourceRequest => ({
    operation,
    jobId: extras.jobId ?? makeJobId(),
    engine: workspace.engine,
    projectRoot: workspace.projectRoot,
    mainFile: workspace.mainFile,
    overlays: workspace.overlays,
    allowedRoots: workspace.allowedRoots,
    workspaceIdentity: workspace.workspaceIdentity,
    templateAssets: workspace.templateAssets,
    selection: selection.length ? selection : undefined,
    ...extras,
  }), [selection]);

  const call = useCallback(async <T,>(request: ProjectResourceRequest): Promise<T> => {
    const value = await invoke<unknown>('resources_workspace_operation', { request });
    return unwrapResult<T>(value);
  }, []);

  const snapshotSelectionIsCurrent = useCallback((target: AnalysisTarget) => (
    currentSnapshotRef.current?.fingerprint === target.workspace.fingerprint
      && currentSelectionKeyRef.current === target.selectionKey
      && isSnapshotCurrent(target.workspace.fingerprint)
  ), [isSnapshotCurrent]);
  const analysisTargetIsCurrent = useCallback((target: AnalysisTarget) => (
    isOpenRef.current && !activeJobRef.current && snapshotSelectionIsCurrent(target)
  ), [snapshotSelectionIsCurrent]);

  const refreshPlan = useCallback(async (target: AnalysisTarget) => {
    const { workspace, selection: currentSelection } = target;
    const analyzeRequest = {
      ...requestFor(workspace, 'resources.analyze'),
      selection: currentSelection.length ? currentSelection : undefined,
    };
    const analyzed = await call<ResourcePlanSummary>(analyzeRequest);
    if (!analysisTargetIsCurrent(target)) throw { code: 'resources.input_changed', message: i18n.t('errors:resources.changedDuringAnalysis') };
    const planned = await call<ResourcePlanSummary>({
      ...analyzeRequest,
      operation: 'resources.plan',
      expectedInputDigest: analyzed.inputDigest,
    });
    if (!analysisTargetIsCurrent(target)) throw { code: 'resources.input_changed', message: i18n.t('errors:resources.changedDuringPlanning') };
    setPlan(planned);
    setPlannedFingerprint(workspace.fingerprint);
    setPlannedSelection(JSON.stringify(currentSelection.slice().sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))));
    return planned;
  }, [analysisTargetIsCurrent, call, requestFor]);

  const analyze = useCallback(async () => {
    if (!snapshot || !isOpenRef.current) return;
    const selected = selection.slice();
    const selectedKey = JSON.stringify(selected.slice().sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)));
    const target: AnalysisTarget = { workspace: snapshot, selection: selected, selectionKey: selectedKey, key: JSON.stringify([snapshot.fingerprint, selectedKey]) };
    const queue = analysisQueueRef.current;
    if (activeJobRef.current) return;
    queue.desired = target;
    if (queue.running) return queue.promise ?? undefined;

    queue.running = true;
    setIsAnalyzing(true);
    const run = async () => {
      try {
        while (queue.desired) {
          const next = queue.desired;
          queue.desired = null;
          if (!analysisTargetIsCurrent(next)) continue;
          setError(null);
          setErrorAction(null);
          setPlan(null);
          setPlannedFingerprint(null);
          setPlannedSelection('');
          try {
            await refreshPlan(next);
          } catch (operationError) {
            if (analysisTargetIsCurrent(next)) {
              setError(failureFrom(operationError));
              setErrorAction('check');
            }
          }
        }
      } finally {
        queue.running = false;
        queue.promise = null;
        setIsAnalyzing(false);
        if (queue.desired && isOpenRef.current) void analyzeRef.current();
      }
    };
    queue.promise = run();
    return queue.promise;
  }, [analysisTargetIsCurrent, refreshPlan, selection, snapshot]);
  analyzeRef.current = analyze;

  const open = useCallback((tab?: 'project' | 'cache' | SyntheticEvent) => {
    const nextTab = tab === 'cache' ? 'cache' : 'project';
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      const active = document.activeElement;
      focusReturnRef.current = active.closest('.menu-item-wrapper')?.querySelector<HTMLElement>('.menu-button') ?? active;
    }
    setModalTab(nextTab);
    setIsOpen(true);
    setOpenRevision(previous => previous + 1);
  }, []);

  const setSidebarVisible = useCallback((visible: boolean) => {
    setIsSidebarVisible(visible);
  }, []);

  useEffect(() => {
    if ((!isOpen && !isSidebarVisible) || !snapshot) return;
    if (activeJobRef.current) return;
    const selectedKey = JSON.stringify(selection.slice().sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)));
    const targetKey = JSON.stringify([snapshot.fingerprint, selectedKey]);
    const shouldAnalyze = lastAutomaticOpenRevisionRef.current !== openRevision
      || lastAutomaticTargetRef.current !== targetKey
      || refreshAfterJobRef.current;
    if (!shouldAnalyze) return;
    lastAutomaticOpenRevisionRef.current = openRevision;
    lastAutomaticTargetRef.current = targetKey;
    refreshAfterJobRef.current = false;
    // Let the owner of the snapshot commit its matching current-snapshot ref
    // before validation begins. This keeps a source edit from being dropped
    // when that ref is synchronized by a sibling passive effect.
    queueMicrotask(() => {
      if (isOpenRef.current) void analyzeRef.current();
    });
  }, [activeJobId, isOpen, isSidebarVisible, openRevision, selection, snapshot?.fingerprint]);

  const prepare = useCallback(async (): Promise<boolean> => {
    if (!snapshot || !plan || !isPlanFresh || activeJobRef.current) return false;
    const jobId = makeJobId();
    const selected = selection.slice();
    const target: AnalysisTarget = { workspace: snapshot, selection: selected, selectionKey, key: JSON.stringify([snapshot.fingerprint, selectionKey]) };
    activeJobRef.current = jobId;
    completedJobRef.current = null;
    setCompletedPaths([]);
    setActiveJobId(jobId);
    setActiveWorkspaceLabel(labelFor(snapshot));
    setProgress({ jobId, status: 'Started', message: i18n.t('editor:resources.preparingKnown') });
    setError(null);
    setErrorAction(null);
    try {
      const result = await call<Record<string, unknown>>(requestFor(snapshot, 'resources.prepare_project', {
        jobId,
        expectedInputDigest: plan.inputDigest,
        expectedPlanDigest: plan.planDigest,
        maxDownloadBytes: RESOURCE_BUDGET,
        maxStorageBytes: RESOURCE_BUDGET,
      }));
      completedJobRef.current = jobId;
      if (!snapshotSelectionIsCurrent(target)) {
        // The result belongs to an older view of the project. Refresh on reopen or
        // after the active job settles instead of showing a stale-plan error.
        refreshAfterJobRef.current = true;
        setProgress(current => current ? { ...current, status: 'Finished', message: i18n.t('editor:resources.detectedReady') } : current);
        return true;
      }
      if (result.plan && typeof result.plan === 'object') {
        const refreshedPlan = result.plan as ResourcePlanSummary;
        setPlan(refreshedPlan);
        setPlannedFingerprint(snapshot.fingerprint);
        setPlannedSelection(JSON.stringify(selected.slice().sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))));
      }
      setProgress(current => current ? { ...current, status: 'Finished', message: i18n.t('editor:resources.detectedReady') } : current);
      return true;
    } catch (operationError) {
      if (cancelRequestedRef.current === jobId) {
        setError(null);
        setErrorAction(null);
        setProgress(current => current ? { ...current, status: 'Cancelled', message: i18n.t('editor:resources.downloadPaused') } : current);
        refreshAfterJobRef.current = true;
        return false;
      }
      const failure = failureFrom(operationError);
      if (snapshotSelectionIsCurrent(target)) {
        setError(failure);
        setErrorAction('prepare');
        setProgress(current => current ? { ...current, status: 'Error', message: failure.message } : current);
      }
      return false;
    } finally {
      if (cancelRequestedRef.current === jobId) cancelRequestedRef.current = null;
      activeJobRef.current = null;
      setActiveJobId(null);
      setActiveWorkspaceLabel(null);
    }
  }, [analysisTargetIsCurrent, call, isPlanFresh, plan, requestFor, selection, selectionKey, snapshot, snapshotSelectionIsCurrent]);

  const cancelJob = useCallback(async (jobId: string) => {
    if (!jobId || activeJobRef.current !== jobId) return false;
    cancelRequestedRef.current = jobId;
    setProgress(current => current?.jobId === jobId ? { ...current, status: 'Cancelling', message: i18n.t('editor:resources.cancelling') } : current);
    try {
      const cancelled = await invoke<boolean>('cancel_project_resources', { jobId });
      if (!cancelled) throw { code: 'job.not_found', message: i18n.t('errors:resources.jobNotFound') };
      if (activeJobRef.current === jobId && completedJobRef.current !== jobId) {
        setProgress(current => current?.jobId === jobId ? { ...current, status: 'Cancelled', message: i18n.t('editor:resources.downloadPaused') } : current);
      }
      return true;
    } catch (cancelError) {
      // The worker may have completed and another preparation may have started
      // while this cancellation request was waiting on the backend.
      if (activeJobRef.current !== jobId) return false;
      if (completedJobRef.current === jobId) return false;
      if (cancelRequestedRef.current === jobId) cancelRequestedRef.current = null;
      const failure = failureFrom(cancelError);
      setError(failure);
      setErrorAction('prepare');
      setProgress(current => current?.jobId === jobId ? { ...current, status: current.phase ?? 'downloading', message: i18n.t('editor:resources.downloadStillRunning') } : current);
      return false;
    }
  }, []);

  const cancel = useCallback(async () => {
    const jobId = activeJobRef.current;
    if (jobId) await cancelJob(jobId);
  }, [cancelJob]);

  const adoptExternalJob = useCallback((jobId: string, workspace: ProjectResourceSnapshot) => {
    if (activeJobRef.current && activeJobRef.current !== jobId) return false;
    activeJobRef.current = jobId;
    completedJobRef.current = null;
    setCompletedPaths([]);
    setActiveJobId(jobId);
    setActiveWorkspaceLabel(labelFor(workspace));
    setProgress({ jobId, status: 'Started', message: i18n.t('editor:resources.preparingKnown') });
    return true;
  }, []);

  const finishExternalJob = useCallback((jobId: string) => {
    if (activeJobRef.current !== jobId) return;
    refreshAfterJobRef.current = true;
    activeJobRef.current = null;
    setActiveJobId(null);
    setActiveWorkspaceLabel(null);
  }, []);

  useEffect(() => () => {
    const jobId = activeJobRef.current;
    if (jobId) void invoke('cancel_project_resources', { jobId }).catch(() => undefined);
  }, []);

  const offerRecoveryPaths = useCallback((paths: unknown[], fingerprint: string) => {
    if (currentSnapshotRef.current?.fingerprint !== fingerprint || !isSnapshotCurrent(fingerprint)) return;
    const candidates = paths.flatMap(value => {
      const path = typeof value === 'string' ? value : value && typeof value === 'object' && 'path' in value
        ? (value as { path?: unknown }).path : null;
      if (typeof path !== 'string' || path.length === 0 || path.length > 512 || path.startsWith('/') || path.includes('\\')
        || path.split('/').some(part => part === '..' || part === '.' || part.length === 0)) return [];
      return [path];
    });
    setRecovery(candidates.length ? { fingerprint, paths: Array.from(new Set(candidates)).slice(0, 200) } : null);
  }, [isSnapshotCurrent]);

  const loadResourcePage = useCallback(async (cursor: string | null = null, force = false) => {
    if (!snapshot || !plan || !isPlanFresh || isResourcePageLoading) return;
    const targetFingerprint = snapshot.fingerprint;
    const targetPlanDigest = plan.planDigest;
    const attemptKey = `${targetFingerprint}:${targetPlanDigest}:${cursor ?? 'first'}`;
    if (!force && resourceListAttemptRef.current === attemptKey) return;
    resourceListAttemptRef.current = attemptKey;
    const requestRevision = ++resourceListRequestRef.current;
    setResourcePageError(null);
    setIsResourcePageLoading(true);
    try {
      const page = await call<ResourceListPage>(requestFor(snapshot, 'resources.list', {
        expectedInputDigest: plan.inputDigest,
        expectedPlanDigest: plan.planDigest,
        cursor,
        limit: 100,
      }));
      if (currentSnapshotRef.current?.fingerprint !== targetFingerprint || !isSnapshotCurrent(targetFingerprint)
        || currentPlanRef.current?.planDigest !== page.planDigest || page.planDigest !== targetPlanDigest
        || requestRevision !== resourceListRequestRef.current) return;
      setResourcePage(current => cursor ? current && current.planDigest === page.planDigest
        ? { ...page, items: [...current.items, ...page.items] } : page : page);
    } catch (operationError) {
      if (currentSnapshotRef.current?.fingerprint === targetFingerprint && requestRevision === resourceListRequestRef.current) setResourcePageError(failureFrom(operationError));
    } finally {
      if (requestRevision === resourceListRequestRef.current) setIsResourcePageLoading(false);
    }
  }, [call, isPlanFresh, isResourcePageLoading, isSnapshotCurrent, plan, requestFor, snapshot]);

  const loadCachePage = useCallback(async (cursor: string | null = null, force = false) => {
    if (!snapshot || !plan || !isPlanFresh || (isCachePageLoading && !force)) return;
    const targetFingerprint = snapshot.fingerprint;
    const targetInputDigest = plan.inputDigest;
    const requestRevision = ++cacheListRequestRef.current;
    setIsCachePageLoading(true);
    setCacheError(null);
    try {
      const page = await call<InstalledResourcePage>(requestFor(snapshot, 'resources.cache_list', {
        expectedInputDigest: targetInputDigest,
        ...(cursor && cachePage ? { expectedCacheDigest: cachePage.cacheDigest } : {}),
        cursor,
        limit: 200,
      }));
      if (currentSnapshotRef.current?.fingerprint !== targetFingerprint || !isSnapshotCurrent(targetFingerprint)
        || currentPlanRef.current?.inputDigest !== targetInputDigest || requestRevision !== cacheListRequestRef.current) return;
      setCachePage(current => cursor && current?.cacheDigest === page.cacheDigest
        ? { ...page, items: [...current.items, ...page.items] } : page);
    } catch (operationError) {
      if (currentSnapshotRef.current?.fingerprint === targetFingerprint && requestRevision === cacheListRequestRef.current) {
        setCachePage(null);
        setCacheError(failureFrom(operationError));
      }
    } finally {
      if (requestRevision === cacheListRequestRef.current) setIsCachePageLoading(false);
    }
  }, [cachePage, call, isCachePageLoading, isPlanFresh, isSnapshotCurrent, plan, requestFor, snapshot]);

  const removeCachedResources = useCallback(async (paths: string[]) => {
    if (!snapshot || !plan || !isPlanFresh || !cachePage || paths.length === 0) return;
    if (cacheRemovalRef.current || activeJobRef.current || paths.length > 200) {
      setCacheError({ code: activeJobRef.current ? 'resources.cache_busy' : 'resources.cache_selection_invalid', message: i18n.t('errors:resources.cacheCannotRemove') });
      return;
    }
    const allowed = new Set(cachePage.items.filter(item => item.removable && !item.requiredByProject).map(item => item.path));
    if (paths.some(path => !allowed.has(path))) {
      setCacheError({ code: 'resources.cache_selection_invalid', message: i18n.t('errors:resources.cacheProtectedOrMissing') });
      return;
    }
    const targetFingerprint = snapshot.fingerprint;
    const targetCacheDigest = cachePage.cacheDigest;
    const targetInputDigest = plan.inputDigest;
    cacheRemovalRef.current = true;
    setIsRemovingResources(true);
    setCacheError(null);
    setCacheRemovalResult(null);
    try {
      const result = await call<{ removedFiles: number; removedBytes: number }>(requestFor(snapshot, 'resources.cache_remove', {
        expectedInputDigest: targetInputDigest,
        expectedCacheDigest: targetCacheDigest,
        removePaths: paths,
      }));
      if (currentSnapshotRef.current?.fingerprint !== targetFingerprint || !isSnapshotCurrent(targetFingerprint)
        || currentPlanRef.current?.inputDigest !== targetInputDigest || cachePage?.cacheDigest !== targetCacheDigest) return;
      setCacheRemovalResult(result);
      setCachePage(null);
    } catch (operationError) {
      if (currentSnapshotRef.current?.fingerprint === targetFingerprint && currentPlanRef.current?.inputDigest === targetInputDigest) {
        setCachePage(null);
        setCacheError(failureFrom(operationError));
      }
    } finally {
      cacheRemovalRef.current = false;
      setIsRemovingResources(false);
    }
  }, [cachePage, call, isPlanFresh, isSnapshotCurrent, plan, requestFor, snapshot]);

  return {
    isOpen,
    modalTab,
    setModalTab,
    isSidebarVisible,
    setSidebarVisible,
    focusReturnRef,
    setIsOpen,
    open,
    plan,
    recoveryPaths,
    offerRecoveryPaths,
    isPlanFresh,
    isAnalyzing,
    activeJobId,
    activeWorkspaceLabel,
    progress,
    error,
    errorAction,
    resourcePage,
    isResourcePageLoading,
    resourcePageError,
    loadResourcePage,
    cachePage,
    isCachePageLoading,
    cacheError,
    isRemovingResources,
    cacheRemovalResult,
    loadCachePage,
    removeCachedResources,
    completedPaths,
    analyze,
    prepare,
    cancel,
    cancelJob,
    adoptExternalJob,
    finishExternalJob,
  };
}
