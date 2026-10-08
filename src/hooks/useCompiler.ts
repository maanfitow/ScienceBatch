import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { CompileResponse, DiagnosticItem, ProgressPayload, EngineType, CompilationStatus } from '../types';
import type { WorkspaceCompileRequest } from '../types/automation';

export function useCompiler() {
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
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
          const { message, status } = event.payload;
          if (status === 'Cancelled') {
            return;
          }
          setStatusMessage(message);
        });
        if (disposed) stopDesktop(); else unlisten = stopDesktop;
        const stopWorkspace = await listen<{ jobId: string; status: string; message: string }>('workspace-compilation-progress', event => {
          if (activeCompilationKindRef.current !== 'workspace' || event.payload.jobId !== workspaceJobIdRef.current) return;
          setStatusMessage(event.payload.message);
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
  ): Promise<{ success: boolean; errors: DiagnosticItem[]; warnings: DiagnosticItem[]; pdfBytes: number[]; error?: { code: string; message: string } } | null> => {
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
    setIsCompiling(true);
    setCompilationStatus('compiling');
    setStatusMessage(`Preparing in-memory ${request.engine.toUpperCase()} workspace snapshot...`);
    const toastId = toast.loading(`Compiling ${request.engine.toUpperCase()} workspace...`, { description: 'Processing the current editor buffers in memory' });
    activeToastIdRef.current = toastId;
    try {
      const response = await invoke<CompileResponse>('compile_workspace_snapshot', { request });
      if (currentReqId !== compilationIdRef.current || !isCurrent()) { toast.dismiss(toastId); return null; }
      setErrors(response.errors || []);
      setWarnings(response.warnings || []);
      setRawLog(response.raw_log || '');
      if (response.success && response.pdf_bytes?.length) {
        setPdfBytes(new Uint8Array(response.pdf_bytes));
        setCompilationStatus('success');
        setStatusMessage('PDF generated');
        setActiveTab('preview');
        toast.success(`${request.engine.toUpperCase()} compilation successful`, {
          id: toastId,
          description: response.warnings?.length ? `Rendered with ${response.warnings.length} warning(s).` : 'Document rendered and updated in viewer.',
        });
        return { success: true, errors: response.errors || [], warnings: response.warnings || [], pdfBytes: response.pdf_bytes };
      } else {
        setCompilationStatus('error');
        setStatusMessage(response.errors?.[0]?.message || 'Compilation failed.');
        setActiveTab('diagnostics');
        toast.error(`${request.engine.toUpperCase()} Error`, { id: toastId, description: (response.errors?.[0]?.message || 'Compilation failed.').slice(0, 180) });
        return { success: false, errors: response.errors || [], warnings: response.warnings || [], pdfBytes: [] };
      }
    } catch (err: unknown) {
      if (currentReqId !== compilationIdRef.current) return null;
      if (!isCurrent()) { toast.dismiss(toastId); return null; }
      const wasExplicitlyCancelled = explicitlyCancelledWorkspaceJobsRef.current.has(request.jobId);
      const rawMessage = typeof err === 'string' ? err : err instanceof Error ? err.message : 'Unknown compilation error';
      const message = wasExplicitlyCancelled && !rawMessage.includes(':') ? 'operation.interrupted: Workspace compilation was cancelled.' : rawMessage;
      const code = message.match(/^([a-z][a-z0-9_.-]+):/)?.[1];
      setCompilationStatus('error');
      setStatusMessage(message);
      setActiveTab('diagnostics');
      setErrors([{ severity: 'error', message, suggestion: 'Check the workspace diagnostics and retry compilation.' }]);
      toast.error('Compilation Error', { id: toastId, description: message.slice(0, 180) });
      return { success: false, errors: [{ severity: 'error', message, suggestion: 'Check the workspace diagnostics and retry compilation.' }], warnings: [], pdfBytes: [], ...(code ? { error: { code, message } } : {}) };
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

    setIsCompiling(true);
    setCompilationStatus('compiling');
    setStatusMessage(`Preparing in-memory ${engine.toUpperCase()} compiler...`);

    const toastId = toast.loading(`Compiling ${engine.toUpperCase()} document...`, {
      description: 'Processing in RAM VFS',
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
        setCompilationStatus('success');
        setStatusMessage('PDF generated');
        setActiveTab('preview');

        toast.success(`${engine.toUpperCase()} compilation successful`, {
          id: toastId,
          description: response.warnings.length > 0
            ? `Rendered with ${response.warnings.length} warning(s).`
            : 'Document rendered and updated in viewer.',
        });
      } else {
        setCompilationStatus('error');
        const firstError = response.errors?.[0]?.message || 'Compilation failed.';
        setStatusMessage(firstError);
        setActiveTab('diagnostics');

        toast.error(`${engine.toUpperCase()} Error`, {
          id: toastId,
          description: firstError.slice(0, 180),
          duration: 6000,
        });
      }
    } catch (err: unknown) {
      // Ignore errors if this compilation was aborted or superseded
      if (currentReqId !== compilationIdRef.current) return;

      const errorMessage = typeof err === 'string' ? err : err instanceof Error ? err.message : 'Unknown compilation error';

      if (errorMessage.toLowerCase().includes('cancelled') || errorMessage.toLowerCase().includes('aborted')) {
        setCompilationStatus('idle');
        setStatusMessage('');
        toast.dismiss(toastId);
        return;
      }

      setCompilationStatus('error');
      setStatusMessage(errorMessage);
      setActiveTab('diagnostics');

      setErrors([{
        severity: 'error',
        message: errorMessage,
        suggestion: 'Check console logs or retry compilation.',
      }]);

      toast.error('Compilation Error', {
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
