import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  FolderPlus,
  FolderOpen,
  Save,
  Download,
  X,
  XSquare,
  Play,
  Square,
  Eye,
  AlertTriangle,
  Sidebar,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Maximize2,
  ExternalLink,
  ChevronRight,
  Check,
  Archive,
  FileText,
  FileCode,
  FileUp,
  Package,
  History,
  GitBranch,
  Undo2,
  Redo2,
  Scissors,
  Copy,
  ClipboardPaste,
  Search,
  FolderSearch,
  MessageSquareCode,
  ListTree,
  WrapText,
  Terminal,
} from 'lucide-react';
import { useTheme, THEME_OPTIONS } from '../themes/ThemeContext';
import { RecentProject } from '../types';

export type EditorMenuAction = 'cut' | 'copy' | 'paste' | 'comment' | 'commandPalette';

interface MenuBarProps {
  onNewProject: () => void;
  onOpenFolder: () => void;
  onImportZip: () => void;
  onCloneRepository?: () => void;
  onSaveFile: () => void;
  onImportFiles?: () => void;
  onExportPdf: () => void;
  onExportZip: () => void;
  onCloseTab?: () => void;
  onCloseUnpinnedTabs?: () => void;
  onCloseProject: () => void;
  onCompile: () => void;
  onOpenProjectResources: () => void;
  onCancelCompile?: () => void;
  isCompiling: boolean;
  activeTab: 'preview' | 'diagnostics';
  onTabChange: (tab: 'preview' | 'diagnostics') => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onToggleSearch?: () => void;
  onToggleOutline?: () => void;
  engine: 'latex' | 'typst';
  onSwitchEngine: (engine: 'latex' | 'typst') => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onFitWidth?: () => void;
  wordWrap?: boolean;
  onToggleWordWrap?: () => void;
  recentProjects: RecentProject[];
  onOpenRecentProject: (path: string) => void;
  hasOpenProject: boolean;
  hasProjectFolder?: boolean;
  hasPdf?: boolean;
  hasActiveSourceEditor?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onFindReplace?: () => void;
  onEditorAction?: (action: EditorMenuAction) => void;
}

const DARK_THEME_OPTIONS = THEME_OPTIONS.filter((option) => option.id !== 'light');
const LIGHT_THEME_OPTIONS = THEME_OPTIONS.filter((option) => option.id === 'light');

