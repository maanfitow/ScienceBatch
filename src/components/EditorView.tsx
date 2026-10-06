import React, { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';
import Editor, { OnMount, BeforeMount } from '@monaco-editor/react';
import type * as monacoType from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';
import { invoke } from '@tauri-apps/api/core';
import { registerLatexLanguage } from '../editor/latexLanguage';
import { registerLatexLanguageSupport } from '../editor/latexCompletion';
import { registerLatexCodeActions } from '../editor/latexCodeActions';
import { lintLatexDocument } from '../editor/latexLinter';
import { registerTypstLanguageSupport } from '../editor/typstLanguage';
import { registerTypstCompletion } from '../editor/typstCompletion';
import { registerBibtexLanguage } from '../editor/bibtexLanguage';
import { useTheme, registerMonacoCustomThemes } from '../themes/ThemeContext';
import { DiagnosticItem } from '../types';
import type { WritingEditorBridge, WritingEditorState, WritingLanguage } from '../types/writing';
import { createWritingEditorBridge } from '../editor/writingBridge';
import { getWritingSymbolAdapter } from '../editor/writing/adapters';
import { registerEditorClipboardCopy } from '../editor/editorClipboard';

function eligibleWritingLanguage(engine: WritingLanguage, activeFilePath: string | null | undefined, isScratchpad: boolean): WritingLanguage | null {
  if (activeFilePath) {
    if (engine === 'latex' && /\.tex$/i.test(activeFilePath)) return 'latex';
    if (engine === 'typst' && /\.typ$/i.test(activeFilePath)) return 'typst';
    return null;
  }
  return isScratchpad ? engine : null;
}

function buildWritingEditorState({
  language, eligibleLanguage, source, cursorOffset, canAddPackages, readOnly, hasMultipleSelections,
}: {
  language: WritingLanguage;
  eligibleLanguage: WritingLanguage | null;
  source: string;
  cursorOffset: number;
  canAddPackages: boolean;
  readOnly: boolean;
  hasMultipleSelections: boolean;
}): WritingEditorState {
  const context = eligibleLanguage
    ? getWritingSymbolAdapter(eligibleLanguage).classifyContext(source, cursorOffset)
    : { context: 'blocked' as const, reason: 'Writing tools are available only in editable LaTeX or Typst source files.' };
  const editable = eligibleLanguage !== null && !readOnly && !hasMultipleSelections;
  const available = editable && context.context !== 'blocked';
  return {
    language,
    editable,
    available,
    reason: available ? '' : readOnly ? 'The editor is temporarily read-only.' : hasMultipleSelections ? 'Writing tools support one selection at a time.' : context.reason || 'Writing tools are available only in a supported source context.',
    source,
    cursorOffset,
    canAddPackages: canAddPackages && eligibleLanguage === 'latex' && !readOnly,
  };
}

interface EditorViewProps {
  value: string;
  onChange: (value: string) => void;
  errors?: DiagnosticItem[];
  warnings?: DiagnosticItem[];
  jumpToLine?: number | null;
  engine?: 'latex' | 'typst';
  activeFilePath?: string | null;
  readOnly?: boolean;
  documentId?: string;
  isScratchpad?: boolean;
  canAddPackages?: boolean;
  onWritingBridgeChange?: (bridge: WritingEditorBridge | null, state: WritingEditorState, releasedBridge?: WritingEditorBridge) => void;
}

export const EditorView: React.FC<EditorViewProps> = ({
  value,
  onChange,
  errors = [],
  warnings = [],
  jumpToLine,
  engine = 'latex',
  activeFilePath,
  readOnly = false,
  documentId = activeFilePath || 'scratchpad',
  isScratchpad = false,
  canAddPackages = false,
  onWritingBridgeChange,
}) => {
  const { monacoTheme } = useTheme();
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monacoType.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const lintTimerRef = useRef<number | null>(null);
  const previousValueRef = useRef(value);
  const latestValueRef = useRef(value);
  const preReloadValueRef = useRef(value);
  const editorViewStateRef = useRef<monacoType.editor.ICodeEditorViewState | null>(null);
  const frozenViewStateRef = useRef<monacoType.editor.ICodeEditorViewState | null>(null);
  const awaitingExternalContentRef = useRef(false);
  const readOnlyRef = useRef(readOnly);
  const restoreFrameRef = useRef<number | null>(null);
  const clearViewStateFrameRef = useRef<number | null>(null);
  const viewStateListenersRef = useRef<monacoType.IDisposable[]>([]);
  const writingBridgeRef = useRef<WritingEditorBridge | null>(null);
  const clipboardCommandRef = useRef<monacoType.IDisposable | null>(null);
  const writingListenersRef = useRef<monacoType.IDisposable[]>([]);
  const writingStateRef = useRef<WritingEditorState>({ language: engine, editable: false, available: false, reason: 'Writing tools are unavailable.', source: value, cursorOffset: 0, canAddPackages: false });
  const writingPropsRef = useRef({ engine, activeFilePath, canAddPackages, onWritingBridgeChange, documentId, isScratchpad });
  const writingContextKey = `${engine}\u0000${documentId}\u0000${activeFilePath ?? ''}\u0000${isScratchpad}\u0000${readOnly}`;
  const writingContextKeyRef = useRef(writingContextKey);
  const writingContextRevisionRef = useRef(0);
  if (writingContextKeyRef.current !== writingContextKey) {
    writingContextKeyRef.current = writingContextKey;
    writingContextRevisionRef.current += 1;
  }
  writingPropsRef.current = { engine, activeFilePath, canAddPackages, onWritingBridgeChange, documentId, isScratchpad };
  readOnlyRef.current = readOnly;
  latestValueRef.current = value;
  const cloneViewState = (state: monacoType.editor.ICodeEditorViewState | null) => state ? structuredClone(state) : null;

  // Active section tracking (requires explicit click-to-activate)
  const [isEditorActive, setIsEditorActive] = useState<boolean>(false);
  const isEditorActiveRef = useRef<boolean>(false);

  useEffect(() => {
    isEditorActiveRef.current = isEditorActive;
  }, [isEditorActive]);

  useEffect(() => {
    const handleGlobalMouseDown = (e: MouseEvent) => {
      if (editorContainerRef.current && editorContainerRef.current.contains(e.target as Node)) {
        setIsEditorActive(true);
      } else {
        setIsEditorActive(false);
      }
    };

    window.addEventListener('mousedown', handleGlobalMouseDown);
    return () => {
      window.removeEventListener('mousedown', handleGlobalMouseDown);
    };
  }, []);

  // Bounded code font size state (10px to 28px, default 14px)
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem('sciencebatch:editor-font-size');
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= 10 && parsed <= 28) {
        return parsed;
      }
    }
    return 14;
  });

  const updateFontSize = useCallback((updater: (prev: number) => number) => {
    setFontSize((prev: number) => {
      const next = Math.min(28, Math.max(10, updater(prev)));
      if (next !== prev) {
        localStorage.setItem('sciencebatch:editor-font-size', String(next));
        if (editorRef.current) {
          editorRef.current.updateOptions({ fontSize: next });
        }
      }
      return next;
    });
  }, []);

  // Global safeguard: intercept window.open calls to open external URLs in the OS default browser
  useEffect(() => {
    const originalOpen = window.open;
    window.open = (url?: string | URL, target?: string, features?: string) => {
      if (url) {
        const urlStr = url.toString();
        if (/^https?:\/\//i.test(urlStr) || /^mailto:/i.test(urlStr)) {
          invoke('open_external_url', { url: urlStr }).catch((err) => {
            console.error('Failed to open URL via window.open safeguard:', err);
          });
          return null;
        }
      }
      return originalOpen ? originalOpen.call(window, url, target, features) : null;
    };

    return () => {
      window.open = originalOpen;
    };
  }, []);

  // Publish compiler diagnostics (red/yellow wavy underlines)
  const syncCompilerMarkers = useCallback(() => {
    if (!editorRef.current || !monacoRef.current) return;
    const model = editorRef.current.getModel();
    if (!model) return;

    const markers: monacoType.editor.IMarkerData[] = [];

    const isMatchingFile = (itemFile?: string | null) => {
      if (!itemFile) return true;
      if (!activeFilePath) return true;
      const cleanItem = itemFile.replace(/^\.\//, '');
      const cleanActive = activeFilePath.replace(/^\.\//, '');
      return cleanActive.endsWith(cleanItem) || cleanActive === cleanItem;
    };

    // Map compiler errors to red wavy underlines
    errors.forEach((err) => {
      if (!isMatchingFile(err.file)) {
        return;
      }
      if (!err.line || err.line < 1 || err.line > model.getLineCount()) {
        return;
      }
      const lineNum = err.line;
      const lineContent = model.getLineContent(lineNum);
      if (lineContent.trim().startsWith('%') || lineContent.trim().length === 0) {
        return;
      }
      const maxCol = model.getLineMaxColumn(lineNum);
      const tipText = err.suggestion ? `\n\nSuggested Fix: ${err.suggestion}` : '';

      markers.push({
        severity: monacoRef.current!.MarkerSeverity.Error,
        message: `${err.message}${tipText}`,
        startLineNumber: lineNum,
        startColumn: 1,
        endLineNumber: lineNum,
        endColumn: maxCol,
      });
    });

    // Map compiler warnings to yellow wavy underlines
    warnings.forEach((warn) => {
      if (!isMatchingFile(warn.file)) {
        return;
      }
      if (!warn.line || warn.line < 1 || warn.line > model.getLineCount()) {
        return;
      }
      const lineNum = warn.line;
      const lineContent = model.getLineContent(lineNum);
      if (lineContent.trim().startsWith('%') || lineContent.trim().length === 0) {
        return;
      }
      const maxCol = model.getLineMaxColumn(lineNum);
      const tipText = warn.suggestion ? `\n\nSuggested Fix: ${warn.suggestion}` : '';

      markers.push({
        severity: monacoRef.current!.MarkerSeverity.Warning,
        message: `${warn.message}${tipText}`,
        startLineNumber: lineNum,
        startColumn: 1,
        endLineNumber: lineNum,
        endColumn: maxCol,
      });
    });

    // Set markers on the compiler marker owner
    monacoRef.current.editor.setModelMarkers(model, 'sciencebatch-compiler', markers);
  }, [errors, warnings, activeFilePath]);

  // Sync compiler markers when errors or warnings change
  useEffect(() => {
    syncCompilerMarkers();
  }, [syncCompilerMarkers]);

  // Trigger real-time linting when engine is latex or clear when switched to typst
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;
    const model = editorRef.current.getModel();
    if (!model) return;

    if (engine === 'latex') {
      lintLatexDocument(model, monacoRef.current);
    } else {
      // Clear LaTeX heuristic linter markers when viewing Typst
      monacoRef.current.editor.setModelMarkers(model, 'latex-realtime-linter', []);
    }
  }, [engine]);

  // Jump to specific line when user clicks an error card badge
  useEffect(() => {
    if (jumpToLine && editorRef.current) {
      editorRef.current.revealLineInCenter(jumpToLine);
      editorRef.current.setPosition({ lineNumber: jumpToLine, column: 1 });
      editorRef.current.focus();
    }
  }, [jumpToLine]);

  const editorLanguage = activeFilePath?.endsWith('.bib')
    ? 'bibtex'
    : (activeFilePath?.endsWith('.typ') || (!activeFilePath && engine === 'typst')
      ? 'typst'
      : 'latex');

  const handleEditorBeforeMount: BeforeMount = (monaco) => {
    registerMonacoCustomThemes(monaco);
    registerLatexLanguage(monaco);
    registerLatexCodeActions(monaco);
    registerTypstLanguageSupport(monaco);
    registerBibtexLanguage(monaco);
  };

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    clipboardCommandRef.current?.dispose();
    editorRef.current = editor;
    monacoRef.current = monaco;
    clipboardCommandRef.current = registerEditorClipboardCopy(monaco, editor);
    const writingBridge = createWritingEditorBridge(editor, monaco, {
      documentId: writingPropsRef.current.documentId,
      getDocumentId: () => writingPropsRef.current.documentId,
      getLanguage: () => writingPropsRef.current.engine,
      getContextRevision: () => writingContextRevisionRef.current,
      isEditable: () => {
        const currentProps = writingPropsRef.current;
        const model = editor.getModel();
        const eligibleLanguage = eligibleWritingLanguage(currentProps.engine, currentProps.activeFilePath, currentProps.isScratchpad);
        return !readOnlyRef.current
          && editorRef.current === editor
          && eligibleLanguage !== null
          && model !== null
          && !model.isDisposed();
      },
    });
    writingBridgeRef.current = writingBridge;
    const publishWritingState = () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      const source = model?.getValue() ?? latestValueRef.current;
      const cursorOffset = model && position ? model.getOffsetAt(position) : 0;
      const currentProps = writingPropsRef.current;
      const eligibleLanguage = eligibleWritingLanguage(currentProps.engine, currentProps.activeFilePath, currentProps.isScratchpad);
      const hasMultipleSelections = (editor.getSelections()?.length ?? 0) > 1;
      const state = buildWritingEditorState({
        language: currentProps.engine,
        eligibleLanguage,
        source,
        cursorOffset,
        canAddPackages: currentProps.canAddPackages,
        readOnly: readOnlyRef.current,
        hasMultipleSelections,
      });
      writingStateRef.current = state;
      currentProps.onWritingBridgeChange?.(writingBridge, state);
    };
    writingListenersRef.current = [
      editor.onDidChangeCursorSelection(publishWritingState),
      editor.onDidChangeModelContent(publishWritingState),
    ];
    const saveViewState = () => {
      if (readOnlyRef.current || frozenViewStateRef.current) return;
      editorViewStateRef.current = cloneViewState(editor.saveViewState());
    };
    const restoreAfterExternalContent = () => {
      const model = editor.getModel();
      if (!awaitingExternalContentRef.current || !model || !frozenViewStateRef.current) return;
      if (model.getValue() === preReloadValueRef.current || model.getValue() !== latestValueRef.current) return;
      const viewState = frozenViewStateRef.current;
      if (restoreFrameRef.current !== null) cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = requestAnimationFrame(() => {
        restoreFrameRef.current = null;
        if (editorRef.current !== editor || editor.getModel()?.getValue() !== latestValueRef.current) return;
        editor.restoreViewState(viewState);
        editorViewStateRef.current = viewState;
        awaitingExternalContentRef.current = false;
        frozenViewStateRef.current = null;
        if (clearViewStateFrameRef.current !== null) cancelAnimationFrame(clearViewStateFrameRef.current);
        clearViewStateFrameRef.current = null;
      });
    };
    viewStateListenersRef.current = [
      editor.onDidChangeCursorSelection(saveViewState),
      editor.onDidScrollChange(saveViewState),
      editor.onDidChangeModelContent(restoreAfterExternalContent),
    ].filter((listener): listener is monacoType.IDisposable => Boolean(listener));
    saveViewState();

    // Register custom themes
    registerMonacoCustomThemes(monaco);

    // Register languages & completion
    registerLatexLanguage(monaco);
    registerLatexLanguageSupport(monaco);
    registerLatexCodeActions(monaco);
    registerTypstLanguageSupport(monaco);
    registerTypstCompletion(monaco);
    registerBibtexLanguage(monaco);

    const model = editor.getModel();
    if (model) {
      // Explicitly enforce the correct language on initial mount
      monaco.editor.setModelLanguage(model, editorLanguage);

      if (engine === 'latex') {
        lintLatexDocument(model, monaco);
      }
      syncCompilerMarkers();
    }
    publishWritingState();

    // Register external link opener for Monaco's link detector (handles Ctrl + Click and "Follow link")
    const linkDetector = (editor as any).getContribution('editor.linkDetector');
    if (linkDetector && linkDetector.openerService) {
      linkDetector.openerService.registerOpener({
        open: async (target: any) => {
          try {
            const urlStr = typeof target === 'string'
              ? target
              : (target?.toString ? target.toString() : String(target));
            if (/^https?:\/\//i.test(urlStr) || /^mailto:/i.test(urlStr)) {
              await invoke('open_external_url', { url: urlStr });
              return true;
            }
          } catch (err) {
            console.error('Failed to open external link in system browser:', err);
          }
          return false;
        },
      });
    }

    // Register IDE shortcuts inside Monaco so focus never swallows them
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => {
      window.dispatchEvent(new CustomEvent('sciencebatch:toggle-sidebar'));
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => {
      window.dispatchEvent(new CustomEvent('sciencebatch:open-search'));
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => {
      window.dispatchEvent(new CustomEvent('sciencebatch:close-active-tab'));
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyW, () => {
      window.dispatchEvent(new CustomEvent('sciencebatch:close-unpinned-tabs'));
    });

    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Digit1, () => {
      window.dispatchEvent(new CustomEvent('sciencebatch:open-files'));
    });

    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Digit7, () => {
      window.dispatchEvent(new CustomEvent('sciencebatch:open-outline'));
    });

    // Editor font zoom commands (Ctrl/Cmd + =, Ctrl/Cmd + -, Ctrl/Cmd + 0)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Equal, () => {
      updateFontSize((prev) => prev + 1);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Minus, () => {
      updateFontSize((prev) => prev - 1);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit0, () => {
      updateFontSize(() => 14);
    });

    editor.onDidFocusEditorWidget(() => {
      setIsEditorActive(true);
    });

    editor.focus();
  };

  // Keep Monaco model language in sync when editorLanguage changes (e.g. engine switch or file selection)
  useEffect(() => {
    if (editorRef.current && monacoRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        const currentLang = model.getLanguageId();
        if (currentLang !== editorLanguage) {
          monacoRef.current.editor.setModelLanguage(model, editorLanguage);
        }
      }
    }
  }, [editorLanguage]);

  useLayoutEffect(() => {
    if (readOnly && !frozenViewStateRef.current) {
      frozenViewStateRef.current = cloneViewState(editorRef.current?.saveViewState() ?? editorViewStateRef.current);
      preReloadValueRef.current = value;
      awaitingExternalContentRef.current = true;
    } else if (!readOnly && frozenViewStateRef.current) {
      if (clearViewStateFrameRef.current !== null) cancelAnimationFrame(clearViewStateFrameRef.current);
      clearViewStateFrameRef.current = requestAnimationFrame(() => {
        clearViewStateFrameRef.current = null;
        if (!readOnlyRef.current && latestValueRef.current === preReloadValueRef.current) {
          awaitingExternalContentRef.current = false;
          frozenViewStateRef.current = null;
        }
      });
    }
  }, [readOnly, value]);

  useEffect(() => {
    const changed = previousValueRef.current !== value;
    previousValueRef.current = value;
    if (changed && awaitingExternalContentRef.current && value !== preReloadValueRef.current && clearViewStateFrameRef.current !== null) {
      cancelAnimationFrame(clearViewStateFrameRef.current);
      clearViewStateFrameRef.current = null;
    }
  }, [value]);

  useEffect(() => () => {
    viewStateListenersRef.current.forEach(listener => listener.dispose());
    writingListenersRef.current.forEach(listener => listener.dispose());
    const bridge = writingBridgeRef.current;
    if (bridge) writingPropsRef.current.onWritingBridgeChange?.(null, writingStateRef.current, bridge);
    writingBridgeRef.current = null;
    if (restoreFrameRef.current !== null) cancelAnimationFrame(restoreFrameRef.current);
    if (clearViewStateFrameRef.current !== null) cancelAnimationFrame(clearViewStateFrameRef.current);
  }, []);

  useEffect(() => () => {
    clipboardCommandRef.current?.dispose();
    clipboardCommandRef.current = null;
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const position = editor.getPosition();
    const source = model.getValue();
    const cursorOffset = position ? model.getOffsetAt(position) : 0;
    const eligibleLanguage = eligibleWritingLanguage(engine, activeFilePath, isScratchpad);
    const hasMultipleSelections = (editor.getSelections()?.length ?? 0) > 1;
    const state = buildWritingEditorState({
      language: engine,
      eligibleLanguage,
      source,
      cursorOffset,
      canAddPackages,
      readOnly,
      hasMultipleSelections,
    });
    writingStateRef.current = state;
    const bridge = writingBridgeRef.current;
    if (bridge) onWritingBridgeChange?.(bridge, state);
  }, [activeFilePath, canAddPackages, engine, isScratchpad, onWritingBridgeChange, readOnly]);

  const handleEditorChange = (val: string | undefined) => {
    if (readOnlyRef.current) return;
    const text = val || '';
    onChange(text);

    // Run debounced linter if editing LaTeX
    if (editorLanguage === 'latex') {
      if (lintTimerRef.current) {
        window.clearTimeout(lintTimerRef.current);
      }

      lintTimerRef.current = window.setTimeout(() => {
        if (editorRef.current && monacoRef.current) {
          const model = editorRef.current.getModel();
          if (model) {
            lintLatexDocument(model, monacoRef.current);
          }
        }
      }, 400);
    }
  };

  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.updateOptions({ readOnly });
  }, [readOnly]);

  // Throttled Ctrl+Wheel listener for bounded code font zoom (10px to 28px)
  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container) return;

    let animationFrameId: number | null = null;

    const handleEditorWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();

      // Require active click/focus inside editor to zoom font
      const editor = editorRef.current;
      const isFocused = editor?.hasWidgetFocus() || isEditorActiveRef.current;
      if (!isFocused) {
        return;
      }

      if (animationFrameId !== null) return;

      const delta = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
      if (Math.abs(delta) < 2) return;

      animationFrameId = requestAnimationFrame(() => {
        animationFrameId = null;
        // Inverted to match natural touchpad scroll ergonomics: forward/up (delta > 0) zooms in, backward/down (delta < 0) zooms out
        if (delta > 0) {
          updateFontSize((prev) => prev + 1);
        } else {
          updateFontSize((prev) => prev - 1);
        }
      });
    };

    container.addEventListener('wheel', handleEditorWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleEditorWheel);
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [updateFontSize]);

  return (
    <div ref={editorContainerRef} className="editor-container">
      <Editor
        height="100%"
        path={activeFilePath || (engine === 'typst' ? 'main.typ' : 'main.tex')}
        defaultLanguage={editorLanguage}
        language={editorLanguage}
        theme={monacoTheme}
        value={value}
        onChange={handleEditorChange}
        beforeMount={handleEditorBeforeMount}
        onMount={handleEditorDidMount}
        options={{
          readOnly,
          fontSize: fontSize,
          mouseWheelZoom: false,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
          fontLigatures: true,
          fixedOverflowWidgets: true,
          links: true,
          hover: {
            enabled: true,
            delay: 300,
            sticky: true,
          },
          minimap: {
            enabled: true,
            side: 'right',
            maxColumn: 80,
          },
          lineNumbers: 'on',
          roundedSelection: false,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          insertSpaces: true,
          wordWrap: 'on',
          bracketPairColorization: {
            enabled: true,
          },
          wordBasedSuggestions: 'off',
          snippetSuggestions: 'inline',
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: 'on',
          tabCompletion: 'on',
          suggest: {
            showKeywords: true,
            showSnippets: true,
            showFunctions: true,
            showReferences: true,
            showWords: false,
            preview: true,
            filterGraceful: true,
            localityBonus: true,
            shareSuggestSelections: true,
            showStatusBar: true,
          },
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          renderLineHighlight: 'all',
          overviewRulerBorder: false,
          glyphMargin: true,
          lightbulb: {
            enabled: 'on' as any,
          },
        }}
      />
    </div>
  );
};
