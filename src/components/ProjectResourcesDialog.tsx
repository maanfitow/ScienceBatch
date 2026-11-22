import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Download,
  HardDrive,
  Loader2,
  Package,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type { ResourceRequirement } from '../types/projectResources';
import {
  availabilityLabel,
  availabilityTone,
  cacheErrorMessage,
  formatBytes,
  friendlyPhase,
  friendlyUnknownReason,
  isProjectFileJumpable,
  mergeUnknownItems,
  partitionUnknownItems,
  requirementRows,
  splitCachePath,
  type ResourcesModel,
} from './resourceUtils';
import './projectResources.css';

interface ProjectResourcesDialogProps {
  resources: ResourcesModel;
  projectName: string;
  engine?: 'latex' | 'typst';
  onClose: () => void;
  onRecompile?: () => void;
  onSelectLine?: (line: number, file?: string | null) => void;
}

export const ProjectResourcesDialog: React.FC<ProjectResourcesDialogProps> = ({
  resources,
  projectName,
  engine,
  onClose,
  onRecompile,
  onSelectLine,
}) => {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [localTab, setLocalTab] = useState<'project' | 'cache'>('project');
  const [isInspectOpen, setIsInspectOpen] = useState(false);
  const [cacheFilter, setCacheFilter] = useState('');
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [confirmRemoval, setConfirmRemoval] = useState(false);

  const activeTab = resources.modalTab ?? localTab;
  const setActiveTab = (tab: 'project' | 'cache') => {
    setLocalTab(tab);
    resources.setModalTab?.(tab);
  };

  useEffect(() => {
    if (!resources.isOpen) {
      setLocalTab('project');
      setIsInspectOpen(false);
      setCacheFilter('');
      setSelectedPaths([]);
      setConfirmRemoval(false);
    }
  }, [resources.isOpen]);

  useEffect(() => {
    setSelectedPaths([]);
    setConfirmRemoval(false);
  }, [resources.cachePage?.cacheDigest]);

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
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
        ),
      ).filter(element => {
        if (element.matches(':disabled') || element.tabIndex < 0 || element.closest('[inert], [aria-hidden="true"]')) {
          return false;
        }
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
      else {
        Array.from(document.querySelectorAll<HTMLElement>('.menu-button'))
          .find(button => button.textContent?.trim() === 'Tools')
          ?.focus();
      }
    };
  }, [resources.isOpen, resources.focusReturnRef]);

  useEffect(() => {
    if (
      resources.isOpen
      && activeTab === 'cache'
      && resources.isPlanFresh
      && !resources.cachePage
      && !resources.isCachePageLoading
      && !resources.isRemovingResources
      && !resources.cacheError
    ) {
      void resources.loadCachePage(null, true);
    }
  }, [
    activeTab,
    resources.cacheError,
    resources.cachePage,
    resources.isCachePageLoading,
    resources.isOpen,
    resources.isPlanFresh,
    resources.isRemovingResources,
    resources.loadCachePage,
  ]);

  useEffect(() => {
    if (
      resources.isOpen
      && activeTab === 'project'
      && isInspectOpen
      && resources.isPlanFresh
      && !resources.resourcePage
      && !resources.isResourcePageLoading
      && !resources.resourcePageError
    ) {
      void resources.loadResourcePage();
    }
  }, [
    activeTab,
    isInspectOpen,
    resources.isOpen,
    resources.isPlanFresh,
    resources.isResourcePageLoading,
    resources.loadResourcePage,
    resources.resourcePage,
    resources.resourcePageError,
  ]);

  const completedPaths = useMemo(() => new Set(resources.completedPaths), [resources.completedPaths]);

  if (!resources.isOpen) return null;

  const plan = resources.plan;
  const resolvedEngine = engine ?? plan?.engine ?? 'latex';
  const isTypst = resolvedEngine === 'typst';
  const summary = plan?.summary;
  const metadataInvalid = plan?.bundleMetadataState === 'invalid';
  const metadataMissing = plan?.bundleMetadataState === 'missing';
  const hasInvalidFiles = (summary?.invalidResources ?? 0) > 0;
  const hasMissingFiles = (summary?.missingResources ?? 0) > 0;
  const metadataOnly = Boolean(metadataMissing && !hasMissingFiles && !hasInvalidFiles);
  const blocked = !isTypst && (metadataInvalid || plan?.projectState === 'blocked');
  const needsPreparation = !isTypst && (hasMissingFiles || hasInvalidFiles || metadataMissing);
  const cancelled = !isTypst && resources.progress?.status?.toLowerCase() === 'cancelled' && needsPreparation;
  const ready = isTypst || Boolean(plan && !blocked && !needsPreparation);
  const canPrepare = Boolean(
    !isTypst && plan && resources.isPlanFresh && needsPreparation && !blocked && !resources.activeJobId && !resources.isAnalyzing,
  );
  const rows = requirementRows(resources.resourcePage);
  const directRows = rows.filter(row => row.evidence.some(evidence => evidence.kind === 'detected'));
  const transitiveRows = rows.filter(row => !row.evidence.some(evidence => evidence.kind === 'detected'));
  const unknownItems = mergeUnknownItems(plan, resources.resourcePage);
  const { projectUnknowns, catalogUnknowns } = partitionUnknownItems(unknownItems, rows, plan?.mainFile);
  const planOnlyPartition = plan && (plan.unknownOmitted ?? 0) === 0
    ? partitionUnknownItems(plan.unknown ?? [], rows, plan.mainFile)
    : null;
  const unknownCount = planOnlyPartition
    ? planOnlyPartition.projectUnknowns.length
    : (summary?.unresolvedCount ?? 0);

  const statusText = (() => {
    if (isTypst) return 'Typst Engine Ready';
    if (resources.activeJobId) return friendlyPhase(resources.progress?.phase, resources.progress?.status);
    if (resources.isAnalyzing || !plan || !resources.isPlanFresh) {
      return resources.errorAction === 'check' && resources.error
        ? 'Could not check project resources'
        : 'Checking project resources…';
    }
    if (metadataInvalid) return 'Resource information could not be verified';
    if (blocked) return 'Project resources are unavailable';
    if (resources.error && resources.errorAction === 'prepare') return 'The download did not finish';
    if (ready) return 'Detected resources are ready';
    if (cancelled) return 'Download paused';
    if (metadataOnly) return 'Bundle setup is needed';
    if (needsPreparation) {
      return hasInvalidFiles
        ? `${summary?.invalidResources ?? 0} ${summary?.invalidResources === 1 ? 'file needs' : 'files need'} repairing`
        : `${summary?.missingResources ?? 0} ${summary?.missingResources === 1 ? 'file needs' : 'files need'} downloading`;
    }
    return 'Checking project resources…';
  })();

  const statusToneClass = (() => {
    if (isTypst) return 'is-ready';
    if (blocked || resources.error) return 'is-invalid';
    if (ready && !resources.isAnalyzing && resources.isPlanFresh) return 'is-ready';
    if (needsPreparation || cancelled) return 'is-warning';
    return '';
  })();

  const primaryLabel = (() => {
    if (isTypst) return 'Done';
    if (resources.isAnalyzing || !plan || !resources.isPlanFresh) return resources.error ? 'Try again' : 'Checking…';
    if (blocked) return 'Unavailable';
    if (resources.error) return 'Try again';
    if (cancelled) return 'Resume download';
    if (canPrepare) return metadataOnly ? 'Finish setup' : 'Download required files';
    if (ready) return 'Done';
    return 'Checking…';
  })();

  const primaryDisabled = isTypst
    ? false
    : resources.activeJobId
      ? true
      : resources.isAnalyzing || blocked || (!ready && !canPrepare && !resources.error);

  const progressTotal = resources.progress?.totalResources ?? 0;
  const progressCompleted = resources.progress?.completedResources ?? 0;
  const progressPercent = progressTotal > 0 ? Math.min(100, Math.round((progressCompleted / progressTotal) * 100)) : null;

  const errorText = resources.errorAction === 'prepare'
    ? 'The download could not be completed. You can try again.'
    : 'Project resources could not be checked. You can try again.';

  const onPrimary = () => {
    if (isTypst || (ready && !resources.error)) {
      onClose();
      return;
    }
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

  const handleDownloadAndRecompile = async () => {
    const ok = await resources.prepare();
    if (ok) {
      onClose();
      onRecompile?.();
    }
  };

  const currentCachePage = resources.isPlanFresh ? resources.cachePage : null;
  const cacheSummary = currentCachePage?.summary;
  const installedBytes = cacheSummary?.installedBytes ?? 0;
  const embeddedBytes = cacheSummary?.embeddedBytes ?? 0;
  const metadataAndOtherBytes = (cacheSummary?.metadataBytes ?? 0) + (cacheSummary?.otherBytes ?? 0);
  const totalStorageBytes = installedBytes + embeddedBytes + metadataAndOtherBytes;
  const segmentPercent = (value: number) => (totalStorageBytes > 0 ? (value / totalStorageBytes) * 100 : 0);

  const normalizedFilter = cacheFilter.trim().toLocaleLowerCase();
  const visibleCacheItems = (currentCachePage?.items ?? []).filter(item =>
    normalizedFilter ? item.path.toLocaleLowerCase().includes(normalizedFilter) : true,
  );
  const selectableCount = currentCachePage?.items.filter(item => item.removable && !item.requiredByProject).length ?? 0;

  const toggleSelected = (path: string) => {
    setSelectedPaths(current => (current.includes(path) ? current.filter(value => value !== path) : [...current, path]));
  };

  const renderInspectRequirement = (row: ResourceRequirement) => {
    const path = row.path ?? row.id;
    const downloaded = Boolean(row.path && completedPaths.has(row.path));
    const preparing = Boolean(
      resources.activeJobId && !downloaded && (row.availability === 'missing' || row.availability === 'invalid'),
    );
    const tone = availabilityTone(row.availability, downloaded, preparing);
    const firstEvidence = row.evidence.find(item => item.file);
    const locationLabel = firstEvidence?.file
      ? `${firstEvidence.file}${firstEvidence.line != null ? `:${firstEvidence.line}` : ''}`
      : null;
    const canJump = Boolean(
      firstEvidence?.file && onSelectLine && isProjectFileJumpable(firstEvidence.file, rows, plan?.mainFile),
    );

    return (
      <li className="project-resources-inspect-row" key={`${row.id}:${row.path ?? ''}`}>
        <span className={`project-resources-dot is-${tone}`} aria-hidden="true" />
        <span className="project-resources-inspect-label" title={path}>
          {row.label || path}
        </span>
        {firstEvidence?.file && canJump && onSelectLine ? (
          <button
            type="button"
            className="project-resources-jump-link"
            onClick={() => onSelectLine(firstEvidence.line ?? 1, firstEvidence.file)}
            title={`Jump to ${locationLabel}`}
          >
            {locationLabel}
          </button>
        ) : locationLabel ? (
          <span className="project-resources-location-text" title={locationLabel}>
            {locationLabel}
          </span>
        ) : null}
        <span className={`project-resources-pill is-${tone}`}>
          {preparing ? 'Preparing' : availabilityLabel(row.availability, downloaded)}
        </span>
      </li>
    );
  };

  return (
    <div
      className="project-resources-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
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
          <div className="project-resources-header-left">
            <div className="project-resources-title-line">
              <Package size={18} aria-hidden="true" />
              <h2 id="project-resources-title">Project Resources</h2>
              <span className={`project-resources-engine-pill is-${resolvedEngine}`}>
                {resolvedEngine === 'typst' ? 'TYPST' : 'LATEX'}
              </span>
            </div>
            <p id="project-resources-description">{projectName || 'Untitled project'}</p>
          </div>
          <button
            type="button"
            ref={closeButtonRef}
            className="project-resources-icon-button"
            aria-label="Close Project Resources"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        <div className="project-resources-tabs" role="tablist" aria-label="Project resource views">
          <button
            type="button"
            role="tab"
            id="project-resources-tab-project"
            aria-selected={activeTab === 'project'}
            aria-controls="project-resources-panel-project"
            className={`project-resources-tab ${activeTab === 'project' ? 'active' : ''}`}
            onClick={() => setActiveTab('project')}
          >
            <Package size={14} aria-hidden="true" />
            <span>Project</span>
          </button>
          <button
            type="button"
            role="tab"
            id="project-resources-tab-cache"
            aria-selected={activeTab === 'cache'}
            aria-controls="project-resources-panel-cache"
            className={`project-resources-tab ${activeTab === 'cache' ? 'active' : ''}`}
            onClick={() => setActiveTab('cache')}
          >
            <HardDrive size={14} aria-hidden="true" />
            <span>Shared Cache</span>
          </button>
        </div>

        {activeTab === 'project' ? (
          <>
            <div
              id="project-resources-panel-project"
              role="tabpanel"
              aria-labelledby="project-resources-tab-project"
              className="project-resources-body"
            >
              {isTypst ? (
                <section className="project-resources-status-card is-ready" aria-label="Project resource status">
                  <div className="project-resources-main-status" role="status" aria-live="polite">
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <strong>Typst Engine Ready</strong>
                  </div>
                  <p className="project-resources-note">
                    Typst assets and system fonts are bundled with ScienceBatch. No package downloads are needed.
                  </p>
                  <div className="project-resources-metrics">
                    <div className="project-resources-metric">
                      <span>Engine</span>
                      <strong>Built-in</strong>
                    </div>
                    <div className="project-resources-metric">
                      <span>Local files</span>
                      <strong>{resources.isAnalyzing || !plan ? 'Checking…' : `${summary?.totalResources ?? 0} files`}</strong>
                    </div>
                    <div className="project-resources-metric">
                      <span>Unresolved</span>
                      <strong>
                        {resources.isAnalyzing || !plan
                          ? 'Checking…'
                          : unknownCount > 0
                            ? `${unknownCount} dynamic`
                            : 'None'}
                      </strong>
                    </div>
                  </div>
                </section>
              ) : (
                <section className={`project-resources-status-card ${statusToneClass}`} aria-label="Project resource status">
                  <div className="project-resources-main-status" role="status" aria-live="polite">
                    {resources.isAnalyzing || resources.activeJobId ? (
                      <Loader2 className="spin" size={18} aria-hidden="true" />
                    ) : blocked || resources.error ? (
                      <AlertCircle size={18} aria-hidden="true" />
                    ) : ready ? (
                      <CheckCircle2 size={18} aria-hidden="true" />
                    ) : needsPreparation ? (
                      <AlertTriangle size={18} aria-hidden="true" />
                    ) : (
                      <CircleDashed size={18} aria-hidden="true" />
                    )}
                    <strong>{statusText}</strong>
                  </div>

                  <div className="project-resources-metrics">
                    <div className="project-resources-metric">
                      <span>Required</span>
                      <strong>{resources.isAnalyzing || !plan ? 'Checking…' : `${summary?.totalResources ?? 0} files`}</strong>
                    </div>
                    <div className="project-resources-metric">
                      <span>Download</span>
                      <strong>
                        {resources.isAnalyzing || !plan ? 'Checking…' : formatBytes(summary?.estimatedTransferBytes)}
                      </strong>
                    </div>
                    <div className="project-resources-metric">
                      <span>Unresolved</span>
                      <strong>
                        {resources.isAnalyzing || !plan
                          ? 'Checking…'
                          : unknownCount > 0
                            ? `${unknownCount} dynamic`
                            : 'None'}
                      </strong>
                    </div>
                  </div>

                  {resources.activeJobId && (
                    <div className="project-resources-progress" role="status" aria-live="polite">
                      <div className="project-resources-progress-copy">
                        <strong>{friendlyPhase(resources.progress?.phase, resources.progress?.status)}</strong>
                        <span>
                          {progressPercent != null ? `${progressCompleted} of ${progressTotal} files` : 'Working…'}
                          {resources.progress?.downloadedBytes != null
                            ? ` · ${formatBytes(resources.progress.downloadedBytes)}`
                            : ''}
                        </span>
                      </div>
                      {progressPercent != null && (
                        <div
                          className="project-resources-progress-track"
                          role="progressbar"
                          aria-label="Download progress"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={progressPercent}
                        >
                          <span style={{ width: `${progressPercent}%` }} />
                        </div>
                      )}
                      <button
                        type="button"
                        className="project-resources-cancel"
                        onClick={() => void resources.cancel()}
                        disabled={resources.progress?.status?.toLowerCase() === 'cancelling'}
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  {!resources.activeJobId && resources.error && (
                    <p className="project-resources-friendly-error" role="alert">
                      {errorText}
                    </p>
                  )}
                  {!resources.activeJobId && metadataInvalid && (
                    <p className="project-resources-friendly-error" role="alert">
                      Resource information could not be verified, so downloads are unavailable.
                    </p>
                  )}
                  {!resources.activeJobId && blocked && !metadataInvalid && (
                    <p className="project-resources-friendly-error" role="alert">
                      Resources cannot be prepared for this project right now.
                    </p>
                  )}
                  {!resources.activeJobId && cancelled && (
                    <p className="project-resources-note">The download was paused. You can resume it now.</p>
                  )}
                  {!resources.activeJobId && metadataOnly && !metadataInvalid && (
                    <p className="project-resources-note">All files are already downloaded. No download is needed.</p>
                  )}
                  {!resources.activeJobId && ready && !resources.error && (
                    <p className="project-resources-note">You can compile this project now.</p>
                  )}
                  {resources.recoveryPaths.length > 0 && (
                    <p className="project-resources-note">
                      Includes possible files identified during the last compile.
                    </p>
                  )}
                  {unknownCount > 0 && (
                    <p className="project-resources-note">
                      Some dynamic references can only be checked when you compile.
                    </p>
                  )}
                </section>
              )}

              <details
                className="project-resources-details"
                open={isInspectOpen}
                onToggle={event => {
                  const opened = event.currentTarget.open;
                  setIsInspectOpen(opened);
                  if (
                    opened
                    && resources.isPlanFresh
                    && !resources.resourcePage
                    && !resources.isResourcePageLoading
                    && !resources.resourcePageError
                  ) {
                    void resources.loadResourcePage();
                  }
                }}
              >
                <summary>
                  <span>Inspect detected files</span>
                  {summary ? <span className="project-resources-details-count">{summary.totalResources}</span> : null}
                </summary>
                <div className="project-resources-details-body">
                  {resources.resourcePageError && (
                    <p className="project-resources-friendly-error" role="alert">
                      Detected files could not be loaded.{' '}
                      <button
                        type="button"
                        className="project-resources-inline-link"
                        onClick={() => void resources.loadResourcePage(null, true)}
                      >
                        Retry
                      </button>
                    </p>
                  )}
                  {resources.isAnalyzing || (resources.isResourcePageLoading && !resources.resourcePage) ? (
                    <p className="project-resources-muted">Loading detected files…</p>
                  ) : (
                    <>
                      {directRows.length > 0 && (
                        <div className="project-resources-inspect-group">
                          <h4>Direct dependencies</h4>
                          <ul>{directRows.map(renderInspectRequirement)}</ul>
                        </div>
                      )}
                      {projectUnknowns.length > 0 && (
                        <div className="project-resources-inspect-group">
                          <h4>Unresolved references</h4>
                          <ul>
                            {projectUnknowns.map(item => {
                              const trimmedExpression = item.expression?.trim() ?? '';
                              const reasonLabel = friendlyUnknownReason(item.reason);
                              const locationLabel = item.file
                                ? `${item.file}${item.line != null ? `:${item.line}` : ''}`
                                : null;
                              const canJump = Boolean(
                                item.file && onSelectLine && isProjectFileJumpable(item.file, rows, plan?.mainFile),
                              );

                              return (
                                <li
                                  className="project-resources-inspect-row"
                                  key={`${item.id}:${item.expression}:${item.file ?? ''}:${item.line ?? ''}`}
                                >
                                  <span className="project-resources-dot is-missing" aria-hidden="true" />
                                  <span
                                    className="project-resources-inspect-label"
                                    title={trimmedExpression || reasonLabel}
                                  >
                                    {trimmedExpression ? <code>{trimmedExpression}</code> : <em>Dynamic expression</em>}
                                  </span>
                                  {item.file && canJump && onSelectLine ? (
                                    <button
                                      type="button"
                                      className="project-resources-jump-link"
                                      onClick={() => onSelectLine(item.line ?? 1, item.file)}
                                      title={`Jump to ${locationLabel}`}
                                    >
                                      {locationLabel}
                                    </button>
                                  ) : locationLabel ? (
                                    <span className="project-resources-location-text" title={locationLabel}>
                                      {locationLabel}
                                    </span>
                                  ) : null}
                                  <span className="project-resources-pill is-neutral" title={reasonLabel}>
                                    {reasonLabel}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                      {(transitiveRows.length > 0 || catalogUnknowns.length > 0) && (
                        <p className="project-resources-muted">
                          Supporting resources:{' '}
                          {[
                            transitiveRows.length > 0
                              ? `${transitiveRows.length} transitive ${transitiveRows.length === 1 ? 'file' : 'files'}`
                              : null,
                            catalogUnknowns.length > 0
                              ? `${catalogUnknowns.length} package-internal dynamic ${catalogUnknowns.length === 1 ? 'hook' : 'hooks'}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                      {directRows.length === 0
                        && projectUnknowns.length === 0
                        && transitiveRows.length === 0
                        && catalogUnknowns.length === 0 && (
                        <p className="project-resources-muted">No detected resource files.</p>
                      )}
                      {resources.resourcePage?.nextCursor && (
                        <button
                          type="button"
                          className="project-resources-load-more"
                          disabled={resources.isResourcePageLoading}
                          onClick={() => void resources.loadResourcePage(resources.resourcePage?.nextCursor ?? null)}
                        >
                          {resources.isResourcePageLoading ? 'Loading…' : 'Load more detected files'}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </details>
            </div>

            <footer className="project-resources-footer">
              <button type="button" className="project-resources-secondary" onClick={onClose}>
                Close
              </button>
              {!resources.activeJobId && (
                <div className="project-resources-footer-actions">
                  {!isTypst && onRecompile && canPrepare && resources.recoveryPaths.length > 0 && (
                    <button
                      type="button"
                      className="project-resources-secondary"
                      onClick={() => void handleDownloadAndRecompile()}
                    >
                      <RefreshCw size={14} aria-hidden="true" />
                      <span>Download &amp; Recompile</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="project-resources-primary"
                    onClick={onPrimary}
                    disabled={primaryDisabled}
                  >
                    {!isTypst && (resources.isAnalyzing || !plan) ? (
                      <Loader2 className="spin" size={15} aria-hidden="true" />
                    ) : !isTypst && canPrepare ? (
                      <Download size={15} aria-hidden="true" />
                    ) : null}
                    <span>{primaryLabel}</span>
                  </button>
                </div>
              )}
            </footer>
          </>
        ) : (
          <>
            <div
              id="project-resources-panel-cache"
              role="tabpanel"
              aria-labelledby="project-resources-tab-cache"
              className="project-resources-body"
            >
              <section className="project-resources-storage-card" aria-label="Shared cache summary">
                <div className="project-resources-storage-bar" aria-hidden="true">
                  {installedBytes > 0 && (
                    <span
                      className="is-installed"
                      style={{ width: `${Math.max(4, segmentPercent(installedBytes))}%` }}
                    />
                  )}
                  {embeddedBytes > 0 && (
                    <span
                      className="is-embedded"
                      style={{ width: `${Math.max(4, segmentPercent(embeddedBytes))}%` }}
                    />
                  )}
                  {metadataAndOtherBytes > 0 && (
                    <span
                      className="is-metadata"
                      style={{ width: `${Math.max(3, segmentPercent(metadataAndOtherBytes))}%` }}
                    />
                  )}
                </div>

                <div className="project-resources-storage-legend">
                  <div className="project-resources-legend-item">
                    <span className="project-resources-legend-label">
                      <i className="is-installed" aria-hidden="true" />
                      Downloaded
                    </span>
                    <strong>
                      {cacheSummary?.installedFiles ?? 0} files · {formatBytes(cacheSummary?.installedBytes)}
                    </strong>
                  </div>
                  <div className="project-resources-legend-item">
                    <span className="project-resources-legend-label">
                      <i className="is-embedded" aria-hidden="true" />
                      Built-in starter
                    </span>
                    <strong>
                      {cacheSummary?.embeddedFiles ?? 0} files · {formatBytes(cacheSummary?.embeddedBytes)}
                    </strong>
                  </div>
                  <div className="project-resources-legend-item">
                    <span className="project-resources-legend-label">
                      <i className="is-metadata" aria-hidden="true" />
                      Metadata &amp; formats
                    </span>
                    <strong>{formatBytes(metadataAndOtherBytes)}</strong>
                  </div>
                </div>

                <p className="project-resources-note">
                  Shared across LaTeX projects. Files used by this project and built-in app resources are protected.
                </p>
              </section>

              <div className="project-resources-filter-box">
                <Search size={14} className="project-resources-filter-icon" aria-hidden="true" />
                <input
                  type="text"
                  className="project-resources-filter-input"
                  aria-label="Filter loaded files"
                  placeholder="Filter cached paths…"
                  value={cacheFilter}
                  onChange={event => setCacheFilter(event.target.value)}
                />
                {cacheFilter && (
                  <button
                    type="button"
                    className="project-resources-filter-clear"
                    aria-label="Clear cache filter"
                    onClick={() => setCacheFilter('')}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>

              {resources.cacheError && (
                <p className="project-resources-friendly-error" role="alert">
                  {cacheErrorMessage(resources.cacheError.code)}{' '}
                  <button
                    type="button"
                    className="project-resources-inline-link"
                    onClick={() => void resources.loadCachePage(null, true)}
                  >
                    Reload inventory
                  </button>
                </p>
              )}

              {resources.cacheRemovalResult && (
                <p className="project-resources-removal-result" role="status">
                  Removed {resources.cacheRemovalResult.removedFiles}{' '}
                  {resources.cacheRemovalResult.removedFiles === 1 ? 'file' : 'files'} ·{' '}
                  {formatBytes(resources.cacheRemovalResult.removedBytes)}
                </p>
              )}

              <div className="project-resources-cache-list" aria-live="polite">
                {!resources.isPlanFresh ? (
                  <p className="project-resources-muted">Waiting for current project analysis…</p>
                ) : resources.isCachePageLoading && !currentCachePage ? (
                  <p className="project-resources-muted">Loading installed resources…</p>
                ) : visibleCacheItems.length === 0 ? (
                  <p className="project-resources-muted">No matching installed files in the loaded list.</p>
                ) : (
                  visibleCacheItems.map(item => {
                    const { fileName, dirPath } = splitCachePath(item.path);
                    const isChecked = selectedPaths.includes(item.path);
                    const isProtected = item.requiredByProject || !item.removable;
                    const disabled =
                      Boolean(resources.activeJobId || resources.isRemovingResources)
                      || isProtected
                      || (!isChecked && selectedPaths.length >= 200);

                    return (
                      <label className="project-resources-cache-row" key={item.path} title={item.path}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={disabled}
                          onChange={() => toggleSelected(item.path)}
                        />
                        <div className="project-resources-cache-path">
                          <strong className="project-resources-cache-name">{fileName}</strong>
                          {dirPath && <span className="project-resources-cache-dir">{dirPath}</span>}
                        </div>
                        {item.requiredByProject ? (
                          <span className="project-resources-cache-badge is-in-use">In use</span>
                        ) : !item.removable ? (
                          <span className="project-resources-cache-badge is-built-in">Built-in</span>
                        ) : null}
                        <span className="project-resources-cache-size">{formatBytes(item.bytes)}</span>
                      </label>
                    );
                  })
                )}

                {currentCachePage?.nextCursor && (
                  <button
                    type="button"
                    className="project-resources-load-more"
                    disabled={resources.isCachePageLoading}
                    onClick={() => void resources.loadCachePage(currentCachePage.nextCursor)}
                  >
                    {resources.isCachePageLoading ? 'Loading…' : 'Load more installed files'}
                  </button>
                )}
              </div>

              {confirmRemoval && (
                <div className="project-resources-confirm" role="alertdialog" aria-label="Confirm resource removal">
                  <strong>
                    Remove {selectedPaths.length} selected {selectedPaths.length === 1 ? 'file' : 'files'}?
                  </strong>
                  <span>
                    They will be removed from the shared cache and may be downloaded again by other projects.
                  </span>
                </div>
              )}
            </div>

            <footer className="project-resources-footer is-cache-footer">
              {confirmRemoval ? (
                <>
                  <button
                    type="button"
                    className="project-resources-secondary"
                    onClick={() => setConfirmRemoval(false)}
                  >
                    Keep files
                  </button>
                  <button
                    type="button"
                    className="project-resources-danger"
                    disabled={
                      selectedPaths.length === 0
                      || selectedPaths.length > 200
                      || Boolean(resources.activeJobId || resources.isRemovingResources)
                    }
                    onClick={() => {
                      void resources.removeCachedResources(selectedPaths);
                      setSelectedPaths([]);
                      setConfirmRemoval(false);
                    }}
                  >
                    {resources.isRemovingResources ? 'Removing…' : 'Remove selected files'}
                  </button>
                </>
              ) : (
                <>
                  <span className="project-resources-selection-summary">
                    {selectedPaths.length} selected
                    {selectableCount > 0 ? ` · ${selectableCount} removable on this page` : ''}
                  </span>
                  <div className="project-resources-footer-actions">
                    <button type="button" className="project-resources-secondary" onClick={onClose}>
                      Done
                    </button>
                    <button
                      type="button"
                      className="project-resources-cancel"
                      disabled={
                        !selectedPaths.length
                        || selectedPaths.length > 200
                        || Boolean(resources.activeJobId || resources.isRemovingResources)
                      }
                      onClick={() => setConfirmRemoval(true)}
                    >
                      Remove selected
                    </button>
                  </div>
                </>
              )}
            </footer>
          </>
        )}
      </section>
    </div>
  );
};
