import { EngineType } from './compiler';

export interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileItem[];
}

export interface RecentProject {
  path: string;
  name: string;
  lastOpened?: string | number;
  engine: EngineType;
}

export type ViewMode = 'welcome' | 'editor';

export interface ImageViewerState {
  path: string;
  name: string;
  relPath: string;
}
