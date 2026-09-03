import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { CompileResponse, DiagnosticItem, ProgressPayload, EngineType, CompilationStatus } from '../types';

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

  // Listen to IPC compilation progress events
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    const setupListener = async () => {
      try {
        unlisten = await listen<ProgressPayload>('compilation-progress', (event) => {
          const { message, status } = event.payload;
          if (status === 'Cancelled') {
            return;
          }
          setStatusMessage(message);
        });
      } catch {
        // Not in Tauri runtime
      }
    };

    setupListener();
    return () => {
      if (unlisten) unlisten();
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
      await invoke('cancel_compilation');
    } catch {
      // Not in Tauri runtime or already aborted
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
    cancelCompilation,
    clearCompilationAndDiagnostics,
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
    handleFitWidth,
  };
}
