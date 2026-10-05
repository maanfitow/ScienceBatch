import React, { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Folder, GitBranch, LoaderCircle, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import type { GitOperationError, GitOperationProgressPayload } from '../types/git';
import './cloneRepository.css';

interface CloneRepositoryModalProps {
  isOpen: boolean;
  running: boolean;
  progress: GitOperationProgressPayload | null;
  error: GitOperationError | null;
  onClose: () => void;
  onOpenExisting: (path: string) => Promise<boolean>;
  onClone: (url: string, parentDir: string, directoryName: string) => Promise<void>;
}

const safeMessage = (value: string) => value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@');

export const CloneRepositoryModal: React.FC<CloneRepositoryModalProps> = ({
  isOpen,
  running,
  progress,
  error,
  onClose,
  onOpenExisting,
  onClone,
}) => {
  const [url, setUrl] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [directoryName, setDirectoryName] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openFailurePath, setOpenFailurePath] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busy = running || isSubmitting;

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => urlInputRef.current?.focus());
    return () => previousFocusRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || busy) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, busy, onClose]);

  useEffect(() => {
    if (isOpen && busy) dialogRef.current?.focus();
  }, [isOpen, busy]);

  if (!isOpen) return null;

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select Parent Folder for Repository' });
      if (selected && typeof selected === 'string') setParentDir(selected);
    } catch {
      setSubmitError('Unable to open the folder picker. Enter the parent folder path manually.');
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    if (busy) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter(element => !element.hasAttribute('aria-hidden'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || openFailurePath) return;
    const normalizedName = directoryName.trim();
    if (!url.trim() || !parentDir.trim() || !normalizedName) return;
    if (normalizedName === '.' || normalizedName === '..' || /[/\\]/.test(normalizedName)) {
      setSubmitError('Enter a folder name without path separators.');
      return;
    }
    setSubmitError(null);
    setOpenFailurePath(null);
    setIsSubmitting(true);
    try {
      await onClone(url.trim(), parentDir.trim(), normalizedName);
      onClose();
    } catch (reason) {
      const path = reason && typeof reason === 'object' && 'projectPath' in reason && typeof reason.projectPath === 'string'
        ? reason.projectPath
        : null;
      if (path) setOpenFailurePath(path);
      setSubmitError('Clone failed. Review the details below and try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenExisting = async () => {
    if (!openFailurePath || busy) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const opened = await onOpenExisting(openFailurePath);
      if (opened) onClose();
      else setSubmitError('ScienceBatch could not open the cloned repository. Its files are still available at the path below.');
    } catch {
      setSubmitError('ScienceBatch could not open the cloned repository. Its files are still available at the path below.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const safeError = error ? safeMessage(error.message) : null;
  const safeRecovery = error?.recovery ? safeMessage(error.recovery) : null;

  return (
    <div className="modal-overlay clone-repository-overlay" onClick={() => { if (!busy) onClose(); }}>
      <div
        className="modal-card clone-repository-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clone-repository-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={event => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <GitBranch size={18} className="modal-title-icon" />
            <h3 id="clone-repository-title">Clone Repository</h3>
          </div>
          <button className="btn-modal-close" type="button" aria-label="Close dialog" disabled={busy} onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body clone-repository-body">
            <p className="clone-repository-help">Clone a repository using your existing Git credential manager or SSH configuration.</p>

            <div className="modal-field">
              <label className="modal-label" htmlFor="clone-repository-url">Repository URL</label>
              <input
                ref={urlInputRef}
                id="clone-repository-url"
                className="modal-input"
                value={url}
              onChange={event => setUrl(event.target.value)}
                placeholder="https://github.com/owner/project.git or git@gitlab.com:owner/project.git"
                autoComplete="url"
                required
                disabled={busy}
              />
            </div>

            <div className="modal-field">
              <label className="modal-label" htmlFor="clone-repository-parent">Parent Folder</label>
              <div className="clone-repository-folder-row">
                <input
                  id="clone-repository-parent"
                  className="modal-input folder-path-input truncate"
                  value={parentDir}
                  onChange={event => setParentDir(event.target.value)}
                  placeholder="Choose where the repository folder will be created"
                  required
                  disabled={busy}
                />
                <button className="clone-repository-browse" type="button" onClick={handleBrowse} disabled={busy} aria-label="Browse for parent folder">
                  <Folder size={15} /> Browse
                </button>
              </div>
            </div>

            <div className="modal-field">
              <label className="modal-label" htmlFor="clone-repository-name">New Folder Name</label>
              <input
                id="clone-repository-name"
                className="modal-input"
                value={directoryName}
                onChange={event => setDirectoryName(event.target.value)}
                placeholder="science-project"
                required
                disabled={busy}
              />
            <span className="clone-repository-hint">The destination must be a new folder. Existing files will not be overwritten.</span>
          </div>

            {busy && (
              <div className="clone-repository-progress" role="status" aria-live="polite">
                <LoaderCircle size={15} className="spin" />
                <span>{running ? safeMessage(progress?.message || 'Starting clone…') : 'Opening cloned project…'}</span>
              </div>
            )}
            {(submitError || safeError) && <div className="clone-repository-error" role="alert">{openFailurePath ? 'The repository cloned successfully, but ScienceBatch could not open it.' : safeError || submitError}</div>}
            {error?.partialPath && (
              <div className="clone-repository-recovery">
                Partial repository retained at <code>{error.partialPath}</code>.
                {safeRecovery && <span>{safeRecovery}</span>}
              </div>
            )}
            {openFailurePath && (
              <div className="clone-repository-recovery">
                Cloned repository retained at <code>{openFailurePath}</code>.
                <button type="button" className="clone-repository-open-existing" disabled={busy} onClick={() => void handleOpenExisting()}>Open Existing Repository</button>
              </div>
            )}
            {safeRecovery && !error?.partialPath && <div className="clone-repository-recovery">{safeRecovery}</div>}
          </div>

          <div className="modal-footer clone-repository-footer">
            <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy || !!openFailurePath || !url.trim() || !parentDir.trim() || !directoryName.trim()}>
              {running ? 'Cloning…' : busy ? 'Opening…' : 'Clone Repository'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
