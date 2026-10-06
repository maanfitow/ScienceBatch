import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const bridgePath = new URL('../src/editor/writingBridge.ts', import.meta.url);
const source = await readFile(bridgePath, 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createWritingEditorBridge } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

class Position {
  constructor(lineNumber, column) { this.lineNumber = lineNumber; this.column = column; }
}
class Selection extends Position {
  constructor(startLine, startColumn, endLine, endColumn) {
    super(endLine, endColumn);
    this.selectionStartLineNumber = startLine;
    this.selectionStartColumn = startColumn;
    this.positionLineNumber = endLine;
    this.positionColumn = endColumn;
  }
}
class Range extends Selection {}
const monacoApi = { Selection, Range };

function createModel({ id = 'model-1', uri = 'file:///main.tex', value = 'abcd', version = 1 } = {}) {
  let current = value;
  let currentVersion = version;
  return {
    id,
    uri: { toString: () => uri },
    getValue: () => current,
    getValueLength: () => current.length,
    getVersionId: () => currentVersion,
    getOffsetAt: ({ column }) => column - 1,
    getPositionAt: (offset) => new Position(1, offset + 1),
    isDisposed: () => false,
    replace(start, end, text) { current = `${current.slice(0, start)}${text}${current.slice(end)}`; currentVersion++; },
    setValue(value) { current = value; currentVersion++; },
  };
}

function createEditor(model, { anchor = 4, active = 1, editable = () => true } = {}) {
  let selections = [new Selection(1, anchor + 1, 1, active + 1)];
  let scrollTop = 20;
  let scrollLeft = 3;
  const stops = [];
  const undoStack = [];
  const redoStack = [];
  let executeEditCount = 0;
  const editor = {
    model,
    getModel: () => editor.model,
    getSelection: () => selections[0] ?? null,
    getSelections: () => selections,
    getValue: () => editor.model?.getValue() ?? '',
    getScrollTop: () => scrollTop,
    getScrollLeft: () => scrollLeft,
    setSelection(selection) { selections = [selection]; },
    setScrollPosition(position) { scrollTop = position.scrollTop; scrollLeft = position.scrollLeft; },
    pushUndoStop() { stops.push(true); },
    executeEdits(_source, edits, endCursorState) {
      executeEditCount++;
      const edit = edits[0];
      const start = edit.range.selectionStartColumn - 1;
      const end = edit.range.positionColumn - 1;
      const before = model.getValue();
      const selectionBefore = selections[0];
      model.replace(start, end, edit.text);
      const cursor = endCursorState();
      editor.setSelection(cursor[0]);
      editor.lastEdit = { before, after: model.getValue(), selectionBefore, selectionAfter: cursor[0] };
      undoStack.push(editor.lastEdit);
      return true;
    },
    undo() {
      const edit = undoStack.pop();
      if (!edit) return;
      model.setValue(edit.before);
      editor.setSelection(edit.selectionBefore);
      redoStack.push(edit);
    },
    redo() {
      const edit = redoStack.pop();
      if (!edit) return;
      model.setValue(edit.after);
      editor.setSelection(edit.selectionAfter);
      undoStack.push(edit);
    },
    focus() { editor.focused = true; },
    isEditable: editable,
    setSelections(value) { selections = value; },
    getExecuteEditCount: () => executeEditCount,
    stops,
  };
  return editor;
}

const environmentFor = (editor, documentId = 'tab:main') => {
  const environment = { documentId, language: 'latex', contextRevision: 0 };
  return {
    environment,
    getDocumentId: () => environment.documentId,
    getLanguage: () => environment.language,
    getContextRevision: () => environment.contextRevision,
    isEditable: () => editor.isEditable() && editor.getModel() !== null && !editor.getModel().isDisposed(),
  };
};

{
  const model = createModel();
  const editor = createEditor(model);
  const bridge = createWritingEditorBridge(editor, monacoApi, environmentFor(editor));
  const session = bridge.capture();
  assert.ok(session);
  assert.equal(session.anchor, 4, 'reverse selection keeps its anchor');
  assert.equal(session.active, 1, 'reverse selection keeps its active end');
  const result = bridge.apply(session, { start: 1, end: 4, text: 'X' });
  assert.ok(result);
  assert.equal(model.getValue(), 'aX');
  assert.deepEqual([editor.lastEdit.selectionBefore.selectionStartColumn, editor.lastEdit.selectionBefore.positionColumn], [5, 2], 'Undo keeps the original reverse selection');
  assert.deepEqual([editor.lastEdit.selectionAfter.selectionStartColumn, editor.lastEdit.selectionAfter.positionColumn], [3, 3], 'Redo receives the post-edit cursor through endCursorState');
  assert.equal(editor.stops.length, 2, 'the edit is bounded by undo stops');
  assert.equal(editor.focused, true);
  editor.undo();
  assert.equal(model.getValue(), 'abcd');
  assert.deepEqual([editor.getSelection().selectionStartColumn, editor.getSelection().positionColumn], [5, 2]);
  editor.redo();
  assert.equal(model.getValue(), 'aX');
  assert.deepEqual([editor.getSelection().selectionStartColumn, editor.getSelection().positionColumn], [3, 3]);
}

