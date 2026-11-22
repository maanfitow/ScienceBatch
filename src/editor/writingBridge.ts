import type * as monaco from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';
import type { WritingChange, WritingEditorBridge, WritingLanguage, WritingSession } from '../types/writing';

export interface WritingBridgeEnvironment {
  documentId: string;
  getDocumentId?: () => string;
  getLanguage?: () => WritingLanguage;
  getContextRevision?: () => number;
  isEditable: () => boolean;
}

/** Creates a bridge bound to one mounted editor, model, and workspace document. */
export function createWritingEditorBridge(
  editor: monaco.editor.IStandaloneCodeEditor,
  monacoApi: Monaco,
  environment: WritingBridgeEnvironment,
): WritingEditorBridge {
  // URI identifies a document location, while model.id distinguishes disposed and recreated instances at that URI.
  const modelIdFor = (model: monaco.editor.ITextModel) => `${model.uri.toString()}::${model.id}`;
  const documentId = () => environment.getDocumentId?.() ?? environment.documentId;
  const language = () => environment.getLanguage?.() ?? 'latex';
  const contextRevision = () => environment.getContextRevision?.() ?? 0;
  const offsetAt = (model: monaco.editor.ITextModel, lineNumber: number, column: number) =>
    model.getOffsetAt({ lineNumber, column });

  const capture = (): WritingSession | null => {
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection || !environment.isEditable() || (editor.getSelections()?.length ?? 0) > 1) return null;
    const anchor = offsetAt(model, selection.selectionStartLineNumber, selection.selectionStartColumn);
    const active = offsetAt(model, selection.positionLineNumber, selection.positionColumn);
    return {
      documentId: documentId(),
      modelId: modelIdFor(model),
      language: language(),
      contextRevision: contextRevision(),
      version: model.getVersionId(),
      source: model.getValue(),
      start: Math.min(anchor, active),
      end: Math.max(anchor, active),
      anchor,
      active,
      scrollTop: editor.getScrollTop(),
      scrollLeft: editor.getScrollLeft(),
    };
  };

  const isCurrent = (session: WritingSession): boolean => {
    const model = editor.getModel();
    return Boolean(
      (editor.getSelections()?.length ?? 0) <= 1
      && environment.isEditable()
      && model
      && editor.getValue() === session.source
      && model.getVersionId() === session.version
      && modelIdFor(model) === session.modelId
      && documentId() === session.documentId
      && language() === session.language
      && contextRevision() === session.contextRevision,
    );
  };

  const setOffsetSelection = (model: monaco.editor.ITextModel, anchor: number, active: number) => {
    const anchorPosition = model.getPositionAt(Math.max(0, Math.min(model.getValueLength(), anchor)));
    const activePosition = model.getPositionAt(Math.max(0, Math.min(model.getValueLength(), active)));
    editor.setSelection(new monacoApi.Selection(
      anchorPosition.lineNumber,
      anchorPosition.column,
      activePosition.lineNumber,
      activePosition.column,
    ));
  };

  const apply = (session: WritingSession, change: WritingChange): WritingSession | null => {
    if (!isCurrent(session)) return null;
    const model = editor.getModel();
    if (!model || change.start < 0 || change.end < change.start || change.end > model.getValueLength()) return null;

    // Monaco captures this directional selection as the pre-edit state for Undo.
    setOffsetSelection(model, session.anchor, session.active);
    editor.pushUndoStop();
    const range = rangeFromOffsets(model, change.start, change.end, monacoApi);
    const caret = change.start + change.text.length;
    const nextAnchor = change.selection?.anchor ?? caret;
    const nextActive = change.selection?.active ?? caret;
    const applied = editor.executeEdits(
      'sciencebatch-writing-ribbon',
      [{ range, text: change.text, forceMoveMarkers: true }],
      () => {
        const boundedAnchor = Math.max(0, Math.min(model.getValueLength(), nextAnchor));
        const boundedActive = Math.max(0, Math.min(model.getValueLength(), nextActive));
        const anchorPosition = model.getPositionAt(boundedAnchor);
        const activePosition = model.getPositionAt(boundedActive);
        return [new monacoApi.Selection(anchorPosition.lineNumber, anchorPosition.column, activePosition.lineNumber, activePosition.column)];
      },
    );
    if (!applied) return null;
    editor.pushUndoStop();

    setOffsetSelection(model, nextAnchor, nextActive);
    editor.focus();
    return capture();
  };

  const restore = (session: WritingSession) => {
    if (!isCurrent(session)) return;
    const model = editor.getModel();
    if (!model || modelIdFor(model) !== session.modelId) return;
    setOffsetSelection(model, session.anchor, session.active);
    editor.setScrollPosition({ scrollTop: session.scrollTop, scrollLeft: session.scrollLeft });
    editor.focus();
  };

  return { capture, isCurrent, apply, restore };
}

function rangeFromOffsets(model: monaco.editor.ITextModel, start: number, end: number, monacoApi: Monaco): monaco.Range {
  const startPosition = model.getPositionAt(start);
  const endPosition = model.getPositionAt(end);
  return new monacoApi.Range(startPosition.lineNumber, startPosition.column, endPosition.lineNumber, endPosition.column);
}
