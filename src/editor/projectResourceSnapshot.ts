import type { WorkspaceTab } from '../types/workspace';
import type { ProjectResourceSnapshot } from '../types/projectResources';

export interface SnapshotProjectState {
  projectRoot: string | null;
  projectName: string;
  mainFilePath: string | null;
  engine: 'latex' | 'typst';
  templateAssets: 'starter-latex' | 'starter-typst' | null;
  tabs: WorkspaceTab[];
  getProjectGeneration: () => number;
  getDocumentRevision: (id: string) => number;
}

const engineForMainFile = (mainFilePath: string, fallback: 'latex' | 'typst'): 'latex' | 'typst' =>
  /\.typ$/i.test(mainFilePath) ? 'typst' : /\.tex$/i.test(mainFilePath) ? 'latex' : fallback;

export const captureProjectSnapshot = (project: SnapshotProjectState): ProjectResourceSnapshot => {
  const root = project.projectRoot?.replace(/\\/g, '/').replace(/\/$/, '') || null;
  const fallbackMain = `main.${project.engine === 'typst' ? 'typ' : 'tex'}`;
  const selectedMain = (project.mainFilePath || fallbackMain).replace(/\\/g, '/');
  const mainFile = root && (selectedMain.startsWith(`${root}/`) || selectedMain === root)
    ? selectedMain.slice(root.length).replace(/^\//, '') || fallbackMain
    : selectedMain;
  const engine = engineForMainFile(mainFile, project.engine);
  const overlays: Record<string, string> = {};
  const documents = project.tabs
    .filter(tab => tab.kind === 'source')
    .map(tab => {
      let path = tab.path?.replace(/\\/g, '/') ?? null;
      if (path && root && path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
      if (!path) path = mainFile;
      path = path.replace(/^\.\//, '');
      overlays[path] = tab.content;
      return {
        id: tab.id,
        path,
        revision: project.getDocumentRevision(tab.id),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const sortedOverlays = Object.fromEntries(Object.entries(overlays).sort(([left], [right]) => left.localeCompare(right)));
  const workspaceIdentity: Record<string, unknown> = {
    projectRoot: root,
    projectName: project.projectName,
    generation: project.getProjectGeneration(),
    engine,
    mainFile,
    documents,
    templateAssets: project.templateAssets,
  };
  const identityMaterial = { root, engine, mainFile, sortedOverlays, workspaceIdentity, templateAssets: project.templateAssets };
  return {
    projectRoot: root,
    engine,
    mainFile,
    overlays: sortedOverlays,
    allowedRoots: root ? [root] : [],
    workspaceIdentity,
    templateAssets: project.templateAssets,
    fingerprint: JSON.stringify(identityMaterial),
  };
};
