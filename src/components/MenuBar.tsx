import React, { useState, useEffect, useRef } from 'react';
import { 
  FolderPlus, 
  FolderOpen, 
  Save, 
  Download, 
  XSquare, 
  Play, 
  Square,
  Eye, 
  AlertTriangle, 
  Sidebar, 
  ZoomIn, 
  ZoomOut, 
  RotateCcw, 
  Sun, 
  Moon, 
  Palette, 
  ExternalLink,
  ChevronRight,
  Check,
  Archive,
  FileText,
  FileCode,
  Globe
} from 'lucide-react';
import { useTheme } from '../themes/ThemeContext';
import { RecentProject } from '../types';

interface MenuBarProps {
  onNewProject: () => void;
  onOpenFolder: () => void;
  onImportZip: () => void;
  onSaveFile: () => void;
  onExportPdf: () => void;
  onExportZip: () => void;
  onExportMarkdown: () => void;
  onExportHtml: () => void;
  onCloseProject: () => void;
  onCompile: () => void;
  onCancelCompile?: () => void;
  isCompiling: boolean;
  activeTab: 'preview' | 'diagnostics';
  onTabChange: (tab: 'preview' | 'diagnostics') => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  engine: 'latex' | 'typst';
  onSwitchEngine: (engine: 'latex' | 'typst') => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  recentProjects: RecentProject[];
  onOpenRecentProject: (path: string) => void;
  hasOpenProject: boolean;
}

