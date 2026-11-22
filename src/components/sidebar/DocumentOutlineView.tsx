import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  ListTree,
  Search,
  X,
  FileText,
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Link2,
  ArrowRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { EngineType } from '../../types/compiler';
import { OutlineItem } from '../../types/sidebar';
import { ContextMenu, type ContextMenuAction } from '../ContextMenu';
import {
  parseDocumentOutline,
  buildOutlineTree,
  findActiveOutlineId,
  type OutlineTreeNode,
} from './outlineParser';

interface DocumentOutlineViewProps {
  engine: EngineType;
  sourceCode: string;
  activeFilePath: string | null;
  activeCursorLine?: number | null;
  mainFilePath?: string | null;
  projectRoot?: string | null;
  onSelectFile?: (path: string) => Promise<void> | void;
  onSelectLine: (line: number, file?: string | null) => void;
  onClose?: () => void;
}

interface VisibleOutlineRow {
  node: OutlineTreeNode;
  parentId: string | null;
  hasChildren: boolean;
  isExpanded: boolean;
  firstChildId: string | null;
}

function normalizePathForCompare(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function getFallbackLevelLabel(level: number): string {
  const labels = ['P', 'C', 'H1', 'H2', 'H3', 'H4', 'H5'];
  return labels[level] || `H${level}`;
}

function filterOutlineTree(nodes: OutlineTreeNode[], query: string): OutlineTreeNode[] {
  const result: OutlineTreeNode[] = [];
  for (const node of nodes) {
    const filteredChildren = filterOutlineTree(node.children, query);
    const matchesSelf =
      node.item.title.toLowerCase().includes(query) ||
      (node.item.label?.toLowerCase().includes(query) ?? false);
    if (matchesSelf || filteredChildren.length > 0) {
      result.push({
        ...node,
        children: filteredChildren,
      });
    }
  }
  return result;
}

function collectExpandableIds(nodes: OutlineTreeNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: OutlineTreeNode[]) => {
    for (const node of list) {
      if (node.children.length > 0) {
        ids.push(node.item.id);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return ids;
}

function flattenVisibleTree(
  nodes: OutlineTreeNode[],
  collapsedIds: Set<string>,
  forceExpand: boolean,
  parentId: string | null = null,
  acc: VisibleOutlineRow[] = []
): VisibleOutlineRow[] {
  for (const node of nodes) {
    const hasChildren = node.children.length > 0;
    const isExpanded = hasChildren && (forceExpand || !collapsedIds.has(node.item.id));
    const firstChildId = isExpanded ? node.children[0]?.item.id ?? null : null;
    acc.push({
      node,
      parentId,
      hasChildren,
      isExpanded,
      firstChildId,
    });
    if (isExpanded) {
      flattenVisibleTree(node.children, collapsedIds, forceExpand, node.item.id, acc);
    }
  }
  return acc;
}

export const DocumentOutlineView: React.FC<DocumentOutlineViewProps> = ({
  engine,
  sourceCode,
  activeFilePath,
  activeCursorLine,
  onSelectLine,
  onClose,
}) => {
  const [filterQuery, setFilterQuery] = useState('');
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [eventCursorLine, setEventCursorLine] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: OutlineItem;
  } | null>(null);

  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Fallback cursor-line listener when rendered standalone or before parent state syncs
  useEffect(() => {
    setEventCursorLine(null);
  }, [activeFilePath]);

  useEffect(() => {
    const handleCursorLineChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ line?: number; filePath?: string | null }>).detail;
      if (typeof detail?.line !== 'number' || !Number.isFinite(detail.line)) return;
      const incomingPath = normalizePathForCompare(detail.filePath ?? null);
      const currentPath = normalizePathForCompare(activeFilePath);
      if (incomingPath !== currentPath) return;
      setEventCursorLine(detail.line);
    };

    window.addEventListener('sciencebatch:cursor-line-changed', handleCursorLineChanged);
    return () => {
      window.removeEventListener('sciencebatch:cursor-line-changed', handleCursorLineChanged);
    };
  }, [activeFilePath]);

  const effectiveCursorLine = activeCursorLine ?? eventCursorLine;

  const activeFileName = useMemo(() => {
    if (!activeFilePath) return 'Document';
    return activeFilePath.split(/[/\\]/).pop() || 'Document';
  }, [activeFilePath]);

  const outlineItems = useMemo(() => {
    if (!activeFilePath) return [];
    return parseDocumentOutline(engine, sourceCode, activeFilePath, activeFileName);
  }, [engine, sourceCode, activeFilePath, activeFileName]);

  const treeNodes = useMemo(() => buildOutlineTree(outlineItems), [outlineItems]);

  const normalizedQuery = filterQuery.trim().toLowerCase();
  const isFiltering = normalizedQuery.length > 0;

  const visibleTree = useMemo(() => {
    if (!isFiltering) return treeNodes;
    return filterOutlineTree(treeNodes, normalizedQuery);
  }, [treeNodes, isFiltering, normalizedQuery]);

  const expandableIds = useMemo(() => collectExpandableIds(treeNodes), [treeNodes]);
  const hasExpandableNodes = expandableIds.length > 0;
  const allCollapsed =
    hasExpandableNodes && expandableIds.every((id) => collapsedIds.has(id));

  // Prune stale collapsed IDs when outline items change
  useEffect(() => {
    const validIds = new Set(expandableIds);
    setCollapsedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [expandableIds]);

  const visibleRows = useMemo(
    () => flattenVisibleTree(visibleTree, collapsedIds, isFiltering),
    [visibleTree, collapsedIds, isFiltering]
  );

  const activeItemId = useMemo(
    () => findActiveOutlineId(outlineItems, effectiveCursorLine),
    [outlineItems, effectiveCursorLine]
  );

  const handleItemClick = useCallback(
    (item: OutlineItem) => {
      setFocusedId(item.id);
      onSelectLine(item.line, item.filePath);
    },
    [onSelectLine]
  );

  const toggleNodeCollapsed = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setCollapsedIds(new Set());
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsedIds(new Set(expandableIds));
  }, [expandableIds]);

  const handleToggleAll = useCallback(() => {
    if (!hasExpandableNodes) return;
    if (allCollapsed) {
      expandAll();
    } else {
      collapseAll();
    }
  }, [hasExpandableNodes, allCollapsed, expandAll, collapseAll]);

  const focusRowById = useCallback((id: string | null) => {
    if (!id) return;
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }, []);

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, rowIndex: number) => {
      const current = visibleRows[rowIndex];
      if (!current) return;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const nextRow = visibleRows[rowIndex + 1];
          if (nextRow) focusRowById(nextRow.node.item.id);
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const prevRow = visibleRows[rowIndex - 1];
          if (prevRow) focusRowById(prevRow.node.item.id);
          break;
        }
        case 'ArrowRight': {
          e.preventDefault();
          if (current.hasChildren && !current.isExpanded) {
            toggleNodeCollapsed(current.node.item.id);
          } else if (current.hasChildren && current.isExpanded && current.firstChildId) {
            focusRowById(current.firstChildId);
          }
          break;
        }
        case 'ArrowLeft': {
          e.preventDefault();
          if (current.hasChildren && current.isExpanded && !isFiltering) {
            toggleNodeCollapsed(current.node.item.id);
          } else if (current.parentId) {
            focusRowById(current.parentId);
          }
          break;
        }
        case 'Home': {
          e.preventDefault();
          const first = visibleRows[0];
          if (first) focusRowById(first.node.item.id);
          break;
        }
        case 'End': {
          e.preventDefault();
          const last = visibleRows[visibleRows.length - 1];
          if (last) focusRowById(last.node.item.id);
          break;
        }
        case 'Enter':
        case ' ': {
          e.preventDefault();
          handleItemClick(current.node.item);
          break;
        }
      }
    },
    [visibleRows, focusRowById, toggleNodeCollapsed, isFiltering, handleItemClick]
  );

  const copyToClipboard = useCallback(async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(successMessage);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  }, []);

  const contextMenuActions: ContextMenuAction[] = useMemo(() => {
    if (!contextMenu) return [];
    const { item } = contextMenu;
    const actions: ContextMenuAction[] = [
      {
        label: 'Jump to Section',
        icon: <ArrowRight size={13} />,
        shortcut: `L${item.line}`,
        onSelect: () => handleItemClick(item),
      },
      {
        label: 'Copy Heading Title',
        icon: <Copy size={13} />,
        onSelect: () => {
          void copyToClipboard(item.title, 'Heading title copied');
        },
      },
    ];

    if (item.label) {
      const refText = engine === 'typst' ? `@${item.label}` : `\\ref{${item.label}}`;
      actions.push({
        label: 'Copy Reference',
        icon: <Link2 size={13} />,
        shortcut: refText,
        onSelect: () => {
          void copyToClipboard(refText, 'Reference copied');
        },
      });
    }

    if (hasExpandableNodes && !isFiltering) {
      actions.push(
        {
          label: 'Expand All',
          icon: <ChevronsUpDown size={13} />,
          separatorBefore: true,
          disabled: collapsedIds.size === 0,
          onSelect: expandAll,
        },
        {
          label: 'Collapse All',
          icon: <ChevronsDownUp size={13} />,
          disabled: allCollapsed,
          onSelect: collapseAll,
        }
      );
    }

    return actions;
  }, [
    contextMenu,
    handleItemClick,
    copyToClipboard,
    engine,
    hasExpandableNodes,
    isFiltering,
    collapsedIds.size,
    allCollapsed,
    expandAll,
    collapseAll,
  ]);

  const tabStopId = useMemo(() => {
    if (focusedId && visibleRows.some((r) => r.node.item.id === focusedId)) {
      return focusedId;
    }
    if (activeItemId && visibleRows.some((r) => r.node.item.id === activeItemId)) {
      return activeItemId;
    }
    return visibleRows[0]?.node.item.id ?? null;
  }, [focusedId, activeItemId, visibleRows]);

  return (
    <div className="outline-view-container">
      {/* Header */}
      <div className="outline-view-header">
        <div className="outline-header-left">
          <span className="outline-view-title">OUTLINE</span>
          <span className="outline-active-file-pill" title={activeFilePath || ''}>
            <FileText size={11} className="outline-file-icon" aria-hidden="true" />
            <span className="truncate">{activeFileName}</span>
          </span>
        </div>
        <div className="outline-view-header-actions">
          <span className="outline-count-badge" title="Detected outline sections">
            {outlineItems.length}
          </span>
          <button
            type="button"
            className="btn-outline-header-action"
            onClick={handleToggleAll}
            disabled={!hasExpandableNodes || isFiltering}
            title={
              isFiltering
                ? 'Clear filter to collapse or expand sections'
                : allCollapsed
                  ? 'Expand all sections'
                  : 'Collapse all sections'
            }
            aria-label={allCollapsed ? 'Expand all sections' : 'Collapse all sections'}
          >
            {allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
          </button>
          {onClose && (
            <button
              type="button"
              className="btn-outline-header-action"
              onClick={onClose}
              title="Close outline panel"
              aria-label="Close outline panel"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Filter Input */}
      <div className="outline-filter-wrapper">
        <div className="outline-filter-box">
          <Search size={13} className="outline-filter-icon" aria-hidden="true" />
          <input
            type="text"
            className="outline-filter-input"
            placeholder="Filter headings..."
            aria-label="Filter headings"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
          {filterQuery && (
            <button
              type="button"
              className="outline-clear-filter-btn"
              onClick={() => setFilterQuery('')}
              title="Clear filter"
              aria-label="Clear filter"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Outline Tree */}
      <div className="outline-items-list" role="tree" aria-label="Document outline">
        {visibleRows.length === 0 ? (
          <div className="outline-empty-state">
            <ListTree size={28} className="outline-empty-icon" aria-hidden="true" />
            <p className="outline-empty-text">
              {isFiltering ? 'No matching headings found' : 'No sections or headings detected'}
            </p>
            <span className="outline-empty-hint">
              {engine === 'typst'
                ? 'Add = Heading in your document'
                : 'Use \\section{...} or \\chapter{...}'}
            </span>
          </div>
        ) : (
          visibleRows.map((row, rowIndex) => {
            const { node, hasChildren, isExpanded } = row;
            const { item, depth } = node;
            const isActive = item.id === activeItemId;
            const levelClass = `level-${Math.min(Math.max(item.level, 0), 6)}`;
            const kindLabel = item.kindLabel || getFallbackLevelLabel(item.level);

            return (
              <div
                key={item.id}
                ref={(el) => {
                  if (el) {
                    rowRefs.current.set(item.id, el);
                  } else {
                    rowRefs.current.delete(item.id);
                  }
                }}
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={hasChildren ? isExpanded : undefined}
                aria-selected={isActive}
                tabIndex={item.id === tabStopId ? 0 : -1}
                className={`outline-tree-row${isActive ? ' is-active' : ''}`}
                style={{ paddingLeft: `${depth * 14 + 6}px` }}
                onClick={() => handleItemClick(item)}
                onFocus={() => setFocusedId(item.id)}
                onKeyDown={(e) => handleRowKeyDown(e, rowIndex)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setFocusedId(item.id);
                  setContextMenu({ x: e.clientX, y: e.clientY, item });
                }}
                title={`${item.title} (Line ${item.line})`}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className="outline-chevron-btn"
                    disabled={isFiltering}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isFiltering) {
                        toggleNodeCollapsed(item.id);
                      }
                    }}
                    aria-label={isExpanded ? 'Collapse section' : 'Expand section'}
                    title={
                      isFiltering
                        ? 'Clear filter to collapse or expand sections'
                        : isExpanded
                          ? 'Collapse section'
                          : 'Expand section'
                    }
                  >
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                ) : (
                  <span className="outline-chevron-spacer" aria-hidden="true" />
                )}
                <span className={`outline-level-badge ${levelClass}`}>{kindLabel}</span>
                <span className="outline-item-title">{item.title}</span>
                {item.label && (
                  <span className="outline-item-label-tag" title={`Label: ${item.label}`}>
                    @{item.label}
                  </span>
                )}
                <span className="outline-item-line-badge">L{item.line}</span>
              </div>
            );
          })
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={contextMenuActions}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
