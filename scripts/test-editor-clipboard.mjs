import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const nativeWrites = [];
const browserWrites = [];
const errors = [];
let nativeFailure;
let tauriEnvironment = true;
let nativeWriteGate = null;
globalThis.__clipboardToast = { error: (title, options) => errors.push({ title, options }) };

const source = await readFile(new URL('../src/editor/editorClipboard.ts', import.meta.url), 'utf8');
let javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
javascript = javascript
  .replace("import { isTauri } from '@tauri-apps/api/core';", 'const isTauri = () => globalThis.__clipboardIsTauri();')
  .replace("import { writeText } from '@tauri-apps/plugin-clipboard-manager';", 'const writeText = (text) => globalThis.__clipboardWriteText(text);')
  .replace("import { toast } from 'sonner';", 'const toast = globalThis.__clipboardToast;');

const clipboardModule = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
globalThis.__clipboardIsTauri = () => tauriEnvironment;
globalThis.__clipboardWriteText = async (text) => {
  if (nativeWriteGate) await nativeWriteGate;
  if (nativeFailure) throw nativeFailure;
  nativeWrites.push(text);
};
globalThis.__clipboardToast = { error: (title, options) => errors.push({ title, options }) };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async (text) => browserWrites.push(text) } },
});

class TestUri {
  constructor(components) { this.components = components; }
  toString() {
    const { scheme, authority = '', path = '', query = '', fragment = '' } = this.components;
    const authorityPart = authority || scheme === 'file' ? `//${authority}` : '';
    return `${scheme}:${authorityPart}${path}${query ? `?${query}` : ''}${fragment ? `#${fragment}` : ''}`;
  }
}
TestUri.from = (components) => new TestUri(components);
TestUri.isUri = (value) => value instanceof TestUri;

const activeRegistrations = new Set();
const registrationHistory = [];
const monaco = {
  Uri: TestUri,
  editor: {
    EditorOption: { emptySelectionClipboard: 'emptySelectionClipboard' },
    registerCommand(id, handler) {
      const registration = { id, handler, disposed: false, disposeCount: 0 };
      activeRegistrations.add(registration);
      registrationHistory.push(registration);
      return {
        dispose() {
          registration.disposeCount++;
          registration.disposed = true;
          activeRegistrations.delete(registration);
        },
      };
    },
  },
};

