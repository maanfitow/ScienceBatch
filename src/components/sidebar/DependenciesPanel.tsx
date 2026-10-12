import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronRight, Download, Loader2, PackageSearch, Settings2, X } from 'lucide-react';
import type { useProjectResources } from '../../hooks/useProjectResources';
import type { ResourceRequirement } from '../../types/projectResources';
import './dependencies.css';

type ResourcesModel = ReturnType<typeof useProjectResources>;

const formatBytes = (bytes: number | null | undefined) => {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index++) { value /= 1024; unit = units[index]; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
};

function availabilityLabel(value: string, downloaded: boolean) {
  if (downloaded) return 'Downloaded';
  switch (value) {
    case 'local': return 'In project';
    case 'embedded': return 'Included with app';
    case 'cached_verified': return 'Downloaded';
    case 'invalid': return 'Needs repair';
    case 'missing': return 'Available to download';
    default: return value.replace(/_/g, ' ');
  }
}

function cacheErrorMessage(code?: string) {
  if (code?.includes('stale') || code?.includes('changed')) return 'The installed resource inventory changed. Reload the list to review the latest files.';
  if (code?.includes('busy') || code?.includes('locked')) return 'Installed resources are in use and cannot be removed right now.';
  return 'Installed resources could not be updated. Reload the list and try again.';
}

function requirementRows(resources: ResourcesModel): ResourceRequirement[] {
  return (resources.resourcePage?.items ?? [])
    .filter(entry => entry.itemType === 'requirement')
    .map(entry => entry.item as ResourceRequirement);
}

