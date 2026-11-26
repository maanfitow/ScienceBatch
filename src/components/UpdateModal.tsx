import React, { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { UpdateCheckResult } from '../hooks/useUpdateNotifier';

interface UpdateModalProps {
  isOpen: boolean;
  isChecking: boolean;
  updateResult: UpdateCheckResult | null;
  checkError: string | null;
  autoCheckOnStartup: boolean;
  onToggleAutoCheckOnStartup: (enabled: boolean) => void;
  onCheckAgain: () => void;
  onClose: () => void;
}

const formatPublishedDate = (isoDate: string | null): string | null => {
  if (!isoDate) return null;
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

export const UpdateModal: React.FC<UpdateModalProps> = ({
  isOpen,
  isChecking,
  updateResult,
  checkError,
  autoCheckOnStartup,
  onToggleAutoCheckOnStartup,
  onCheckAgain,
  onClose,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const currentVersion = updateResult?.currentVersion ?? '0.1.0';
  const publishedDate = formatPublishedDate(updateResult?.publishedAt ?? null);

  const handleDownloadRelease = async () => {
    if (!updateResult?.downloadUrl) return;
    try {
      await invoke('open_external_url', { url: updateResult.downloadUrl });
    } catch (err) {
      toast.error('Failed to open release page', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card update-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Sparkles size={18} className="modal-title-icon" />
            <h3 id="update-modal-title">Software Updates</h3>
          </div>
          <button
            type="button"
            className="btn-modal-close"
            aria-label="Close update dialog"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>

        <div className="modal-body">
          <div className="update-version-row">
            <span className="update-version-label">Installed Version</span>
            <span className="update-version-badge">v{currentVersion}</span>
          </div>

          {isChecking && (
            <div className="update-status-card update-status-checking" role="status" aria-live="polite">
              <LoaderCircle size={18} className="spin" />
              <div>
                <div className="update-status-title">Checking for updates...</div>
                <div className="update-status-subtitle">
                  Querying GitHub Releases for the latest stable ScienceBatch build.
                </div>
              </div>
            </div>
          )}

          {!isChecking && checkError && (
            <div className="update-status-card update-status-error" role="alert">
              <AlertCircle size={18} />
              <div>
                <div className="update-status-title">Update check failed</div>
                <div className="update-status-subtitle">{checkError}</div>
              </div>
            </div>
          )}

          {!isChecking && !checkError && updateResult && updateResult.updateAvailable && (
            <div className="update-status-card update-status-available">
              <div className="update-available-header">
                <div>
                  <div className="update-status-title">
                    {updateResult.releaseName || `ScienceBatch ${updateResult.latestTag}`}
                  </div>
                  <div className="update-status-subtitle">
                    Version v{updateResult.latestVersion} is available
                    {publishedDate ? ` · Published ${publishedDate}` : ''}
                  </div>
                </div>
                <span className="update-new-badge">New Release</span>
              </div>

              {updateResult.releaseNotes && (
                <div className="update-release-notes" aria-label="Release notes">
                  {updateResult.releaseNotes}
                </div>
              )}
            </div>
          )}

          {!isChecking && !checkError && updateResult && !updateResult.updateAvailable && (
            <div
              className={`update-status-card ${updateResult.noPublishedReleases ? '' : 'update-status-current'}`}
              role="status"
            >
              {updateResult.noPublishedReleases ? <RefreshCw size={18} /> : <CheckCircle2 size={18} />}
              <div>
                <div className="update-status-title">
                  {updateResult.noPublishedReleases
                    ? 'No published releases yet'
                    : 'You are up to date'}
                </div>
                <div className="update-status-subtitle">
                  {updateResult.noPublishedReleases
                    ? `You are running ScienceBatch v${currentVersion}. Public releases will appear here once published on GitHub.`
                    : `ScienceBatch v${currentVersion} matches the latest stable release (${updateResult.latestTag}).`}
                </div>
              </div>
            </div>
          )}

          {!isChecking && !checkError && !updateResult && (
            <div className="update-status-card">
              <RefreshCw size={18} />
              <div>
                <div className="update-status-title">Ready to check for updates</div>
                <div className="update-status-subtitle">
                  Check GitHub Releases manually whenever you want to verify if a newer version is available.
                </div>
              </div>
            </div>
          )}

          <label className="update-modal-checkbox">
            <input
              type="checkbox"
              checked={autoCheckOnStartup}
              onChange={(event) => onToggleAutoCheckOnStartup(event.target.checked)}
            />
            <span>Check for updates automatically on startup</span>
          </label>

          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className={updateResult?.updateAvailable ? 'btn-secondary' : 'btn-primary'}
              disabled={isChecking}
              onClick={onCheckAgain}
            >
              <RefreshCw size={14} className={isChecking ? 'spin' : undefined} />
              <span>{isChecking ? 'Checking...' : 'Check Again'}</span>
            </button>
            {updateResult?.updateAvailable && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => void handleDownloadRelease()}
              >
                <Download size={14} />
                <span>Download Release</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
