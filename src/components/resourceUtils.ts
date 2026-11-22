import type { useProjectResources } from '../hooks/useProjectResources';
import type {
  ResourceListPage,
  ResourcePlanSummary,
  ResourceRequirement,
  ResourceUnknown,
} from '../types/projectResources';

type BaseResourcesModel = ReturnType<typeof useProjectResources>;

export type ResourcesModel = Omit<BaseResourcesModel, 'modalTab' | 'setModalTab' | 'prepare'> & {
  modalTab?: 'project' | 'cache';
  setModalTab?: (tab: 'project' | 'cache') => void;
  prepare: () => Promise<boolean | void>;
};

export function formatBytes(bytes: number | null | undefined): string {
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
}

export function availabilityLabel(value: string, downloaded: boolean): string {
  if (downloaded) return 'Ready';
  switch (value) {
    case 'local':
      return 'In project';
    case 'embedded':
      return 'Built-in';
    case 'cached_verified':
      return 'Ready';
    case 'invalid':
      return 'Repair';
    case 'missing':
      return 'Missing';
    default:
      return value.replace(/_/g, ' ');
  }
}

export function availabilityTone(value: string, downloaded: boolean, preparing: boolean): string {
  if (downloaded) return 'ready';
  if (preparing) return 'preparing';
  switch (value) {
    case 'local':
    case 'embedded':
    case 'cached_verified':
      return 'ready';
    case 'missing':
    case 'invalid':
      return 'missing';
    default:
      return 'neutral';
  }
}

export function cacheErrorMessage(code?: string): string {
  if (code?.includes('stale') || code?.includes('changed')) {
    return 'The installed resource inventory changed. Reload the list to review the latest files.';
  }
  if (code?.includes('busy') || code?.includes('locked')) {
    return 'Installed resources are in use and cannot be removed right now.';
  }
  return 'Installed resources could not be updated. Reload the list and try again.';
}

export function friendlyPhase(phase?: string, status?: string): string {
  switch (status?.toLowerCase()) {
    case 'finished':
      return 'Detected resources are ready';
    case 'cancelled':
      return 'Download paused';
    case 'cancelling':
      return 'Stopping the download';
  }
  switch (phase?.toLowerCase()) {
    case 'downloading':
    case 'download':
      return 'Downloading required files';
    case 'publishing':
      return 'Verifying and saving files';
    case 'verifying':
      return 'Verifying files';
    default:
      return 'Preparing required files';
  }
}

export function requirementRows(resourcePage: ResourceListPage | null): ResourceRequirement[] {
  return (resourcePage?.items ?? [])
    .filter(entry => entry.itemType === 'requirement')
    .map(entry => entry.item as ResourceRequirement);
}

export function mergeUnknownItems(
  plan: ResourcePlanSummary | null,
  resourcePage: ResourceListPage | null,
): ResourceUnknown[] {
  const fromPlan = plan?.unknown ?? [];
  const fromPage = (resourcePage?.items ?? [])
    .filter(entry => entry.itemType === 'unknown')
    .map(entry => entry.item as ResourceUnknown);

  const seen = new Set<string>();
  const merged: ResourceUnknown[] = [];
  for (const item of [...fromPlan, ...fromPage]) {
    const key = `${item.id}\0${item.expression}\0${item.file ?? ''}\0${item.line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function splitCachePath(path: string): { fileName: string; dirPath: string } {
  const slashIndex = path.lastIndexOf('/');
  if (slashIndex <= 0) return { fileName: path, dirPath: '' };
  return {
    fileName: path.slice(slashIndex + 1),
    dirPath: path.slice(0, slashIndex),
  };
}

const UNKNOWN_REASON_LABELS: Record<string, string> = {
  macro_valued_catalog_reference: 'Dynamic macro in package',
  macro_valued_package_reference: 'Dynamic package macro',
  macro_valued_file_reference: 'Dynamic file macro',
  macro_valued_user_asset: 'Dynamic asset path',
  macro_valued_font_reference: 'Dynamic font path',
  input_not_found_in_project_or_bundle: 'Optional or missing input',
  bundle_style_not_found: 'Package not found in bundle',
  missing_project_asset_not_downloadable: 'Missing project asset',
  missing_project_bibliography_not_downloadable: 'Missing bibliography file',
  font_file_not_found: 'Font file not found',
  font_family_resolution_unknown: 'System font (checked on compile)',
  conditional_tex_dependency: 'Conditional dependency',
  project_local_file_missing: 'Missing project file',
  source_not_utf8: 'Non-UTF-8 source file',
};

/** Converts backend unknown-resource reason codes into readable English labels. */
export function friendlyUnknownReason(reason?: string | null): string {
  const trimmed = reason?.trim() ?? '';
  if (!trimmed) return 'Dynamic reference';
  const mapped = UNKNOWN_REASON_LABELS[trimmed];
  if (mapped) return mapped;
  const humanized = trimmed.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

function basenameOf(path: string): string {
  const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
}

function buildResourcePathSets(
  requirements: ResourceRequirement[],
  mainFile?: string | null,
): { localPaths: Set<string>; bundlePaths: Set<string> } {
  const localPaths = new Set<string>();
  const trimmedMain = mainFile?.trim();
  if (trimmedMain) localPaths.add(trimmedMain);

  for (const row of requirements) {
    if (row.availability === 'local' || row.provider === 'project_local') {
      if (row.path) localPaths.add(row.path);
      if (row.label) localPaths.add(row.label);
    }
  }

  const bundlePaths = new Set<string>();
  for (const row of requirements) {
    if (row.availability === 'local' || row.provider === 'project_local') continue;
    if (row.path) {
      if (!localPaths.has(row.path)) bundlePaths.add(row.path);
      const base = basenameOf(row.path);
      if (base && !localPaths.has(base)) bundlePaths.add(base);
    }
    if (row.label && !localPaths.has(row.label)) {
      bundlePaths.add(row.label);
    }
  }

  return { localPaths, bundlePaths };
}

/** Splits unresolved items into user-project items vs. CTAN/bundle-internal dynamic hooks. */
export function partitionUnknownItems(
  unknownItems: ResourceUnknown[],
  requirements: ResourceRequirement[],
  mainFile?: string | null,
): { projectUnknowns: ResourceUnknown[]; catalogUnknowns: ResourceUnknown[] } {
  const { localPaths, bundlePaths } = buildResourcePathSets(requirements, mainFile);
  const projectUnknowns: ResourceUnknown[] = [];
  const catalogUnknowns: ResourceUnknown[] = [];

  for (const item of unknownItems) {
    const isCatalogUnknown =
      item.reason === 'macro_valued_catalog_reference'
      || Boolean(item.parent && item.parent.trim().length > 0)
      || Boolean(item.file && bundlePaths.has(item.file) && !localPaths.has(item.file));
    if (isCatalogUnknown) {
      catalogUnknowns.push(item);
    } else {
      projectUnknowns.push(item);
    }
  }

  return { projectUnknowns, catalogUnknowns };
}

/** Returns true only when `file` refers to a jumpable project source file rather than a bundle file. */
export function isProjectFileJumpable(
  file: string | null | undefined,
  requirements: ResourceRequirement[],
  mainFile?: string | null,
): boolean {
  const trimmed = file?.trim();
  if (!trimmed) return false;
  const { localPaths, bundlePaths } = buildResourcePathSets(requirements, mainFile);
  if (localPaths.has(trimmed)) return true;
  if (bundlePaths.has(trimmed)) return false;
  return true;
}
