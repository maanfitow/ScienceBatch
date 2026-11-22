import React, { useEffect, useRef, useState } from 'react';
import {
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  File,
  ChevronRight,
  ChevronDown,
  Star,
  Plus,
  FilePlus,
  FolderPlus,
  Trash2,
  Image as ImageIcon,
  BookOpen,
  Sliders,
  BookMarked,
  FileUp,
  X,
  Copy,
  Code2,
  MoreHorizontal,
  ChevronsDownUp,
  RefreshCw,
  Pencil,
  Files,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import { FileItem } from '../types';
import { ContextMenu, ContextMenuAction } from './ContextMenu';
import { copyTextToClipboard } from './pdfClipboard';

export type { FileItem };

interface FileTreeProps {
  files: FileItem[];
  activeFilePath: string | null;
  mainFilePath: string | null;
  onSelectFile: (path: string, permanent?: boolean) => void;
  onSetMainFile: (path: string) => void;
  onCreateFile: (parentDir: string, name: string) => void;
  onCreateFolder: (parentDir: string, name: string) => void;
  onDeleteFile: (path: string) => void;
  onViewImage?: (path: string, name: string) => void;
  onImportFiles?: (targetDir?: string) => void;
  onRenamePath?: (oldPath: string, newName: string) => Promise<boolean> | boolean;
  onMovePath?: (srcPath: string, destDir: string) => Promise<boolean> | boolean;
  onDeletePath?: (path: string, isDir?: boolean) => Promise<boolean> | boolean;
  onDuplicatePath?: (path: string, isDir?: boolean) => Promise<string | null> | void;
  onRevealInFileManager?: (path: string) => Promise<void> | void;
  onRefreshFiles?: () => Promise<void> | void;
  projectRoot: string;
  projectName: string;
  engine: 'latex' | 'typst';
  onClose?: () => void;
}

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  activeFilePath,
  mainFilePath,
  onSelectFile,
  onSetMainFile,
  onCreateFile,
  onCreateFolder,
  onDeleteFile,
  onViewImage,
  onImportFiles,
  onRenamePath,
  onMovePath,
  onDeletePath,
  onDuplicatePath,
  onRevealInFileManager,
  onRefreshFiles,
  projectRoot,
  projectName,
  engine,
  onClose,
}) => {
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    [projectRoot]: true,
  });
  const [creatingType, setCreatingType] = useState<'file' | 'folder' | null>(null);
  const [creatingParent, setCreatingParent] = useState<string>(projectRoot);
  const [newItemName, setNewItemName] = useState<string>('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renamingIsDir, setRenamingIsDir] = useState<boolean>(false);
  const [renameValue, setRenameValue] = useState<string>('');
  const [draggedItem, setDraggedItem] = useState<{ path: string; isDir: boolean } | null>(null);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: FileItem;
    viaButton?: boolean;
  } | null>(null);

  const createInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameSubmittingRef = useRef<boolean>(false);
  const draggedItemRef = useRef<{ path: string; isDir: boolean } | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setExpandedFolders((prev) => (prev[projectRoot] ? prev : { ...prev, [projectRoot]: true }));
  }, [projectRoot]);

  useEffect(() => {
    if (creatingType) {
      createInputRef.current?.focus();
    }
  }, [creatingType, creatingParent]);

  useEffect(() => {
    if (!renamingPath) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    if (renamingIsDir) {
      input.select();
    } else {
      const dotIndex = input.value.lastIndexOf('.');
      if (dotIndex > 0) {
        input.setSelectionRange(0, dotIndex);
      } else {
        input.select();
      }
    }
  }, [renamingPath, renamingIsDir]);

  const getRelativePath = (fullPath: string) => {
    const normalizedRoot = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedPath = fullPath.replace(/\\/g, '/');
    if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
      return normalizedPath.slice(normalizedRoot.length + 1);
    }
    return normalizedPath;
  };

  const rootDropTarget = projectRoot.replace(/[/\\]+$/, '') || projectRoot;

  const getParentDir = (fullPath: string): string => {
    const normalized = fullPath.replace(/[/\\]+$/, '');
    const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
    return lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
  };

  const canDropInto = (dragged: { path: string; isDir: boolean } | null, destDir: string): boolean => {
    if (!dragged || !onMovePath) return false;
    const cleanDragged = dragged.path.replace(/[/\\]+$/, '');
    const cleanDest = destDir.replace(/[/\\]+$/, '');
    if (!cleanDragged || !cleanDest) return false;
    if (getParentDir(dragged.path) === cleanDest) return false;
    if (
      dragged.isDir &&
      (cleanDest === cleanDragged ||
        cleanDest.startsWith(`${cleanDragged}/`) ||
        cleanDest.startsWith(`${cleanDragged}\\`))
    ) {
      return false;
    }
    return true;
  };

  const handleRowDragStart = (e: React.DragEvent<HTMLDivElement>, item: FileItem) => {
    if (renamingPath === item.path || !onMovePath) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    const nextDragged = { path: item.path, isDir: item.is_dir };
    draggedItemRef.current = nextDragged;
    setDraggedItem(nextDragged);
    e.dataTransfer.setData('text/plain', item.path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleRowDragEnd = () => {
    draggedItemRef.current = null;
    setDraggedItem(null);
    setDropTargetDir(null);
  };

  const handleDragOverDest = (e: React.DragEvent, destDir: string) => {
    const activeDragged = draggedItem || draggedItemRef.current;
    if (!activeDragged || !onMovePath) return;
    e.preventDefault();
    e.stopPropagation();
    if (canDropInto(activeDragged, destDir)) {
      e.dataTransfer.dropEffect = 'move';
      setDropTargetDir((prev) => (prev === destDir ? prev : destDir));
    } else {
      e.dataTransfer.dropEffect = 'none';
      setDropTargetDir((prev) => (prev === destDir ? null : prev));
    }
  };

  const handleDragLeaveDest = (e: React.DragEvent, destDir: string) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropTargetDir((prev) => (prev === destDir ? null : prev));
    }
  };

  const handleDropIntoDest = async (e: React.DragEvent, destDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    const activeDragged = draggedItem || draggedItemRef.current;
    draggedItemRef.current = null;
    setDraggedItem(null);
    setDropTargetDir(null);
    if (!canDropInto(activeDragged, destDir) || !activeDragged || !onMovePath) {
      return;
    }

    const cleanDragged = activeDragged.path.replace(/[/\\]+$/, '');
    const cleanDest = destDir.replace(/[/\\]+$/, '');
    const lastSlash = Math.max(cleanDragged.lastIndexOf('/'), cleanDragged.lastIndexOf('\\'));
    const sep = lastSlash >= 0 ? cleanDragged[lastSlash] : '/';
    const baseName = lastSlash >= 0 ? cleanDragged.slice(lastSlash + 1) : cleanDragged;
    const newPath = `${cleanDest}${sep}${baseName}`;
    const wasExpanded = activeDragged.isDir && Boolean(expandedFolders[activeDragged.path] || expandedFolders[cleanDragged]);

    const ok = await onMovePath(activeDragged.path, destDir);
    if (!ok) return;

    setExpandedFolders((prev) => {
      let updated: Record<string, boolean> = { ...prev };
      if (activeDragged.isDir && wasExpanded) {
        const remapped: Record<string, boolean> = {};
        const prefixForward = `${cleanDragged}/`;
        const prefixBackward = `${cleanDragged}\\`;
        for (const [key, value] of Object.entries(updated)) {
          if (key === cleanDragged) {
            remapped[newPath] = value;
          } else if (key.startsWith(prefixForward) || key.startsWith(prefixBackward)) {
            remapped[`${newPath}${key.slice(cleanDragged.length)}`] = value;
          } else {
            remapped[key] = value;
          }
        }
        updated = remapped;
      }
      updated[destDir] = true;
      return updated;
    });
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  };

  const handleCollapseAll = () => {
    setExpandedFolders({ [projectRoot]: true });
  };

  const handleStartCreate = (type: 'file' | 'folder', parent: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setRenamingPath(null);
    setExpandedFolders((prev) => ({ ...prev, [parent]: true }));
    setCreatingType(type);
    setCreatingParent(parent);
    setNewItemName('');
  };

  const handleConfirmCreate = () => {
    if (!newItemName.trim()) {
      setCreatingType(null);
      return;
    }

    if (creatingType === 'file') {
      onCreateFile(creatingParent, newItemName.trim());
    } else if (creatingType === 'folder') {
      onCreateFolder(creatingParent, newItemName.trim());
    }

    setCreatingType(null);
    setNewItemName('');
  };

  const startRename = (item: FileItem) => {
    setCreatingType(null);
    setContextMenu(null);
    renameSubmittingRef.current = false;
    setRenamingIsDir(item.is_dir);
    setRenamingPath(item.path);
    setRenameValue(item.name);
  };

  const cancelRename = () => {
    renameSubmittingRef.current = true;
    setRenamingPath(null);
    setRenameValue('');
  };

  const commitRename = async () => {
    if (renameSubmittingRef.current || !renamingPath) return;
    renameSubmittingRef.current = true;
    const targetPath = renamingPath;
    const wasDir = renamingIsDir;
    const wasExpanded = Boolean(expandedFolders[targetPath]);
    const nextName = renameValue.trim();
    const originalName = targetPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
    setRenamingPath(null);
    setRenameValue('');
    if (!nextName || nextName === originalName) return;
    if (onRenamePath) {
      const ok = await onRenamePath(targetPath, nextName);
      if (ok && wasDir && wasExpanded) {
        const normalized = targetPath.replace(/[/\\]+$/, '');
        const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
        const parentDir = lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
        const sep = lastSlash >= 0 ? normalized[lastSlash] : '/';
        const newPath = parentDir ? `${parentDir}${sep}${nextName}` : nextName;
        setExpandedFolders((prev) => {
          const updated: Record<string, boolean> = {};
          const prefixForward = `${normalized}/`;
          const prefixBackward = `${normalized}\\`;
          for (const [key, value] of Object.entries(prev)) {
            if (key === normalized) {
              updated[newPath] = value;
            } else if (key.startsWith(prefixForward) || key.startsWith(prefixBackward)) {
              updated[`${newPath}${key.slice(normalized.length)}`] = value;
            } else {
              updated[key] = value;
            }
          }
          return updated;
        });
      }
    }
  };

  const handleDeleteItem = (item: FileItem) => {
    if (onDeletePath) {
      void onDeletePath(item.path, item.is_dir);
    } else if (!item.is_dir) {
      onDeleteFile(item.path);
    }
  };

  const handleOpenActionMenuFromButton = (
    e: React.MouseEvent<HTMLButtonElement>,
    item: FileItem,
  ) => {
    e.stopPropagation();
    if (contextMenu && contextMenu.viaButton && contextMenu.item.path === item.path) {
      setContextMenu(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    menuTriggerRef.current = e.currentTarget;
    setContextMenu({
      x: rect.left,
      y: rect.bottom,
      item,
      viaButton: true,
    });
  };

  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, item: FileItem) => {
    if (renamingPath === item.path) return;
    if (e.key === 'F2' && onRenamePath) {
      e.preventDefault();
      e.stopPropagation();
      startRename(item);
      return;
    }
    if (e.key === 'Delete' && (onDeletePath || !item.is_dir)) {
      e.preventDefault();
      e.stopPropagation();
      handleDeleteItem(item);
      return;
    }
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (item.is_dir) {
        toggleFolder(item.path);
      } else {
        const ext = item.name.split('.').pop()?.toLowerCase() || '';
        const isMediaAsset = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'pdf'].includes(ext);
        if (isMediaAsset && onViewImage) {
          onViewImage(item.path, item.name);
        } else {
          onSelectFile(item.path, e.key === 'Enter');
        }
      }
    }
  };

  const getFileIcon = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext === 'tex') {
      return <FileText size={15} className="file-icon-tex" />;
    }
    if (ext === 'cls') {
      return <BookOpen size={15} className="file-icon-cls" />;
    }
    if (ext === 'sty') {
      return <Sliders size={15} className="file-icon-sty" />;
    }
    if (ext === 'typ') {
      return <FileCode size={15} className="file-icon-typst" />;
    }
    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'svg' || ext === 'webp' || ext === 'gif') {
      return <ImageIcon size={15} className="file-icon-image" />;
    }
    if (ext === 'bib') {
      return <BookMarked size={15} className="file-icon-bib" />;
    }
    if (ext === 'pdf') {
      return <FileText size={15} className="file-icon-pdf" />;
    }
    return <File size={15} className="file-icon-generic" />;
  };

  const renderRenameInput = () => (
    <input
      ref={renameInputRef}
      type="text"
      className="file-tree-rename-input"
      aria-label="Rename item"
      value={renameValue}
      style={{
        flex: 1,
        minWidth: 0,
        height: 22,
        padding: '1px 6px',
        fontSize: 12,
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-focus)',
        borderRadius: 3,
        outline: 'none',
      }}
      onChange={(e) => setRenameValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          void commitRename();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelRename();
        }
      }}
      onBlur={() => {
        void commitRename();
      }}
    />
  );

  const renderItem = (item: FileItem, depth = 0) => {
    const isExpanded = !!expandedFolders[item.path];
    const isActive = activeFilePath === item.path;
    const isRenaming = renamingPath === item.path;
    const relItemPath = getRelativePath(item.path);
    const isMain = Boolean(
      mainFilePath && (mainFilePath === item.path || mainFilePath.replace(/\\/g, '/') === relItemPath),
    );
    const ext = item.name.split('.').pop()?.toLowerCase() || '';
    const isMediaAsset = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'pdf'].includes(ext);

    if (item.is_dir) {
      const isDropTarget = dropTargetDir === item.path;
      return (
        <div key={item.path} className="file-tree-node">
          <div
            tabIndex={0}
            draggable={!isRenaming}
            className={`file-tree-row file-tree-folder-row ${isDropTarget ? 'is-drop-target' : ''}`}
            style={{ paddingLeft: `${depth * 14 + 10}px` }}
            onDragStart={(e) => handleRowDragStart(e, item)}
            onDragEnd={handleRowDragEnd}
            onDragOver={(e) => handleDragOverDest(e, item.path)}
            onDragLeave={(e) => handleDragLeaveDest(e, item.path)}
            onDrop={(e) => {
              void handleDropIntoDest(e, item.path);
            }}
            onClick={() => {
              if (!isRenaming) toggleFolder(item.path);
            }}
            onKeyDown={(e) => handleRowKeyDown(e, item)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              menuTriggerRef.current = null;
              setContextMenu({ x: e.clientX, y: e.clientY, item });
            }}
          >
            <span className="folder-caret">
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            {isExpanded ? (
              <FolderOpen size={16} className="folder-icon" />
            ) : (
              <Folder size={16} className="folder-icon" />
            )}

            {isRenaming ? (
              renderRenameInput()
            ) : (
              <span className="file-tree-label truncate">{item.name}</span>
            )}

            {!isRenaming && (
              <div className="file-tree-actions">
                <button
                  type="button"
                  className="btn-tree-action"
                  title="New file inside folder"
                  aria-label={`New file inside ${item.name}`}
                  onClick={(e) => handleStartCreate('file', item.path, e)}
                >
                  <FilePlus size={13} />
                </button>
                <button
                  type="button"
                  className="btn-tree-action"
                  title={`More actions for ${item.name}`}
                  aria-label={`More actions for ${item.name}`}
                  onClick={(e) => handleOpenActionMenuFromButton(e, item)}
                >
                  <MoreHorizontal size={13} />
                </button>
              </div>
            )}
          </div>

          {isExpanded && item.children && (
            <div className="file-tree-children">
              {item.children.map((child) => renderItem(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    const fileDestDir = getParentDir(item.path);

    return (
      <div
        key={item.path}
        tabIndex={0}
        draggable={!isRenaming}
        className={`file-tree-row file-tree-file-row ${isActive ? 'file-tree-active' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 24}px` }}
        onDragStart={(e) => handleRowDragStart(e, item)}
        onDragEnd={handleRowDragEnd}
        onDragOver={(e) => handleDragOverDest(e, fileDestDir)}
        onDragLeave={(e) => handleDragLeaveDest(e, fileDestDir)}
        onDrop={(e) => {
          void handleDropIntoDest(e, fileDestDir);
        }}
        onClick={() => {
          if (isRenaming) return;
          if (isMediaAsset && onViewImage) {
            onViewImage(item.path, item.name);
          } else {
            onSelectFile(item.path);
          }
        }}
        onDoubleClick={() => {
          if (!isRenaming) onSelectFile(item.path, true);
        }}
        onKeyDown={(e) => handleRowKeyDown(e, item)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          menuTriggerRef.current = null;
          setContextMenu({ x: e.clientX, y: e.clientY, item });
        }}
      >
        {getFileIcon(item.name)}
        {isRenaming ? (
          renderRenameInput()
        ) : (
          <span className="file-tree-label truncate">{item.name}</span>
        )}

        {!isRenaming && isMain && (
          <span className="main-file-badge" title="Main Entrypoint File">
            <Star size={11} fill="currentColor" />
            <span>Main</span>
          </span>
        )}

        {!isRenaming && (
          <div className="file-tree-actions">
            <button
              type="button"
              className="btn-tree-action"
              title={`More actions for ${item.name}`}
              aria-label={`More actions for ${item.name}`}
              onClick={(e) => handleOpenActionMenuFromButton(e, item)}
            >
              <MoreHorizontal size={13} />
            </button>
          </div>
        )}
      </div>
    );
  };

  const buildContextMenuActions = (item: FileItem): ContextMenuAction[] => {
    const relPath = getRelativePath(item.path);
    if (item.is_dir) {
      const isExpanded = !!expandedFolders[item.path];
      return [
        {
          label: 'New File…',
          icon: <FilePlus size={14} />,
          onSelect: () => handleStartCreate('file', item.path),
        },
        {
          label: 'New Folder…',
          icon: <FolderPlus size={14} />,
          onSelect: () => handleStartCreate('folder', item.path),
        },
        ...(onImportFiles
          ? [
              {
                label: 'Import Files Here…',
                icon: <FileUp size={14} />,
                onSelect: () => onImportFiles(item.path),
              },
            ]
          : []),
        {
          label: isExpanded ? 'Collapse Folder' : 'Expand Folder',
          icon: isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />,
          separatorBefore: true,
          onSelect: () => toggleFolder(item.path),
        },
        ...(onRenamePath
          ? [
              {
                label: 'Rename',
                icon: <Pencil size={14} />,
                shortcut: 'F2',
                separatorBefore: true,
                onSelect: () => startRename(item),
              },
            ]
          : []),
        ...(onDuplicatePath
          ? [
              {
                label: 'Duplicate',
                icon: <Files size={14} />,
                separatorBefore: !onRenamePath,
                onSelect: () => {
                  void onDuplicatePath(item.path, true);
                },
              },
            ]
          : []),
        {
          label: 'Copy Path',
          icon: <Copy size={14} />,
          separatorBefore: true,
          onSelect: () => {
            void copyTextToClipboard(item.path)
              .then(() => toast.success('Path copied'))
              .catch(() => toast.error('Failed to copy path'));
          },
        },
        {
          label: 'Copy Relative Path',
          icon: <Copy size={14} />,
          onSelect: () => {
            void copyTextToClipboard(relPath)
              .then(() => toast.success('Relative path copied'))
              .catch(() => toast.error('Failed to copy path'));
          },
        },
        ...(onRevealInFileManager
          ? [
              {
                label: 'Reveal in File Manager',
                icon: <ExternalLink size={14} />,
                separatorBefore: true,
                onSelect: () => {
                  void onRevealInFileManager(item.path);
                },
              },
            ]
          : []),
        ...(onDeletePath
          ? [
              {
                label: 'Delete',
                icon: <Trash2 size={14} />,
                shortcut: 'Del',
                danger: true,
                separatorBefore: true,
                onSelect: () => handleDeleteItem(item),
              },
            ]
          : []),
      ];
    }

    const ext = item.name.split('.').pop()?.toLowerCase() || '';
    const isMediaAsset = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'pdf'].includes(ext);
    const isMain = Boolean(
      mainFilePath && (mainFilePath === item.path || mainFilePath.replace(/\\/g, '/') === relPath),
    );
    const canSetMain = !isMain && (ext === 'tex' || ext === 'typ');
    const stem = item.name.replace(/\.[^/.]+$/, '');
    const figureLabel = stem.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() || 'figure';
    const figureSnippet =
      engine === 'typst'
        ? `#figure(\n  image("${relPath}", width: 80%),\n  caption: [${stem}],\n) <fig:${figureLabel}>`
        : `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{${relPath}}\n  \\caption{${stem}}\n  \\label{fig:${figureLabel}}\n\\end{figure}`;

    return [
      {
        label: isMediaAsset ? 'Preview Asset' : 'Open File',
        icon: isMediaAsset ? <ImageIcon size={14} /> : <FileText size={14} />,
        onSelect: () => {
          if (isMediaAsset && onViewImage) {
            onViewImage(item.path, item.name);
          } else {
            onSelectFile(item.path, true);
          }
        },
      },
      ...(canSetMain
        ? [
            {
              label: 'Set as Main Entrypoint',
              icon: <Star size={14} />,
              onSelect: () => onSetMainFile(item.path),
            },
          ]
        : []),
      ...(onRenamePath
        ? [
            {
              label: 'Rename',
              icon: <Pencil size={14} />,
              shortcut: 'F2',
              separatorBefore: true,
              onSelect: () => startRename(item),
            },
          ]
        : []),
      ...(onDuplicatePath
        ? [
            {
              label: 'Duplicate',
              icon: <Files size={14} />,
              separatorBefore: !onRenamePath,
              onSelect: () => {
                void onDuplicatePath(item.path, false);
              },
            },
          ]
        : []),
      ...(isMediaAsset
        ? [
            {
              label: `Copy ${engine === 'typst' ? 'Typst' : 'LaTeX'} Figure Snippet`,
              icon: <Code2 size={14} />,
              separatorBefore: true,
              onSelect: () => {
                void copyTextToClipboard(figureSnippet)
                  .then(() => toast.success('Figure snippet copied to clipboard'))
                  .catch(() => toast.error('Failed to copy snippet'));
              },
            },
          ]
        : []),
      {
        label: 'Copy Path',
        icon: <Copy size={14} />,
        separatorBefore: true,
        onSelect: () => {
          void copyTextToClipboard(item.path)
            .then(() => toast.success('Path copied'))
            .catch(() => toast.error('Failed to copy path'));
        },
      },
      {
        label: 'Copy Relative Path',
        icon: <Copy size={14} />,
        onSelect: () => {
          void copyTextToClipboard(relPath)
            .then(() => toast.success('Relative path copied'))
            .catch(() => toast.error('Failed to copy path'));
        },
      },
      ...(onRevealInFileManager
        ? [
            {
              label: 'Reveal in File Manager',
              icon: <ExternalLink size={14} />,
              separatorBefore: true,
              onSelect: () => {
                void onRevealInFileManager(item.path);
              },
            },
          ]
        : []),
      {
        label: 'Delete',
        icon: <Trash2 size={14} />,
        shortcut: 'Del',
        danger: true,
        separatorBefore: true,
        onSelect: () => handleDeleteItem(item),
      },
    ];
  };

  const isRootDropTarget = dropTargetDir === projectRoot || dropTargetDir === rootDropTarget;

  return (
    <div className="file-tree-container">
      <div
        className={`file-tree-header ${isRootDropTarget ? 'is-drop-target' : ''}`}
        onDragOver={(e) => handleDragOverDest(e, rootDropTarget)}
        onDragLeave={(e) => handleDragLeaveDest(e, rootDropTarget)}
        onDrop={(e) => {
          void handleDropIntoDest(e, rootDropTarget);
        }}
      >
        <div className="file-tree-title">
          <span className="project-title truncate" title={projectRoot}>
            {projectName || 'Project Explorer'}
          </span>
          <span className="project-engine-pill">{engine.toUpperCase()}</span>
        </div>

        <div className="file-tree-header-actions">
          {onImportFiles && (
            <button
              type="button"
              className="btn-tree-header-action"
              title="Import Files / Images"
              aria-label="Import files or images"
              onClick={() => onImportFiles()}
            >
              <FileUp size={14} />
            </button>
          )}
          <button
            type="button"
            className="btn-tree-header-action"
            title="New File"
            aria-label="New file"
            onClick={(e) => handleStartCreate('file', projectRoot, e)}
          >
            <FilePlus size={14} />
          </button>
          <button
            type="button"
            className="btn-tree-header-action"
            title="New Folder"
            aria-label="New folder"
            onClick={(e) => handleStartCreate('folder', projectRoot, e)}
          >
            <FolderPlus size={14} />
          </button>
          <button
            type="button"
            className="btn-tree-header-action"
            title="Collapse All Folders"
            aria-label="Collapse all folders"
            onClick={handleCollapseAll}
          >
            <ChevronsDownUp size={14} />
          </button>
          {onRefreshFiles && (
            <button
              type="button"
              className="btn-tree-header-action"
              title="Refresh Explorer"
              aria-label="Refresh explorer"
              onClick={() => {
                void onRefreshFiles();
              }}
            >
              <RefreshCw size={14} />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="btn-tree-header-action"
              title="Close panel"
              aria-label="Close panel"
              onClick={onClose}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {creatingType && (
        <div className="file-tree-inline-create">
          {creatingParent !== projectRoot && (
            <div className="file-tree-create-target truncate" title={getRelativePath(creatingParent)}>
              Inside: <code>{getRelativePath(creatingParent)}</code>
            </div>
          )}
          <div className="file-tree-inline-input">
            <input
              ref={createInputRef}
              type="text"
              placeholder={creatingType === 'file' ? 'filename.tex or filename.typ' : 'folder name'}
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmCreate();
                if (e.key === 'Escape') setCreatingType(null);
              }}
              autoFocus
            />
            <button type="button" className="btn-confirm-create" aria-label="Confirm create" onClick={handleConfirmCreate}>
              <Plus size={13} />
            </button>
          </div>
        </div>
      )}

      <div
        className={`file-tree-body ${isRootDropTarget ? 'is-drop-target' : ''}`}
        onDragOver={(e) => handleDragOverDest(e, rootDropTarget)}
        onDragLeave={(e) => handleDragLeaveDest(e, rootDropTarget)}
        onDrop={(e) => {
          void handleDropIntoDest(e, rootDropTarget);
        }}
      >
        {files.length > 0 ? (
          files.map((item) => renderItem(item, 0))
        ) : (
          <div className="file-tree-empty">
            <span>No files in project folder</span>
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={buildContextMenuActions(contextMenu.item)}
          triggerRef={menuTriggerRef}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
