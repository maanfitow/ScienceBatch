import React, { useEffect, useRef } from 'react';
import { AlertCircle, CheckCircle2, CircleDashed, Download, Loader2, Package, X } from 'lucide-react';
import type { useProjectResources } from '../hooks/useProjectResources';
import './projectResources.css';

type ResourcesModel = ReturnType<typeof useProjectResources>;

interface ProjectResourcesDialogProps {
  resources: ResourcesModel;
  projectName: string;
  onClose: () => void;
}

const formatBytes = (bytes: number | null | undefined) => {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
};

function friendlyPhase(phase?: string, status?: string) {
  switch (status?.toLowerCase()) {
    case 'finished': return 'Detected resources are ready';
    case 'cancelled': return 'Download paused';
    case 'cancelling': return 'Stopping the download';
  }
  switch (phase?.toLowerCase()) {
    case 'downloading':
    case 'download': return 'Downloading required files';
    case 'publishing': return 'Verifying and saving files';
    case 'verifying': return 'Verifying files';
    default: return 'Preparing required files';
  }
}

export const ProjectResourcesDialog: React.FC<ProjectResourcesDialogProps> = ({ resources, projectName, onClose }) => {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!resources.isOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
      )).filter(element => {
        if (element.matches(':disabled') || element.tabIndex < 0 || element.closest('[inert], [aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
      });
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const returnTarget = resources.focusReturnRef.current ?? previouslyFocused;
      resources.focusReturnRef.current = null;
      if (returnTarget?.isConnected) returnTarget.focus();
      else Array.from(document.querySelectorAll<HTMLElement>('.menu-button'))
        .find(button => button.textContent?.trim() === 'Tools')?.focus();
    };
  }, [resources.isOpen, resources.focusReturnRef]);

  if (!resources.isOpen) return null;

  const plan = resources.plan;
  const summary = plan?.summary;
  const metadataInvalid = plan?.bundleMetadataState === 'invalid';
  const metadataMissing = plan?.bundleMetadataState === 'missing';
  const hasInvalidFiles = (summary?.invalidResources ?? 0) > 0;
  const hasMissingFiles = (summary?.missingResources ?? 0) > 0;
  const metadataOnly = Boolean(metadataMissing && !hasMissingFiles && !hasInvalidFiles);
  const blocked = metadataInvalid || plan?.projectState === 'blocked';
  const needsPreparation = hasMissingFiles || hasInvalidFiles || metadataMissing;
  const cancelled = resources.progress?.status?.toLowerCase() === 'cancelled' && needsPreparation;
  const ready = Boolean(plan && !blocked && !needsPreparation);
  const canPrepare = Boolean(plan && resources.isPlanFresh && needsPreparation && !blocked
    && !resources.activeJobId && !resources.isAnalyzing);
  const unknownCount = summary?.unresolvedCount ?? 0;
  const statusText = (() => {
    if (resources.activeJobId) return friendlyPhase(resources.progress?.phase, resources.progress?.status);
    if (resources.isAnalyzing || !plan || !resources.isPlanFresh) {
      return resources.errorAction === 'check' && resources.error ? 'Could not check project resources' : 'Checking project resources…';
    }
    if (metadataInvalid) return 'Resource information could not be verified';
    if (blocked) return 'Project resources are unavailable';
    if (resources.error && resources.errorAction === 'prepare') return 'The download did not finish';
    if (ready) return 'Detected resources are ready';
    if (cancelled) return 'Download paused';
    if (metadataOnly) return 'Bundle setup is needed';
    if (needsPreparation) return hasInvalidFiles
      ? `${summary?.invalidResources ?? 0} file${summary?.invalidResources === 1 ? ' needs' : 's need'} to be repaired`
      : `${summary?.missingResources ?? 0} file${summary?.missingResources === 1 ? ' needs' : 's need'} to be downloaded`;
    return 'Checking project resources…';
  })();
  const primaryLabel = (() => {
    if (resources.isAnalyzing || !plan || !resources.isPlanFresh) return resources.error ? 'Try again' : 'Checking…';
    if (blocked) return 'Unavailable';
    if (resources.error) return 'Try again';
    if (cancelled) return 'Resume download';
    if (canPrepare) return metadataOnly ? 'Finish setup' : 'Download required files';
    if (ready) return 'Done';
    return 'Checking…';
  })();
  const primaryDisabled = resources.activeJobId ? true : resources.isAnalyzing || blocked || (!ready && !canPrepare && !resources.error);
  const progressTotal = resources.progress?.totalResources ?? 0;
  const progressCompleted = resources.progress?.completedResources ?? 0;
  const progressPercent = progressTotal > 0 ? Math.min(100, Math.round((progressCompleted / progressTotal) * 100)) : null;
  const errorText = resources.errorAction === 'prepare'
    ? 'The download could not be completed. You can try again.'
    : 'Project resources could not be checked. You can try again.';
  const onPrimary = () => {
    if (ready && !resources.error) { onClose(); return; }
    if (resources.error && resources.errorAction === 'prepare' && resources.isPlanFresh && canPrepare) {
      void resources.prepare();
      return;
    }
    if (canPrepare && (cancelled || needsPreparation)) {
      void resources.prepare();
      return;
    }
    if (resources.error) void resources.analyze();
  };

  return (
    <div className="project-resources-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        className="project-resources-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-resources-title"
        aria-describedby="project-resources-description"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="project-resources-header">
          <div>
            <div className="project-resources-title-line"><Package size={18} /><h2 id="project-resources-title">Project Resources</h2></div>
            <p id="project-resources-description">{projectName || 'Untitled project'}</p>
          </div>
          <button ref={closeButtonRef} className="project-resources-icon-button" aria-label="Close Project Resources" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="project-resources-body">
          <section className={`project-resources-basic ${blocked ? 'is-invalid' : ready ? 'is-ready' : ''}`} aria-label="Project resource status">
            <div className="project-resources-main-status" role="status" aria-live="polite">
              {resources.isAnalyzing || resources.activeJobId ? <Loader2 className="spin" size={17} /> : blocked ? <AlertCircle size={17} /> : ready ? <CheckCircle2 size={17} /> : <CircleDashed size={17} />}
              <strong>{statusText}</strong>
            </div>
            {(plan || resources.isAnalyzing) && <div className="project-resources-estimate">
              <span>Estimated download</span>
              <strong>{resources.isAnalyzing || !plan ? 'Checking…' : formatBytes(summary?.estimatedTransferBytes)}</strong>
            </div>}
            {resources.activeJobId && (
              <div className="project-resources-progress" role="status" aria-live="polite">
                <div className="project-resources-progress-copy">
                  <strong>{friendlyPhase(resources.progress?.phase, resources.progress?.status)}</strong>
                  {progressPercent != null ? <span>{progressCompleted} of {progressTotal} files</span> : <span>Working…</span>}
                </div>
                {progressPercent != null && <div className="project-resources-progress-track" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}><span style={{ width: `${progressPercent}%` }} /></div>}
                <button className="project-resources-cancel" onClick={() => void resources.cancel()} disabled={resources.progress?.status?.toLowerCase() === 'cancelling'}>Cancel</button>
              </div>
            )}
            {!resources.activeJobId && cancelled && <p className="project-resources-pause-note">The download was paused. You can resume it now.</p>}
            {!resources.activeJobId && metadataOnly && !metadataInvalid && <p className="project-resources-pause-note">All files are already downloaded. No download is needed.</p>}
            {!resources.activeJobId && ready && <p className="project-resources-pause-note">You can compile this project now.</p>}
            {!resources.activeJobId && needsPreparation && <p className="project-resources-pause-note">Files already downloaded will be reused.</p>}
            {!resources.activeJobId && resources.error && <p className="project-resources-friendly-error" role="alert">{errorText}</p>}
            {unknownCount > 0 && <p className="project-resources-unknown-note">Some dependencies can only be checked when you compile.</p>}
            {resources.recoveryPaths.length > 0 && <p className="project-resources-unknown-note">Possible files identified during the last compile are included in this check.</p>}
            {metadataInvalid && <p className="project-resources-friendly-error" role="alert">Resource information could not be verified, so downloads are unavailable.</p>}
            {blocked && !metadataInvalid && <p className="project-resources-friendly-error" role="alert">Resources cannot be prepared for this project right now.</p>}
          </section>
        </div>

        <footer className="project-resources-footer">
          <button className="project-resources-secondary" onClick={onClose}>Close</button>
          {resources.activeJobId ? null : (
            <button className="project-resources-primary" onClick={onPrimary} disabled={primaryDisabled}>
              {resources.isAnalyzing || !plan ? <Loader2 className="spin" size={15} /> : canPrepare ? <Download size={15} /> : null}
              <span>{primaryLabel}</span>
            </button>
          )}
        </footer>
      </section>
    </div>
  );
};
