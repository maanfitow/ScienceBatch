import React, { useState, useCallback } from 'react';
import { 
  AlertOctagon, 
  AlertTriangle, 
  Lightbulb, 
  ChevronDown, 
  ChevronRight, 
  FileText, 
  CheckCircle2, 
  Copy, 
  Check, 
  RotateCw 
} from 'lucide-react';
import { toast } from 'sonner';
import { DiagnosticItem } from '../types';

export type { DiagnosticItem };

interface DiagnosticsViewProps {
  errors: DiagnosticItem[];
  warnings: DiagnosticItem[];
  rawLog: string;
  onRetryCompile: () => void;
  isCompiling: boolean;
  onSelectLine?: (line: number, file?: string | null) => void;
  engine?: 'latex' | 'typst';
}

export const DiagnosticsView: React.FC<DiagnosticsViewProps> = ({
  errors,
  warnings,
  rawLog,
  onRetryCompile,
  isCompiling,
  onSelectLine,
  engine = 'latex',
}) => {
  const [showRawLog, setShowRawLog] = useState<boolean>(false);
  const [copiedErrors, setCopiedErrors] = useState<boolean>(false);
  const [copiedRawLog, setCopiedRawLog] = useState<boolean>(false);
  const [copiedCardKey, setCopiedCardKey] = useState<string | null>(null);

  const hasIssues = errors.length > 0 || warnings.length > 0;

  // Copy concise formatted summary of all errors and warnings
  const handleCopyErrors = useCallback(async () => {
    if (!hasIssues) return;

    const sections: string[] = [];
    const engineTitle = engine === 'typst' ? 'Typst' : 'LaTeX';
    sections.push(`=== ${engineTitle} Compilation Diagnostics ===`);

    if (errors.length > 0) {
      sections.push(`\n[Errors (${errors.length})]`);
      errors.forEach((err, idx) => {
        const filePrefix = err.file 
          ? (err.line ? `[${err.file}:${err.line}] ` : `[${err.file}] `) 
          : (err.line ? `(Line ${err.line}) ` : '');
        sections.push(`${idx + 1}. ${filePrefix}${err.message}`);
        if (err.suggestion) {
          sections.push(`   Suggested Fix: ${err.suggestion}`);
        }
      });
    }

    if (warnings.length > 0) {
      sections.push(`\n[Warnings (${warnings.length})]`);
      warnings.forEach((warn, idx) => {
        const filePrefix = warn.file 
          ? (warn.line ? `[${warn.file}:${warn.line}] ` : `[${warn.file}] `) 
          : (warn.line ? `(Line ${warn.line}) ` : '');
        sections.push(`${idx + 1}. ${filePrefix}${warn.message}`);
        if (warn.suggestion) {
          sections.push(`   Note: ${warn.suggestion}`);
        }
      });
    }

    const summaryText = sections.join('\n');

    try {
      await navigator.clipboard.writeText(summaryText);
      setCopiedErrors(true);
      toast.success('Errors summary copied to clipboard');
      setTimeout(() => setCopiedErrors(false), 2000);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  }, [errors, warnings, hasIssues]);

  // Copy complete raw compiler log (texput.log)
  const handleCopyRawLog = useCallback(async () => {
    if (!rawLog) return;

    try {
      await navigator.clipboard.writeText(rawLog);
      setCopiedRawLog(true);
      toast.success('Complete compiler log copied to clipboard');
      setTimeout(() => setCopiedRawLog(false), 2000);
    } catch {
      toast.error('Failed to copy raw log');
    }
  }, [rawLog]);

  // Copy a single diagnostic card message and suggestion
  const handleCopySingleCard = useCallback(async (item: DiagnosticItem, key: string) => {
    const textToCopy = item.suggestion 
      ? `${item.message}\nSuggested Fix: ${item.suggestion}`
      : item.message;

    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopiedCardKey(key);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopiedCardKey(null), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  }, []);

  return (
    <div className="diagnostics-container">
      {/* Top Header Action Bar */}
      <div className="diagnostics-header">
        <div className="diagnostics-summary">
          {errors.length > 0 && (
            <span className="diag-pill diag-pill-error">
              <AlertOctagon size={14} />
              {errors.length} {errors.length === 1 ? 'Error' : 'Errors'}
            </span>
          )}
          {warnings.length > 0 && (
            <span className="diag-pill diag-pill-warning">
              <AlertTriangle size={14} />
              {warnings.length} {warnings.length === 1 ? 'Warning' : 'Warnings'}
            </span>
          )}
          {!hasIssues && (
            <span className="diag-pill diag-pill-clean">
              <CheckCircle2 size={14} />
              Clean Compilation
            </span>
          )}
        </div>

        <div className="diag-header-actions">
          {/* Copy Errors Summary Button */}
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleCopyErrors}
            disabled={!hasIssues}
            title="Copy concise error summary for chat analysis"
          >
            {copiedErrors ? (
              <>
                <Check size={14} className="text-emerald-400" />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <Copy size={14} />
                <span>Copy Errors</span>
              </>
            )}
          </button>

          {/* Copy Full Raw Log Button */}
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleCopyRawLog}
            disabled={!rawLog}
            title="Copy complete compiler log (texput.log)"
          >
            {copiedRawLog ? (
              <>
                <Check size={14} className="text-emerald-400" />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <FileText size={14} />
                <span>Copy Raw Log</span>
              </>
            )}
          </button>

          {/* Recompile Button */}
          <button
            className="btn btn-compile btn-sm"
            onClick={onRetryCompile}
            disabled={isCompiling}
            title="Trigger LaTeX recompilation (Ctrl + S)"
          >
            <RotateCw size={13} className={isCompiling ? 'animate-spin' : ''} />
            <span>{isCompiling ? 'Compiling...' : 'Recompile'}</span>
          </button>
        </div>
      </div>

      <div className="diagnostics-list">
        {/* Red Error Cards */}
        {errors.map((err, idx) => {
          const cardKey = `err-${idx}`;
          const isCopied = copiedCardKey === cardKey;

          return (
            <div key={cardKey} className="diag-card diag-card-error">
              <div className="diag-card-header">
                <div className="diag-card-title">
                  <AlertOctagon className="diag-icon-error" size={18} />
                  <span>{engine === 'typst' || err.message.toLowerCase().includes('typst') ? 'Typst Error' : 'LaTeX Error'}</span>
                  {(err.file || err.line) && (
                    <button
                      className="diag-card-line diag-card-line-btn flex items-center gap-1"
                      onClick={() => onSelectLine?.(err.line || 1, err.file)}
                      title={err.file ? `Open ${err.file}${err.line ? ` at line ${err.line}` : ''}` : `Jump to line ${err.line}`}
                    >
                      {err.file && <FileText size={11} className="shrink-0" />}
                      <span>{err.file ? (err.line ? `${err.file}:${err.line}` : err.file) : `Line ${err.line}`}</span>
                    </button>
                  )}
                </div>

                <button
                  className="btn-copy-card"
                  onClick={() => handleCopySingleCard(err, cardKey)}
                  title="Copy this error message"
                >
                  {isCopied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                </button>
              </div>

              <div className="diag-card-message">{err.message}</div>

              {err.suggestion && (
                <div className="diag-card-suggestion">
                  <Lightbulb size={15} className="diag-icon-tip" />
                  <div className="diag-tip-text">
                    <strong>Suggested Fix:</strong> {err.suggestion}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Yellow Warning Cards */}
        {warnings.map((warn, idx) => {
          const cardKey = `warn-${idx}`;
          const isCopied = copiedCardKey === cardKey;

          return (
            <div key={cardKey} className="diag-card diag-card-warning">
              <div className="diag-card-header">
                <div className="diag-card-title">
                  <AlertTriangle className="diag-icon-warning" size={18} />
                  <span>{engine === 'typst' || warn.message.toLowerCase().includes('typst') ? 'Typst Warning' : 'LaTeX Warning'}</span>
                  {(warn.file || warn.line) && (
                    <button
                      className="diag-card-line diag-card-line-btn flex items-center gap-1"
                      onClick={() => onSelectLine?.(warn.line || 1, warn.file)}
                      title={warn.file ? `Open ${warn.file}${warn.line ? ` at line ${warn.line}` : ''}` : `Jump to line ${warn.line}`}
                    >
                      {warn.file && <FileText size={11} className="shrink-0" />}
                      <span>{warn.file ? (warn.line ? `${warn.file}:${warn.line}` : warn.file) : `Line ${warn.line}`}</span>
                    </button>
                  )}
                </div>

                <button
                  className="btn-copy-card"
                  onClick={() => handleCopySingleCard(warn, cardKey)}
                  title="Copy this warning message"
                >
                  {isCopied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                </button>
              </div>

              <div className="diag-card-message">{warn.message}</div>

              {warn.suggestion && (
                <div className="diag-card-suggestion">
                  <Lightbulb size={15} className="diag-icon-tip" />
                  <div className="diag-tip-text">
                    <strong>Note:</strong> {warn.suggestion}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Empty / Clean State */}
        {!hasIssues && (
          <div className="diag-empty-clean">
            <CheckCircle2 size={42} className="text-emerald-400" />
            <h3>No Compilation Errors</h3>
            <p>Your document source code compiled cleanly without any errors or warnings.</p>
          </div>
        )}

        {/* Collapsible Raw Log Viewer with Header Copy Button */}
        {rawLog && (
          <div className="raw-log-section">
            <div className="raw-log-header">
              <button
                className="raw-log-toggle"
                onClick={() => setShowRawLog((prev) => !prev)}
              >
                <div className="raw-log-toggle-left">
                  <FileText size={16} />
                  <span>Raw Compiler Log</span>
                </div>
                {showRawLog ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>

              <button
                className="btn btn-secondary btn-sm raw-log-copy-btn"
                onClick={handleCopyRawLog}
                title="Copy entire raw log"
              >
                {copiedRawLog ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                <span>{copiedRawLog ? 'Copied' : 'Copy'}</span>
              </button>
            </div>

            {showRawLog && (
              <pre className="raw-log-viewer">
                <code>{rawLog}</code>
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
