export type SidebarToolId = 'files' | 'search' | 'outline' | 'git';

export interface SidebarState {
  topTools: SidebarToolId[];
  bottomTools: SidebarToolId[];
  activeTopTool: SidebarToolId | null;
  activeBottomTool: SidebarToolId | null;
  panelWidth: number;
  splitRatio: number;
  isOpen: boolean;
}

export interface OutlineItem {
  id: string;
  title: string;
  level: number;
  line: number;
  filePath: string;
  fileName: string;
  rawCommand?: string;
}

export interface SearchMatchItem {
  line: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
  matchText: string;
}

export interface FileSearchResults {
  filePath: string;
  relativePath: string;
  fileName: string;
  matches: SearchMatchItem[];
}