function model(uri, value = 'alpha beta gamma', eol = '\n') {
  const uriValue = typeof uri === 'string' ? uri : TestUri.from(uri).toString();
  const lines = value.split(eol);
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + eol.length;
  }
  return {
    uri: TestUri.from({ scheme: 'file', path: uriValue.replace(/^file:\/\//, '') }),
    isDisposed: () => false,
    getEOL: () => eol,
    getLineContent: (lineNumber) => lines[lineNumber - 1] ?? '',
    getOffsetAt: (position) => offsets[position.lineNumber - 1] + position.column - 1,
    getValueInRange: (range) => range.text,
  };
}

function selection(startOffset, endOffset, text) {
  const first = Math.min(startOffset, endOffset);
  const last = Math.max(startOffset, endOffset);
  const position = (offset) => ({ lineNumber: 1, column: offset + 1 });
  return {
    text,
    isEmpty: () => startOffset === endOffset,
    getStartPosition: () => position(first),
    getEndPosition: () => position(last),
  };
}

function editor(uri, options = {}) {
  let focused = options.focused ?? true;
  let selections = options.selections ?? [selection(0, 5, 'alpha')];
  const focusListeners = new Set();
  const disposeListeners = new Set();
  const instance = {
    model: model(uri, options.value, options.eol),
    readOnly: options.readOnly ?? false,
    getModel() { return instance.model; },
    hasTextFocus: () => focused,
    setFocus(value) {
      focused = value;
      if (value) for (const listener of focusListeners) listener();
    },
    onDidFocusEditorWidget(listener) {
      focusListeners.add(listener);
      return { dispose: () => focusListeners.delete(listener) };
    },
    onDidDispose(listener) {
      disposeListeners.add(listener);
      return { dispose: () => disposeListeners.delete(listener) };
    },
    disposeEditor() { for (const listener of disposeListeners) listener(); },
    getSelections: () => selections,
    setSelections(value) { selections = value; },
    getSelection: () => selections[0] ?? null,
    getPosition: () => options.position ?? { lineNumber: 1, column: 2 },
    getOption: () => options.emptySelectionClipboard ?? true,
  };
  return instance;
}

function currentCommand() {
  const registration = [...activeRegistrations].at(-1);
  assert.ok(registration, 'a Copy command should be registered while an editor is mounted');
  return registration.handler;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const resetWrites = () => {
  nativeWrites.length = 0;
  browserWrites.length = 0;
  errors.length = 0;
  nativeFailure = undefined;
  nativeWriteGate = null;
  tauriEnvironment = true;
};

{
  resetWrites();
  const current = editor('file:///main.tex', { selections: [selection(0, 5, 'alpha')] });
  const dispose = clipboardModule.registerEditorClipboardCopy(monaco, current);
  const command = currentCommand();
  command({}, current.model.uri);
  await flush();
  assert.deepEqual(nativeWrites, ['alpha'], 'Tauri Copy writes the selected source text through the native clipboard plugin');
  dispose.dispose();
  assert.equal(activeRegistrations.size, 0, 'the global command registration is disposed after the final editor unmounts');
}

{
  resetWrites();
  const current = editor('file:///main.tex', { selections: [selection(0, 5, 'alpha')] });
  const dispose = clipboardModule.registerEditorClipboardCopy(monaco, current);
  tauriEnvironment = false;
  currentCommand()({}, current.model.uri);
  await flush();
  assert.deepEqual(browserWrites, ['alpha'], 'browser Copy uses the browser clipboard fallback');
  dispose.dispose();
}

{
  resetWrites();
  const first = editor('file:///first.tex', { focused: false, selections: [selection(0, 5, 'first')] });
  const surviving = editor('file:///surviving.tex', { selections: [selection(0, 9, 'surviving')] });
  const firstMount = clipboardModule.registerEditorClipboardCopy(monaco, first);
  const survivingMount = clipboardModule.registerEditorClipboardCopy(monaco, surviving);
  const registration = registrationHistory.at(-1);
  assert.equal(activeRegistrations.size, 1, 'multiple mounted editors share one global Monaco command');
  firstMount.dispose();
  assert.equal(registration.disposed, false, 'disposing one editor keeps the command for the mounted editor that remains');
  currentCommand()({}, surviving.model.uri);
  await flush();
  assert.deepEqual(nativeWrites, ['surviving'], 'the surviving editor still copies after another editor unmounts');
  surviving.disposeEditor();
  assert.equal(registration.disposeCount, 1, 'the final editor dispose event unregisters the shared command');
  survivingMount.dispose();
  survivingMount.dispose();
  assert.equal(registration.disposeCount, 1, 'external cleanup after the dispose event remains idempotent');
  assert.equal(activeRegistrations.size, 0);
}

{
  resetWrites();
  const current = editor('file:///main.tex', {
    selections: [selection(14, 8, 'second\r\nthird'), selection(0, 5, 'first')],
    value: 'first\r\nsecond\r\nthird',
    eol: '\r\n',
  });
  const dispose = clipboardModule.registerEditorClipboardCopy(monaco, current);
  currentCommand()({}, current.model.uri);
  await flush();
  assert.deepEqual(nativeWrites, ['first\r\nsecond\r\nthird'], 'reverse, multiline and multiple selections preserve source order and model line endings');
  dispose.dispose();
}

{
  resetWrites();
  const current = editor('file:///main.tex', { selections: [selection(5, 0, 'alpha')] });
  const dispose = clipboardModule.registerEditorClipboardCopy(monaco, current);
  currentCommand()({}, { scheme: 'file', path: '/main.tex' });
  await flush();
  assert.deepEqual(nativeWrites, ['alpha'], 'serialized URI components route to the mounted model without calling Object.toString');
  dispose.dispose();
}

{
  resetWrites();
  const oldTab = editor('file:///old.tex', { focused: false, selections: [selection(0, 3, 'old')] });
  const activeTab = editor('file:///active.tex', { focused: true, selections: [selection(0, 6, 'active')] });
  const disposeOld = clipboardModule.registerEditorClipboardCopy(monaco, oldTab);
  const disposeActive = clipboardModule.registerEditorClipboardCopy(monaco, activeTab);
  currentCommand()({}, { scheme: 'file', path: '/old.tex' });
  await flush();
  assert.deepEqual(nativeWrites, [], 'a URI for an unfocused old tab is never redirected to a different model');
  currentCommand()({}, { scheme: 'file', path: '/active.tex' });
  await flush();
  assert.deepEqual(nativeWrites, ['active'], 'the command URI routes to the active editor model');
  disposeOld.dispose();
  disposeActive.dispose();
}

{
  resetWrites();
  const current = editor('file:///readonly.tex', {
    readOnly: true,
    selections: [selection(0, 4, 'read')],
  });
  const dispose = clipboardModule.registerEditorClipboardCopy(monaco, current);
  currentCommand()({}, current.model.uri);
  await flush();
  assert.deepEqual(nativeWrites, ['read'], 'read-only editor content remains copyable');
  dispose.dispose();
}

{
  resetWrites();
  let releaseWrite;
  nativeWriteGate = new Promise((resolve) => { releaseWrite = resolve; });
  const current = editor('file:///main.tex', { selections: [selection(0, 5, 'alpha')] });
  const dispose = clipboardModule.registerEditorClipboardCopy(monaco, current);
  currentCommand()({}, current.model.uri);
  current.setSelections([selection(6, 10, 'beta')]);
  releaseWrite();
  await flush();
  assert.deepEqual(nativeWrites, ['alpha'], 'selection text is captured before awaiting the clipboard write');
  dispose.dispose();
}

{
  resetWrites();
  const current = editor('file:///main.tex', {
    selections: [selection(0, 0, '')],
    position: { lineNumber: 2, column: 3 },
    value: 'first\nsecond',
    emptySelectionClipboard: true,
  });
  const dispose = clipboardModule.registerEditorClipboardCopy(monaco, current);
  currentCommand()({}, current.model.uri);
  await flush();
  assert.deepEqual(nativeWrites, ['second\n'], 'an empty selection copies the current line when enabled');
  dispose.dispose();
}

{
  resetWrites();
  const current = editor('file:///main.tex', {
    selections: [selection(0, 0, '')],
    position: { lineNumber: 2, column: 3 },
    value: 'first\nsecond',
    emptySelectionClipboard: false,
  });
  const dispose = clipboardModule.registerEditorClipboardCopy(monaco, current);
  currentCommand()({}, current.model.uri);
  await flush();
  assert.deepEqual(nativeWrites, [], 'an empty selection does nothing when empty-line copy is disabled');
  dispose.dispose();
}

{
  resetWrites();
  const current = editor('file:///main.tex', { selections: [selection(0, 5, 'alpha')] });
  const dispose = clipboardModule.registerEditorClipboardCopy(monaco, current);
  nativeFailure = new Error('Clipboard permission denied');
  currentCommand()({}, current.model.uri);
  await flush();
  assert.deepEqual(errors, [{ title: 'Copy failed', options: { description: 'Clipboard permission denied' } }], 'clipboard failures are reported in English');
  dispose.dispose();
}

{
  resetWrites();
  const current = editor('file:///main.tex');
  const dispose = clipboardModule.registerEditorClipboardCopy(monaco, current);
  const command = currentCommand();
  const registration = registrationHistory.at(-1);
  dispose.dispose();
  dispose.dispose();
  assert.equal(activeRegistrations.size, 0, 'disposal is idempotent and removes the registered command exactly once');
  assert.equal(registration.disposeCount, 1, 'the Monaco command registration is disposed once');
  assert.equal(typeof command, 'function', 'the mounted command has a callable handler');
}

console.log('Editor clipboard regression checks passed.');