export const MenuBar: React.FC<MenuBarProps> = ({
  onNewProject,
  onOpenFolder,
  onImportZip,
  onCloneRepository,
  onSaveFile,
  onImportFiles,
  onExportPdf,
  onExportZip,
  onCloseTab,
  onCloseUnpinnedTabs,
  onCloseProject,
  onCompile,
  onOpenProjectResources,
  onCancelCompile,
  isCompiling,
  activeTab,
  onTabChange,
  sidebarOpen,
  onToggleSidebar,
  onToggleSearch,
  onToggleOutline,
  engine,
  onSwitchEngine,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onFitWidth,
  wordWrap = true,
  onToggleWordWrap,
  recentProjects,
  onOpenRecentProject,
  hasOpenProject,
  hasProjectFolder,
  hasPdf,
  hasActiveSourceEditor,
  onUndo,
  onRedo,
  onFindReplace,
  onEditorAction,
}) => {
  const resolvedHasProjectFolder = hasProjectFolder ?? hasOpenProject;
  const resolvedHasPdf = hasPdf ?? true;
  const resolvedHasActiveSourceEditor = hasActiveSourceEditor ?? hasOpenProject;
  const { theme, setTheme } = useTheme();
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [showRecentSubmenu, setShowRecentSubmenu] = useState<boolean>(false);
  const [showExportSubmenu, setShowExportSubmenu] = useState<boolean>(false);
  const menuBarRef = useRef<HTMLDivElement>(null);

  // Close menus on click outside or Escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
        setShowRecentSubmenu(false);
        setShowExportSubmenu(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeMenu !== null) {
        e.preventDefault();
        setActiveMenu(null);
        setShowRecentSubmenu(false);
        setShowExportSubmenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [activeMenu]);

  const MENU_ORDER = ['file', 'edit', 'view', 'tools', 'theme', 'help'] as const;

  const handleMenuBarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!activeMenu) return;
    const currentIndex = MENU_ORDER.indexOf(activeMenu as (typeof MENU_ORDER)[number]);
    if (e.key === 'ArrowRight' && currentIndex >= 0) {
      e.preventDefault();
      const nextMenu = MENU_ORDER[(currentIndex + 1) % MENU_ORDER.length];
      setActiveMenu(nextMenu);
      setShowRecentSubmenu(false);
      setShowExportSubmenu(false);
    } else if (e.key === 'ArrowLeft' && currentIndex >= 0) {
      e.preventDefault();
      const prevMenu = MENU_ORDER[(currentIndex - 1 + MENU_ORDER.length) % MENU_ORDER.length];
      setActiveMenu(prevMenu);
      setShowRecentSubmenu(false);
      setShowExportSubmenu(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const dropdown = menuBarRef.current?.querySelector<HTMLElement>('.menu-dropdown');
      if (!dropdown) return;
      const items = Array.from(
        dropdown.querySelectorAll<HTMLElement>('button.menu-dropdown-item:not(:disabled)'),
      ).filter((el) => !el.closest('.menu-submenu'));
      if (items.length === 0) return;
      e.preventDefault();
      const activeIdx = items.indexOf(document.activeElement as HTMLElement);
      const nextIdx = e.key === 'ArrowDown'
        ? (activeIdx < 0 ? 0 : (activeIdx + 1) % items.length)
        : (activeIdx < 0 ? items.length - 1 : (activeIdx - 1 + items.length) % items.length);
      items[nextIdx]?.focus();
    }
  };

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

  const openExternalUrl = async (url: string) => {
    try {
      await invoke('open_external_url', { url });
    } catch (err) {
      console.error('Failed to open external URL:', err);
    }
  };

  const handleSubmenuParentKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    isOpen: boolean,
    setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  ) => {
    if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
      const wrapper = e.currentTarget.parentElement;
      requestAnimationFrame(() => {
        wrapper?.querySelector<HTMLButtonElement>('.menu-submenu button.menu-dropdown-item:not(:disabled)')?.focus();
      });
    } else if (e.key === 'ArrowLeft' && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const handleSubmenuKeyDown = (
    e: React.KeyboardEvent<HTMLDivElement>,
    setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  ) => {
    if (e.key === 'ArrowLeft' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      const parentBtn = e.currentTarget.parentElement?.querySelector<HTMLButtonElement>('.menu-dropdown-submenu-parent');
      parentBtn?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = Array.from(
        e.currentTarget.querySelectorAll<HTMLButtonElement>('button.menu-dropdown-item:not(:disabled)'),
      );
      if (items.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const activeIdx = items.indexOf(document.activeElement as HTMLButtonElement);
      const nextIdx = e.key === 'ArrowDown'
        ? (activeIdx < 0 ? 0 : (activeIdx + 1) % items.length)
        : (activeIdx < 0 ? items.length - 1 : (activeIdx - 1 + items.length) % items.length);
      items[nextIdx]?.focus();
    }
  };

  return (
    <div className="menu-bar-container" ref={menuBarRef} onKeyDown={handleMenuBarKeyDown}>
      {/* File Menu */}
      <div className="menu-item-wrapper">
        <button
          type="button"
          className={`menu-button ${activeMenu === 'file' ? 'menu-button-active' : ''}`}
          onClick={() => handleMenuToggle('file')}
          onMouseEnter={() => handleMenuHover('file')}
        >
          File
        </button>

        {activeMenu === 'file' && (
          <div className="menu-dropdown" role="menu">
            <button type="button" className="menu-dropdown-item" onClick={() => { onNewProject(); closeMenu(); }}>
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <FolderPlus size={14} />
                </span>
                <span>New Project...</span>
              </div>
              <span className="menu-shortcut">Ctrl+N</span>
            </button>

            <button type="button" className="menu-dropdown-item" onClick={() => { onOpenFolder(); closeMenu(); }}>
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <FolderOpen size={14} />
                </span>
                <span>Open Folder...</span>
              </div>
              <span className="menu-shortcut">Ctrl+O</span>
            </button>

            <button type="button" className="menu-dropdown-item" onClick={() => { onImportZip(); closeMenu(); }}>
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <Archive size={14} />
                </span>
                <span>Import from ZIP...</span>
              </div>
              <span className="menu-shortcut">Ctrl+I</span>
            </button>

            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!onCloneRepository}
              onClick={() => { onCloneRepository?.(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <GitBranch size={14} />
                </span>
                <span>Clone Repository...</span>
              </div>
            </button>

            {/* Recent Projects Submenu */}
            <div
              className="menu-submenu-wrapper"
              onMouseEnter={() => setShowRecentSubmenu(true)}
              onMouseLeave={() => setShowRecentSubmenu(false)}
            >
              <button
                type="button"
                className={`menu-dropdown-item menu-dropdown-submenu-parent${showRecentSubmenu ? ' is-submenu-open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={showRecentSubmenu}
                onClick={() => setShowRecentSubmenu((prev) => !prev)}
                onKeyDown={(e) => handleSubmenuParentKeyDown(e, showRecentSubmenu, setShowRecentSubmenu)}
              >
                <div className="menu-item-left">
                  <span className="menu-item-icon" aria-hidden="true">
                    <History size={14} />
                  </span>
                  <span>Open Recent</span>
                </div>
                <ChevronRight size={13} />
              </button>

              {showRecentSubmenu && (
                <div
                  className="menu-submenu"
                  role="menu"
                  onKeyDown={(e) => handleSubmenuKeyDown(e, setShowRecentSubmenu)}
                >
                  {recentProjects.length > 0 ? (
                    recentProjects.slice(0, 6).map((proj) => (
                      <button
                        type="button"
                        key={proj.path}
                        className="menu-dropdown-item"
                        onClick={() => { onOpenRecentProject(proj.path); closeMenu(); }}
                      >
                        <div className="menu-item-left">
                          <span className="recent-proj-badge">{proj.engine.toUpperCase()}</span>
                          <span className="menu-recent-name">{proj.name}</span>
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

                <button type="button" className="menu-dropdown-item" onClick={() => { onSaveFile(); closeMenu(); }}>
                  <div className="menu-item-left">
                    <span className="menu-item-icon" aria-hidden="true">
                      <Save size={14} />
                    </span>
                    <span>Save &amp; Compile</span>
                  </div>
                  <span className="menu-shortcut">Ctrl+S</span>
                </button>

                {resolvedHasProjectFolder && (
                  <button
                    type="button"
                    className="menu-dropdown-item"
                    disabled={!onImportFiles}
                    onClick={() => { onImportFiles?.(); closeMenu(); }}
                  >
                    <div className="menu-item-left">
                      <span className="menu-item-icon" aria-hidden="true">
                        <FileUp size={14} />
                      </span>
                      <span>Import Files...</span>
                    </div>
                  </button>
                )}

                {/* Export Document Submenu */}
                <div
                  className="menu-submenu-wrapper"
                  onMouseEnter={() => setShowExportSubmenu(true)}
                  onMouseLeave={() => setShowExportSubmenu(false)}
                >
                  <button
                    type="button"
                    className={`menu-dropdown-item menu-dropdown-submenu-parent${showExportSubmenu ? ' is-submenu-open' : ''}`}
                    aria-haspopup="menu"
                    aria-expanded={showExportSubmenu}
                    onClick={() => setShowExportSubmenu((prev) => !prev)}
                    onKeyDown={(e) => handleSubmenuParentKeyDown(e, showExportSubmenu, setShowExportSubmenu)}
                  >
                    <div className="menu-item-left">
                      <span className="menu-item-icon" aria-hidden="true">
                        <Download size={14} />
                      </span>
                      <span>Export Document</span>
                    </div>
                    <ChevronRight size={13} />
                  </button>

                  {showExportSubmenu && (
                    <div
                      className="menu-submenu"
                      role="menu"
                      onKeyDown={(e) => handleSubmenuKeyDown(e, setShowExportSubmenu)}
                    >
                      <button
                        type="button"
                        className="menu-dropdown-item"
                        disabled={!resolvedHasPdf}
                        title={resolvedHasPdf ? 'Export compiled PDF document' : 'Compile document first to export PDF'}
                        onClick={() => { onExportPdf(); closeMenu(); }}
                      >
                        <div className="menu-item-left">
                          <span className="menu-item-icon" aria-hidden="true">
                            <FileText size={14} className="icon-latex" />
                          </span>
                          <span>PDF Document (.pdf)</span>
                        </div>
                      </button>

                      <button type="button" className="menu-dropdown-item" onClick={() => { onExportZip(); closeMenu(); }}>
                        <div className="menu-item-left">
                          <span className="menu-item-icon" aria-hidden="true">
                            <Archive size={14} className="icon-archive" />
                          </span>
                          <span>Source Archive (.zip)</span>
                        </div>
                      </button>
                    </div>
                  )}
                </div>

                <div className="menu-divider" />

                <button
                  type="button"
                  className="menu-dropdown-item"
                  disabled={!onCloseTab}
                  onClick={() => { onCloseTab?.(); closeMenu(); }}
                >
                  <div className="menu-item-left">
                    <span className="menu-item-icon" aria-hidden="true">
                      <X size={14} />
                    </span>
                    <span>Close Tab</span>
                  </div>
                  <span className="menu-shortcut">Ctrl+W</span>
                </button>

                <button
                  type="button"
                  className="menu-dropdown-item"
                  disabled={!onCloseUnpinnedTabs}
                  onClick={() => { onCloseUnpinnedTabs?.(); closeMenu(); }}
                >
                  <div className="menu-item-left">
                    <span className="menu-item-icon" aria-hidden="true">
                      <XSquare size={14} />
                    </span>
                    <span>Close All Unpinned</span>
                  </div>
                  <span className="menu-shortcut">Ctrl+Shift+W</span>
                </button>

                <button type="button" className="menu-dropdown-item" onClick={() => { onCloseProject(); closeMenu(); }}>
                  <div className="menu-item-left">
                    <span className="menu-item-icon" aria-hidden="true">
                      <XSquare size={14} />
                    </span>
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
          type="button"
          className={`menu-button ${activeMenu === 'edit' ? 'menu-button-active' : ''}`}
          onClick={() => handleMenuToggle('edit')}
          onMouseEnter={() => handleMenuHover('edit')}
        >
          Edit
        </button>

        {activeMenu === 'edit' && (
          <div className="menu-dropdown" role="menu">
            <button
              type="button"
              className="menu-dropdown-item"
              aria-label="Undo"
              disabled={!resolvedHasActiveSourceEditor}
              onClick={() => { onUndo?.(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <Undo2 size={14} />
                </span>
                <span>Undo</span>
              </div>
              <span className="menu-shortcut">Ctrl+Z</span>
            </button>
            <button
              type="button"
              className="menu-dropdown-item"
              aria-label="Redo"
              disabled={!resolvedHasActiveSourceEditor}
              onClick={() => { onRedo?.(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <Redo2 size={14} />
                </span>
                <span>Redo</span>
              </div>
              <span className="menu-shortcut">Ctrl+Y</span>
            </button>
            <div className="menu-divider" />
            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!resolvedHasActiveSourceEditor}
              onClick={() => { onEditorAction?.('cut'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <Scissors size={14} />
                </span>
                <span>Cut</span>
              </div>
              <span className="menu-shortcut">Ctrl+X</span>
            </button>
            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!resolvedHasActiveSourceEditor}
              onClick={() => { onEditorAction?.('copy'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <Copy size={14} />
                </span>
                <span>Copy</span>
              </div>
              <span className="menu-shortcut">Ctrl+C</span>
            </button>
            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!resolvedHasActiveSourceEditor}
              onClick={() => { onEditorAction?.('paste'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <ClipboardPaste size={14} />
                </span>
                <span>Paste</span>
              </div>
              <span className="menu-shortcut">Ctrl+V</span>
            </button>
            <div className="menu-divider" />
            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!resolvedHasActiveSourceEditor}
              onClick={() => { onFindReplace?.(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <Search size={14} />
                </span>
                <span>Find &amp; Replace</span>
              </div>
              <span className="menu-shortcut">Ctrl+F</span>
            </button>
            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!resolvedHasProjectFolder}
              onClick={() => { onToggleSearch?.(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <FolderSearch size={14} />
                </span>
                <span>Find in Files</span>
              </div>
              <span className="menu-shortcut">Ctrl+Shift+F</span>
            </button>
            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!resolvedHasActiveSourceEditor}
              onClick={() => { onEditorAction?.('comment'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <MessageSquareCode size={14} />
                </span>
                <span>Toggle Line Comment</span>
              </div>
              <span className="menu-shortcut">Ctrl+/</span>
            </button>
          </div>
        )}
      </div>

      {/* View Menu */}
      <div className="menu-item-wrapper">
        <button
          type="button"
          className={`menu-button ${activeMenu === 'view' ? 'menu-button-active' : ''}`}
          onClick={() => handleMenuToggle('view')}
          onMouseEnter={() => handleMenuHover('view')}
        >
          View
        </button>

        {activeMenu === 'view' && (
          <div className="menu-dropdown" role="menu">
            <button
              type="button"
              className={`menu-dropdown-item ${resolvedHasProjectFolder && sidebarOpen ? 'menu-dropdown-item-checked' : ''}`}
              disabled={!resolvedHasProjectFolder}
              onClick={() => { onToggleSidebar(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <Sidebar size={14} />
                </span>
                <span>Toggle Sidebar</span>
              </div>
              <div className="menu-item-right">
                <span className="menu-shortcut">Ctrl+B</span>
                {resolvedHasProjectFolder && sidebarOpen && <Check size={14} className="menu-check-icon" />}
              </div>
            </button>

            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!resolvedHasProjectFolder}
              onClick={() => { onToggleSearch?.(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <FolderSearch size={14} />
                </span>
                <span>Search in Files</span>
              </div>
              <span className="menu-shortcut">Ctrl+Shift+F</span>
            </button>

            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!resolvedHasProjectFolder}
              onClick={() => { onToggleOutline?.(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <ListTree size={14} />
                </span>
                <span>Outline</span>
              </div>
              <span className="menu-shortcut">Alt+7</span>
            </button>

            <div className="menu-divider" />

            <button
              type="button"
              className={`menu-dropdown-item ${hasOpenProject && activeTab === 'preview' ? 'menu-dropdown-item-checked' : ''}`}
              disabled={!hasOpenProject}
              onClick={() => { onTabChange('preview'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <Eye size={14} />
                </span>
                <span>PDF Preview</span>
              </div>
              {hasOpenProject && activeTab === 'preview' && <Check size={14} className="menu-check-icon" />}
            </button>

            <button
              type="button"
              className={`menu-dropdown-item ${hasOpenProject && activeTab === 'diagnostics' ? 'menu-dropdown-item-checked' : ''}`}
              disabled={!hasOpenProject}
              onClick={() => { onTabChange('diagnostics'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <AlertTriangle size={14} />
                </span>
                <span>Logs &amp; Diagnostics</span>
              </div>
              {hasOpenProject && activeTab === 'diagnostics' && <Check size={14} className="menu-check-icon" />}
            </button>

            <div className="menu-divider" />

            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!hasOpenProject || !resolvedHasPdf}
              onClick={() => { onZoomIn(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <ZoomIn size={14} />
                </span>
                <span>PDF Zoom In</span>
              </div>
              <span className="menu-shortcut">Ctrl++</span>
            </button>
            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!hasOpenProject || !resolvedHasPdf}
              onClick={() => { onZoomOut(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <ZoomOut size={14} />
                </span>
                <span>PDF Zoom Out</span>
              </div>
              <span className="menu-shortcut">Ctrl+-</span>
            </button>
            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!hasOpenProject || !resolvedHasPdf}
              onClick={() => { onFitWidth?.(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <Maximize2 size={14} />
                </span>
                <span>Fit PDF to Width</span>
              </div>
            </button>
            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!hasOpenProject || !resolvedHasPdf}
              onClick={() => { onZoomReset(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <RotateCcw size={14} />
                </span>
                <span>Reset PDF Zoom</span>
              </div>
              <span className="menu-shortcut">Ctrl+0</span>
            </button>

            <div className="menu-divider" />

            <button
              type="button"
              className={`menu-dropdown-item ${wordWrap ? 'menu-dropdown-item-checked' : ''}`}
              onClick={() => { onToggleWordWrap?.(); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <WrapText size={14} />
                </span>
                <span>Toggle Word Wrap</span>
              </div>
              {wordWrap && <Check size={14} className="menu-check-icon" />}
            </button>

            <button
              type="button"
              className="menu-dropdown-item"
              disabled={!resolvedHasActiveSourceEditor}
              onClick={() => { onEditorAction?.('commandPalette'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <Terminal size={14} />
                </span>
                <span>Command Palette...</span>
              </div>
              <span className="menu-shortcut">F1</span>
            </button>
          </div>
        )}
      </div>

      {/* Tools Menu */}
      <div className="menu-item-wrapper">
        <button
          type="button"
          className={`menu-button ${activeMenu === 'tools' ? 'menu-button-active' : ''}`}
          onClick={() => handleMenuToggle('tools')}
          onMouseEnter={() => handleMenuHover('tools')}
        >
          Tools
        </button>

        {activeMenu === 'tools' && (
          <div className="menu-dropdown" role="menu">
            {isCompiling ? (
              <button
                type="button"
                className="menu-dropdown-item menu-dropdown-item-danger"
                onClick={() => { onCancelCompile?.(); closeMenu(); }}
              >
                <div className="menu-item-left">
                  <span className="menu-item-icon" aria-hidden="true">
                    <Square size={14} fill="currentColor" />
                  </span>
                  <span>Stop Compilation</span>
                </div>
              </button>
            ) : (
              <button
                type="button"
                className="menu-dropdown-item"
                disabled={!hasOpenProject}
                onClick={() => { onCompile(); closeMenu(); }}
              >
                <div className="menu-item-left">
                  <span className="menu-item-icon" aria-hidden="true">
                    <Play size={14} fill="currentColor" />
                  </span>
                  <span>Compile Document</span>
                </div>
                <span className="menu-shortcut">Ctrl+S</span>
              </button>
            )}

            {hasOpenProject && (
              <button type="button" className="menu-dropdown-item" onClick={() => { onOpenProjectResources(); closeMenu(); }}>
                <div className="menu-item-left">
                  <span className="menu-item-icon" aria-hidden="true">
                    <Package size={14} />
                  </span>
                  <span>Project Resources…</span>
                </div>
              </button>
            )}

            <div className="menu-divider" />

            <div className="menu-section-label">Active Typesetting Engine</div>
            <button
              type="button"
              className={`menu-dropdown-item ${engine === 'latex' ? 'menu-dropdown-item-checked' : ''}`}
              disabled={!hasOpenProject}
              onClick={() => { onSwitchEngine('latex'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <FileText size={14} className="icon-latex" />
                </span>
                <span>LaTeX (Tectonic RAM VFS)</span>
              </div>
              {engine === 'latex' && <Check size={14} className="menu-check-icon" />}
            </button>
            <button
              type="button"
              className={`menu-dropdown-item ${engine === 'typst' ? 'menu-dropdown-item-checked' : ''}`}
              disabled={!hasOpenProject}
              onClick={() => { onSwitchEngine('typst'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <FileCode size={14} className="icon-typst" />
                </span>
                <span>Typst (Rust Native in-memory)</span>
              </div>
              {engine === 'typst' && <Check size={14} className="menu-check-icon" />}
            </button>
          </div>
        )}
      </div>

      {/* Theme Menu */}
      <div className="menu-item-wrapper">
        <button
          type="button"
          className={`menu-button ${activeMenu === 'theme' ? 'menu-button-active' : ''}`}
          onClick={() => handleMenuToggle('theme')}
          onMouseEnter={() => handleMenuHover('theme')}
        >
          Theme
        </button>

        {activeMenu === 'theme' && (
          <div className="menu-dropdown menu-dropdown-themes" role="menu">
            <div className="menu-section-label">Dark Themes</div>
            {DARK_THEME_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.id}
                className={`menu-dropdown-item ${theme === option.id ? 'menu-dropdown-item-checked' : ''}`}
                onClick={() => { setTheme(option.id); closeMenu(); }}
                title={option.description}
              >
                <div className="menu-item-left">
                  <span className="theme-swatch-group" aria-hidden="true">
                    {option.swatches.map((hex, index) => (
                      <span key={index} className="theme-swatch-dot" style={{ backgroundColor: hex }} />
                    ))}
                  </span>
                  <span>{option.label}</span>
                </div>
                {theme === option.id && <Check size={14} className="menu-check-icon" />}
              </button>
            ))}

            <div className="menu-divider" />
            <div className="menu-section-label">Light Themes</div>
            {LIGHT_THEME_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.id}
                className={`menu-dropdown-item ${theme === option.id ? 'menu-dropdown-item-checked' : ''}`}
                onClick={() => { setTheme(option.id); closeMenu(); }}
                title={option.description}
              >
                <div className="menu-item-left">
                  <span className="theme-swatch-group" aria-hidden="true">
                    {option.swatches.map((hex, index) => (
                      <span key={index} className="theme-swatch-dot" style={{ backgroundColor: hex }} />
                    ))}
                  </span>
                  <span>{option.label}</span>
                </div>
                {theme === option.id && <Check size={14} className="menu-check-icon" />}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Help Menu */}
      <div className="menu-item-wrapper">
        <button
          type="button"
          className={`menu-button ${activeMenu === 'help' ? 'menu-button-active' : ''}`}
          onClick={() => handleMenuToggle('help')}
          onMouseEnter={() => handleMenuHover('help')}
        >
          Help
        </button>

        {activeMenu === 'help' && (
          <div className="menu-dropdown" role="menu">
            <button
              type="button"
              className="menu-dropdown-item"
              onClick={() => { void openExternalUrl('https://www.latex-project.org/help/documentation/'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <ExternalLink size={14} />
                </span>
                <span>LaTeX Documentation</span>
              </div>
            </button>
            <button
              type="button"
              className="menu-dropdown-item"
              onClick={() => { void openExternalUrl('https://typst.app/docs'); closeMenu(); }}
            >
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true">
                  <ExternalLink size={14} />
                </span>
                <span>Typst Documentation</span>
              </div>
            </button>
            <div className="menu-divider" />
            <div className="menu-dropdown-item menu-item-disabled">
              <div className="menu-item-left">
                <span className="menu-item-icon" aria-hidden="true" />
                <span>ScienceBatch Studio v0.1.0</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
