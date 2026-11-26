import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { CompileResponse, DiagnosticItem, ProgressPayload, EngineType, CompilationStatus, PdfSourceMap } from '../types';
import type { WorkspaceCompileRequest } from '../types/automation';
import i18n from '../i18n';
import { translateBackendError, translateCompilerProgress } from '../i18n/backendMessages';

export function useCompiler() {
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [sourceMap, setSourceMap] = useState<PdfSourceMap | null>(null);
  const [isCompiling, setIsCompiling] = useState<boolean>(false);
  const [compilationStatus, setCompilationStatus] = useState<CompilationStatus>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [zoom, setZoom] = useState<number>(1.0);

  // Diagnostics & Tabs
  const [activeTab, setActiveTab] = useState<'preview' | 'diagnostics'>('preview');
  const [errors, setErrors] = useState<DiagnosticItem[]>([]);
  const [warnings, setWarnings] = useState<DiagnosticItem[]>([]);
  const [rawLog, setRawLog] = useState<string>('');

  const activeToastIdRef = useRef<string | number | null>(null);
  const compilationIdRef = useRef<number>(0);
  const workspaceJobIdRef = useRef<string | null>(null);
  const activeCompilationKindRef = useRef<'desktop' | 'workspace' | null>(null);
  const explicitlyCancelledWorkspaceJobsRef = useRef(new Set<string>());

  // Listen to IPC compilation progress events
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let unlistenWorkspace: UnlistenFn | undefined;
    let disposed = false;

    const setupListener = async () => {
      try {
        const stopDesktop = await listen<ProgressPayload>('compilation-progress', (event) => {
          if (activeCompilationKindRef.current === 'workspace') return;
          const { status } = event.payload;
          if (status === 'Cancelled') {
            return;
          }
          setStatusMessage(translateCompilerProgress(event.payload));
        });
        if (disposed) stopDesktop(); else unlisten = stopDesktop;
        const stopWorkspace = await listen<{
          jobId: string;
          status: string;
          message: string;
          code?: string | null;
          params?: Record<string, string | number> | null;
        }>('workspace-compilation-progress', event => {
          if (activeCompilationKindRef.current !== 'workspace' || event.payload.jobId !== workspaceJobIdRef.current) return;
          setStatusMessage(translateCompilerProgress(event.payload));
        });
        if (disposed) stopWorkspace(); else unlistenWorkspace = stopWorkspace;
      } catch {
        // Not in Tauri runtime
      }
    };

    setupListener();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
      if (unlistenWorkspace) unlistenWorkspace();
    };
  }, []);

  // Proactively cancel running compilation in backend and invalidate frontend state
  const cancelCompilation = useCallback(async () => {
    compilationIdRef.current += 1;

    if (activeToastIdRef.current) {
      toast.dismiss(activeToastIdRef.current);
      activeToastIdRef.current = null;
    }

    setIsCompiling(false);
    setCompilationStatus('idle');
    setStatusMessage('');

    try {
      const workspaceJobId = workspaceJobIdRef.current;
      if (workspaceJobId) {
        workspaceJobIdRef.current = null;
        await invoke('cancel_workspace_compilation', { jobId: workspaceJobId });
      } else {
        await invoke('cancel_compilation');
      }
    } catch {
      // Not in Tauri runtime or already aborted
    }
  }, []);

  const compileWorkspace = useCallback(async (
    request: WorkspaceCompileRequest,
    isCurrent: () => boolean,
  ): Promise<{ success: boolean; errors: DiagnosticItem[]; warnings: DiagnosticItem[]; pdfBytes: number[]; error?: { code: string; message: string; details?: unknown; diagnostics?: unknown[] } } | null> => {
    if (activeCompilationKindRef.current === 'workspace') {
      return {
        success: false,
        errors: [],
        warnings: [],
        pdfBytes: [],
        error: { code: 'worker.busy', message: 'Another workspace compilation is already active.' },
      };
    }
    if (activeCompilationKindRef.current === 'desktop') void invoke('cancel_compilation').catch(() => undefined);
    activeCompilationKindRef.current = 'workspace';
    if (activeToastIdRef.current) toast.dismiss(activeToastIdRef.current);
    const currentReqId = ++compilationIdRef.current;
    workspaceJobIdRef.current = request.jobId;
    const engineLabel = request.engine === 'typst' ? i18n.t('common:engines.typst') : i18n.t('common:engines.latex');
    setIsCompiling(true);
    setCompilationStatus('compiling');
    setStatusMessage(i18n.t('editor:compiler.preparingWorkspace', { engine: engineLabel }));
    const toastId = toast.loading(i18n.t('editor:compiler.compilingWorkspace', { engine: engineLabel }), {
      description: i18n.t('editor:compiler.compilingWorkspaceDescription'),
    });
    activeToastIdRef.current = toastId;
    try {
      const response = await invoke<CompileResponse>('compile_workspace_snapshot', { request });
      if (currentReqId !== compilationIdRef.current || !isCurrent()) { toast.dismiss(toastId); return null; }
      setErrors(response.errors || []);
      setWarnings(response.warnings || []);
      setRawLog(response.raw_log || '');
      if (response.success && response.pdf_bytes?.length) {
        setPdfBytes(new Uint8Array(response.pdf_bytes));
        setSourceMap(response.source_map ?? null);
        setCompilationStatus('success');
        setStatusMessage(i18n.t('editor:compiler.pdfGenerated'));
        setActiveTab('preview');
        const warningsCount = response.warnings?.length ?? 0;
        toast.success(i18n.t('editor:compiler.compileSuccessTitle', { engine: engineLabel }), {
          id: toastId,
          description: warningsCount > 0
            ? (warningsCount === 1
                ? i18n.t('editor:compiler.compileSuccessWarningsSingular', { count: warningsCount })
                : i18n.t('editor:compiler.compileSuccessWarningsPlural', { count: warningsCount }))
            : i18n.t('editor:compiler.compileSuccessDescription'),
        });
        return { success: true, errors: response.errors || [], warnings: response.warnings || [], pdfBytes: response.pdf_bytes };
      } else {
        const firstError = response.errors?.[0]?.message
          ? translateBackendError(response.errors[0].message)
          : i18n.t('editor:compiler.compilationFailed');
        setCompilationStatus('error');
        setStatusMessage(firstError);
        setActiveTab('diagnostics');
        toast.error(i18n.t('editor:compiler.engineErrorTitle', { engine: engineLabel }), { id: toastId, description: firstError.slice(0, 180) });
        return { success: false, errors: response.errors || [], warnings: response.warnings || [], pdfBytes: [] };
      }
    } catch (err: unknown) {
      if (currentReqId !== compilationIdRef.current) return null;
      if (!isCurrent()) { toast.dismiss(toastId); return null; }
      const wasExplicitlyCancelled = explicitlyCancelledWorkspaceJobsRef.current.has(request.jobId);
      const outer = err && typeof err === 'object' ? err as Record<string, unknown> : null;
      const nested = outer?.error && typeof outer.error === 'object' ? outer.error as Record<string, unknown> : outer;
      const rawMessage = typeof nested?.message === 'string'
        ? nested.message
        : typeof err === 'string' ? err : err instanceof Error ? err.message : i18n.t('errors:compiler.unknownError');
      const message = wasExplicitlyCancelled && !rawMessage.includes(':') ? 'operation.interrupted: Workspace compilation was cancelled.' : rawMessage;
      const code = typeof nested?.code === 'string' ? nested.code : message.match(/^([a-z][a-z0-9_.-]+):/)?.[1];
      const displayMessage = translateBackendError(message, code, i18n.t('errors:compiler.unknownError'));
      const details = nested?.details ?? outer?.details;
      const diagnostics = Array.isArray(nested?.diagnostics) ? nested.diagnostics : Array.isArray(outer?.diagnostics) ? outer.diagnostics : undefined;
      const structuredDiagnostics: DiagnosticItem[] = diagnostics?.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const value = item as Record<string, unknown>;
        if (typeof value.message !== 'string') return [];
        return [{
          severity: typeof value.severity === 'string' ? value.severity : 'error',
          message: value.message,
          ...(typeof value.file === 'string' ? { file: value.file } : {}),
          ...(typeof value.line === 'number' ? { line: value.line } : {}),
          ...(typeof value.suggestion === 'string' ? { suggestion: value.suggestion } : {}),
          ...(typeof value.suggestion_code === 'string' ? { suggestion_code: value.suggestion_code } : {}),
          ...(value.suggestion_params && typeof value.suggestion_params === 'object'
            ? { suggestion_params: value.suggestion_params as Record<string, string | number> }
            : {}),
        }];
      }) ?? [];
      const fallbackMessage = details === undefined ? displayMessage : `${displayMessage}\n${JSON.stringify(details, null, 2)}`;
      const fallbackDiagnostic: DiagnosticItem = { severity: 'error', message: fallbackMessage, suggestion: i18n.t('editor:compiler.checkWorkspaceDiagnosticsSuggestion') };
      const errorItems = structuredDiagnostics.filter(item => item.severity.toLowerCase() === 'error');
      const warningItems = structuredDiagnostics.filter(item => item.severity.toLowerCase() === 'warning');
      setCompilationStatus('error');
      setStatusMessage(displayMessage);
      setActiveTab('diagnostics');
      setRawLog(JSON.stringify({ code, message, details, diagnostics }, null, 2));
      setErrors(errorItems.length ? errorItems : [fallbackDiagnostic]);
      setWarnings(warningItems);
      toast.error(i18n.t('errors:compiler.compilationErrorTitle'), { id: toastId, description: displayMessage.slice(0, 180) });
      return { success: false, errors: errorItems.length ? errorItems : [fallbackDiagnostic], warnings: warningItems, pdfBytes: [], ...(code ? { error: { code, message, ...(details !== undefined ? { details } : {}), ...(diagnostics ? { diagnostics } : {}) } } : {}) };
    } finally {
      explicitlyCancelledWorkspaceJobsRef.current.delete(request.jobId);
      if (currentReqId === compilationIdRef.current) {
        workspaceJobIdRef.current = null;
        activeCompilationKindRef.current = null;
        setIsCompiling(false);
        activeToastIdRef.current = null;
      }
    }
  }, []);

  const cancelWorkspaceCompilation = useCallback(async (jobId: string) => {
    explicitlyCancelledWorkspaceJobsRef.current.add(jobId);
    try { await invoke('cancel_workspace_compilation', { jobId }); } catch { /* The job may have finished already. */ }
    if (workspaceJobIdRef.current === jobId) {
      workspaceJobIdRef.current = null;
      if (activeToastIdRef.current) toast.dismiss(activeToastIdRef.current);
      activeToastIdRef.current = null;
      setIsCompiling(false);
      setCompilationStatus('idle');
      setStatusMessage('');
    }
  }, []);

  // Cleanly reset right panel state (PDF canvas, errors, warnings, logs)
  const clearCompilationAndDiagnostics = useCallback(() => {
    cancelCompilation();
    setPdfBytes(null);
    setSourceMap(null);
    setErrors([]);
    setWarnings([]);
    setRawLog('');
    setCompilationStatus('idle');
    setStatusMessage('');
    setActiveTab('preview');
  }, [cancelCompilation]);

  const compile = useCallback(async (
    source: string,
    engine: EngineType,
    projectDir?: string | null,
    mainFile?: string | null
  ) => {
    const supersededWorkspaceJob = workspaceJobIdRef.current;
    if (supersededWorkspaceJob) {
      workspaceJobIdRef.current = null;
      void invoke('cancel_workspace_compilation', { jobId: supersededWorkspaceJob }).catch(() => undefined);
    }
    activeCompilationKindRef.current = 'desktop';
    // Dismiss any active toast if superseding a prior compilation
    if (activeToastIdRef.current) {
      toast.dismiss(activeToastIdRef.current);
      activeToastIdRef.current = null;
    }

    // Increment request generation ID to discard any earlier in-flight responses
    const currentReqId = ++compilationIdRef.current;

    const engineLabel = engine === 'typst' ? i18n.t('common:engines.typst') : i18n.t('common:engines.latex');
    setIsCompiling(true);
    setCompilationStatus('compiling');
    setStatusMessage(i18n.t('editor:compiler.preparingCompiler', { engine: engineLabel }));

    const toastId = toast.loading(i18n.t('editor:compiler.compilingDocument', { engine: engineLabel }), {
      description: i18n.t('editor:compiler.compilingDocumentDescription'),
    });
    activeToastIdRef.current = toastId;

    const relMain = mainFile && projectDir
      ? (mainFile.startsWith(projectDir)
          ? mainFile.slice(projectDir.length).replace(/^[/\\]/, '')
          : mainFile)
      : (mainFile || undefined);

    try {
      const response = await invoke<CompileResponse>('compile_document', {
        source,
        engine,
        projectDir: projectDir || undefined,
        project_dir: projectDir || undefined,
        mainFile: relMain || undefined,
        main_file: relMain || undefined,
      });

      // Ignore response if this compilation was cancelled or superseded
      if (currentReqId !== compilationIdRef.current) return;

      setErrors(response.errors || []);
      setWarnings(response.warnings || []);
      setRawLog(response.raw_log || '');

      if (response.success && response.pdf_bytes && response.pdf_bytes.length > 0) {
        const uint8 = new Uint8Array(response.pdf_bytes);
        setPdfBytes(uint8);
        setSourceMap(response.source_map ?? null);
        setCompilationStatus('success');
        setStatusMessage(i18n.t('editor:compiler.pdfGenerated'));
        setActiveTab('preview');

        toast.success(i18n.t('editor:compiler.compileSuccessTitle', { engine: engineLabel }), {
          id: toastId,
          description: response.warnings.length > 0
            ? (response.warnings.length === 1
                ? i18n.t('editor:compiler.compileSuccessWarningsSingular', { count: response.warnings.length })
                : i18n.t('editor:compiler.compileSuccessWarningsPlural', { count: response.warnings.length }))
            : i18n.t('editor:compiler.compileSuccessDescription'),
        });
      } else {
        setCompilationStatus('error');
        const firstError = response.errors?.[0]?.message
          ? translateBackendError(response.errors[0].message)
          : i18n.t('editor:compiler.compilationFailed');
        setStatusMessage(firstError);
        setActiveTab('diagnostics');

        toast.error(i18n.t('editor:compiler.engineErrorTitle', { engine: engineLabel }), {
          id: toastId,
          description: firstError.slice(0, 180),
          duration: 6000,
        });
      }
    } catch (err: unknown) {
      // Ignore errors if this compilation was aborted or superseded
      if (currentReqId !== compilationIdRef.current) return;

      const rawErrorMessage = typeof err === 'string' ? err : err instanceof Error ? err.message : i18n.t('errors:compiler.unknownError');

      const lowerError = rawErrorMessage.toLowerCase();
      if (
        lowerError.includes('operation.interrupted')
        || lowerError.includes('compilation.cancelled')
        || lowerError.includes('cancelled')
        || lowerError.includes('aborted')
      ) {
        setCompilationStatus('idle');
        setStatusMessage('');
        toast.dismiss(toastId);
        return;
      }

      const errorMessage = translateBackendError(err, null, i18n.t('errors:compiler.unknownError'));

      setCompilationStatus('error');
      setStatusMessage(errorMessage);
      setActiveTab('diagnostics');

      setErrors([{
        severity: 'error',
        message: errorMessage,
        suggestion: i18n.t('editor:compiler.checkLogsSuggestion'),
      }]);

      toast.error(i18n.t('errors:compiler.compilationErrorTitle'), {
        id: toastId,
        description: errorMessage.slice(0, 180),
        duration: 6000,
      });
    } finally {
      if (currentReqId === compilationIdRef.current) {
        activeCompilationKindRef.current = null;
        setIsCompiling(false);
        activeToastIdRef.current = null;
      }
    }
  }, []);

  // Zoom controls (25% to 500% bounds)
  const handleZoomIn = useCallback(() => setZoom((prev) => Math.min(Number((prev + 0.15).toFixed(2)), 5.0)), []);
  const handleZoomOut = useCallback(() => setZoom((prev) => Math.max(Number((prev - 0.15).toFixed(2)), 0.25)), []);
  const handleZoomReset = useCallback(() => setZoom(1.0), []);
  const handleFitWidth = useCallback(() => {
    window.dispatchEvent(new CustomEvent('sciencebatch:fit-width'));
  }, []);

  return {
    pdfBytes,
    setPdfBytes,
    sourceMap,
    isCompiling,
    compilationStatus,
    statusMessage,
    zoom,
    setZoom,
    activeTab,
    setActiveTab,
    errors,
    setErrors,
    warnings,
    setWarnings,
    rawLog,
    setRawLog,
    compile,
    compileWorkspace,
    cancelWorkspaceCompilation,
    cancelCompilation,
    clearCompilationAndDiagnostics,
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
    handleFitWidth,
  };
}
