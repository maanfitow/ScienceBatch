import React, { useState, useEffect, useCallback, useMemo, useRef, startTransition } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { 
  Search, 
  Replace, 
  ChevronRight, 
  ChevronDown, 
  X, 
  RotateCw, 
  FileText, 
  Check, 
  Filter, 
  CheckCheck,
  AlertCircle
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { FileItem } from '../../types';
import { FileSearchResults, SearchMatchItem } from '../../types/sidebar';

interface GlobalSearchViewProps {
  projectFiles: FileItem[];
  projectRoot: string | null;
  activeFilePath: string | null;
  sourceCode: string;
  onUpdateSourceCode: (code: string) => void;
  onSelectFile: (path: string) => Promise<void> | void;
  onSelectLine: (line: number, file?: string | null) => void;
  onClose?: () => void;
}

const TEXT_EXTENSIONS = new Set([
  'tex', 'typ', 'bib', 'sty', 'cls', 'txt', 'md', 'json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'dtx', 'ins', 'bst', 'def', 'xml', 'html'
]);

const INITIAL_MATCHES_PER_FILE_LIMIT = 40;

function isTextFile(fileName: string): boolean {
  const parts = fileName.split('.');
  if (parts.length < 2) return false;
  const ext = parts.pop()?.toLowerCase() || '';
  return TEXT_EXTENSIONS.has(ext);
}

function collectTextFiles(items: FileItem[]): { path: string; name: string }[] {
  const result: { path: string; name: string }[] = [];
  const traverse = (list: FileItem[]) => {
    for (const item of list) {
      if (item.is_dir && item.children) {
        traverse(item.children);
      } else if (!item.is_dir && isTextFile(item.name)) {
        result.push({ path: item.path, name: item.name });
      }
    }
  };
  traverse(items);
  return result;
}

export const GlobalSearchView: React.FC<GlobalSearchViewProps> = ({
  projectFiles,
  projectRoot,
  activeFilePath,
  sourceCode,
  onUpdateSourceCode,
  onSelectFile,
  onSelectLine,
  onClose,
}) => {
  const { t } = useTranslation(['sidebar', 'common']);
  // Decoupled input value for zero typing lag (instant 60fps)
  const [inputValue, setInputValue] = useState('');
  const [activeQuery, setActiveQuery] = useState('');

  const [replaceQuery, setReplaceQuery] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [includePattern, setIncludePattern] = useState('');
  const [excludePattern, setExcludePattern] = useState('');

  // Toggles
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);

  // Results & UI State
  const [results, setResults] = useState<FileSearchResults[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [regexError, setRegexError] = useState<string | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const [expandedMatchFiles, setExpandedMatchFiles] = useState<Record<string, boolean>>({});

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cache file contents in memory to avoid repeated heavy disk IPC reads
  const fileCacheRef = useRef<Map<string, string>>(new Map());

  // Invalidate file cache when projectFiles change
  useEffect(() => {
    fileCacheRef.current.clear();
  }, [projectFiles]);

  // Build RegExp safely
  const buildSearchRegex = useCallback((term: string): RegExp | null => {
    if (!term) return null;
    try {
      let pattern = term;
      if (!isRegex) {
        pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      if (wholeWord) {
        pattern = `\\b${pattern}\\b`;
      }
      const flags = matchCase ? 'g' : 'gi';
      setRegexError(null);
      return new RegExp(pattern, flags);
    } catch (e: any) {
      setRegexError(e?.message || t('sidebar:search.invalidRegex'));
      return null;
    }
  }, [isRegex, wholeWord, matchCase, t]);

  // Execute Search
  const executeSearch = useCallback(async (searchQueryToRun: string) => {
    const trimmed = searchQueryToRun.trim();
    if (!trimmed || !projectRoot) {
      startTransition(() => {
        setResults([]);
        setIsSearching(false);
      });
      return;
    }

    const regex = buildSearchRegex(trimmed);
    if (!regex) {
      startTransition(() => {
        setResults([]);
        setIsSearching(false);
      });
      return;
    }

    setIsSearching(true);
    try {
      const allFiles = collectTextFiles(projectFiles);

      // Filter included / excluded files if set
      const filteredFiles = allFiles.filter(({ path, name }) => {
        if (includePattern.trim()) {
          const patterns = includePattern.split(',').map((p) => p.trim().toLowerCase());
          const matchInclude = patterns.some((p) => {
            if (p.startsWith('*.')) return name.toLowerCase().endsWith(p.slice(1));
            return name.toLowerCase().includes(p);
          });
          if (!matchInclude) return false;
        }

        if (excludePattern.trim()) {
          const patterns = excludePattern.split(',').map((p) => p.trim().toLowerCase());
          const matchExclude = patterns.some((p) => {
            if (p.startsWith('*.')) return name.toLowerCase().endsWith(p.slice(1));
            return path.toLowerCase().includes(p);
          });
          if (matchExclude) return false;
        }

        return true;
      });

      const searchResults: FileSearchResults[] = [];

      for (const file of filteredFiles) {
        let content: string;
        if (file.path === activeFilePath) {
          content = sourceCode;
        } else if (fileCacheRef.current.has(file.path)) {
          content = fileCacheRef.current.get(file.path)!;
        } else {
          try {
            content = await invoke<string>('read_file_content', { path: file.path });
            fileCacheRef.current.set(file.path, content);
          } catch {
            continue;
          }
        }

        const lines = content.split('\n');
        const matches: SearchMatchItem[] = [];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          regex.lastIndex = 0;
          let match: RegExpExecArray | null;

          while ((match = regex.exec(line)) !== null) {
            matches.push({
              line: i + 1,
              lineContent: line,
              matchStart: match.index,
              matchEnd: match.index + match[0].length,
              matchText: match[0],
            });

            if (match.index === regex.lastIndex) {
              regex.lastIndex++;
            }
          }
        }

        if (matches.length > 0) {
          const rel = file.path.startsWith(projectRoot)
            ? file.path.slice(projectRoot.length).replace(/^[/\\]/, '')
            : file.name;

          searchResults.push({
            filePath: file.path,
            relativePath: rel,
            fileName: file.name,
            matches,
          });
        }
      }

      // Use React transition to never block input typing rendering
      startTransition(() => {
        setResults(searchResults);
      });
    } catch (e) {
      console.error('Error during global search:', e);
    } finally {
      setIsSearching(false);
    }
  }, [
    projectRoot, 
    buildSearchRegex, 
    projectFiles, 
    includePattern, 
    excludePattern, 
    activeFilePath, 
    sourceCode
  ]);

  // Adaptive debounce: 550ms for 1 character, 180ms for 2+ characters
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    const trimmed = inputValue.trim();
    if (!trimmed) {
      setActiveQuery('');
      setResults([]);
      setIsSearching(false);
      setRegexError(null);
      return;
    }

    // Adaptive delay: 550ms for 1 char so typing isn't interrupted, 180ms for 2+ chars for instant results
    const delay = trimmed.length === 1 ? 550 : 180;

    debounceTimerRef.current = setTimeout(() => {
      setActiveQuery(trimmed);
      executeSearch(trimmed);
    }, delay);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [inputValue, matchCase, wholeWord, isRegex, includePattern, excludePattern, executeSearch]);

  const handleManualSearch = () => {
    if (!inputValue.trim()) return;
    setActiveQuery(inputValue.trim());
    executeSearch(inputValue.trim());
  };

  const totalMatchesCount = useMemo(() => {
    return results.reduce((acc, r) => acc + r.matches.length, 0);
  }, [results]);

  const toggleFileCollapse = (filePath: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [filePath]: !prev[filePath] }));
  };

  const toggleExpandMatches = (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedMatchFiles((prev) => ({ ...prev, [filePath]: !prev[filePath] }));
  };

  const handleSelectMatch = async (filePath: string, line: number) => {
    if (activeFilePath !== filePath) {
      await onSelectFile(filePath);
    }
    onSelectLine(line, filePath);
  };

  // Replace all in a specific file
  const handleReplaceInFile = async (filePath: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const regex = buildSearchRegex(activeQuery || inputValue);
    if (!regex) return;

    try {
      let content: string;
      const isActive = filePath === activeFilePath;
      if (isActive) {
        content = sourceCode;
      } else {
        content = fileCacheRef.current.get(filePath) || await invoke<string>('read_file_content', { path: filePath });
      }

      const newContent = content.replace(regex, replaceQuery);
      if (isActive) {
        onUpdateSourceCode(newContent);
      } else {
        await invoke('write_file_content', { path: filePath, content: newContent });
        fileCacheRef.current.set(filePath, newContent);
      }

      toast.success(t('sidebar:search.toast.replacedInFile'));
      executeSearch(activeQuery || inputValue);
    } catch (err: any) {
      toast.error(t('sidebar:search.toast.replaceInFileFailed'));
      console.error(err);
    }
  };

  // Replace All in Project
  const handleReplaceAll = async () => {
    const term = activeQuery || inputValue;
    if (!term || results.length === 0) return;
    const regex = buildSearchRegex(term);
    if (!regex) return;

    let replacedFilesCount = 0;
    let totalReplacedMatches = 0;

    for (const fileResult of results) {
      try {
        let content: string;
        const isActive = fileResult.filePath === activeFilePath;
        if (isActive) {
          content = sourceCode;
        } else {
          content = fileCacheRef.current.get(fileResult.filePath) || await invoke<string>('read_file_content', { path: fileResult.filePath });
        }

        const newContent = content.replace(regex, replaceQuery);
        if (isActive) {
          onUpdateSourceCode(newContent);
        } else {
          await invoke('write_file_content', { path: fileResult.filePath, content: newContent });
          fileCacheRef.current.set(fileResult.filePath, newContent);
        }

        totalReplacedMatches += fileResult.matches.length;
        replacedFilesCount++;
      } catch (e) {
        console.error(`Failed to replace in ${fileResult.filePath}:`, e);
      }
    }

    const filesLabel = t('sidebar:search.toast.replacedFileCount', { count: replacedFilesCount });
    toast.success(
      t('sidebar:search.toast.replacedSummary', {
        count: totalReplacedMatches,
        files: filesLabel,
      })
    );
    executeSearch(term);
  };

  // Replace individual match
  const handleReplaceSingleMatch = async (
    filePath: string,
    match: SearchMatchItem,
    e: React.MouseEvent
  ) => {
    e.stopPropagation();
    try {
      let content: string;
      const isActive = filePath === activeFilePath;
      if (isActive) {
        content = sourceCode;
      } else {
        content = fileCacheRef.current.get(filePath) || await invoke<string>('read_file_content', { path: filePath });
      }

      const lines = content.split('\n');
      const targetLineIdx = match.line - 1;
      if (targetLineIdx >= 0 && targetLineIdx < lines.length) {
        const line = lines[targetLineIdx];
        const before = line.slice(0, match.matchStart);
        const after = line.slice(match.matchEnd);
        lines[targetLineIdx] = before + replaceQuery + after;
        const newContent = lines.join('\n');

        if (isActive) {
          onUpdateSourceCode(newContent);
        } else {
          await invoke('write_file_content', { path: filePath, content: newContent });
          fileCacheRef.current.set(filePath, newContent);
        }

        toast.success(t('sidebar:search.toast.replacedAtLine', { line: match.line }));
        executeSearch(activeQuery || inputValue);
      }
    } catch (err: any) {
      toast.error(t('sidebar:search.toast.replaceOccurrenceFailed'));
      console.error(err);
    }
  };

  return (
    <div className="search-view-container">
      {/* Panel Header */}
      <div className="search-view-header">
        <span className="search-view-title">{t('sidebar:search.title')}</span>
        <div className="search-view-header-actions">
          <button
            className={`btn-search-header-action ${showFilters ? 'active' : ''}`}
            onClick={() => setShowFilters((prev) => !prev)}
            title={t('sidebar:search.filtersTooltip')}
            aria-label={t('sidebar:search.filtersTooltip')}
          >
            <Filter size={13} />
          </button>
          <button
            className="btn-search-header-action"
            onClick={handleManualSearch}
            title={t('sidebar:search.refreshTooltip')}
            aria-label={t('sidebar:search.refreshTooltip')}
            disabled={!inputValue.trim()}
          >
            <RotateCw size={13} className={isSearching ? 'animate-spin' : ''} />
          </button>
          {onClose && (
            <button
              className="btn-search-header-action"
              onClick={onClose}
              title={t('sidebar:common.closePanel')}
              aria-label={t('sidebar:common.closePanel')}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Search Input Controls */}
      <div className="search-view-controls">
        {/* Search Row */}
        <div className="search-input-row">
          <button
            className="search-toggle-replace-btn"
            onClick={() => setShowReplace((prev) => !prev)}
            title={showReplace ? t('sidebar:search.hideReplace') : t('sidebar:search.showReplace')}
            aria-label={showReplace ? t('sidebar:search.hideReplace') : t('sidebar:search.showReplace')}
          >
            <ChevronRight size={13} className={`transition-transform ${showReplace ? 'rotate-90' : ''}`} />
          </button>
          <div className="search-input-wrapper">
            <Search size={14} className="search-icon-inside" />
            <input
              type="text"
              className="search-field-input"
              placeholder={t('sidebar:search.searchPlaceholder')}
              aria-label={t('sidebar:search.searchAriaLabel')}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleManualSearch();
              }}
              autoFocus
            />
            {inputValue && (
              <button
                className="search-clear-btn"
                onClick={() => {
                  setInputValue('');
                  setActiveQuery('');
                  setResults([]);
                }}
                title={t('sidebar:search.clearSearch')}
                aria-label={t('sidebar:search.clearSearch')}
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Badges / Mode Buttons */}
          <div className="search-options-group">
            <button
              className={`search-option-btn ${matchCase ? 'active' : ''}`}
              onClick={() => setMatchCase((prev) => !prev)}
              title={t('sidebar:search.matchCaseTooltip')}
              aria-label={t('sidebar:search.matchCaseTooltip')}
            >
              Aa
            </button>
            <button
              className={`search-option-btn ${wholeWord ? 'active' : ''}`}
              onClick={() => setWholeWord((prev) => !prev)}
              title={t('sidebar:search.wholeWordTooltip')}
              aria-label={t('sidebar:search.wholeWordTooltip')}
            >
              \b
            </button>
            <button
              className={`search-option-btn ${isRegex ? 'active' : ''}`}
              onClick={() => setIsRegex((prev) => !prev)}
              title={t('sidebar:search.regexTooltip')}
              aria-label={t('sidebar:search.regexTooltip')}
            >
              .*
            </button>
          </div>
        </div>

        {/* Replace Row */}
        {showReplace && (
          <div className="replace-input-row">
            <div className="replace-input-spacer" />
            <div className="search-input-wrapper">
              <Replace size={14} className="search-icon-inside" />
              <input
                type="text"
                className="search-field-input"
                placeholder={t('sidebar:search.replacePlaceholder')}
                aria-label={t('sidebar:search.replaceAriaLabel')}
                value={replaceQuery}
                onChange={(e) => setReplaceQuery(e.target.value)}
              />
              {replaceQuery && (
                <button
                  className="search-clear-btn"
                  onClick={() => setReplaceQuery('')}
                  title={t('sidebar:search.clearField')}
                  aria-label={t('sidebar:search.clearField')}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <button
              className="btn-replace-all"
              onClick={handleReplaceAll}
              disabled={results.length === 0}
              title={t('sidebar:search.replaceAllTooltip')}
            >
              <CheckCheck size={13} />
              <span>{t('sidebar:search.replaceAllButton')}</span>
            </button>
          </div>
        )}

        {/* File Inclusion / Exclusion Filters */}
        {showFilters && (
          <div className="search-filters-container">
            <div className="search-filter-row">
              <label className="search-filter-label">{t('sidebar:search.includeLabel')}</label>
              <input
                type="text"
                className="search-filter-input"
                placeholder={t('sidebar:search.includePlaceholder')}
                aria-label={t('sidebar:search.includeLabel')}
                value={includePattern}
                onChange={(e) => setIncludePattern(e.target.value)}
              />
            </div>
            <div className="search-filter-row">
              <label className="search-filter-label">{t('sidebar:search.excludeLabel')}</label>
              <input
                type="text"
                className="search-filter-input"
                placeholder={t('sidebar:search.excludePlaceholder')}
                aria-label={t('sidebar:search.excludeLabel')}
                value={excludePattern}
                onChange={(e) => setExcludePattern(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* Regex Error Alert */}
        {regexError && (
          <div className="search-regex-error">
            <AlertCircle size={12} />
            <span>{regexError}</span>
          </div>
        )}
      </div>

      {/* Results Header / Stats */}
      <div className="search-results-summary">
        {inputValue.trim() ? (
          isSearching ? (
            <span className="text-muted">{t('sidebar:search.searching')}</span>
          ) : results.length > 0 ? (
            <span>
              <Trans
                ns="sidebar"
                i18nKey="search.resultsPart"
                count={totalMatchesCount}
                values={{ count: totalMatchesCount }}
                components={{ strong: <strong /> }}
              />{' '}
              {t('sidebar:search.acrossConnector')}{' '}
              <Trans
                ns="sidebar"
                i18nKey="search.filesPart"
                count={results.length}
                values={{ count: results.length }}
                components={{ strong: <strong /> }}
              />
            </span>
          ) : (
            <span className="text-muted">{t('sidebar:search.noResults')}</span>
          )
        ) : (
          <span className="text-muted">{t('sidebar:search.emptyPrompt')}</span>
        )}
      </div>

      {/* Results List */}
      <div className="search-results-list">
        {results.map((fileResult) => {
          const isCollapsed = collapsedFiles[fileResult.filePath];
          const isExpanded = expandedMatchFiles[fileResult.filePath];
          const visibleMatches = isExpanded 
            ? fileResult.matches 
            : fileResult.matches.slice(0, INITIAL_MATCHES_PER_FILE_LIMIT);
          const hasMore = fileResult.matches.length > INITIAL_MATCHES_PER_FILE_LIMIT && !isExpanded;

          return (
            <div key={fileResult.filePath} className="search-file-group">
              {/* File Header */}
              <div 
                className="search-file-header"
                onClick={() => toggleFileCollapse(fileResult.filePath)}
              >
                <div className="search-file-header-left">
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <FileText size={14} className="search-file-icon icon-latex" />
                  <span className="search-file-name" title={fileResult.filePath}>
                    {fileResult.fileName}
                  </span>
                  <span className="search-file-relpath">
                    {fileResult.relativePath !== fileResult.fileName ? fileResult.relativePath : ''}
                  </span>
                </div>
                <div className="search-file-header-right">
                  {showReplace && (
                    <button
                      className="btn-replace-file-action"
                      onClick={(e) => handleReplaceInFile(fileResult.filePath, e)}
                      title={t('sidebar:search.replaceInFileTooltip')}
                      aria-label={t('sidebar:search.replaceInFileTooltip')}
                    >
                      <Replace size={12} />
                    </button>
                  )}
                  <span className="search-file-count-badge">
                    {fileResult.matches.length}
                  </span>
                </div>
              </div>

              {/* Match Items */}
              {!isCollapsed && (
                <div className="search-file-matches">
                  {visibleMatches.map((match, idx) => {
                    const lineContent = match.lineContent.trim();
                    return (
                      <div
                        key={`${fileResult.filePath}-${match.line}-${idx}`}
                        className="search-match-row"
                        onClick={() => handleSelectMatch(fileResult.filePath, match.line)}
                        title={t('sidebar:search.matchLineTooltip', { line: match.line, content: lineContent })}
                      >
                        <span className="search-match-line-badge">
                          {match.line}
                        </span>
                        <div className="search-match-snippet">
                          {lineContent}
                        </div>
                        {showReplace && (
                          <button
                            className="btn-replace-match-action"
                            onClick={(e) => handleReplaceSingleMatch(fileResult.filePath, match, e)}
                            title={t('sidebar:search.replaceMatchTooltip')}
                            aria-label={t('sidebar:search.replaceMatchTooltip')}
                          >
                            <Check size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {hasMore && (
                    <button
                      className="btn-show-more-matches"
                      onClick={(e) => toggleExpandMatches(fileResult.filePath, e)}
                    >
                      {t('sidebar:search.showMoreMatches', {
                        count: fileResult.matches.length - INITIAL_MATCHES_PER_FILE_LIMIT,
                      })}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
