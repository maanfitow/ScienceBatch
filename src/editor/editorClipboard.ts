import type { Monaco } from '@monaco-editor/react';
import type * as monacoType from 'monaco-editor';
import { isTauri } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { toast } from 'sonner';

interface MountedEditor {
  editor: monacoType.editor.IStandaloneCodeEditor;
  focusListener: monacoType.IDisposable;
  disposeListener: monacoType.IDisposable;
}

const mountedEditors = new Map<number, MountedEditor>();
let nextEditorId = 0;
let lastFocusedEditorId: number | null = null;
let copyCommandRegistration: monacoType.IDisposable | null = null;

function getActiveEditor(expectedModelUri?: string): monacoType.editor.IStandaloneCodeEditor | null {
  for (const [id, mounted] of mountedEditors) {
    const model = mounted.editor.getModel();
    if (model && (!expectedModelUri || model.uri.toString() === expectedModelUri) && mounted.editor.hasTextFocus()) {
      lastFocusedEditorId = id;
      return mounted.editor;
    }
  }

  const lastFocused = lastFocusedEditorId === null ? undefined : mountedEditors.get(lastFocusedEditorId);
  const lastFocusedModel = lastFocused?.editor.getModel();
  if (lastFocused && lastFocusedModel && (!expectedModelUri || lastFocusedModel.uri.toString() === expectedModelUri)) {
    return lastFocused.editor;
  }

  return null;
}

async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) {
    await writeText(text);
    return;
  }

  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard access is unavailable in this browser context.');
  }

  await navigator.clipboard.writeText(text);
}

async function copyEditorSelection(editor: monacoType.editor.IStandaloneCodeEditor, monaco: Monaco): Promise<void> {
  const model = editor.getModel();
  if (!model || model.isDisposed()) return;

  const selections = (editor.getSelections() ?? []).filter((selection) => !selection.isEmpty());
  let text: string;

  if (selections.length > 0) {
    const orderedSelections = [...selections].sort((left, right) => {
      const leftOffset = model.getOffsetAt(left.getStartPosition());
      const rightOffset = model.getOffsetAt(right.getStartPosition());
      return leftOffset - rightOffset;
    });
    text = orderedSelections.map((selection) => model.getValueInRange(selection)).join(model.getEOL());
  } else {
    const copiesLine = editor.getOption(monaco.editor.EditorOption.emptySelectionClipboard);
    const position = editor.getPosition();
    if (!copiesLine || !position) return;
    text = `${model.getLineContent(position.lineNumber)}${model.getEOL()}`;
  }

  try {
    await writeClipboardText(text);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    toast.error('Copy failed', { description: details });
  }
}

function getExpectedModelUri(args: unknown[], monaco: Monaco): string | undefined {
  for (const arg of args) {
    if (monaco.Uri.isUri(arg)) {
      return arg.toString();
    }

    if (typeof arg !== 'object' || arg === null || !('scheme' in arg)) continue;
    const components = arg as Partial<monacoType.UriComponents>;
    if (typeof components.scheme !== 'string') continue;
    if (components.path !== undefined && typeof components.path !== 'string') continue;
    if (components.authority !== undefined && typeof components.authority !== 'string') continue;
    if (components.query !== undefined && typeof components.query !== 'string') continue;
    if (components.fragment !== undefined && typeof components.fragment !== 'string') continue;

    try {
      return monaco.Uri.from(components as monacoType.UriComponents).toString();
    } catch {
      // Ignore malformed command arguments and continue looking for a URI.
    }
  }

  return undefined;
}

export function registerEditorClipboardCopy(
  monaco: Monaco,
  editor: monacoType.editor.IStandaloneCodeEditor,
): monacoType.IDisposable {
  if (copyCommandRegistration === null) {
    copyCommandRegistration = monaco.editor.registerCommand('editor.action.clipboardCopyAction', (_accessor, ...args) => {
      const expectedModelUri = getExpectedModelUri(args, monaco);
      const activeEditor = getActiveEditor(expectedModelUri);
      if (activeEditor) void copyEditorSelection(activeEditor, monaco);
    });
  }

  const id = ++nextEditorId;
  let disposed = false;
  let dispose = () => {};
  const mounted: MountedEditor = {
    editor,
    focusListener: editor.onDidFocusEditorWidget(() => {
      lastFocusedEditorId = id;
    }),
    disposeListener: editor.onDidDispose(() => dispose()),
  };
  mountedEditors.set(id, mounted);
  lastFocusedEditorId = id;

  dispose = () => {
    if (disposed) return;
    disposed = true;
    mounted.focusListener.dispose();
    mounted.disposeListener.dispose();
    mountedEditors.delete(id);
    if (lastFocusedEditorId === id) {
      lastFocusedEditorId = [...mountedEditors.keys()].at(-1) ?? null;
    }
    if (mountedEditors.size === 0) {
      copyCommandRegistration?.dispose();
      copyCommandRegistration = null;
    }
  };

  return { dispose };
}
