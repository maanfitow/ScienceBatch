import { DiagnosticItem } from './diagnostics';

export type EngineType = 'latex' | 'typst';

export type CompilationStatus = 'idle' | 'compiling' | 'success' | 'error';

export interface ProgressPayload {
  status: string;
  message: string;
  code?: string | null;
  params?: Record<string, string | number> | null;
}

export interface PdfSourceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  fileIdx: number;
  line: number;
  column?: number | null;
  level: number;
}

export interface PdfSourcePage {
  page: number;
  widthPt: number;
  heightPt: number;
  boxes: PdfSourceBox[];
}

export interface PdfSourceMap {
  files: string[];
  pages: PdfSourcePage[];
}

export interface CompileResponse {
  pdf_bytes: number[];
  success: boolean;
  errors: DiagnosticItem[];
  warnings: DiagnosticItem[];
  raw_log: string;
  source_map?: PdfSourceMap | null;
}
