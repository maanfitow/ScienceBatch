import type * as monaco from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';
import type { AutomationEditorBridge } from '../types/automation';

const LARGE_DOCUMENT_INTERACTIVE_LIMIT = 1024 * 1024;
const largeDocumentEditorOptions: monaco.editor.IEditorOptions = {
  wordWrap: 'off',
  minimap: { enabled: false },
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  stopRenderingLineAfter: 10000,
};

export interface WorkspaceAutomationEnvironment {
  getDocumentId(): string;
  getRevision(): number;
  getSource(): string;
  isEditable(): boolean;
  setReadOnly(value: boolean): void;
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

export function validateWorkspaceEdit(source: string, start: number, end: number, text: string): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) return 'range.invalid';
  const splitsPair = (offset: number) => offset > 0 && offset < source.length
    && isHighSurrogate(source.charCodeAt(offset - 1)) && isLowSurrogate(source.charCodeAt(offset));
  if (splitsPair(start) || splitsPair(end)) return 'range.splits_surrogate';
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (isHighSurrogate(unit)) {
      if (!isLowSurrogate(text.charCodeAt(index + 1))) return 'text.invalid_unicode';
      index++;
    } else if (isLowSurrogate(unit)) return 'text.invalid_unicode';
  }
  const next = `${source.slice(0, start)}${text}${source.slice(end)}`;
  if (new TextEncoder().encode(next).byteLength > 8 * 1024 * 1024) return 'document.too_large';
  return null;
}

export function createWorkspaceAutomationBridge(
  editor: monaco.editor.IStandaloneCodeEditor,
  monacoApi: Monaco,
  environment: WorkspaceAutomationEnvironment,
): AutomationEditorBridge {
  return {
    getDocumentId: environment.getDocumentId,
    getRevision: environment.getRevision,
    apply: edit => {
      const model = editor.getModel();
      if (!model || model.isDisposed() || !environment.isEditable()
        || edit.documentId !== environment.getDocumentId()
        || edit.expectedRevision !== environment.getRevision()
        || model.getValue() !== environment.getSource()
        || validateWorkspaceEdit(model.getValue(), edit.start, edit.end, edit.text)) return null;

      const selections = editor.getSelections() ?? [];
      const delta = edit.text.length - (edit.end - edit.start);
      const nextLength = model.getValueLength() + delta;
      // Configure Monaco before a large insertion triggers layout/tokenization.
      // React props catch up after the model change, which is too late for a
      // single multi-megabyte workspace edit.
      if (nextLength > LARGE_DOCUMENT_INTERACTIVE_LIMIT) editor.updateOptions(largeDocumentEditorOptions);
      const mapOffset = (offset: number) => offset <= edit.start ? offset : offset >= edit.end ? offset + delta : edit.start + edit.text.length;
      const previous = selections.map(selection => ({
        anchor: model.getOffsetAt({ lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn }),
        active: model.getOffsetAt({ lineNumber: selection.positionLineNumber, column: selection.positionColumn }),
      }));
      const scroll = { scrollTop: editor.getScrollTop(), scrollLeft: editor.getScrollLeft() };
      editor.pushUndoStop();
      const start = model.getPositionAt(edit.start);
      const end = model.getPositionAt(edit.end);
      const applied = editor.executeEdits('sciencebatch-workspace-automation', [{
        range: new monacoApi.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        text: edit.text,
        forceMoveMarkers: true,
      }], () => previous.map(({ anchor, active }) => {
        const nextAnchor = model.getPositionAt(Math.max(0, Math.min(model.getValueLength(), mapOffset(anchor))));
        const nextActive = model.getPositionAt(Math.max(0, Math.min(model.getValueLength(), mapOffset(active))));
        return new monacoApi.Selection(nextAnchor.lineNumber, nextAnchor.column, nextActive.lineNumber, nextActive.column);
      }));
      if (!applied) return null;
      editor.pushUndoStop();
      editor.setScrollPosition(scroll);
      return environment.getRevision();
    },
    undo: () => { if (environment.isEditable()) editor.trigger('sciencebatch-workspace-automation', 'undo', null); },
    redo: () => { if (environment.isEditable()) editor.trigger('sciencebatch-workspace-automation', 'redo', null); },
    setReadOnly: environment.setReadOnly,
  };
}
