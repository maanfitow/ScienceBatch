export interface DiagnosticItem {
  severity: string;
  message: string;
  line?: number | null;
  file?: string | null;
  suggestion?: string | null;
  suggestion_code?: string | null;
  suggestion_params?: Record<string, string | number> | null;
}
