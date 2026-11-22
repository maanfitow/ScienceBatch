import React, { useState } from 'react';
import { 
  FolderTree, 
  Search, 
  ListTree, 
  GitBranch,
  PackageSearch,
  MoveUp, 
  MoveDown, 
  RotateCcw,
  LucideIcon
} from 'lucide-react';
import { SidebarToolId } from '../../types/sidebar';
import { ContextMenu, ContextMenuAction } from '../ContextMenu';

interface ToolMeta {
  id: SidebarToolId;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
}

const TOOLS_CONFIG: Record<SidebarToolId, ToolMeta> = {
  files: {
    id: 'files',
    label: 'Project Files',
    icon: FolderTree,
    shortcut: 'Alt+1',
  },
  search: {
    id: 'search',
    label: 'Search in Files',
    icon: Search,
    shortcut: 'Ctrl+Shift+F',
  },
  git: {
    id: 'git',
    label: 'Source Control (Git)',
    icon: GitBranch,
    shortcut: 'Ctrl+Shift+G',
  },
  dependencies: {
    id: 'dependencies',
    label: 'Dependencies',
    icon: PackageSearch,
  },
  outline: {
    id: 'outline',
    label: 'Outline & Structure',
    icon: ListTree,
    shortcut: 'Alt+7',
  },
};

interface SidebarActivityBarProps {
  topTools: SidebarToolId[];
  bottomTools: SidebarToolId[];
  activeTopTool: SidebarToolId | null;
  activeBottomTool: SidebarToolId | null;
  onToggleTool: (id: SidebarToolId) => void;
  onMoveTool: (id: SidebarToolId, targetGroup: 'top' | 'bottom', targetIndex?: number) => void;
  onResetToDefaults: () => void;
  isOpen: boolean;
}

export const SidebarActivityBar: React.FC<SidebarActivityBarProps> = ({
  topTools,
  bottomTools,
  activeTopTool,
  activeBottomTool,
  onToggleTool,
  onMoveTool,
  onResetToDefaults,
  isOpen,
}) => {
  const [draggedTool, setDraggedTool] = useState<SidebarToolId | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    group: 'top' | 'bottom';
    index?: number;
    isSeparator?: boolean;
  } | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    toolId: SidebarToolId;
    currentGroup: 'top' | 'bottom';
    x: number;
    y: number;
  } | null>(null);

  // Drag & Drop handlers
  const handleDragStart = (e: React.DragEvent, id: SidebarToolId) => {
    setDraggedTool(id);
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = () => {
    setDraggedTool(null);
    setDropTarget(null);
  };

  const handleDragOver = (e: React.DragEvent, group: 'top' | 'bottom', index?: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dropTarget || dropTarget.group !== group || dropTarget.index !== index || dropTarget.isSeparator) {
      setDropTarget({ group, index, isSeparator: false });
    }
  };

  const handleSeparatorDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dropTarget?.isSeparator) {
      setDropTarget({ group: 'bottom', isSeparator: true });
    }
  };

  const handleDrop = (e: React.DragEvent, group: 'top' | 'bottom', index?: number) => {
    e.preventDefault();
    const toolId = (e.dataTransfer.getData('text/plain') as SidebarToolId) || draggedTool;
    if (toolId) {
      onMoveTool(toolId, group, index);
    }
    setDraggedTool(null);
    setDropTarget(null);
  };

  const handleContextMenu = (e: React.MouseEvent, toolId: SidebarToolId, currentGroup: 'top' | 'bottom') => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      toolId,
      currentGroup,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const renderToolButton = (toolId: SidebarToolId, group: 'top' | 'bottom', index: number) => {
    const meta = TOOLS_CONFIG[toolId];
    if (!meta) return null;
    const Icon = meta.icon;
    const isActive = isOpen && (
      (group === 'top' && activeTopTool === toolId) ||
      (group === 'bottom' && activeBottomTool === toolId)
    );
    const isBeingDragged = draggedTool === toolId;
    const isTarget = dropTarget && dropTarget.group === group && dropTarget.index === index && !dropTarget.isSeparator;

    return (
      <div 
        key={toolId}
        className={`activity-bar-item-wrapper ${isTarget ? 'drop-target-active' : ''}`}
        onDragOver={(e) => handleDragOver(e, group, index)}
        onDrop={(e) => handleDrop(e, group, index)}
      >
        <button
          className={`activity-bar-btn ${isActive ? 'active' : ''} ${isBeingDragged ? 'dragging' : ''}`}
          onClick={() => onToggleTool(toolId)}
          onContextMenu={(e) => handleContextMenu(e, toolId, group)}
          draggable
          onDragStart={(e) => handleDragStart(e, toolId)}
          onDragEnd={handleDragEnd}
          title={`${meta.label}${meta.shortcut ? ` (${meta.shortcut})` : ''} - Drag to move`}
          aria-label={meta.label}
        >
          <Icon size={19} className="activity-bar-icon" />
          {isActive && <div className="activity-bar-active-indicator" />}
        </button>
      </div>
    );
  };

  const contextMenuActions: ContextMenuAction[] = contextMenu ? [
    contextMenu.currentGroup === 'top'
      ? {
          label: 'Move to Bottom Group',
          icon: <MoveDown size={14} />,
          onSelect: () => onMoveTool(contextMenu.toolId, 'bottom'),
        }
      : {
          label: 'Move to Top Group',
          icon: <MoveUp size={14} />,
          onSelect: () => onMoveTool(contextMenu.toolId, 'top'),
        },
    {
      label: 'Reset to Default Layout',
      icon: <RotateCcw size={14} />,
      separatorBefore: true,
      onSelect: onResetToDefaults,
    },
  ] : [];

  return (
    <aside className="activity-bar-container" aria-label="JetBrains Activity Bar">
      {/* Top Icons Group */}
      <div 
        className={`activity-bar-group activity-bar-top ${dropTarget?.group === 'top' && dropTarget.index === undefined ? 'group-drop-target' : ''}`}
        onDragOver={(e) => handleDragOver(e, 'top')}
        onDrop={(e) => handleDrop(e, 'top')}
      >
        {topTools.map((id, index) => renderToolButton(id, 'top', index))}
      </div>

      {/* JetBrains Separator */}
      <div 
        className={`activity-bar-separator-container ${dropTarget?.isSeparator ? 'separator-drop-target' : ''}`}
        onDragOver={handleSeparatorDragOver}
        onDrop={(e) => handleDrop(e, 'bottom', 0)}
        title="JetBrains group separator (Drag an icon here to move between groups)"
      >
        <div className="activity-bar-separator-line" />
        <div className="activity-bar-separator-handle" />
      </div>

      {/* Bottom Icons Group */}
      <div 
        className={`activity-bar-group activity-bar-bottom ${dropTarget?.group === 'bottom' && dropTarget.index === undefined && !dropTarget.isSeparator ? 'group-drop-target' : ''}`}
        onDragOver={(e) => handleDragOver(e, 'bottom')}
        onDrop={(e) => handleDrop(e, 'bottom')}
      >
        {bottomTools.map((id, index) => renderToolButton(id, 'bottom', index))}
      </div>

      {/* Context Menu for right-click on icons */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={contextMenuActions}
          onClose={() => setContextMenu(null)}
        />
      )}
    </aside>
  );
};
