import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation(['resources', 'common']);
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
          .find(button => button.dataset.menuId === 'tools')
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
    if (isTypst) return t('resources:dialog.typstReadyTitle');
    if (resources.activeJobId) return friendlyPhase(resources.progress?.phase, resources.progress?.status);
    if (resources.isAnalyzing || !plan || !resources.isPlanFresh) {
      return resources.errorAction === 'check' && resources.error
        ? t('resources:dialog.status.checkFailed')
        : t('resources:dialog.status.checking');
    }
    if (metadataInvalid) return t('resources:dialog.status.notVerified');
    if (blocked) return t('resources:dialog.status.unavailable');
    if (resources.error && resources.errorAction === 'prepare') return t('resources:dialog.status.downloadFailed');
    if (ready) return t('resources:phases.finished');
    if (cancelled) return t('resources:phases.cancelled');
    if (metadataOnly) return t('resources:dialog.status.bundleSetupNeeded');
    if (needsPreparation) {
      return hasInvalidFiles
        ? t('resources:dialog.status.repairNeeded', { count: summary?.invalidResources ?? 0 })
        : t('resources:dialog.status.downloadNeeded', { count: summary?.missingResources ?? 0 });
    }
    return t('resources:dialog.status.checking');
  })();

  const statusToneClass = (() => {
    if (isTypst) return 'is-ready';
    if (blocked || resources.error) return 'is-invalid';
    if (ready && !resources.isAnalyzing && resources.isPlanFresh) return 'is-ready';
    if (needsPreparation || cancelled) return 'is-warning';
    return '';
  })();

  const primaryLabel = (() => {
    if (isTypst) return t('common:actions.done');
    if (resources.isAnalyzing || !plan || !resources.isPlanFresh) return resources.error ? t('resources:common.tryAgain') : t('resources:common.checking');
    if (blocked) return t('resources:common.unavailable');
    if (resources.error) return t('resources:common.tryAgain');
    if (cancelled) return t('resources:common.resumeDownload');
    if (canPrepare) return metadataOnly ? t('resources:common.finishSetup') : t('resources:common.downloadRequiredFiles');
    if (ready) return t('common:actions.done');
    return t('resources:common.checking');
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
    ? t('resources:dialog.errors.prepareFailed')
    : t('resources:dialog.errors.checkFailed');

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
  const loadedCacheItems = currentCachePage?.items ?? [];
  const visibleCacheItems = loadedCacheItems.filter(item =>
    normalizedFilter ? item.path.toLocaleLowerCase().includes(normalizedFilter) : true,
  );
  const selectableCount = loadedCacheItems.filter(item => item.removable && !item.requiredByProject).length;
  const isWindowsPlatform = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
  const isReadOnlyCache =
    isWindowsPlatform && loadedCacheItems.length > 0 && loadedCacheItems.every(item => !item.removable);

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
            title={t('resources:common.jumpTo', { location: locationLabel })}
          >
            {locationLabel}
          </button>
        ) : locationLabel ? (
          <span className="project-resources-location-text" title={locationLabel}>
            {locationLabel}
          </span>
        ) : null}
        <span className={`project-resources-pill is-${tone}`}>
          {preparing ? t('resources:dialog.inspect.preparing') : availabilityLabel(row.availability, downloaded)}
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
              <h2 id="project-resources-title">{t('resources:dialog.title')}</h2>
              <span className={`project-resources-engine-pill is-${resolvedEngine}`}>
                {resolvedEngine === 'typst' ? 'TYPST' : 'LATEX'}
              </span>
            </div>
            <p id="project-resources-description">{projectName || t('resources:dialog.untitledProject')}</p>
          </div>
          <button
            type="button"
            ref={closeButtonRef}
            className="project-resources-icon-button"
            aria-label={t('resources:dialog.closeAria')}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        <div className="project-resources-tabs" role="tablist" aria-label={t('resources:dialog.tabsAria')}>
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
            <span>{t('resources:dialog.projectTab')}</span>
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
            <span>{t('resources:dialog.cacheTab')}</span>
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
                <section className="project-resources-status-card is-ready" aria-label={t('resources:dialog.statusAria')}>
                  <div className="project-resources-main-status" role="status" aria-live="polite">
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <strong>{t('resources:dialog.typstReadyTitle')}</strong>
                  </div>
                  <p className="project-resources-note">
                    {t('resources:dialog.typstNote')}
                  </p>
                  <div className="project-resources-metrics">
                    <div className="project-resources-metric">
                      <span>{t('resources:dialog.engineLabel')}</span>
                      <strong>{t('resources:availability.builtIn')}</strong>
                    </div>
                    <div className="project-resources-metric">
                      <span>{t('resources:dialog.localFilesLabel')}</span>
                      <strong>{resources.isAnalyzing || !plan ? t('resources:common.checking') : t('resources:common.fileCount', { count: summary?.totalResources ?? 0 })}</strong>
                    </div>
                    <div className="project-resources-metric">
                      <span>{t('resources:dialog.unresolvedLabel')}</span>
                      <strong>
                        {resources.isAnalyzing || !plan
                          ? t('resources:common.checking')
                          : unknownCount > 0
                            ? t('resources:dialog.dynamicCount', { count: unknownCount })
                            : t('resources:dialog.none')}
                      </strong>
                    </div>
                  </div>
                </section>
              ) : (
                <section className={`project-resources-status-card ${statusToneClass}`} aria-label={t('resources:dialog.statusAria')}>
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
                      <span>{t('resources:dialog.requiredLabel')}</span>
                      <strong>{resources.isAnalyzing || !plan ? t('resources:common.checking') : t('resources:common.fileCount', { count: summary?.totalResources ?? 0 })}</strong>
                    </div>
                    <div className="project-resources-metric">
                      <span>{t('resources:dialog.downloadLabel')}</span>
                      <strong>
                        {resources.isAnalyzing || !plan ? t('resources:common.checking') : formatBytes(summary?.estimatedTransferBytes)}
                      </strong>
                    </div>
                    <div className="project-resources-metric">
                      <span>{t('resources:dialog.unresolvedLabel')}</span>
                      <strong>
                        {resources.isAnalyzing || !plan
                          ? t('resources:common.checking')
                          : unknownCount > 0
                            ? t('resources:dialog.dynamicCount', { count: unknownCount })
                            : t('resources:dialog.none')}
                      </strong>
                    </div>
                  </div>

                  {resources.activeJobId && (
                    <div className="project-resources-progress" role="status" aria-live="polite">
                      <div className="project-resources-progress-copy">
                        <strong>{friendlyPhase(resources.progress?.phase, resources.progress?.status)}</strong>
                        <span>
                          {progressPercent != null
                            ? t('resources:dialog.progress.files', { completed: progressCompleted, total: progressTotal })
                            : t('resources:dialog.progress.working')}
                          {resources.progress?.downloadedBytes != null
                            ? ` · ${formatBytes(resources.progress.downloadedBytes)}`
                            : ''}
                        </span>
                      </div>
                      {progressPercent != null && (
                        <div
                          className="project-resources-progress-track"
                          role="progressbar"
                          aria-label={t('resources:dialog.progress.ariaLabel')}
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
                        {t('common:actions.cancel')}
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
                      {t('resources:dialog.errors.notVerifiedNote')}
                    </p>
                  )}
                  {!resources.activeJobId && blocked && !metadataInvalid && (
                    <p className="project-resources-friendly-error" role="alert">
                      {t('resources:dialog.errors.blockedNote')}
                    </p>
                  )}
                  {!resources.activeJobId && cancelled && (
                    <p className="project-resources-note">{t('resources:dialog.notes.paused')}</p>
                  )}
                  {!resources.activeJobId && metadataOnly && !metadataInvalid && (
                    <p className="project-resources-note">{t('resources:dialog.notes.metadataOnly')}</p>
                  )}
                  {!resources.activeJobId && ready && !resources.error && (
                    <p className="project-resources-note">{t('resources:dialog.notes.ready')}</p>
                  )}
                  {resources.recoveryPaths.length > 0 && (
                    <p className="project-resources-note">
                      {t('resources:dialog.notes.recoveryPaths')}
                    </p>
                  )}
                  {unknownCount > 0 && (
                    <p className="project-resources-note">
                      {t('resources:dialog.notes.dynamicCompileCheck')}
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
                  <span>{t('resources:dialog.inspect.summary')}</span>
                  {summary ? <span className="project-resources-details-count">{summary.totalResources}</span> : null}
                </summary>
                <div className="project-resources-details-body">
                  {resources.resourcePageError && (
                    <p className="project-resources-friendly-error" role="alert">
                      {t('resources:dialog.inspect.loadError')}{' '}
                      <button
                        type="button"
                        className="project-resources-inline-link"
                        onClick={() => void resources.loadResourcePage(null, true)}
                      >
                        {t('common:actions.retry')}
                      </button>
                    </p>
                  )}
                  {resources.isAnalyzing || (resources.isResourcePageLoading && !resources.resourcePage) ? (
                    <p className="project-resources-muted">{t('resources:dialog.inspect.loading')}</p>
                  ) : (
                    <>
                      {directRows.length > 0 && (
                        <div className="project-resources-inspect-group">
                          <h4>{t('resources:dialog.inspect.directHeading')}</h4>
                          <ul>{directRows.map(renderInspectRequirement)}</ul>
                        </div>
                      )}
                      {projectUnknowns.length > 0 && (
                        <div className="project-resources-inspect-group">
                          <h4>{t('resources:dialog.inspect.unresolvedHeading')}</h4>
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
                                    {trimmedExpression ? <code>{trimmedExpression}</code> : <em>{t('resources:common.dynamicExpression')}</em>}
                                  </span>
                                  {item.file && canJump && onSelectLine ? (
                                    <button
                                      type="button"
                                      className="project-resources-jump-link"
                                      onClick={() => onSelectLine(item.line ?? 1, item.file)}
                                      title={t('resources:common.jumpTo', { location: locationLabel })}
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
                          {t('resources:common.supportingSummary', {
                            details: [
                              transitiveRows.length > 0
                                ? t('resources:common.transitiveFiles', { count: transitiveRows.length })
                                : null,
                              catalogUnknowns.length > 0
                                ? t('resources:common.catalogHooks', { count: catalogUnknowns.length })
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · '),
                          })}
                        </p>
                      )}
                      {directRows.length === 0
                        && projectUnknowns.length === 0
                        && transitiveRows.length === 0
                        && catalogUnknowns.length === 0 && (
                        <p className="project-resources-muted">{t('resources:dialog.inspect.noDetectedFiles')}</p>
                      )}
                      {resources.resourcePage?.nextCursor && (
                        <button
                          type="button"
                          className="project-resources-load-more"
                          disabled={resources.isResourcePageLoading}
                          onClick={() => void resources.loadResourcePage(resources.resourcePage?.nextCursor ?? null)}
                        >
                          {resources.isResourcePageLoading ? t('resources:common.loading') : t('resources:dialog.inspect.loadMore')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </details>
            </div>

            <footer className="project-resources-footer">
              <button type="button" className="project-resources-secondary" onClick={onClose}>
                {t('common:actions.close')}
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
                      <span>{t('resources:dialog.downloadAndRecompile')}</span>
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
              <section className="project-resources-storage-card" aria-label={t('resources:dialog.cache.summaryAria')}>
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
                      {t('resources:dialog.cache.downloaded')}
                    </span>
                    <strong>
                      {t('resources:dialog.cache.summaryItem', {
                        files: t('resources:common.fileCount', { count: cacheSummary?.installedFiles ?? 0 }),
                        size: formatBytes(cacheSummary?.installedBytes),
                      })}
                    </strong>
                  </div>
                  <div className="project-resources-legend-item">
                    <span className="project-resources-legend-label">
                      <i className="is-embedded" aria-hidden="true" />
                      {t('resources:dialog.cache.builtInStarter')}
                    </span>
                    <strong>
                      {t('resources:dialog.cache.summaryItem', {
                        files: t('resources:common.fileCount', { count: cacheSummary?.embeddedFiles ?? 0 }),
                        size: formatBytes(cacheSummary?.embeddedBytes),
                      })}
                    </strong>
                  </div>
                  <div className="project-resources-legend-item">
                    <span className="project-resources-legend-label">
                      <i className="is-metadata" aria-hidden="true" />
                      {t('resources:dialog.cache.metadataAndFormats')}
                    </span>
                    <strong>{formatBytes(metadataAndOtherBytes)}</strong>
                  </div>
                </div>

                <p className="project-resources-note">
                  {t('resources:dialog.cache.sharedNote')}
                </p>
                {isReadOnlyCache && (
                  <p className="project-resources-note project-resources-readonly-note">
                    {t('resources:dialog.cache.readOnlyNote')}
                  </p>
                )}
              </section>

              <div className="project-resources-filter-box">
                <Search size={14} className="project-resources-filter-icon" aria-hidden="true" />
                <input
                  type="text"
                  className="project-resources-filter-input"
                  aria-label={t('resources:dialog.cache.filterAria')}
                  placeholder={t('resources:dialog.cache.filterPlaceholder')}
                  value={cacheFilter}
                  onChange={event => setCacheFilter(event.target.value)}
                />
                {cacheFilter && (
                  <button
                    type="button"
                    className="project-resources-filter-clear"
                    aria-label={t('resources:dialog.cache.clearFilterAria')}
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
                    {t('resources:dialog.cache.reloadInventory')}
                  </button>
                </p>
              )}

              {resources.cacheRemovalResult && (
                <p className="project-resources-removal-result" role="status">
                  {t('resources:dialog.cache.removedResult', {
                    count: resources.cacheRemovalResult.removedFiles,
                    bytes: formatBytes(resources.cacheRemovalResult.removedBytes),
                  })}
                </p>
              )}

              <div className="project-resources-cache-list" aria-live="polite">
                {!resources.isPlanFresh ? (
                  <p className="project-resources-muted">{t('resources:dialog.cache.waitingAnalysis')}</p>
                ) : resources.isCachePageLoading && !currentCachePage ? (
                  <p className="project-resources-muted">{t('resources:dialog.cache.loadingInstalled')}</p>
                ) : visibleCacheItems.length === 0 ? (
                  <p className="project-resources-muted">{t('resources:dialog.cache.noMatchingInstalled')}</p>
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
                          <span className="project-resources-cache-badge is-in-use">{t('resources:dialog.cache.inUse')}</span>
                        ) : !item.removable ? (
                          isReadOnlyCache ? (
                            <span className="project-resources-cache-badge is-read-only">{t('resources:dialog.cache.readOnly')}</span>
                          ) : (
                            <span className="project-resources-cache-badge is-built-in">{t('resources:availability.builtIn')}</span>
                          )
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
                    {resources.isCachePageLoading ? t('resources:common.loading') : t('resources:dialog.cache.loadMore')}
                  </button>
                )}
              </div>

              {confirmRemoval && (
                <div className="project-resources-confirm" role="alertdialog" aria-label={t('resources:dialog.cache.confirmAria')}>
                  <strong>
                    {t('resources:dialog.cache.confirmTitle', { count: selectedPaths.length })}
                  </strong>
                  <span>
                    {t('resources:dialog.cache.confirmBody')}
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
                    {t('resources:dialog.cache.keepFiles')}
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
                    {resources.isRemovingResources ? t('resources:dialog.cache.removing') : t('resources:dialog.cache.removeSelectedFiles')}
                  </button>
                </>
              ) : (
                <>
                  <span className="project-resources-selection-summary">
                    {isReadOnlyCache
                      ? t('resources:dialog.cache.readOnlyNote')
                      : (
                        <>
                          {t('resources:dialog.cache.selectedCount', { count: selectedPaths.length })}
                          {selectableCount > 0 ? ` · ${t('resources:dialog.cache.removableCount', { count: selectableCount })}` : ''}
                        </>
                      )}
                  </span>
                  <div className="project-resources-footer-actions">
                    <button type="button" className="project-resources-secondary" onClick={onClose}>
                      {t('common:actions.done')}
                    </button>
                    <button
                      type="button"
                      className="project-resources-cancel"
                      disabled={
                        isReadOnlyCache
                        || !selectedPaths.length
                        || selectedPaths.length > 200
                        || Boolean(resources.activeJobId || resources.isRemovingResources)
                      }
                      title={
                        isReadOnlyCache
                          ? t('resources:dialog.cache.readOnlyNote')
                          : undefined
                      }
                      onClick={() => setConfirmRemoval(true)}
                    >
                      {t('resources:dialog.cache.removeSelected')}
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
