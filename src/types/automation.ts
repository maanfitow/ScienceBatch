import type { EngineType } from './compiler';
import type { DiagnosticItem } from './diagnostics';

export interface WorkspaceAutomationRequest {
  schemaVersion: 1;
  id: string;
  operation: string;
  args: Record<string, unknown>;
}

export interface WorkspaceAutomationReply {
  schemaVersion: 1;
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface AutomationDocument {
  id: string;
  path: string | null;
  name: string;
  content: string;
  saved: boolean;
  revision: number;
}

export interface AutomationEditorBridge {
  getDocumentId(): string;
  getRevision(): number;
  apply(edit: { documentId: string; expectedRevision: number; start: number; end: number; text: string }): number | null;
  undo(): void;
  redo(): void;
  setReadOnly(readOnly: boolean): void;
}

export interface WorkspaceAutomationCompileResult {
  success: boolean;
  pdf_bytes: number[];
  errors: DiagnosticItem[];
  warnings: DiagnosticItem[];
  raw_log: string;
}

export interface WorkspaceCompileRequest {
  jobId: string;
  engine: EngineType;
  projectRoot: string | null;
  mainFile: string;
  overlays: Record<string, string>;
  allowedRoots: string[];
  timeoutSeconds?: number;
}
