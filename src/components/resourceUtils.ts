import i18n from '../i18n';
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
  if (downloaded) return i18n.t('resources:availability.ready');
  switch (value) {
    case 'local':
      return i18n.t('resources:availability.inProject');
    case 'embedded':
      return i18n.t('resources:availability.builtIn');
    case 'cached_verified':
      return i18n.t('resources:availability.ready');
    case 'invalid':
      return i18n.t('resources:availability.repair');
    case 'missing':
      return i18n.t('resources:availability.missing');
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
    return i18n.t('resources:cacheErrors.inventoryChanged');
  }
  if (code?.includes('busy') || code?.includes('locked')) {
    return i18n.t('resources:cacheErrors.inUse');
  }
  return i18n.t('resources:cacheErrors.updateFailed');
}

export function friendlyPhase(phase?: string, status?: string): string {
  switch (status?.toLowerCase()) {
    case 'finished':
      return i18n.t('resources:phases.finished');
    case 'cancelled':
      return i18n.t('resources:phases.cancelled');
    case 'cancelling':
      return i18n.t('resources:phases.cancelling');
  }
  switch (phase?.toLowerCase()) {
    case 'downloading':
    case 'download':
      return i18n.t('resources:phases.downloading');
    case 'publishing':
      return i18n.t('resources:phases.publishing');
    case 'verifying':
      return i18n.t('resources:phases.verifying');
    default:
      return i18n.t('resources:phases.preparing');
  }
}

const PACK_LABEL_KEYS: Record<string, string> = {
  'latex-basic': 'editor:resources.packs.latexBasic',
  'LaTeX basic': 'editor:resources.packs.latexBasic',
  'LaTeX Basic': 'editor:resources.packs.latexBasic',
  'latex-ieeetran': 'editor:resources.packs.latexIeeetran',
  'IEEEtran article': 'editor:resources.packs.latexIeeetran',
  'latex-resume-fonts': 'editor:resources.packs.latexResumeFonts',
  'Resume fonts': 'editor:resources.packs.latexResumeFonts',
  'typst-engine-assets': 'editor:resources.packs.typstEngineAssets',
  'Typst engine assets': 'editor:resources.packs.typstEngineAssets',
  'Base package': 'editor:resources.packs.basePackage',
};

/** Maps known backend pack identifiers and English pack labels to localized display labels. */
export function friendlyPackLabel(labelOrId: string): string {
  const key = PACK_LABEL_KEYS[labelOrId.trim()];
  if (!key) return labelOrId;
  return i18n.t(key as never, { defaultValue: labelOrId } as never) as unknown as string;
}

export function requirementRows(resourcePage: ResourceListPage | null): ResourceRequirement[] {
  return (resourcePage?.items ?? [])
    .filter(entry => entry.itemType === 'requirement')
    .map(entry => {
      const item = entry.item as ResourceRequirement;
      const mappedLabel = friendlyPackLabel(item.label);
      const mappedParents = item.parents.map(parent => friendlyPackLabel(parent));
      if (mappedLabel === item.label && mappedParents.every((parent, idx) => parent === item.parents[idx])) {
        return item;
      }
      return {
        ...item,
        label: mappedLabel,
        parents: mappedParents,
      };
    });
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

const UNKNOWN_REASON_KEYS = {
  macro_valued_catalog_reference: 'resources:unknownReasons.macro_valued_catalog_reference',
  macro_valued_package_reference: 'resources:unknownReasons.macro_valued_package_reference',
  macro_valued_file_reference: 'resources:unknownReasons.macro_valued_file_reference',
  macro_valued_user_asset: 'resources:unknownReasons.macro_valued_user_asset',
  macro_valued_font_reference: 'resources:unknownReasons.macro_valued_font_reference',
  input_not_found_in_project_or_bundle: 'resources:unknownReasons.input_not_found_in_project_or_bundle',
  bundle_style_not_found: 'resources:unknownReasons.bundle_style_not_found',
  missing_project_asset_not_downloadable: 'resources:unknownReasons.missing_project_asset_not_downloadable',
  missing_project_bibliography_not_downloadable: 'resources:unknownReasons.missing_project_bibliography_not_downloadable',
  font_file_not_found: 'resources:unknownReasons.font_file_not_found',
  font_family_resolution_unknown: 'resources:unknownReasons.font_family_resolution_unknown',
  conditional_tex_dependency: 'resources:unknownReasons.conditional_tex_dependency',
  project_local_file_missing: 'resources:unknownReasons.project_local_file_missing',
  source_not_utf8: 'resources:unknownReasons.source_not_utf8',
} as const;

/** Converts backend unknown-resource reason codes into readable localized labels. */
export function friendlyUnknownReason(reason?: string | null): string {
  const trimmed = reason?.trim() ?? '';
  if (!trimmed) return i18n.t('resources:unknownReasons.default');
  const key = UNKNOWN_REASON_KEYS[trimmed as keyof typeof UNKNOWN_REASON_KEYS];
  if (key) return i18n.t(key);
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