{
  const model = createModel();
  const editor = createEditor(model);
  const bridge = createWritingEditorBridge(editor, monacoApi, environmentFor(editor));
  assert.equal(bridge.capture() !== null, true);
  editor.setSelections([new Selection(1, 1, 1, 1), new Selection(1, 2, 1, 2)]);
  assert.equal(bridge.capture(), null, 'multiple selections are rejected');
}

{
  const model = createModel();
  let editable = false;
  const editor = createEditor(model, { editable: () => editable });
  const bridge = createWritingEditorBridge(editor, monacoApi, environmentFor(editor));
  assert.equal(bridge.capture(), null, 'read-only editors cannot capture an edit session');
  editable = true;
  const session = bridge.capture();
  assert.ok(session);
  model.isDisposed = () => true;
  assert.equal(bridge.isCurrent(session), false, 'disposed models invalidate captured sessions');
}

{
  const originalModel = createModel({ id: 'model-old' });
  const editor = createEditor(originalModel);
  const environment = environmentFor(editor);
  const bridge = createWritingEditorBridge(editor, monacoApi, environment);
  const session = bridge.capture();
  assert.ok(session);
  editor.model = createModel({ id: 'model-new' });
  assert.equal(bridge.isCurrent(session), false, 'recreated models at the same URI cannot reuse old sessions');
  assert.equal(bridge.apply(session, { start: 1, end: 4, text: 'X' }), null);
  assert.equal(editor.getExecuteEditCount(), 0, 'a recreated model receives no stale edit');
  assert.equal(editor.getValue(), 'abcd');
  environment.environment.documentId = 'tab:other';
  assert.equal(bridge.apply(session, { start: 1, end: 4, text: 'X' }), null, 'a switched document rejects the captured session');
  assert.equal(editor.getExecuteEditCount(), 0);
  assert.equal(editor.getValue(), 'abcd');
}

{
  const model = createModel();
  const editor = createEditor(model);
  const environment = environmentFor(editor);
  const bridge = createWritingEditorBridge(editor, monacoApi, environment);
  const engineSession = bridge.capture();
  assert.ok(engineSession);
  assert.equal(engineSession.language, 'latex');
  environment.environment.language = 'typst';
  environment.environment.contextRevision++;
  environment.environment.language = 'latex';
  environment.environment.contextRevision++;
  assert.equal(bridge.isCurrent(engineSession), false, 'switching engines away and back permanently invalidates an open session');

  const unlockedSession = bridge.capture();
  assert.ok(unlockedSession);
  let editable = true;
  editor.isEditable = () => editable;
  editable = false;
  environment.environment.contextRevision++;
  editable = true;
  environment.environment.contextRevision++;
  assert.equal(bridge.isCurrent(unlockedSession), false, 'locking and unlocking permanently invalidates an open session');
}

{
  const model = createModel();
  const editor = createEditor(model);
  const bridge = createWritingEditorBridge(editor, monacoApi, environmentFor(editor));
  const session = bridge.capture();
  assert.ok(session);
  model.setValue('changed');
  model.setValue('abcd');
  assert.equal(bridge.isCurrent(session), false, 'restoring identical text does not restore the captured model version');
  assert.equal(bridge.apply(session, { start: 1, end: 4, text: 'X' }), null);
  assert.equal(editor.getExecuteEditCount(), 0, 'a changed and restored model receives no stale edit');
  assert.equal(model.getValue(), 'abcd');
}

{
  let editable = true;
  const model = createModel();
  const editor = createEditor(model, { editable: () => editable });
  const bridge = createWritingEditorBridge(editor, monacoApi, environmentFor(editor));
  const session = bridge.capture();
  assert.ok(session);
  editable = false;
  assert.equal(bridge.isCurrent(session), false, 'a Git lock invalidates an already captured session');
  assert.equal(bridge.apply(session, { start: 1, end: 4, text: 'X' }), null);
  assert.equal(editor.getExecuteEditCount(), 0, 'a newly read-only editor receives no edit');
  assert.equal(model.getValue(), 'abcd');
}

{
  const model = createModel();
  const editor = createEditor(model, { anchor: 4, active: 1 });
  const bridge = createWritingEditorBridge(editor, monacoApi, environmentFor(editor));
  const session = bridge.capture();
  assert.ok(session);
  editor.setSelection(new Selection(1, 2, 1, 2));
  editor.setScrollPosition({ scrollTop: 110, scrollLeft: 18 });
  bridge.restore(session);
  assert.deepEqual([editor.getSelection().selectionStartColumn, editor.getSelection().positionColumn], [5, 2], 'cancel restores the original reverse selection');
  assert.deepEqual([editor.getScrollTop(), editor.getScrollLeft()], [20, 3], 'cancel restores the original scroll position');
  assert.equal(editor.focused, true, 'cancel returns focus to the active editor');
}

console.log('Writing bridge regression checks passed.');
