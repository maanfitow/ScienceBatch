import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
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
import { translateBackendError, translateDiagnosticSuggestion } from '../i18n/backendMessages';

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
  const { t } = useTranslation(['editor', 'errors', 'common']);
  const [showRawLog, setShowRawLog] = useState<boolean>(false);
  const [copiedErrors, setCopiedErrors] = useState<boolean>(false);
  const [copiedRawLog, setCopiedRawLog] = useState<boolean>(false);
  const [copiedCardKey, setCopiedCardKey] = useState<string | null>(null);

  const hasIssues = errors.length > 0 || warnings.length > 0;
  const engineLabel = engine === 'typst' ? t('common:engines.typst') : t('common:engines.latex');

  // Copy concise formatted summary of all errors and warnings
  const handleCopyErrors = useCallback(async () => {
    if (!hasIssues) return;

    const sections: string[] = [];
    sections.push(t('editor:diagnostics.summaryHeader', { engine: engineLabel }));

    if (errors.length > 0) {
      sections.push(`\n${t('editor:diagnostics.summaryErrorsSection', { count: errors.length })}`);
      errors.forEach((err, idx) => {
        const filePrefix = err.file 
          ? (err.line ? `[${err.file}:${err.line}] ` : `[${err.file}] `) 
          : (err.line ? t('editor:diagnostics.summaryLinePrefix', { line: err.line }) : '');
        const messageText = translateBackendError(err.message);
        const suggestionText = translateDiagnosticSuggestion(err);
        sections.push(`${idx + 1}. ${filePrefix}${messageText}`);
        if (suggestionText) {
          sections.push(`   ${t('editor:diagnostics.summarySuggestedFix', { suggestion: suggestionText })}`);
        }
      });
    }

    if (warnings.length > 0) {
      sections.push(`\n${t('editor:diagnostics.summaryWarningsSection', { count: warnings.length })}`);
      warnings.forEach((warn, idx) => {
        const filePrefix = warn.file 
          ? (warn.line ? `[${warn.file}:${warn.line}] ` : `[${warn.file}] `) 
          : (warn.line ? t('editor:diagnostics.summaryLinePrefix', { line: warn.line }) : '');
        const messageText = translateBackendError(warn.message);
        const suggestionText = translateDiagnosticSuggestion(warn);
        sections.push(`${idx + 1}. ${filePrefix}${messageText}`);
        if (suggestionText) {
          sections.push(`   ${t('editor:diagnostics.summaryNote', { suggestion: suggestionText })}`);
        }
      });
    }

    const summaryText = sections.join('\n');

    try {
      await navigator.clipboard.writeText(summaryText);
      setCopiedErrors(true);
      toast.success(t('editor:diagnostics.errorsCopied'));
      setTimeout(() => setCopiedErrors(false), 2000);
    } catch {
      toast.error(t('errors:diagnostics.copyFailed'));
    }
  }, [errors, warnings, hasIssues, engineLabel, t]);

  // Copy complete raw compiler log (texput.log)
  const handleCopyRawLog = useCallback(async () => {
    if (!rawLog) return;

    try {
      await navigator.clipboard.writeText(rawLog);
      setCopiedRawLog(true);
      toast.success(t('editor:diagnostics.rawLogCopied'));
      setTimeout(() => setCopiedRawLog(false), 2000);
    } catch {
      toast.error(t('errors:diagnostics.copyRawLogFailed'));
    }
  }, [rawLog, t]);

  // Copy a single diagnostic card message and suggestion
  const handleCopySingleCard = useCallback(async (item: DiagnosticItem, key: string) => {
    const messageText = translateBackendError(item.message);
    const suggestionText = translateDiagnosticSuggestion(item);
    const textToCopy = suggestionText 
      ? `${messageText}\n${t('editor:diagnostics.summarySuggestedFix', { suggestion: suggestionText })}`
      : messageText;

    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopiedCardKey(key);
      toast.success(t('editor:diagnostics.copiedToClipboard'));
      setTimeout(() => setCopiedCardKey(null), 2000);
    } catch {
      toast.error(t('errors:clipboard.copyFailed'));
    }
  }, [t]);

  return (
    <div className="diagnostics-container">
      {/* Top Header Action Bar */}
      <div className="diagnostics-header">
        <div className="diagnostics-summary">
          {errors.length > 0 && (
            <span className="diag-pill diag-pill-error">
              <AlertOctagon size={14} />
              {errors.length === 1
                ? t('editor:diagnostics.errorSingular', { count: errors.length })
                : t('editor:diagnostics.errorPlural', { count: errors.length })}
            </span>
          )}
          {warnings.length > 0 && (
            <span className="diag-pill diag-pill-warning">
              <AlertTriangle size={14} />
              {warnings.length === 1
                ? t('editor:diagnostics.warningSingular', { count: warnings.length })
                : t('editor:diagnostics.warningPlural', { count: warnings.length })}
            </span>
          )}
          {!hasIssues && (
            <span className="diag-pill diag-pill-clean">
              <CheckCircle2 size={14} />
              {t('editor:diagnostics.cleanCompilation')}
            </span>
          )}
        </div>

        <div className="diag-header-actions">
          {/* Copy Errors Summary Button */}
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleCopyErrors}
            disabled={!hasIssues}
            title={t('editor:diagnostics.copyErrorsTooltip')}
          >
            {copiedErrors ? (
              <>
                <Check size={14} className="icon-success" />
                <span>{t('editor:diagnostics.copiedBang')}</span>
              </>
            ) : (
              <>
                <Copy size={14} />
                <span>{t('editor:diagnostics.copyErrors')}</span>
              </>
            )}
          </button>

          {/* Copy Full Raw Log Button */}
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleCopyRawLog}
            disabled={!rawLog}
            title={t('editor:diagnostics.copyRawLogTooltip')}
          >
            {copiedRawLog ? (
              <>
                <Check size={14} className="icon-success" />
                <span>{t('editor:diagnostics.copiedBang')}</span>
              </>
            ) : (
              <>
                <FileText size={14} />
                <span>{t('editor:diagnostics.copyRawLog')}</span>
              </>
            )}
          </button>

          {/* Recompile Button */}
          <button
            className="btn btn-compile btn-sm"
            onClick={onRetryCompile}
            disabled={isCompiling}
            title={t('editor:diagnostics.recompileTooltip', { engine: engineLabel })}
          >
            <RotateCw size={13} className={isCompiling ? 'animate-spin' : ''} />
            <span>{isCompiling ? t('editor:diagnostics.compiling') : t('editor:diagnostics.recompile')}</span>
          </button>
        </div>
      </div>

      <div className="diagnostics-list">
        {/* Red Error Cards */}
        {errors.map((err, idx) => {
          const cardKey = `err-${idx}`;
          const isCopied = copiedCardKey === cardKey;
          const messageText = translateBackendError(err.message);
          const suggestionText = translateDiagnosticSuggestion(err);

          return (
            <div key={cardKey} className="diag-card diag-card-error">
              <div className="diag-card-header">
                <div className="diag-card-title">
                  <AlertOctagon className="diag-icon-error" size={18} />
                  <span>{engine === 'typst' || err.message.toLowerCase().includes('typst') ? t('editor:diagnostics.typstError') : t('editor:diagnostics.latexError')}</span>
                  {(err.file || err.line) && (
                    <button
                      className="diag-card-line diag-card-line-btn flex items-center gap-1"
                      onClick={() => onSelectLine?.(err.line || 1, err.file)}
                      title={
                        err.file
                          ? (err.line
                              ? t('editor:diagnostics.openFileAtLineTooltip', { file: err.file, line: err.line })
                              : t('editor:diagnostics.openFileTooltip', { file: err.file }))
                          : t('editor:diagnostics.jumpToLineTooltip', { line: err.line })
                      }
                    >
                      {err.file && <FileText size={11} className="shrink-0" />}
                      <span>{err.file ? (err.line ? `${err.file}:${err.line}` : err.file) : t('editor:diagnostics.lineLabel', { line: err.line })}</span>
                    </button>
                  )}
                </div>

                <button
                  className="btn-copy-card"
                  onClick={() => handleCopySingleCard(err, cardKey)}
                  title={t('editor:diagnostics.copyErrorTooltip')}
                >
                  {isCopied ? <Check size={14} className="icon-success" /> : <Copy size={14} />}
                </button>
              </div>

              <div className="diag-card-message">{messageText}</div>

              {suggestionText && (
                <div className="diag-card-suggestion">
                  <Lightbulb size={15} className="diag-icon-tip" />
                  <div className="diag-tip-text">
                    <strong>{t('editor:diagnostics.suggestedFix')}</strong> {suggestionText}
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
          const messageText = translateBackendError(warn.message);
          const suggestionText = translateDiagnosticSuggestion(warn);

          return (
            <div key={cardKey} className="diag-card diag-card-warning">
              <div className="diag-card-header">
                <div className="diag-card-title">
                  <AlertTriangle className="diag-icon-warning" size={18} />
                  <span>{engine === 'typst' || warn.message.toLowerCase().includes('typst') ? t('editor:diagnostics.typstWarning') : t('editor:diagnostics.latexWarning')}</span>
                  {(warn.file || warn.line) && (
                    <button
                      className="diag-card-line diag-card-line-btn flex items-center gap-1"
                      onClick={() => onSelectLine?.(warn.line || 1, warn.file)}
                      title={
                        warn.file
                          ? (warn.line
                              ? t('editor:diagnostics.openFileAtLineTooltip', { file: warn.file, line: warn.line })
                              : t('editor:diagnostics.openFileTooltip', { file: warn.file }))
                          : t('editor:diagnostics.jumpToLineTooltip', { line: warn.line })
                      }
                    >
                      {warn.file && <FileText size={11} className="shrink-0" />}
                      <span>{warn.file ? (warn.line ? `${warn.file}:${warn.line}` : warn.file) : t('editor:diagnostics.lineLabel', { line: warn.line })}</span>
                    </button>
                  )}
                </div>

                <button
                  className="btn-copy-card"
                  onClick={() => handleCopySingleCard(warn, cardKey)}
                  title={t('editor:diagnostics.copyWarningTooltip')}
                >
                  {isCopied ? <Check size={14} className="icon-success" /> : <Copy size={14} />}
                </button>
              </div>

              <div className="diag-card-message">{messageText}</div>

              {suggestionText && (
                <div className="diag-card-suggestion">
                  <Lightbulb size={15} className="diag-icon-tip" />
                  <div className="diag-tip-text">
                    <strong>{t('editor:diagnostics.note')}</strong> {suggestionText}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Empty / Clean State */}
        {!hasIssues && (
          <div className="diag-empty-clean">
            <CheckCircle2 size={42} className="icon-success" />
            <h3>{t('editor:diagnostics.emptyTitle')}</h3>
            <p>{t('editor:diagnostics.emptyDescription')}</p>
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
                  <span>{t('editor:diagnostics.rawLogTitle')}</span>
                </div>
                {showRawLog ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>

              <button
                className="btn btn-secondary btn-sm raw-log-copy-btn"
                onClick={handleCopyRawLog}
                title={t('editor:diagnostics.copyEntireRawLogTooltip')}
              >
                {copiedRawLog ? <Check size={13} className="icon-success" /> : <Copy size={13} />}
                <span>{copiedRawLog ? t('editor:diagnostics.copied') : t('common:actions.copy')}</span>
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
