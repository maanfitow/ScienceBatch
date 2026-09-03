import React, { useState, useMemo } from 'react';
import { 
  ListTree, 
  Search, 
  X, 
  FileText
} from 'lucide-react';
import { EngineType } from '../../types/compiler';
import { OutlineItem } from '../../types/sidebar';

interface DocumentOutlineViewProps {
  engine: EngineType;
  sourceCode: string;
  activeFilePath: string | null;
  mainFilePath?: string | null;
  projectRoot?: string | null;
  onSelectFile?: (path: string) => Promise<void> | void;
  onSelectLine: (line: number, file?: string | null) => void;
  onClose?: () => void;
}

const LATEX_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

function cleanTitle(raw: string): string {
  return raw
    .replace(/\\(?:textbf|textit|emph|underline|texttt)\{([^}]+)\}/g, '$1')
    .replace(/\\label\{[^}]+\}/g, '')
    .trim();
}

function parseLatexOutline(content: string, filePath: string, fileName: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = content.split('\n');

  // Match \part{...}, \chapter{...}, \section{...}, etc.
  const regex = /\\(part|chapter|(?:sub)*section|(?:sub)?paragraph)\*?(?:\[.*?\])?\{([^}]+)\}/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('%')) continue;

    const match = line.match(regex);
    if (match) {
      const command = match[1].toLowerCase();
      const rawTitle = match[2];
      const level = LATEX_LEVELS[command] ?? 2;

      items.push({
        id: `${filePath}-${i + 1}`,
        title: cleanTitle(rawTitle),
        level,
        line: i + 1,
        filePath,
        fileName,
        rawCommand: command,
      });
    }
  }

  return items;
}

function parseTypstOutline(content: string, filePath: string, fileName: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = content.split('\n');

  // Match = Heading 1, == Heading 2, etc.
  const regex = /^(={1,6})\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('//')) continue;

    const match = line.match(regex);
    if (match) {
      const equalCount = match[1].length;
      const title = match[2].trim();

      items.push({
        id: `${filePath}-${i + 1}`,
        title,
        level: equalCount - 1,
        line: i + 1,
        filePath,
        fileName,
      });
    }
  }

  return items;
}

export const DocumentOutlineView: React.FC<DocumentOutlineViewProps> = ({
  engine,
  sourceCode,
  activeFilePath,
  onSelectLine,
  onClose,
}) => {
  const [filterQuery, setFilterQuery] = useState('');

  const activeFileName = useMemo(() => {
    if (!activeFilePath) return 'Document';
    return activeFilePath.split(/[/\\]/).pop() || 'Document';
  }, [activeFilePath]);

  // Dynamically extract active file outline in real-time from memory buffer
  const outlineItems = useMemo(() => {
    if (!activeFilePath) return [];
    if (engine === 'typst') {
      return parseTypstOutline(sourceCode, activeFilePath, activeFileName);
    } else {
      return parseLatexOutline(sourceCode, activeFilePath, activeFileName);
    }
  }, [sourceCode, activeFilePath, activeFileName, engine]);

  // Filter items by search query
  const filteredItems = useMemo(() => {
    if (!filterQuery.trim()) return outlineItems;
    const q = filterQuery.toLowerCase();
    return outlineItems.filter((item) => item.title.toLowerCase().includes(q));
  }, [outlineItems, filterQuery]);

  const handleItemClick = (item: OutlineItem) => {
    onSelectLine(item.line, item.filePath);
  };

  const renderLevelBadge = (level: number) => {
    const labels = ['P', 'C', 'H1', 'H2', 'H3', 'H4', 'H5'];
    const label = labels[level] || `H${level}`;
    return <span className={`outline-level-badge level-${level}`}>{label}</span>;
  };

  return (
    <div className="outline-view-container">
      {/* Header */}
      <div className="outline-view-header">
        <div className="outline-header-left">
          <span className="outline-view-title">OUTLINE</span>
          <span className="outline-active-file-pill truncate" title={activeFilePath || ''}>
            <FileText size={10} className="inline mr-1" />
            {activeFileName}
          </span>
        </div>
        <div className="outline-view-header-actions">
          <span className="outline-count-badge" title="Detected outline sections">
            {outlineItems.length}
          </span>
          {onClose && (
            <button
              className="btn-outline-header-action"
              onClick={onClose}
              title="Close panel"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Filter Input */}
      <div className="outline-filter-wrapper">
        <Search size={13} className="outline-filter-icon" />
        <input
          type="text"
          className="outline-filter-input"
          placeholder="Filter headings..."
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
        />
        {filterQuery && (
          <button
            className="outline-clear-filter-btn"
            onClick={() => setFilterQuery('')}
            title="Clear filter"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Outline Tree List */}
      <div className="outline-items-list">
        {filteredItems.length === 0 ? (
          <div className="outline-empty-state">
            <ListTree size={28} className="outline-empty-icon text-muted" />
            <p className="outline-empty-text">
              {filterQuery ? 'No matching headings found' : 'No sections or headings detected'}
            </p>
            <span className="outline-empty-hint">
              {engine === 'typst' ? 'Add = Heading in your document' : 'Use \\section{...} or \\chapter{...}'}
            </span>
          </div>
        ) : (
          filteredItems.map((item) => {
            const indentPixels = Math.min(item.level * 14, 70);
            return (
              <div
                key={item.id}
                className="outline-tree-item"
                style={{ paddingLeft: `${indentPixels + 10}px` }}
                onClick={() => handleItemClick(item)}
                title={`${item.title} (Line ${item.line})`}
              >
                {renderLevelBadge(item.level)}
                <span className="outline-item-title">{item.title}</span>
                <span className="outline-item-line-badge">L{item.line}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
