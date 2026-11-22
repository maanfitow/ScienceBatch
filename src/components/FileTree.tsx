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
  Code2
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
  onImportFiles?: () => void;
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FileItem } | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creatingType) {
      createInputRef.current?.focus();
    }
  }, [creatingType, creatingParent]);

  const getRelativePath = (fullPath: string) => {
    const normalizedRoot = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedPath = fullPath.replace(/\\/g, '/');
    if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
      return normalizedPath.slice(normalizedRoot.length + 1);
    }
    return normalizedPath;
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  };

  const handleStartCreate = (type: 'file' | 'folder', parent: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
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

  const renderItem = (item: FileItem, depth = 0) => {
    const isExpanded = !!expandedFolders[item.path];
    const isActive = activeFilePath === item.path;
    const isMain = mainFilePath === item.path || (mainFilePath && item.path.endsWith(mainFilePath));
    const ext = item.name.split('.').pop()?.toLowerCase() || '';
    const isMediaAsset = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'pdf'].includes(ext);

    if (item.is_dir) {
      return (
        <div key={item.path} className="file-tree-node">
          <div 
            className="file-tree-row file-tree-folder-row"
            style={{ paddingLeft: `${depth * 14 + 10}px` }}
            onClick={() => toggleFolder(item.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
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
            <span className="file-tree-label truncate">{item.name}</span>

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
            </div>
          </div>

          {isExpanded && item.children && (
            <div className="file-tree-children">
              {item.children.map((child) => renderItem(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div 
        key={item.path} 
        className={`file-tree-row file-tree-file-row ${isActive ? 'file-tree-active' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 24}px` }}
        onClick={() => {
          if (isMediaAsset && onViewImage) {
            onViewImage(item.path, item.name);
          } else {
            onSelectFile(item.path);
          }
        }}
        onDoubleClick={() => onSelectFile(item.path, true)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({ x: e.clientX, y: e.clientY, item });
        }}
      >
        {getFileIcon(item.name)}
        <span className="file-tree-label truncate">{item.name}</span>

        {isMain && (
          <span className="main-file-badge" title="Main Entrypoint File">
            <Star size={11} fill="currentColor" />
            <span>Main</span>
          </span>
        )}

        <div className="file-tree-actions">
          {!isMain && (item.name.endsWith('.tex') || item.name.endsWith('.typ')) && (
            <button
              type="button"
              className="btn-tree-action"
              title="Set as Main Entrypoint File"
              aria-label={`Set ${item.name} as Main Entrypoint File`}
              onClick={(e) => { e.stopPropagation(); onSetMainFile(item.path); }}
            >
              <Star size={12} />
            </button>
          )}
          <button
            type="button"
            className="btn-tree-action btn-tree-danger"
            title="Delete file"
            aria-label={`Delete ${item.name}`}
            onClick={(e) => { e.stopPropagation(); onDeleteFile(item.path); }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    );
  };

  const buildContextMenuActions = (item: FileItem): ContextMenuAction[] => {
    const relPath = getRelativePath(item.path);
    if (item.is_dir) {
      const isExpanded = !!expandedFolders[item.path];
      return [
        {
          label: 'New File Here…',
          icon: <FilePlus size={14} />,
          onSelect: () => handleStartCreate('file', item.path),
        },
        {
          label: 'New Folder Here…',
          icon: <FolderPlus size={14} />,
          onSelect: () => handleStartCreate('folder', item.path),
        },
        {
          label: isExpanded ? 'Collapse Folder' : 'Expand Folder',
          icon: isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />,
          separatorBefore: true,
          onSelect: () => toggleFolder(item.path),
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
      ];
    }

    const ext = item.name.split('.').pop()?.toLowerCase() || '';
    const isMediaAsset = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'pdf'].includes(ext);
    const isMain = mainFilePath === item.path || (mainFilePath && item.path.endsWith(mainFilePath));
    const canSetMain = !isMain && (ext === 'tex' || ext === 'typ');
    const stem = item.name.replace(/\.[^/.]+$/, '');
    const figureLabel = stem.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() || 'figure';
    const figureSnippet = engine === 'typst'
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
      ...(canSetMain ? [{
        label: 'Set as Main Entrypoint',
        icon: <Star size={14} />,
        onSelect: () => onSetMainFile(item.path),
      }] : []),
      ...(isMediaAsset ? [{
        label: `Copy ${engine === 'typst' ? 'Typst' : 'LaTeX'} Figure Snippet`,
        icon: <Code2 size={14} />,
        onSelect: () => {
          void copyTextToClipboard(figureSnippet)
            .then(() => toast.success('Figure snippet copied to clipboard'))
            .catch(() => toast.error('Failed to copy snippet'));
        },
      }] : []),
      {
        label: 'Copy Relative Path',
        icon: <Copy size={14} />,
        separatorBefore: true,
        onSelect: () => {
          void copyTextToClipboard(relPath)
            .then(() => toast.success('Relative path copied'))
            .catch(() => toast.error('Failed to copy path'));
        },
      },
      {
        label: 'Delete',
        icon: <Trash2 size={14} />,
        danger: true,
        separatorBefore: true,
        onSelect: () => onDeleteFile(item.path),
      },
    ];
  };

  return (
    <div className="file-tree-container">
      <div className="file-tree-header">
        <div className="file-tree-title">
          <span className="project-title truncate" title={projectRoot}>
            {projectName || 'Project Explorer'}
          </span>
          <span className="project-engine-pill">{engine.toUpperCase()}</span>
        </div>

        <div className="file-tree-header-actions">
          {onImportFiles && (
            <button 
              className="btn-tree-header-action" 
              title="Import Files / Images"
              onClick={onImportFiles}
            >
              <FileUp size={14} />
            </button>
          )}
          <button 
            className="btn-tree-header-action" 
            title="New File"
            onClick={(e) => handleStartCreate('file', projectRoot, e)}
          >
            <FilePlus size={14} />
          </button>
          <button 
            className="btn-tree-header-action" 
            title="New Folder"
            onClick={(e) => handleStartCreate('folder', projectRoot, e)}
          >
            <FolderPlus size={14} />
          </button>
          {onClose && (
            <button
              className="btn-tree-header-action"
              title="Close panel"
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

      <div className="file-tree-body">
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
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
