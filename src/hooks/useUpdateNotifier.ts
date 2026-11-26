import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

const AUTO_CHECK_STORAGE_KEY = 'sciencebatch:auto-check-updates';

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  latestTag: string;
  updateAvailable: boolean;
  noPublishedReleases: boolean;
  releaseName: string;
  releaseNotes: string;
  downloadUrl: string;
  publishedAt: string | null;
}

export interface CheckForUpdatesOptions {
  silent?: boolean;
}

export interface UseUpdateNotifierReturn {
  autoCheckOnStartup: boolean;
  setAutoCheckOnStartup: (enabled: boolean) => void;
  isChecking: boolean;
  updateResult: UpdateCheckResult | null;
  checkError: string | null;
  isModalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
  checkForUpdates: (options?: CheckForUpdatesOptions) => Promise<void>;
}

const readStoredAutoCheck = (): boolean => {
  try {
    return localStorage.getItem(AUTO_CHECK_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

export function useUpdateNotifier(): UseUpdateNotifierReturn {
  const [autoCheckOnStartup, setAutoCheckState] = useState<boolean>(readStoredAutoCheck);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);

  const mountedRef = useRef<boolean>(true);
  const inFlightRef = useRef<boolean>(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setAutoCheckOnStartup = useCallback((enabled: boolean) => {
    setAutoCheckState(enabled);
    try {
      localStorage.setItem(AUTO_CHECK_STORAGE_KEY, String(enabled));
    } catch {
      // Ignore storage quota or restricted-environment errors.
    }
  }, []);

  const openModal = useCallback(() => {
    setIsModalOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  const checkForUpdates = useCallback(async (options?: CheckForUpdatesOptions) => {
    const silent = options?.silent ?? false;

    if (!silent) {
      setIsModalOpen(true);
    }

    if (inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    setIsChecking(true);
    setCheckError(null);

    try {
      const result = await invoke<UpdateCheckResult>('check_for_updates');
      if (!mountedRef.current) return;

      setUpdateResult(result);
      setCheckError(null);

      if (silent && result.updateAvailable) {
        toast.info(`Update available: v${result.latestVersion}`, {
          description: result.releaseName || 'A new ScienceBatch release is ready.',
          action: {
            label: 'View Details',
            onClick: () => setIsModalOpen(true),
          },
        });
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      if (!silent) {
        setCheckError(message || 'Unable to check for updates.');
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setIsChecking(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!readStoredAutoCheck()) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    let cancelled = false;
    const runStartupCheck = async () => {
      if (cancelled) return;
      await checkForUpdates({ silent: true });
    };
    void runStartupCheck();

    return () => {
      cancelled = true;
    };
  }, [checkForUpdates]);

  return {
    autoCheckOnStartup,
    setAutoCheckOnStartup,
    isChecking,
    updateResult,
    checkError,
    isModalOpen,
    openModal,
    closeModal,
    checkForUpdates,
  };
}
