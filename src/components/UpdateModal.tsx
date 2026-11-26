import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
import { getIntlLocale } from '../i18n';
import { translateBackendError } from '../i18n/backendMessages';
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
  return parsed.toLocaleDateString(getIntlLocale(), {
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
  const { t } = useTranslation(['menu', 'common']);

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
      toast.error(t('menu:updateModal.openReleaseError'), {
        description: translateBackendError(err),
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
            <h3 id="update-modal-title">{t('menu:updateModal.title')}</h3>
          </div>
          <button
            type="button"
            className="btn-modal-close"
            aria-label={t('menu:updateModal.closeAria')}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>

        <div className="modal-body">
          <div className="update-version-row">
            <span className="update-version-label">{t('menu:updateModal.installedVersion')}</span>
            <span className="update-version-badge">v{currentVersion}</span>
          </div>

          {isChecking && (
            <div className="update-status-card update-status-checking" role="status" aria-live="polite">
              <LoaderCircle size={18} className="spin" />
              <div>
                <div className="update-status-title">{t('menu:updateModal.checkingTitle')}</div>
                <div className="update-status-subtitle">
                  {t('menu:updateModal.checkingSubtitle')}
                </div>
              </div>
            </div>
          )}

          {!isChecking && checkError && (
            <div className="update-status-card update-status-error" role="alert">
              <AlertCircle size={18} />
              <div>
                <div className="update-status-title">{t('menu:updateModal.errorTitle')}</div>
                <div className="update-status-subtitle">{translateBackendError(checkError)}</div>
              </div>
            </div>
          )}

          {!isChecking && !checkError && updateResult && updateResult.updateAvailable && (
            <div className="update-status-card update-status-available">
              <div className="update-available-header">
                <div>
                  <div className="update-status-title">
                    {updateResult.releaseName ||
                      t('menu:updateModal.releaseFallbackName', { tag: updateResult.latestTag })}
                  </div>
                  <div className="update-status-subtitle">
                    {publishedDate
                      ? t('menu:updateModal.versionAvailableWithDate', {
                          version: updateResult.latestVersion,
                          date: publishedDate,
                        })
                      : t('menu:updateModal.versionAvailable', {
                          version: updateResult.latestVersion,
                        })}
                  </div>
                </div>
                <span className="update-new-badge">{t('menu:updateModal.newReleaseBadge')}</span>
              </div>

              {updateResult.releaseNotes && (
                <div className="update-release-notes" aria-label={t('menu:updateModal.releaseNotesAria')}>
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
                    ? t('menu:updateModal.noReleasesTitle')
                    : t('menu:updateModal.upToDateTitle')}
                </div>
                <div className="update-status-subtitle">
                  {updateResult.noPublishedReleases
                    ? t('menu:updateModal.noReleasesSubtitle', { version: currentVersion })
                    : t('menu:updateModal.upToDateSubtitle', {
                        version: currentVersion,
                        tag: updateResult.latestTag,
                      })}
                </div>
              </div>
            </div>
          )}

          {!isChecking && !checkError && !updateResult && (
            <div className="update-status-card">
              <RefreshCw size={18} />
              <div>
                <div className="update-status-title">{t('menu:updateModal.readyTitle')}</div>
                <div className="update-status-subtitle">
                  {t('menu:updateModal.readySubtitle')}
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
            <span>{t('menu:updateModal.autoCheckLabel')}</span>
          </label>

          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>
              {t('common:actions.close')}
            </button>
            <button
              type="button"
              className={updateResult?.updateAvailable ? 'btn-secondary' : 'btn-primary'}
              disabled={isChecking}
              onClick={onCheckAgain}
            >
              <RefreshCw size={14} className={isChecking ? 'spin' : undefined} />
              <span>
                {isChecking
                  ? t('menu:updateModal.checkingButton')
                  : t('menu:updateModal.checkAgainButton')}
              </span>
            </button>
            {updateResult?.updateAvailable && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => void handleDownloadRelease()}
              >
                <Download size={14} />
                <span>{t('menu:updateModal.downloadRelease')}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
