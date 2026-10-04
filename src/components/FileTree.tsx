import React, { useState } from 'react';
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
  X
} from 'lucide-react';
import { FileItem } from '../types';

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

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  };

  const handleStartCreate = (type: 'file' | 'folder', parent: string, e: React.MouseEvent) => {
    e.stopPropagation();
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
                className="btn-tree-action" 
                title="New file inside folder"
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
              className="btn-tree-action"
              title="Set as Main Entrypoint File"
              onClick={(e) => { e.stopPropagation(); onSetMainFile(item.path); }}
            >
              <Star size={12} />
            </button>
          )}
          <button
            className="btn-tree-action btn-tree-danger"
            title="Delete file"
            onClick={(e) => { e.stopPropagation(); onDeleteFile(item.path); }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    );
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
        <div className="file-tree-inline-input">
          <input
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
          <button className="btn-confirm-create" onClick={handleConfirmCreate}>
            <Plus size={13} />
          </button>
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
    </div>
  );
};
