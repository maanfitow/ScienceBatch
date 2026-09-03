import React, { useState } from 'react';
import { X, Folder, Sparkles, FileText, FileCode, Check, Archive } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { DEFAULT_LATEX_SOURCE } from '../editor/latexData';
import { DEFAULT_TYPST_SOURCE } from '../editor/typstData';

interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateProject: (
    parentDir: string,
    projectName: string,
    engine: 'latex' | 'typst',
    templateContent: string
  ) => Promise<void>;
  onImportZipProject?: (
    zipPath: string,
    parentDir: string,
    projectName: string
  ) => Promise<void>;
  initialTab?: 'create' | 'import';
}

export const NewProjectModal: React.FC<NewProjectModalProps> = ({
  isOpen,
  onClose,
  onCreateProject,
  onImportZipProject,
  initialTab = 'create',
}) => {
  const [activeTab, setActiveTab] = useState<'create' | 'import'>(initialTab);
  const [engine, setEngine] = useState<'latex' | 'typst'>('typst');
  const [projectName, setProjectName] = useState<string>('MySciencePaper');
  const [parentDir, setParentDir] = useState<string>('');
  const [zipPath, setZipPath] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  if (!isOpen) return null;

  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Destination Folder for Project',
      });

      if (selected && typeof selected === 'string') {
        setParentDir(selected);
      }
    } catch (e) {
      console.error('Error choosing destination directory:', e);
    }
  };

  const handleSelectZip = async () => {
    try {
      const selected = await open({
        multiple: false,
        title: 'Select LaTeX or Typst Project ZIP Archive',
        filters: [{ name: 'ZIP Archives (*.zip)', extensions: ['zip'] }],
      });

      if (selected && typeof selected === 'string') {
        setZipPath(selected);
        const fileName = selected.split(/[/\\]/).pop() || '';
        const stem = fileName.replace(/\.zip$/i, '');
        if (stem) {
          setProjectName(stem);
        }
      }
    } catch (e) {
      console.error('Error choosing ZIP archive:', e);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isProcessing) return;

    if (activeTab === 'import') {
      if (!zipPath.trim() || !parentDir.trim() || !projectName.trim()) return;
      if (!onImportZipProject) return;

      setIsProcessing(true);
      try {
        await onImportZipProject(zipPath.trim(), parentDir.trim(), projectName.trim());
        onClose();
      } catch (err) {
        console.error('Failed to import project from zip:', err);
      } finally {
        setIsProcessing(false);
      }
    } else {
      if (!projectName.trim() || !parentDir.trim()) return;

      setIsProcessing(true);
      try {
        const templateContent = engine === 'typst' ? DEFAULT_TYPST_SOURCE : DEFAULT_LATEX_SOURCE;
        await onCreateProject(parentDir.trim(), projectName.trim(), engine, templateContent);
        onClose();
      } catch (err) {
        console.error('Failed to create project:', err);
      } finally {
        setIsProcessing(false);
      }
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-group">
            {activeTab === 'import' ? (
              <Archive size={18} className="modal-title-icon text-purple-400" />
            ) : (
              <Sparkles size={18} className="modal-title-icon" />
            )}
            <h3>{activeTab === 'import' ? 'Import Project from ZIP' : 'Create New Scientific Project'}</h3>
          </div>
          <button className="btn-modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="modal-tabs">
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === 'create' ? 'active' : ''}`}
            onClick={() => setActiveTab('create')}
          >
            <Sparkles size={14} />
            <span>New Blank Project</span>
          </button>
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === 'import' ? 'active' : ''}`}
            onClick={() => setActiveTab('import')}
          >
            <Archive size={14} />
            <span>Import from ZIP</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          {activeTab === 'import' ? (
            /* ZIP Archive Picker */
            <div className="modal-field">
              <label className="modal-label">Project ZIP Archive</label>
              <div className="folder-picker-group">
                <input
                  type="text"
                  className="modal-input folder-path-input truncate"
                  value={zipPath}
                  placeholder="Click browse to select .zip archive..."
                  readOnly
                  required
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-browse-folder"
                  onClick={handleSelectZip}
                >
                  <Archive size={15} className="text-purple-400" />
                  <span>Browse ZIP...</span>
                </button>
              </div>
              <p className="modal-desc text-xs text-muted" style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
                Select any LaTeX or Typst archive (.zip), including project packages exported from cloud services.
              </p>
            </div>
          ) : (
            /* Engine Choice Cards */
            <div className="modal-field">
              <label className="modal-label">Typesetting Engine</label>
              <div className="engine-card-selector">
                <div 
                  className={`engine-card ${engine === 'typst' ? 'engine-card-selected' : ''}`}
                  onClick={() => setEngine('typst')}
                >
                  <div className="engine-card-header">
                    <FileCode size={22} className="text-cyan-400" />
                    <span className="engine-card-title">Typst</span>
                    {engine === 'typst' && <Check size={16} className="engine-card-check" />}
                  </div>
                  <p className="engine-card-desc">
                    Modern Rust-native typesetting. Blazing fast (&lt;50ms), intuitive syntax and expressive layouts.
                  </p>
                </div>

                <div 
                  className={`engine-card ${engine === 'latex' ? 'engine-card-selected' : ''}`}
                  onClick={() => setEngine('latex')}
                >
                  <div className="engine-card-header">
                    <FileText size={22} className="text-blue-400" />
                    <span className="engine-card-title">LaTeX</span>
                    {engine === 'latex' && <Check size={16} className="engine-card-check" />}
                  </div>
                  <p className="engine-card-desc">
                    Gold-standard academic typesetting with Tectonic RAM VFS. Complete CTAN packages and BibTeX.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Project Name */}
          <div className="modal-field">
            <label className="modal-label">Project Folder Name</label>
            <input
              type="text"
              className="modal-input"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g. QuantumComputingPaper"
              required
            />
          </div>

          {/* Location Folder */}
          <div className="modal-field">
            <label className="modal-label">Destination Folder</label>
            <div className="folder-picker-group">
              <input
                type="text"
                className="modal-input folder-path-input truncate"
                value={parentDir}
                placeholder="Click browse to select directory..."
                readOnly
                required
              />
              <button
                type="button"
                className="btn btn-secondary btn-browse-folder"
                onClick={handleSelectFolder}
              >
                <Folder size={15} />
                <span>Browse...</span>
              </button>
            </div>
          </div>

          {/* Modal Footer Actions */}
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={isProcessing}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-compile"
              disabled={
                activeTab === 'import'
                  ? !zipPath.trim() || !parentDir.trim() || !projectName.trim() || isProcessing
                  : !projectName.trim() || !parentDir.trim() || isProcessing
              }
            >
              {isProcessing
                ? activeTab === 'import' ? 'Importing Archive...' : 'Creating Project...'
                : activeTab === 'import' ? 'Import & Open Project' : 'Create & Open Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

