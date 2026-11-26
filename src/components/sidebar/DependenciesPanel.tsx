import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  HardDrive,
  Loader2,
  RotateCw,
  Search,
  X,
} from 'lucide-react';
import type { ResourceRequirement, ResourceUnknown } from '../../types/projectResources';
import {
  availabilityLabel,
  availabilityTone,
  formatBytes,
  friendlyUnknownReason,
  isProjectFileJumpable,
  mergeUnknownItems,
  partitionUnknownItems,
  requirementRows,
  type ResourcesModel,
} from '../resourceUtils';
import './dependencies.css';

interface DependenciesPanelProps {
  resources: ResourcesModel;
  onClose: () => void;
  onSelectLine?: (line: number, file?: string | null) => void;
  engine?: 'latex' | 'typst';
}

export const DependenciesPanel: React.FC<DependenciesPanelProps> = ({
  resources,
  onClose,
  onSelectLine,
  engine,
}) => {
  const { t } = useTranslation(['resources', 'common']);
  const [filter, setFilter] = useState('');

  const plan = resources.plan;
  const resolvedEngine = engine ?? plan?.engine ?? 'latex';
  const isTypst = resolvedEngine === 'typst';
  const summary = plan?.summary;

  const rows = useMemo(() => requirementRows(resources.resourcePage), [resources.resourcePage]);
  const completedPaths = useMemo(() => new Set(resources.completedPaths), [resources.completedPaths]);

  const isDirectRequirement = (row: ResourceRequirement) =>
    row.evidence.some(evidence => evidence.kind === 'detected');
  const directRows = useMemo(() => rows.filter(isDirectRequirement), [rows]);
  const transitiveRows = useMemo(() => rows.filter(row => !isDirectRequirement(row)), [rows]);
  const unknownItems = useMemo(
    () => mergeUnknownItems(plan, resources.resourcePage),
    [plan, resources.resourcePage],
  );
  const { projectUnknowns, catalogUnknowns } = useMemo(
    () => partitionUnknownItems(unknownItems, rows, plan?.mainFile),
    [unknownItems, rows, plan?.mainFile],
  );

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const matchesRequirement = (row: ResourceRequirement) => {
    if (!normalizedFilter) return true;
    return [row.label, row.path ?? '', row.id, ...row.parents]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedFilter);
  };
  const matchesUnknown = (item: ResourceUnknown) => {
    if (!normalizedFilter) return true;
    return [
      item.expression,
      item.reason,
      friendlyUnknownReason(item.reason),
      item.file ?? '',
      item.parent ?? '',
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedFilter);
  };

  const filteredDirectRows = useMemo(
    () => directRows.filter(matchesRequirement),
    [directRows, normalizedFilter],
  );
  const filteredTransitiveRows = useMemo(
    () => transitiveRows.filter(matchesRequirement),
    [transitiveRows, normalizedFilter],
  );
  const filteredProjectUnknowns = useMemo(
    () => projectUnknowns.filter(matchesUnknown),
    [projectUnknowns, normalizedFilter],
  );
  const filteredCatalogUnknowns = useMemo(
    () => catalogUnknowns.filter(matchesUnknown),
    [catalogUnknowns, normalizedFilter],
  );

  const blocked = !isTypst && (plan?.bundleMetadataState === 'invalid' || plan?.projectState === 'blocked');
  const needsDownload = !isTypst && Boolean(
    summary && (summary.missingResources > 0 || summary.invalidResources > 0 || plan?.bundleMetadataState === 'missing'),
  );
  const canDownload = Boolean(
    !isTypst && resources.isPlanFresh && needsDownload && !resources.activeJobId && !resources.isAnalyzing && !blocked,
  );
  const canRetry = resources.errorAction === 'prepare' && canDownload;

  const downloadLabel = blocked
    ? t('resources:common.unavailable')
    : resources.errorAction === 'check' && resources.error
      ? t('resources:common.tryAgain')
      : canRetry
        ? t('resources:panel.downloadLabel.retry')
        : resources.progress?.status?.toLowerCase() === 'cancelled'
          ? t('resources:common.resumeDownload')
          : plan?.bundleMetadataState === 'missing' && !summary?.missingResources && !summary?.invalidResources
            ? t('resources:common.finishSetup')
            : needsDownload
              ? t('resources:common.downloadRequiredFiles')
              : t('resources:panel.downloadLabel.ready');

  useEffect(() => {
    if (
      resources.isPlanFresh
      && !resources.resourcePage
      && !resources.resourcePageError
      && !resources.isResourcePageLoading
    ) {
      void resources.loadResourcePage();
    }
  }, [
    resources.isPlanFresh,
    resources.isResourcePageLoading,
    resources.loadResourcePage,
    resources.resourcePage,
    resources.resourcePageError,
  ]);

  const missingOrInvalidCount = (summary?.missingResources ?? 0) + (summary?.invalidResources ?? 0);

  const statusPill = (() => {
    if (isTypst) return { label: t('resources:availability.builtIn'), tone: 'ready' };
    if (resources.errorAction === 'check' && resources.error) return { label: t('resources:panel.status.error'), tone: 'error' };
    if (resources.isAnalyzing || !resources.isPlanFresh) return { label: t('resources:common.checking'), tone: 'neutral' };
    if (blocked) return { label: t('resources:panel.status.error'), tone: 'error' };
    if (needsDownload) {
      return {
        label: missingOrInvalidCount > 0
          ? t('resources:panel.status.missing', { count: missingOrInvalidCount })
          : t('resources:panel.status.setup'),
        tone: 'warning',
      };
    }
    return { label: t('resources:availability.ready'), tone: 'ready' };
  })();

  const summaryLine = (() => {
    if (resources.errorAction === 'check' && resources.error) {
      return t('resources:panel.summary.checkFailed');
    }
    if (resources.isAnalyzing || !resources.isPlanFresh) {
      return t('resources:panel.summary.checking');
    }
    if (blocked) {
      return t('resources:panel.summary.notVerified');
    }
    if (needsDownload) {
      return t('resources:panel.summary.needsDownload', {
        count: missingOrInvalidCount || 1,
        size: formatBytes(summary?.estimatedTransferBytes),
      });
    }
    return t('resources:panel.summary.ready', { count: summary?.resolvedResources ?? 0 });
  })();

  const renderRequirementRow = (row: ResourceRequirement) => {
    const path = row.path ?? row.id;
    const downloaded = Boolean(row.path && completedPaths.has(row.path));
    const preparing = Boolean(
      resources.activeJobId && !downloaded && (row.availability === 'missing' || row.availability === 'invalid'),
    );
    const tone = availabilityTone(row.availability, downloaded, preparing);
    const firstEvidence = row.evidence.find(item => item.file);
    const displayName = row.label || path;
    const locationLabel = firstEvidence?.file
      ? `${firstEvidence.file}${firstEvidence.line != null ? `:${firstEvidence.line}` : ''}`
      : null;
    const canJump = Boolean(
      firstEvidence?.file && onSelectLine && isProjectFileJumpable(firstEvidence.file, rows, plan?.mainFile),
    );

    return (
      <li className="dependency-row" key={`${row.id}:${row.path ?? ''}`}>
        <div className="dependency-row-main">
          <span className={`dependency-state dependency-state-${tone}`} aria-hidden="true" />
          <div className="dependency-name-group">
            <strong title={path}>{displayName}</strong>
            {displayName !== path && <span title={path}>{path}</span>}
          </div>
          <span className={`dependency-availability-pill is-${tone}`}>
            {preparing ? t('resources:panel.preparingBatch') : availabilityLabel(row.availability, downloaded)}
          </span>
          <span className="dependency-size">{formatBytes(row.indexedBytes)}</span>
        </div>
        {(firstEvidence?.file || row.parents.length > 0) && (
          <div className="dependency-row-meta">
            {firstEvidence?.file && canJump && onSelectLine ? (
              <button
                type="button"
                className="dependency-location-btn"
                onClick={() => onSelectLine(firstEvidence.line ?? 1, firstEvidence.file)}
                title={t('resources:common.jumpTo', { location: locationLabel })}
              >
                {locationLabel}
              </button>
            ) : locationLabel ? (
              <span className="dependency-location-text" title={locationLabel}>
                {locationLabel}
              </span>
            ) : null}
            {row.parents.length > 0 && (
              <span className="dependency-parents" title={t('resources:panel.requiredBy', { parents: row.parents.join(', ') })}>
                {t('resources:panel.viaParents', { parents: row.parents.join(', ') })}
              </span>
            )}
          </div>
        )}
      </li>
    );
  };

  const renderUnknownRow = (item: ResourceUnknown) => {
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
        className="dependency-row dependency-unknown-row"
        key={`${item.id}:${item.expression}:${item.file ?? ''}:${item.line ?? ''}`}
      >
        <div className="dependency-row-main">
          <span className="dependency-state dependency-state-missing" aria-hidden="true" />
          <div className="dependency-name-group">
            <strong title={trimmedExpression || reasonLabel}>
              {trimmedExpression ? <code>{trimmedExpression}</code> : <em>{t('resources:common.dynamicExpression')}</em>}
            </strong>
            <span title={reasonLabel}>{reasonLabel}</span>
          </div>
          {item.file && canJump && onSelectLine ? (
            <button
              type="button"
              className="dependency-location-btn"
              onClick={() => onSelectLine(item.line ?? 1, item.file)}
              title={t('resources:common.jumpTo', { location: locationLabel })}
            >
              {locationLabel}
            </button>
          ) : locationLabel ? (
            <span className="dependency-location-text" title={locationLabel}>
              {locationLabel}
            </span>
          ) : null}
        </div>
      </li>
    );
  };

  const supportingCount = filteredTransitiveRows.length + filteredCatalogUnknowns.length;
  const hasVisibleRows =
    filteredDirectRows.length > 0 || filteredProjectUnknowns.length > 0 || supportingCount > 0;

  return (
    <section className="dependencies-panel" aria-label={t('resources:panel.ariaLabel')}>
      <header className="dependencies-panel-header">
        <div className="dependencies-header-left">
          <span className="dependencies-panel-title">{t('resources:panel.title')}</span>
          <span className={`dependencies-status-pill is-${statusPill.tone}`}>{statusPill.label}</span>
        </div>
        <div className="dependencies-header-actions">
          <button
            type="button"
            className="btn-dependencies-header-action"
            onClick={() => void resources.analyze()}
            disabled={resources.isAnalyzing || Boolean(resources.activeJobId)}
            aria-label={t('resources:panel.refreshTitle')}
            title={t('resources:panel.refreshTitle')}
          >
            <RotateCw size={13} className={resources.isAnalyzing ? 'dependency-spin' : undefined} />
          </button>
          <button
            type="button"
            className="btn-dependencies-header-action"
            onClick={() => resources.open?.('cache')}
            aria-label={t('resources:panel.manageResourcesAria')}
            title={t('resources:panel.manageResourcesTitle')}
          >
            <HardDrive size={13} />
          </button>
          <button
            type="button"
            className="btn-dependencies-header-action"
            onClick={onClose}
            aria-label={t('resources:panel.closeTitle')}
            title={t('resources:panel.closeTitle')}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {isTypst ? (
        <div className="dependency-ready-strip is-typst" role="status" aria-live="polite">
          <CheckCircle2 size={14} aria-hidden="true" />
          <span>{t('resources:panel.typstNotice')}</span>
        </div>
      ) : (
        <>
          {resources.activeJobId && (
            <div className="dependency-job" role="status" aria-live="polite">
              <div>
                <strong>
                  {resources.progress?.status === 'Cancelling'
                    ? t('resources:panel.stoppingDownload')
                    : t('resources:phases.preparing')}
                </strong>
                <span>
                  {resources.progress?.downloadedBytes != null
                    ? t('resources:panel.downloadedBytes', { bytes: formatBytes(resources.progress.downloadedBytes) })
                    : t('resources:panel.batchProgressNote')}
                </span>
              </div>
              {resources.progress?.totalResources != null && resources.progress.totalResources > 0 && (
                <span className="dependency-count">
                  {resources.progress.completedResources ?? 0}/{resources.progress.totalResources}
                </span>
              )}
              <button
                type="button"
                className="dependency-cancel-btn"
                onClick={() => void resources.cancel()}
                disabled={resources.progress?.status === 'Cancelling'}
              >
                {t('common:actions.cancel')}
              </button>
            </div>
          )}

          {!resources.activeJobId && (needsDownload || blocked || Boolean(resources.error)) ? (
            <div
              className={`dependency-action-card ${blocked || resources.error ? 'is-error' : 'is-warning'}`}
              role="status"
              aria-live="polite"
            >
              <div className="dependency-action-summary">
                {blocked || resources.error ? (
                  <AlertCircle size={15} aria-hidden="true" />
                ) : (
                  <AlertTriangle size={15} aria-hidden="true" />
                )}
                <span>
                  {resources.error && resources.errorAction === 'prepare'
                    ? t('resources:panel.downloadUnfinished')
                    : summaryLine}
                </span>
              </div>
              <button
                type="button"
                className="dependency-primary-btn"
                disabled={resources.errorAction === 'check' ? resources.isAnalyzing : !canDownload}
                onClick={() => {
                  if (resources.errorAction === 'check') void resources.analyze();
                  else void resources.prepare();
                }}
              >
                {resources.isAnalyzing ? (
                  <Loader2 className="dependency-spin" size={14} aria-hidden="true" />
                ) : (
                  <Download size={14} aria-hidden="true" />
                )}
                <span>{resources.isAnalyzing ? t('resources:panel.checkingResources') : downloadLabel}</span>
              </button>
              <div className="dependency-action-links">
                <button
                  type="button"
                  className="dependency-link-btn"
                  onClick={() => resources.open?.('cache')}
                >
                  {t('resources:panel.manageCache')}
                </button>
              </div>
            </div>
          ) : !resources.activeJobId ? (
            <div className="dependency-ready-strip" role="status" aria-live="polite">
              {resources.isAnalyzing || !resources.isPlanFresh ? (
                <Loader2 className="dependency-spin" size={14} aria-hidden="true" />
              ) : (
                <CheckCircle2 size={14} aria-hidden="true" />
              )}
              <span>{summaryLine}</span>
              <button
                type="button"
                className="dependency-link-btn"
                onClick={() => resources.open?.('cache')}
              >
                {t('resources:panel.manageCache')}
              </button>
            </div>
          ) : null}
        </>
      )}

      <div className="dependency-filter-wrapper">
        <div className="dependency-filter-box">
          <Search size={13} className="dependency-filter-icon" aria-hidden="true" />
          <input
            type="text"
            className="dependency-filter-input"
            aria-label={t('resources:panel.filterAria')}
            placeholder={t('resources:panel.filterPlaceholder')}
            value={filter}
            onChange={event => setFilter(event.target.value)}
          />
          {filter && (
            <button
              type="button"
              className="dependency-filter-clear"
              onClick={() => setFilter('')}
              aria-label={t('resources:panel.clearFilterAria')}
              title={t('resources:panel.clearFilterTitle')}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="dependency-list-scroll">
        {resources.resourcePageError && (
          <p className="dependency-error" role="alert">
            {t('resources:panel.loadError')}{' '}
            <button type="button" onClick={() => void resources.loadResourcePage(null, true)}>
              {t('common:actions.retry')}
            </button>
          </p>
        )}

        {resources.isAnalyzing || (resources.isResourcePageLoading && !resources.resourcePage) ? (
          <p className="dependency-muted">{t('resources:panel.loadingDetected')}</p>
        ) : !hasVisibleRows ? (
          <p className="dependency-muted">
            {normalizedFilter
              ? t('resources:panel.noMatchingDependencies', { filter })
              : t('resources:panel.noDetectedResources')}
          </p>
        ) : (
          <>
            {filteredDirectRows.length > 0 && (
              <section className="dependency-group">
                <h3>{t('resources:panel.directHeading')}</h3>
                <ul>{filteredDirectRows.map(renderRequirementRow)}</ul>
              </section>
            )}

            {filteredProjectUnknowns.length > 0 && (
              <section className="dependency-group">
                <h3>{t('resources:panel.unresolvedHeading')}</h3>
                <ul>{filteredProjectUnknowns.map(renderUnknownRow)}</ul>
              </section>
            )}

            {supportingCount > 0 && (
              <details className="dependency-group dependency-supporting">
                <summary>
                  {t('resources:common.supportingResources')} <span>{supportingCount}</span>
                </summary>
                {filteredTransitiveRows.length > 0 && (
                  <ul>{filteredTransitiveRows.map(renderRequirementRow)}</ul>
                )}
                {filteredCatalogUnknowns.length > 0 && (
                  <details className="dependency-catalog-unknowns">
                    <summary>
                      {t('resources:common.catalogHooksHeading')} <span>{filteredCatalogUnknowns.length}</span>
                    </summary>
                    <ul>{filteredCatalogUnknowns.map(renderUnknownRow)}</ul>
                  </details>
                )}
              </details>
            )}
          </>
        )}

        {resources.resourcePage?.nextCursor && (
          <button
            type="button"
            className="dependency-load-more"
            disabled={resources.isResourcePageLoading}
            onClick={() => void resources.loadResourcePage(resources.resourcePage?.nextCursor ?? null)}
          >
            {resources.isResourcePageLoading ? t('resources:common.loading') : t('resources:panel.loadMore')}
          </button>
        )}
      </div>
    </section>
  );
};
