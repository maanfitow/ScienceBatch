import { DiagnosticItem } from './diagnostics';

export type EngineType = 'latex' | 'typst';

export type CompilationStatus = 'idle' | 'compiling' | 'success' | 'error';

export interface ProgressPayload {
  status: string;
  message: string;
}

export interface CompileResponse {
  pdf_bytes: number[];
  success: boolean;
  errors: DiagnosticItem[];
  warnings: DiagnosticItem[];
  raw_log: string;
}