export const DependenciesPanel: React.FC<{ resources: ResourcesModel; onClose: () => void }> = ({ resources, onClose }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const manageButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const closeModalRef = useRef<HTMLButtonElement>(null);
  const rows = requirementRows(resources);
  const plan = resources.plan;
  const summary = plan?.summary;
  const completedPaths = useMemo(() => new Set(resources.completedPaths), [resources.completedPaths]);
  const isDirectRequirement = (row: ResourceRequirement) => row.evidence.some(evidence => evidence.kind === 'detected');
  const directRows = rows.filter(isDirectRequirement);
  const transitiveRows = rows.filter(row => !isDirectRequirement(row));
  const blocked = plan?.bundleMetadataState === 'invalid' || plan?.projectState === 'blocked';
  const needsDownload = Boolean(summary && (summary.missingResources > 0 || summary.invalidResources > 0 || plan?.bundleMetadataState === 'missing'));
  const canDownload = resources.isPlanFresh && needsDownload && !resources.activeJobId && !resources.isAnalyzing && !blocked;
  const canRetry = resources.errorAction === 'prepare' && canDownload;
  const downloadLabel = blocked ? 'Unavailable'
    : resources.errorAction === 'check' && resources.error ? 'Try again'
    : canRetry ? 'Retry download'
      : resources.progress?.status?.toLowerCase() === 'cancelled' ? 'Resume download'
        : plan?.bundleMetadataState === 'missing' && !summary?.missingResources && !summary?.invalidResources ? 'Finish setup'
          : needsDownload ? 'Download required files' : 'Resources ready';

  useEffect(() => {
    if (resources.isPlanFresh && !resources.resourcePage && !resources.resourcePageError && !resources.isResourcePageLoading) void resources.loadResourcePage();
  }, [resources.isPlanFresh, resources.isResourcePageLoading, resources.loadResourcePage, resources.resourcePage, resources.resourcePageError]);

  useEffect(() => {
    setSelected([]);
    setConfirmRemoval(false);
  }, [resources.cachePage?.cacheDigest]);

  useEffect(() => {
    if (isManageOpen && resources.isPlanFresh && !resources.cachePage && !resources.isCachePageLoading && !resources.isRemovingResources && !resources.cacheError) {
      void resources.loadCachePage(null, true);
    }
  }, [isManageOpen, resources.cacheError, resources.cachePage, resources.isCachePageLoading, resources.isPlanFresh, resources.isRemovingResources, resources.loadCachePage]);

  useEffect(() => {
    if (!isManageOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeModalRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setIsManageOpen(false); setConfirmRemoval(false); return; }
      if (event.key !== 'Tab' || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'))
        .filter(element => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (!modalRef.current.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (manageButtonRef.current?.isConnected) manageButtonRef.current.focus();
      else if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [isManageOpen]);

  const openManage = () => {
    setSelected([]);
    setConfirmRemoval(false);
    setIsManageOpen(true);
    if (resources.isPlanFresh) void resources.loadCachePage(null, true);
  };
  const toggleSelected = (path: string) => setSelected(current => current.includes(path) ? current.filter(value => value !== path) : [...current, path]);
  const currentCachePage = resources.isPlanFresh ? resources.cachePage : null;
  const visibleCacheItems = (currentCachePage?.items ?? []).filter(item => item.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const selectableCount = currentCachePage?.items.filter(item => item.removable && !item.requiredByProject).length ?? 0;
  const summaryLine = resources.isAnalyzing || !resources.isPlanFresh
    ? 'Checking detected dependencies…'
    : resources.errorAction === 'check' && resources.error
      ? 'Dependency information could not be checked.'
      : blocked
        ? 'Resource information could not be verified.'
      : needsDownload
        ? `${summary?.missingResources ?? 0} required files need downloading · ${formatBytes(summary?.estimatedTransferBytes)} estimated`
        : `${summary?.resolvedResources ?? 0} known files are ready`;

  const renderRows = (items: ResourceRequirement[]) => items.map(row => {
    const path = row.path ?? row.id;
    const downloaded = Boolean(row.path && completedPaths.has(row.path));
    const preparing = Boolean(resources.activeJobId && !downloaded && (row.availability === 'missing' || row.availability === 'invalid'));
    return <li className="dependency-row" key={`${row.id}:${row.path ?? ''}`}>
      <div className="dependency-row-main">
        <span className={`dependency-state dependency-state-${downloaded ? 'ready' : preparing ? 'preparing' : row.availability}`} aria-hidden="true" />
        <div className="dependency-name-group"><strong title={path}>{row.label || path}</strong><span title={path}>{path}</span></div>
        <span className="dependency-size">{formatBytes(row.indexedBytes)}</span>
      </div>
      <div className="dependency-row-meta"><span>{preparing ? 'Preparing in current batch' : availabilityLabel(row.availability, downloaded)}</span>{row.parents.length > 0 && <span>Required by {row.parents.join(', ')}</span>}</div>
    </li>;
  });

  return <section className="dependencies-panel" aria-label="Dependencies">
    <header className="dependencies-panel-header">
      <div><h2><PackageSearch size={16} />Dependencies</h2><p>{plan?.project ?? 'Current project'}</p></div>
      <button className="dependencies-icon-button" onClick={onClose} aria-label="Close Dependencies"><X size={16} /></button>
    </header>
    <div className="dependencies-summary" role="status" aria-live="polite">
      {resources.isAnalyzing ? <Loader2 className="dependency-spin" size={15} /> : needsDownload || blocked ? <AlertCircle size={15} /> : <Check size={15} />}
      <span>{summaryLine}</span>
    </div>
    {resources.activeJobId && <div className="dependency-job" role="status" aria-live="polite">
      <div><strong>{resources.progress?.status === 'Cancelling' ? 'Stopping download…' : 'Preparing required files'}</strong>
        <span>{resources.progress?.downloadedBytes != null ? `${formatBytes(resources.progress.downloadedBytes)} downloaded` : 'Batch progress applies to all selected files'}</span></div>
      {resources.progress?.totalResources != null && resources.progress.totalResources > 0 && <span className="dependency-count">{resources.progress.completedResources ?? 0}/{resources.progress.totalResources}</span>}
      <button className="project-resources-cancel" onClick={() => void resources.cancel()} disabled={resources.progress?.status === 'Cancelling'}>Cancel</button>
    </div>}
    {resources.error && resources.errorAction === 'check' && <p className="dependency-error" role="alert">Could not check dependencies. <button onClick={() => void resources.analyze()}>Try again</button></p>}
    {resources.error && resources.errorAction === 'prepare' && <p className="dependency-error" role="alert">The download did not finish. Retry when ready.</p>}
    <p className="dependency-unknown-note">Some dependencies can only be checked when you compile. Download size may differ from file sizes.</p>
    <div className="dependency-actions">
      <button className="project-resources-primary" disabled={resources.errorAction === 'check' ? resources.isAnalyzing : !canDownload} onClick={() => {
        if (resources.errorAction === 'check') void resources.analyze();
        else void resources.prepare();
      }}>{resources.isAnalyzing || resources.activeJobId ? <Loader2 className="dependency-spin" size={14} /> : <Download size={14} />}{resources.isAnalyzing ? 'Checking resources…' : downloadLabel}</button>
      <button ref={manageButtonRef} className="dependency-manage-button" onClick={openManage}><Settings2 size={14} />Manage installed resources</button>
    </div>
    <div className="dependency-list-heading">
      <button className="dependency-disclosure" aria-expanded={isExpanded} onClick={() => setIsExpanded(value => !value)}>
        {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}Detected resources <span>{rows.length}{summary ? ` / ${summary.totalResources}` : ''}</span>
      </button>
    </div>
    {isExpanded && <div className="dependency-list-scroll">
      {resources.resourcePageError && <p className="dependency-error" role="alert">Detected resources could not be loaded. <button onClick={() => void resources.loadResourcePage(null, true)}>Retry</button></p>}
      {resources.isAnalyzing || resources.isResourcePageLoading && !resources.resourcePage
        ? <p className="dependency-muted">Loading detected resources…</p>
        : rows.length === 0 ? <p className="dependency-muted">No known resource files were detected.</p>
          : <>
            {directRows.length > 0 && <section className="dependency-group"><h3>Detected dependencies</h3><ul>{renderRows(directRows)}</ul></section>}
            {transitiveRows.length > 0 && <details className="dependency-group dependency-supporting">
              <summary>Supporting resources <span>{transitiveRows.length}</span></summary>
              <ul>{renderRows(transitiveRows)}</ul>
            </details>}
          </>}
      {resources.resourcePage?.nextCursor && <button className="dependency-load-more" disabled={resources.isResourcePageLoading} onClick={() => void resources.loadResourcePage(resources.resourcePage?.nextCursor ?? null)}>
        {resources.isResourcePageLoading ? 'Loading…' : 'Load more detected resources'}
      </button>}
    </div>}
    {isManageOpen && <div className="installed-resources-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setIsManageOpen(false); }}>
      <section className="installed-resources-dialog" role="dialog" aria-modal="true" aria-labelledby="installed-resources-title" ref={modalRef} tabIndex={-1}>
        <header className="installed-resources-header"><div><h2 id="installed-resources-title">Installed Resources</h2><p>Shared cache used by this and other projects.</p></div>
          <button ref={closeModalRef} className="dependencies-icon-button" aria-label="Close Installed Resources" onClick={() => setIsManageOpen(false)}><X size={16} /></button></header>
        <div className="installed-resources-summary" aria-label="Installed resource summary">
          <span><strong>{currentCachePage?.summary.installedFiles ?? 0}</strong> installed files</span>
          <span><strong>{formatBytes(currentCachePage?.summary.installedBytes)}</strong> installed</span>
          <span><strong>{formatBytes(currentCachePage?.summary.metadataBytes)}</strong> metadata (read-only)</span>
          <span><strong>{formatBytes(currentCachePage?.summary.otherBytes)}</strong> formats and other cache (read-only)</span>
          <span><strong>{currentCachePage?.summary.embeddedFiles ?? 0}</strong> included with app (read-only) · {formatBytes(currentCachePage?.summary.embeddedBytes)}</span>
        </div>
        <p className="installed-resources-shared-note">File sizes show logical payload bytes; occupied disk space can differ.</p>
        <p className="installed-resources-shared-note">Removing selected files clears the shared cache. Other projects may need to download them again.</p>
        <label className="installed-resources-filter">Filter loaded files<input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter loaded paths" /></label>
        {resources.cacheError && <p className="dependency-error" role="alert">{cacheErrorMessage(resources.cacheError.code)} <button onClick={() => void resources.loadCachePage(null, true)}>Reload inventory</button></p>}
        {resources.cacheRemovalResult && <p className="installed-resources-result" role="status">Removed {resources.cacheRemovalResult.removedFiles} {resources.cacheRemovalResult.removedFiles === 1 ? 'file' : 'files'} · {formatBytes(resources.cacheRemovalResult.removedBytes)}</p>}
        <div className="installed-resources-list" aria-live="polite">
          {!resources.isPlanFresh ? <p className="dependency-muted">Waiting for current project analysis…</p>
            : resources.isCachePageLoading && !currentCachePage ? <p className="dependency-muted">Loading installed resources…</p>
            : visibleCacheItems.length === 0 ? <p className="dependency-muted">No matching installed files in the loaded list.</p>
              : visibleCacheItems.map(item => <label className="installed-resource-row" key={item.path}>
                <input type="checkbox" checked={selected.includes(item.path)} disabled={Boolean(resources.activeJobId || resources.isRemovingResources) || !item.removable || item.requiredByProject || (!selected.includes(item.path) && selected.length >= 200)} onChange={() => toggleSelected(item.path)} />
                <span className="installed-resource-path" title={item.path}>{item.path}{item.requiredByProject ? <small>Required by current project</small> : !item.removable && <small>Included with app · Protected</small>}</span>
                <span>{formatBytes(item.bytes)}</span>
              </label>)}
          {currentCachePage?.nextCursor && <button className="dependency-load-more" disabled={resources.isCachePageLoading} onClick={() => void resources.loadCachePage(currentCachePage.nextCursor)}>{resources.isCachePageLoading ? 'Loading…' : 'Load more installed files'}</button>}
        </div>
        {confirmRemoval && <div className="installed-resources-confirm" role="alertdialog" aria-label="Confirm resource removal">
          <strong>Remove {selected.length} selected {selected.length === 1 ? 'file' : 'files'}?</strong><span>They will be removed from the shared cache and may be downloaded again by other projects.</span>
        </div>}
        <footer className="installed-resources-footer">
          {confirmRemoval ? <><button className="project-resources-secondary" onClick={() => setConfirmRemoval(false)}>Keep files</button>
            <button className="project-resources-cancel" disabled={selected.length === 0 || selected.length > 200 || Boolean(resources.activeJobId || resources.isRemovingResources)} onClick={() => { void resources.removeCachedResources(selected); setSelected([]); setConfirmRemoval(false); }}>{resources.isRemovingResources ? 'Removing…' : 'Remove selected files'}</button></>
            : <><span>{selected.length} selected{selectableCount > 0 ? ` · ${selectableCount} removable on this page` : ''}</span>
              <button className="project-resources-secondary" onClick={() => setIsManageOpen(false)}>Done</button>
              <button className="project-resources-cancel" disabled={!selected.length || selected.length > 200 || Boolean(resources.activeJobId || resources.isRemovingResources)} onClick={() => setConfirmRemoval(true)}>Remove selected</button></>}
        </footer>
      </section>
    </div>}
  </section>;
};
