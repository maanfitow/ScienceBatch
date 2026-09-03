export interface DiagnosticItem {
  severity: string;
  message: string;
  line?: number | null;
  file?: string | null;
  suggestion?: string | null;
}
