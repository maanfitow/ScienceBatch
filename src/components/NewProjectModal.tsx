import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Folder, Sparkles, FileText, FileCode, Check, Archive } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { getDefaultLatexSource } from '../editor/latexData';
import { getDefaultTypstSource } from '../editor/typstData';

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
  const { t, i18n } = useTranslation(['menu', 'common']);
  const [activeTab, setActiveTab] = useState<'create' | 'import'>(initialTab);
  const [engine, setEngine] = useState<'latex' | 'typst'>('typst');
  const [projectName, setProjectName] = useState<string>('MySciencePaper');
  const [parentDir, setParentDir] = useState<string>('');
  const [zipPath, setZipPath] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (!isOpen || isProcessing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isProcessing, onClose]);

  if (!isOpen) return null;

  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('menu:newProjectModal.selectDestinationDialogTitle'),
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
        title: t('menu:newProjectModal.selectZipDialogTitle'),
        filters: [{ name: t('menu:newProjectModal.zipFilterName'), extensions: ['zip'] }],
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
        const templateContent = engine === 'typst'
          ? getDefaultTypstSource(i18n.language)
          : getDefaultLatexSource(i18n.language);
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
    <div className="modal-overlay" onClick={() => { if (!isProcessing) onClose(); }}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-group">
            {activeTab === 'import' ? (
              <Archive size={18} className="modal-title-icon icon-archive" />
            ) : (
              <Sparkles size={18} className="modal-title-icon" />
            )}
            <h3>
              {activeTab === 'import'
                ? t('menu:newProjectModal.importTitle')
                : t('menu:newProjectModal.createTitle')}
            </h3>
          </div>
          <button
            type="button"
            className="btn-modal-close"
            aria-label={t('menu:newProjectModal.closeAria')}
            disabled={isProcessing}
            onClick={onClose}
          >
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
            <span>{t('menu:newProjectModal.tabCreate')}</span>
          </button>
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === 'import' ? 'active' : ''}`}
            onClick={() => setActiveTab('import')}
          >
            <Archive size={14} />
            <span>{t('menu:newProjectModal.tabImport')}</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          {activeTab === 'import' ? (
            /* ZIP Archive Picker */
            <div className="modal-field">
              <label className="modal-label">{t('menu:newProjectModal.zipArchiveLabel')}</label>
              <div className="folder-picker-group">
                <input
                  type="text"
                  className="modal-input folder-path-input truncate"
                  value={zipPath}
                  placeholder={t('menu:newProjectModal.zipPlaceholder')}
                  readOnly
                  required
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-browse-folder"
                  onClick={handleSelectZip}
                >
                  <Archive size={15} className="icon-archive" />
                  <span>{t('menu:newProjectModal.browseZip')}</span>
                </button>
              </div>
              <p className="modal-desc">
                {t('menu:newProjectModal.zipDescription')}
              </p>
            </div>
          ) : (
            /* Engine Choice Cards */
            <div className="modal-field">
              <label className="modal-label">{t('menu:newProjectModal.engineLabel')}</label>
              <div className="engine-card-selector">
                <div 
                  className={`engine-card ${engine === 'typst' ? 'engine-card-selected' : ''}`}
                  onClick={() => setEngine('typst')}
                >
                  <div className="engine-card-header">
                    <FileCode size={22} className="icon-typst" />
                    <span className="engine-card-title">{t('common:engines.typst')}</span>
                    {engine === 'typst' && <Check size={16} className="engine-card-check" />}
                  </div>
                  <p className="engine-card-desc">
                    {t('menu:newProjectModal.typstDesc')}
                  </p>
                </div>

                <div 
                  className={`engine-card ${engine === 'latex' ? 'engine-card-selected' : ''}`}
                  onClick={() => setEngine('latex')}
                >
                  <div className="engine-card-header">
                    <FileText size={22} className="icon-latex" />
                    <span className="engine-card-title">{t('common:engines.latex')}</span>
                    {engine === 'latex' && <Check size={16} className="engine-card-check" />}
                  </div>
                  <p className="engine-card-desc">
                    {t('menu:newProjectModal.latexDesc')}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Project Name */}
          <div className="modal-field">
            <label className="modal-label">{t('menu:newProjectModal.projectNameLabel')}</label>
            <input
              type="text"
              className="modal-input"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={t('menu:newProjectModal.projectNamePlaceholder')}
              required
            />
          </div>

          {/* Location Folder */}
          <div className="modal-field">
            <label className="modal-label">{t('menu:newProjectModal.destinationLabel')}</label>
            <div className="folder-picker-group">
              <input
                type="text"
                className="modal-input folder-path-input truncate"
                value={parentDir}
                placeholder={t('menu:newProjectModal.destinationPlaceholder')}
                readOnly
                required
              />
              <button
                type="button"
                className="btn btn-secondary btn-browse-folder"
                onClick={handleSelectFolder}
              >
                <Folder size={15} />
                <span>{t('menu:newProjectModal.browseFolder')}</span>
              </button>
            </div>
          </div>

          {/* Modal Footer Actions */}
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={isProcessing}>
              {t('common:actions.cancel')}
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
                ? activeTab === 'import'
                  ? t('menu:newProjectModal.importing')
                  : t('menu:newProjectModal.creating')
                : activeTab === 'import'
                  ? t('menu:newProjectModal.submitImport')
                  : t('menu:newProjectModal.submitCreate')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