export const MenuBar: React.FC<MenuBarProps> = ({
  onNewProject,
  onOpenFolder,
  onImportZip,
  onSaveFile,
  onExportPdf,
  onExportZip,
  onExportMarkdown,
  onExportHtml,
  onCloseProject,
  onCompile,
  onCancelCompile,
  isCompiling,
  activeTab,
  onTabChange,
  sidebarOpen,
  onToggleSidebar,
  engine,
  onSwitchEngine,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  recentProjects,
  onOpenRecentProject,
  hasOpenProject,
}) => {
  const { theme, setTheme } = useTheme();
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [showRecentSubmenu, setShowRecentSubmenu] = useState<boolean>(false);
  const [showExportSubmenu, setShowExportSubmenu] = useState<boolean>(false);
  const menuBarRef = useRef<HTMLDivElement>(null);

  // Close menus on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
        setShowRecentSubmenu(false);
        setShowExportSubmenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleMenuToggle = (name: string) => {
    setActiveMenu((prev) => (prev === name ? null : name));
    setShowRecentSubmenu(false);
    setShowExportSubmenu(false);
  };

  const handleMenuHover = (name: string) => {
    if (activeMenu !== null) {
      setActiveMenu(name);
      setShowRecentSubmenu(false);
      setShowExportSubmenu(false);
    }
  };

  const closeMenu = () => {
    setActiveMenu(null);
    setShowRecentSubmenu(false);
    setShowExportSubmenu(false);
  };

  return (
    <div className="menu-bar-container" ref={menuBarRef}>
      {/* File Menu */}
      <div className="menu-item-wrapper">
        <button 
          className={`menu-button ${activeMenu === 'file' ? 'menu-button-active' : ''}`}
          onClick={() => handleMenuToggle('file')}
          onMouseEnter={() => handleMenuHover('file')}
        >
          File
        </button>

        {activeMenu === 'file' && (
          <div className="menu-dropdown">
            <button className="menu-dropdown-item" onClick={() => { onNewProject(); closeMenu(); }}>
              <div className="menu-item-left">
                <FolderPlus size={14} />
                <span>New Project...</span>
              </div>
              <span className="menu-shortcut">Ctrl+N</span>
            </button>

            <button className="menu-dropdown-item" onClick={() => { onImportZip(); closeMenu(); }}>
              <div className="menu-item-left">
                <Archive size={14} />
                <span>Import from ZIP...</span>
              </div>
              <span className="menu-shortcut">Ctrl+I</span>
            </button>

            <button className="menu-dropdown-item" onClick={() => { onOpenFolder(); closeMenu(); }}>
              <div className="menu-item-left">
                <FolderOpen size={14} />
                <span>Open Folder...</span>
              </div>
              <span className="menu-shortcut">Ctrl+O</span>
            </button>

            {/* Recent Projects Submenu */}
            <div 
              className="menu-dropdown-item menu-dropdown-submenu-parent"
              onMouseEnter={() => setShowRecentSubmenu(true)}
              onMouseLeave={() => setShowRecentSubmenu(false)}
            >
              <div className="menu-item-left">
                <RotateCcw size={14} />
                <span>Open Recent</span>
              </div>
              <ChevronRight size={13} />

              {showRecentSubmenu && (
                <div className="menu-submenu">
                  {recentProjects.length > 0 ? (
                    recentProjects.slice(0, 6).map((proj) => (
                      <button
                        key={proj.path}
                        className="menu-dropdown-item"
                        onClick={() => { onOpenRecentProject(proj.path); closeMenu(); }}
                      >
                        <div className="menu-item-left">
                          <span className="recent-proj-badge">{proj.engine.toUpperCase()}</span>
                          <span className="truncate max-w-[160px]">{proj.name}</span>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="menu-dropdown-item menu-item-disabled">
                      <span>No recent projects</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {hasOpenProject && (
              <>
                <div className="menu-divider" />

                <button className="menu-dropdown-item" onClick={() => { onSaveFile(); closeMenu(); }}>
                  <div className="menu-item-left">
                    <Save size={14} />
                    <span>Save File</span>
                  </div>
                  <span className="menu-shortcut">Ctrl+S</span>
                </button>

                {/* Export Document Submenu */}
                <div 
                  className="menu-dropdown-item menu-dropdown-submenu-parent"
                  onMouseEnter={() => setShowExportSubmenu(true)}
                  onMouseLeave={() => setShowExportSubmenu(false)}
                >
                  <div className="menu-item-left">
                    <Download size={14} />
                    <span>Export Document</span>
                  </div>
                  <ChevronRight size={13} />

                  {showExportSubmenu && (
                    <div className="menu-submenu">
                      <button className="menu-dropdown-item" onClick={() => { onExportPdf(); closeMenu(); }}>
                        <div className="menu-item-left">
                          <FileText size={14} className="text-blue-400" />
                          <span>PDF Document (.pdf)</span>
                        </div>
                        <span className="menu-shortcut">Ctrl+Shift+E</span>
                      </button>

                      <button className="menu-dropdown-item" onClick={() => { onExportZip(); closeMenu(); }}>
                        <div className="menu-item-left">
                          <Archive size={14} className="text-amber-400" />
                          <span>Source Archive (.zip)</span>
                        </div>
                        <span className="menu-shortcut">Ctrl+Shift+Z</span>
                      </button>

                      <div className="menu-divider" />

                      <button className="menu-dropdown-item" onClick={() => { onExportMarkdown(); closeMenu(); }}>
                        <div className="menu-item-left">
                          <FileCode size={14} className="text-emerald-400" />
                          <span>Markdown (.md)</span>
                        </div>
                      </button>

                      <button className="menu-dropdown-item" onClick={() => { onExportHtml(); closeMenu(); }}>
                        <div className="menu-item-left">
                          <Globe size={14} className="text-cyan-400" />
                          <span>HTML Document (.html)</span>
                        </div>
                      </button>
                    </div>
                  )}
                </div>

                <div className="menu-divider" />
                <button className="menu-dropdown-item" onClick={() => { onCloseProject(); closeMenu(); }}>
                  <div className="menu-item-left">
                    <XSquare size={14} />
                    <span>Close Project (Home)</span>
                  </div>
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Edit Menu */}
      <div className="menu-item-wrapper">
        <button 
          className={`menu-button ${activeMenu === 'edit' ? 'menu-button-active' : ''}`}
          onClick={() => handleMenuToggle('edit')}
          onMouseEnter={() => handleMenuHover('edit')}
        >
          Edit
        </button>

        {activeMenu === 'edit' && (
          <div className="menu-dropdown">
            <button className="menu-dropdown-item" onClick={closeMenu}>
              <div className="menu-item-left">
                <span>Undo</span>
              </div>
              <span className="menu-shortcut">Ctrl+Z</span>
            </button>
            <button className="menu-dropdown-item" onClick={closeMenu}>
              <div className="menu-item-left">
                <span>Redo</span>
              </div>
              <span className="menu-shortcut">Ctrl+Y</span>
            </button>
            <div className="menu-divider" />
            <button className="menu-dropdown-item" onClick={closeMenu}>
              <div className="menu-item-left">
                <span>Find & Replace</span>
              </div>
              <span className="menu-shortcut">Ctrl+F</span>
            </button>
          </div>
        )}
      </div>

      {/* View Menu */}
      <div className="menu-item-wrapper">
        <button 
          className={`menu-button ${activeMenu === 'view' ? 'menu-button-active' : ''}`}
          onClick={() => handleMenuToggle('view')}
          onMouseEnter={() => handleMenuHover('view')}
        >
          View
        </button>

        {activeMenu === 'view' && (
          <div className="menu-dropdown">
            <button className="menu-dropdown-item" onClick={() => { onToggleSidebar(); closeMenu(); }}>
              <div className="menu-item-left">
                <Sidebar size={14} />
                <span>Toggle File Explorer</span>
              </div>
              {sidebarOpen && <Check size={14} />}
            </button>

            <div className="menu-divider" />

            <button 
              className={`menu-dropdown-item ${activeTab === 'preview' ? 'menu-dropdown-item-checked' : ''}`}
              onClick={() => { onTabChange('preview'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <Eye size={14} />
                <span>PDF Preview</span>
              </div>
              {activeTab === 'preview' && <Check size={14} />}
            </button>

            <button 
              className={`menu-dropdown-item ${activeTab === 'diagnostics' ? 'menu-dropdown-item-checked' : ''}`}
              onClick={() => { onTabChange('diagnostics'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <AlertTriangle size={14} />
                <span>Logs & Diagnostics</span>
              </div>
              {activeTab === 'diagnostics' && <Check size={14} />}
            </button>

            <div className="menu-divider" />

            <button className="menu-dropdown-item" onClick={() => { onZoomIn(); closeMenu(); }}>
              <div className="menu-item-left">
                <ZoomIn size={14} />
                <span>Zoom In</span>
              </div>
              <span className="menu-shortcut">Ctrl++</span>
            </button>
            <button className="menu-dropdown-item" onClick={() => { onZoomOut(); closeMenu(); }}>
              <div className="menu-item-left">
                <ZoomOut size={14} />
                <span>Zoom Out</span>
              </div>
              <span className="menu-shortcut">Ctrl+-</span>
            </button>
            <button className="menu-dropdown-item" onClick={() => { onZoomReset(); closeMenu(); }}>
              <div className="menu-item-left">
                <RotateCcw size={14} />
                <span>Reset Zoom</span>
              </div>
              <span className="menu-shortcut">Ctrl+0</span>
            </button>
          </div>
        )}
      </div>

      {/* Tools Menu */}
      <div className="menu-item-wrapper">
        <button 
          className={`menu-button ${activeMenu === 'tools' ? 'menu-button-active' : ''}`}
          onClick={() => handleMenuToggle('tools')}
          onMouseEnter={() => handleMenuHover('tools')}
        >
          Tools
        </button>

        {activeMenu === 'tools' && (
          <div className="menu-dropdown">
            {isCompiling ? (
              <button 
                className="menu-dropdown-item text-rose-400 hover:text-rose-300" 
                onClick={() => { onCancelCompile?.(); closeMenu(); }}
              >
                <div className="menu-item-left">
                  <Square size={14} fill="currentColor" />
                  <span>Stop Compilation</span>
                </div>
              </button>
            ) : (
              <button className="menu-dropdown-item" onClick={() => { onCompile(); closeMenu(); }}>
                <div className="menu-item-left">
                  <Play size={14} fill="currentColor" />
                  <span>Compile Document</span>
                </div>
                <span className="menu-shortcut">Ctrl+S</span>
              </button>
            )}

            <div className="menu-divider" />

            <div className="menu-section-label">Active Typesetting Engine</div>
            <button 
              className={`menu-dropdown-item ${engine === 'latex' ? 'menu-dropdown-item-checked' : ''}`}
              onClick={() => { onSwitchEngine('latex'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span>LaTeX (Tectonic RAM VFS)</span>
              </div>
              {engine === 'latex' && <Check size={14} />}
            </button>
            <button 
              className={`menu-dropdown-item ${engine === 'typst' ? 'menu-dropdown-item-checked' : ''}`}
              onClick={() => { onSwitchEngine('typst'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span>Typst (Rust Native in-memory)</span>
              </div>
              {engine === 'typst' && <Check size={14} />}
            </button>

          </div>
        )}
      </div>

      {/* Theme Menu */}
      <div className="menu-item-wrapper">
        <button 
          className={`menu-button ${activeMenu === 'theme' ? 'menu-button-active' : ''}`}
          onClick={() => handleMenuToggle('theme')}
          onMouseEnter={() => handleMenuHover('theme')}
        >
          Theme
        </button>

        {activeMenu === 'theme' && (
          <div className="menu-dropdown">
            <button 
              className={`menu-dropdown-item ${theme === 'dark' ? 'menu-dropdown-item-checked' : ''}`}
              onClick={() => { setTheme('dark'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <Moon size={14} />
                <span>Dark (Default)</span>
              </div>
              {theme === 'dark' && <Check size={14} />}
            </button>

            <button 
              className={`menu-dropdown-item ${theme === 'light' ? 'menu-dropdown-item-checked' : ''}`}
              onClick={() => { setTheme('light'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <Sun size={14} />
                <span>Light</span>
              </div>
              {theme === 'light' && <Check size={14} />}
            </button>

            <button 
              className={`menu-dropdown-item ${theme === 'monokai' ? 'menu-dropdown-item-checked' : ''}`}
              onClick={() => { setTheme('monokai'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <Palette size={14} />
                <span>Monokai</span>
              </div>
              {theme === 'monokai' && <Check size={14} />}
            </button>
          </div>
        )}
      </div>

      {/* Help Menu */}
      <div className="menu-item-wrapper">
        <button 
          className={`menu-button ${activeMenu === 'help' ? 'menu-button-active' : ''}`}
          onClick={() => handleMenuToggle('help')}
          onMouseEnter={() => handleMenuHover('help')}
        >
          Help
        </button>

        {activeMenu === 'help' && (
          <div className="menu-dropdown">
            <a 
              href="https://www.overleaf.com/learn" 
              target="_blank" 
              rel="noreferrer" 
              className="menu-dropdown-item"
              onClick={closeMenu}
            >
              <div className="menu-item-left">
                <ExternalLink size={14} />
                <span>LaTeX Documentation</span>
              </div>
            </a>
            <a 
              href="https://typst.app/docs" 
              target="_blank" 
              rel="noreferrer" 
              className="menu-dropdown-item"
              onClick={closeMenu}
            >
              <div className="menu-item-left">
                <ExternalLink size={14} />
                <span>Typst Documentation</span>
              </div>
            </a>
            <div className="menu-divider" />
            <div className="menu-dropdown-item menu-item-disabled">
              <span>ScienceBatch Studio v0.1.0</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
