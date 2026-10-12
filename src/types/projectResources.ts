import type { EngineType } from './compiler';

export type ProjectResourceOperation =
  | 'resources.analyze'
  | 'resources.plan'
  | 'resources.list'
  | 'resources.prepare_project'
  | 'resources.cache_list'
  | 'resources.cache_remove';

export type ResourceSelectorKind = 'pack' | 'package' | 'resource';

export interface ResourceSelector {
  kind: ResourceSelectorKind;
  id: string;
}

export interface ProjectResourceSnapshot {
  engine: EngineType;
  projectRoot: string | null;
  mainFile: string;
  overlays: Record<string, string>;
  allowedRoots: string[];
  workspaceIdentity: Record<string, unknown>;
  templateAssets: 'starter-latex' | 'starter-typst' | null;
  fingerprint: string;
}

export interface ResourcePlanSummary {
  resourceSchemaVersion: number;
  project: string;
  engine: EngineType;
  mainFile: string;
  inputDigest: string;
  planDigest: string;
  bundleDigest: string | null;
  indexSha256: string | null;
  bundleUrl: string | null;
  catalogSha256: string | null;
  catalogPacks: Array<{ id: string; label: string }>;
  coverage: string;
  selection: ResourceSelector[];
  projectState: 'prepared_known_set' | 'not_prepared' | 'blocked' | string;
  bundleMetadataState: 'cached_verified' | 'missing' | 'invalid' | 'embedded' | string;
  summary: {
    totalResources: number;
    resolvedResources: number;
    cachedVerifiedResources: number;
    missingResources: number;
    invalidResources: number;
    unresolvedCount: number;
    totalIndexedBytes: number;
    cachedVerifiedBytes: number;
    estimatedTransferBytes: number;
    incrementalStorageBytes: number;
    metadataStorageBytes: number;
  };
  unknown: ResourceUnknown[];
  unknownOmitted: number;
}

export interface ResourceUnknown {
  id: string;
  expression: string;
  reason: string;
  file: string | null;
  line: number | null;
  parent: string | null;
}

export interface ResourceRequirement {
  id: string;
  kind: string;
  label: string;
  path: string | null;
  provider: string;
  resolution: string;
  availability: 'local' | 'embedded' | 'cached_verified' | 'missing' | 'invalid' | string;
  mandatory: boolean;
  evidence: Array<{ kind: string; file: string | null; line: number | null; parent: string | null }>;
  parents: string[];
  indexedBytes: number | null;
  sha256: string | null;
}

export interface ResourceListItem {
  itemType: 'requirement' | 'unknown';
  item: ResourceRequirement | ResourceUnknown;
}

export interface ResourceListPage {
  resourceSchemaVersion: number;
  planDigest: string;
  offset: number;
  limit: number;
  total: number;
  items: ResourceListItem[];
  nextCursor: string | null;
}

export interface ProjectResourceProgress {
  jobId: string;
  status?: string;
  message?: string;
  phase?: string;
  completedResources?: number;
  totalResources?: number;
  downloadedBytes?: number;
  maxDownloadBytes?: number;
  resourcePath?: string;
}

export interface InstalledResourceItem {
  path: string;
  bytes: number;
  requiredByProject: boolean;
  removable: boolean;
}

export interface InstalledResourcePage {
  cacheDigest: string;
  bundleDigest: string;
  offset: number;
  total: number;
  nextCursor: string | null;
  items: InstalledResourceItem[];
  summary: {
    installedFiles: number;
    installedBytes: number;
    metadataBytes: number;
    otherBytes: number;
    embeddedFiles: number;
    embeddedBytes: number;
  };
}

export interface ProjectResourceFailure {
  code: string;
  message: string;
  details?: unknown;
  diagnostics?: unknown[];
}

export interface ProjectResourceRequest {
  operation: ProjectResourceOperation;
  jobId: string;
  engine: EngineType;
  projectRoot: string | null;
  mainFile: string;
  overlays: Record<string, string>;
  allowedRoots: string[];
  workspaceIdentity: Record<string, unknown>;
  selection?: ResourceSelector[];
  expectedInputDigest?: string;
  expectedPlanDigest?: string;
  cursor?: string | null;
  limit?: number;
  maxDownloadBytes?: number;
  maxStorageBytes?: number;
  expectedCacheDigest?: string;
  removePaths?: string[];
  templateAssets: 'starter-latex' | 'starter-typst' | null;
}
