import React from 'react';
import { 
  FolderPlus, 
  FolderOpen, 
  GitBranch,
  RotateCcw, 
  FileCode, 
  FileText, 
  ChevronRight,
  BookOpen,
  X
} from 'lucide-react';
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
  onQuickScratchpad,
  recentProjects,
  onOpenRecentProject,
  onRemoveRecentProject,
}) => {
  return (
    <div className="welcome-screen">
      <div className="welcome-hero">
        <div className="welcome-logo-badge">
          <FileText size={32} className="text-blue-500" />
          <FileCode size={32} className="text-cyan-400" />
        </div>
        <h1 className="welcome-title">ScienceBatch Studio</h1>
        <p className="welcome-subtitle">
          High-performance local typesetting environment for <strong>LaTeX</strong> and <strong>Typst</strong>.
        </p>
      </div>

      <div className="welcome-grid">
        {/* Left Column: Streamlined Quick Actions */}
        <div className="welcome-actions-card">
          <h2 className="welcome-section-title">Start a Document</h2>

          <div className="welcome-action-buttons">
            <button className="btn-welcome-action btn-welcome-primary" onClick={onNewProject}>
              <div className="action-icon-circle bg-blue-600/20 text-blue-400">
                <FolderPlus size={20} />
              </div>
              <div className="action-text-group">
                <span className="action-title">New Project</span>
                <span className="action-desc">Create from starter templates or import from ZIP archive</span>
              </div>
              <ChevronRight size={16} className="action-arrow" />
            </button>

            <button className="btn-welcome-action" onClick={onOpenFolder}>
              <div className="action-icon-circle bg-amber-600/20 text-amber-400">
                <FolderOpen size={20} />
              </div>
              <div className="action-text-group">
                <span className="action-title">Open Project Folder</span>
                <span className="action-desc">Open any folder containing .tex or .typ files</span>
              </div>
              <ChevronRight size={16} className="action-arrow" />
            </button>

            <button className="btn-welcome-action" onClick={onCloneRepository}>
              <div className="action-icon-circle bg-emerald-600/20 text-emerald-400">
                <GitBranch size={20} />
              </div>
              <div className="action-text-group">
                <span className="action-title">Clone Repository</span>
                <span className="action-desc">Clone a GitHub or GitLab project to your computer</span>
              </div>
              <ChevronRight size={16} className="action-arrow" />
            </button>

            {/* Sleek Compact In-Memory Scratchpad Bar */}
            <div className="welcome-scratchpad-bar">
              <span className="welcome-scratchpad-title">Instant in-memory scratchpad:</span>
              <div className="welcome-scratchpad-actions">
                <button 
                  className="btn-scratchpad-pill" 
                  onClick={() => onQuickScratchpad('latex')}
                  title="Launch instant in-memory LaTeX draft"
                >
                  <FileText size={14} className="text-blue-400" />
                  <span>Quick LaTeX</span>
                </button>
                <button 
                  className="btn-scratchpad-pill" 
                  onClick={() => onQuickScratchpad('typst')}
                  title="Launch instant in-memory Typst draft"
                >
                  <FileCode size={14} className="text-cyan-400" />
                  <span>Quick Typst</span>
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
              <span>Recent Projects</span>
            </h2>
          </div>

          <div className="recent-projects-list">
            {recentProjects.length > 0 ? (
              recentProjects.map((proj) => (
                <div 
                  key={proj.path} 
                  className="recent-project-row"
                  onClick={() => onOpenRecentProject(proj.path)}
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
                        title="Remove from recent projects"
                        aria-label="Remove from recents"
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
                <BookOpen size={28} className="text-slate-500 mb-2" />
                <p>No recent projects found</p>
                <span>Create or open a folder to see it listed here</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
