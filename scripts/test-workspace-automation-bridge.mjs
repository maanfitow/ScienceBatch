import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const bridgeSource = await readFile(new URL('../src/editor/workspaceAutomationBridge.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(bridgeSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createWorkspaceAutomationBridge, validateWorkspaceEdit } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

class Position { constructor(lineNumber, column) { this.lineNumber = lineNumber; this.column = column; } }
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

const model = {
  value: 'alpha beta',
  version: 1,
  getValue() { return this.value; },
  getValueLength() { return this.value.length; },
  getVersionId() { return this.version; },
  getPositionAt(offset) { return new Position(1, offset + 1); },
  getOffsetAt(position) { return position.column - 1; },
  isDisposed() { return false; },
};
let revision = 0;
let documentId = 'source:main.tex';
let source = model.value;
let editable = true;
let selections = [new Selection(1, 1, 1, 6)];
let scroll = { scrollTop: 54, scrollLeft: 9 };
const undo = [];
const redo = [];
const editor = {
  getModel: () => model,
  getSelections: () => selections,
  getScrollTop: () => scroll.scrollTop,
  getScrollLeft: () => scroll.scrollLeft,
  executeEdits(_source, edits, endState) {
    const edit = edits[0];
    const start = edit.range.selectionStartColumn - 1;
    const end = edit.range.positionColumn - 1;
    const before = model.value;
    const beforeSelection = selections;
    model.value = `${model.value.slice(0, start)}${edit.text}${model.value.slice(end)}`;
    model.version += 1;
    source = model.value;
    revision += 1;
    selections = endState();
    undo.push({ before, after: model.value, beforeSelection, afterSelection: selections });
    return true;
  },
  pushUndoStop() {},
  setScrollPosition(value) { scroll = value; },
  trigger(_source, command) {
    if (command === 'undo') {
      const edit = undo.pop();
      if (!edit) return;
      model.value = edit.before;
      model.version += 1;
      source = model.value;
      revision += 1;
      selections = edit.beforeSelection;
      redo.push(edit);
    }
    if (command === 'redo') {
      const edit = redo.pop();
      if (!edit) return;
      model.value = edit.after;
      model.version += 1;
      source = model.value;
      revision += 1;
      selections = edit.afterSelection;
      undo.push(edit);
    }
  },
};
const monaco = { Range, Selection };
const bridge = createWorkspaceAutomationBridge(editor, monaco, {
  getDocumentId: () => documentId,
  getRevision: () => revision,
  getSource: () => source,
  isEditable: () => editable,
  setReadOnly: value => { editable = !value; },
});

const startingSelection = selections;
const updated = bridge.apply({ documentId, expectedRevision: 0, start: 6, end: 10, text: 'gamma' });
assert.equal(model.value, 'alpha gamma');
assert.equal(updated, 1, 'the shared app revision is returned after the Monaco edit');
assert.deepEqual(scroll, { scrollTop: 54, scrollLeft: 9 }, 'edit preserves editor scroll position');
assert.deepEqual(selections, startingSelection, 'the selection is preserved across an edit outside the selection');
bridge.undo();
assert.equal(model.value, 'alpha beta', 'one Undo reverses the complete external edit');
assert.equal(revision, 2, 'Undo advances the same document revision');
bridge.redo();
assert.equal(model.value, 'alpha gamma', 'Redo restores the complete external edit');
assert.equal(revision, 3, 'Redo advances the same document revision');
assert.equal(bridge.apply({ documentId, expectedRevision: 1, start: 0, end: 5, text: 'stale' }), null, 'stale revisions are rejected');
documentId = 'source:other.tex';
assert.equal(bridge.apply({ documentId: 'source:main.tex', expectedRevision: 3, start: 0, end: 5, text: 'bad' }), null, 'a switched document is rejected');
documentId = 'source:main.tex';
editable = false;
assert.equal(bridge.apply({ documentId, expectedRevision: 3, start: 0, end: 5, text: 'locked' }), null, 'Git lock state rejects a live edit');
const beforeFrozenUndo = model.value;
bridge.setReadOnly(true);
bridge.undo();
assert.equal(model.value, beforeFrozenUndo, 'Undo cannot mutate the workspace during an export freeze');
bridge.setReadOnly(false);
assert.equal(validateWorkspaceEdit('A😀B', 2, 2, 'x'), 'range.splits_surrogate', 'UTF-16 offsets cannot split a Unicode scalar');
assert.equal(validateWorkspaceEdit('A😀B', 1, 3, 'é'), null, 'Unicode edits preserve scalar boundaries');
assert.equal(validateWorkspaceEdit('A', 1, 1, '\ud800'), 'text.invalid_unicode', 'unpaired replacement surrogates are rejected');
assert.equal(validateWorkspaceEdit('A'.repeat(8 * 1024 * 1024), 0, 0, 'B'), 'document.too_large', 'edited UTF-8 text respects the 8 MiB limit');

console.log('Workspace automation bridge revision, Undo/Redo, and stale-edit checks passed.');
