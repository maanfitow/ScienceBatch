import React from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { 
  FolderPlus, 
  FolderOpen, 
  GitBranch,
  RotateCcw, 
  FileCode, 
  FileText, 
  ChevronRight,
  BookOpen,
  Archive,
  X,
  Globe
} from 'lucide-react';
import { normalizeLanguage, setAppLanguage } from '../i18n';
import { RecentProject } from '../types';

export type { RecentProject };

interface WelcomeScreenProps {
  onNewProject: () => void;
  onOpenFolder: () => void;
  onCloneRepository: () => void;
  onImportZip: () => void;
  onQuickScratchpad: (engine: 'latex' | 'typst') => void;
  recentProjects: RecentProject[];
  onOpenRecentProject: (path: string) => void;
  onRemoveRecentProject?: (path: string) => void;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  onNewProject,
  onOpenFolder,
  onCloneRepository,
  onImportZip,
  onQuickScratchpad,
  recentProjects,
  onOpenRecentProject,
  onRemoveRecentProject,
}) => {
  const { t, i18n } = useTranslation(['common', 'menu']);
  const currentLanguage = normalizeLanguage(i18n.language);

  return (
    <div className="welcome-screen">
      <div className="welcome-language-switcher" role="group" aria-label={t('menu:language.ariaLabel')}>
        <Globe size={13} aria-hidden="true" />
        <button
          type="button"
          className={`welcome-lang-btn ${currentLanguage === 'en' ? 'is-active' : ''}`}
          onClick={() => { void setAppLanguage('en'); }}
          aria-pressed={currentLanguage === 'en'}
        >
          {t('common:languages.shortEn')}
        </button>
        <button
          type="button"
          className={`welcome-lang-btn ${currentLanguage === 'es' ? 'is-active' : ''}`}
          onClick={() => { void setAppLanguage('es'); }}
          aria-pressed={currentLanguage === 'es'}
        >
          {t('common:languages.shortEs')}
        </button>
      </div>
      <div className="welcome-hero">
        <div className="welcome-logo-badge">
          <span className="welcome-logo-chip welcome-logo-latex">
            <FileText size={26} />
          </span>
          <span className="welcome-logo-chip welcome-logo-typst">
            <FileCode size={26} />
          </span>
        </div>
        <h1 className="welcome-title">{t('common:appStudioName')}</h1>
        <p className="welcome-subtitle">
          <Trans ns="menu" i18nKey="welcome.subtitle" components={{ strong: <strong /> }} />
        </p>
      </div>

      <div className="welcome-grid">
        {/* Left Column: Streamlined Quick Actions */}
        <div className="welcome-actions-card">
          <h2 className="welcome-section-title">{t('menu:welcome.startDocument')}</h2>

          <div className="welcome-action-buttons">
            <button className="btn-welcome-action btn-welcome-primary" onClick={onNewProject}>
              <div className="action-icon-circle action-icon-latex">
                <FolderPlus size={20} />
              </div>
              <div className="action-text-group">
                <span className="action-title">{t('menu:welcome.newProjectTitle')}</span>
                <span className="action-desc">{t('menu:welcome.newProjectDesc')}</span>
              </div>
              <ChevronRight size={16} className="action-arrow" />
            </button>

            <button className="btn-welcome-action" onClick={onOpenFolder}>
              <div className="action-icon-circle action-icon-folder">
                <FolderOpen size={20} />
              </div>
              <div className="action-text-group">
                <span className="action-title">{t('menu:welcome.openFolderTitle')}</span>
                <span className="action-desc">{t('menu:welcome.openFolderDesc')}</span>
              </div>
              <ChevronRight size={16} className="action-arrow" />
            </button>

            <button type="button" className="btn-welcome-action" onClick={onImportZip}>
              <div className="action-icon-circle action-icon-archive">
                <Archive size={20} />
              </div>
              <div className="action-text-group">
                <span className="action-title">{t('menu:welcome.importZipTitle')}</span>
                <span className="action-desc">{t('menu:welcome.importZipDesc')}</span>
              </div>
              <ChevronRight size={16} className="action-arrow" />
            </button>

            <button type="button" className="btn-welcome-action" onClick={onCloneRepository}>
              <div className="action-icon-circle action-icon-git">
                <GitBranch size={20} />
              </div>
              <div className="action-text-group">
                <span className="action-title">{t('menu:welcome.cloneRepoTitle')}</span>
                <span className="action-desc">{t('menu:welcome.cloneRepoDesc')}</span>
              </div>
              <ChevronRight size={16} className="action-arrow" />
            </button>

            {/* Sleek Compact In-Memory Scratchpad Bar */}
            <div className="welcome-scratchpad-bar">
              <span className="welcome-scratchpad-title">{t('menu:welcome.scratchpadLabel')}</span>
              <div className="welcome-scratchpad-actions">
                <button 
                  className="btn-scratchpad-pill" 
                  onClick={() => onQuickScratchpad('latex')}
                  title={t('menu:welcome.quickLatexTooltip')}
                >
                  <FileText size={14} className="icon-latex" />
                  <span>{t('menu:welcome.quickLatex')}</span>
                </button>
                <button 
                  className="btn-scratchpad-pill" 
                  onClick={() => onQuickScratchpad('typst')}
                  title={t('menu:welcome.quickTypstTooltip')}
                >
                  <FileCode size={14} className="icon-typst" />
                  <span>{t('menu:welcome.quickTypst')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Recent Projects */}
        <div className="welcome-recent-card">
          <div className="welcome-recent-header">
            <h2 className="welcome-section-title">
              <RotateCcw size={16} className="text-muted" />
              <span>{t('menu:welcome.recentProjects')}</span>
            </h2>
          </div>

          <div className="recent-projects-list">
            {recentProjects.length > 0 ? (
              recentProjects.map((proj) => (
                <div 
                  key={proj.path} 
                  className="recent-project-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenRecentProject(proj.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenRecentProject(proj.path);
                    }
                  }}
                >
                  <div className="recent-proj-info">
                    <div className="recent-proj-header">
                      <span className="recent-proj-name">{proj.name}</span>
                      <span className={`recent-engine-badge badge-${proj.engine}`}>
                        {proj.engine.toUpperCase()}
                      </span>
                    </div>
                    <span className="recent-proj-path truncate" title={proj.path}>
                      {proj.path}
                    </span>
                  </div>
                  
                  <div className="recent-row-actions">
                    {onRemoveRecentProject && (
                      <button
                        className="btn-remove-recent"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveRecentProject(proj.path);
                        }}
                        title={t('menu:welcome.removeRecentTooltip')}
                        aria-label={t('menu:welcome.removeRecentAria')}
                      >
                        <X size={13} />
                      </button>
                    )}
                    <ChevronRight size={15} className="recent-proj-arrow" />
                  </div>
                </div>
              ))
            ) : (
              <div className="recent-empty-state">
                <BookOpen size={28} className="recent-empty-icon" />
                <p>{t('menu:welcome.noRecentTitle')}</p>
                <span>{t('menu:welcome.noRecentSubtitle')}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
