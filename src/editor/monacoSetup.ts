import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

/**
 * Configures Monaco Editor to run completely offline from the local Vite bundle
 * instead of fetching loader assets from a CDN, and exposes `window.monaco`
 * for automated browser regression checks.
 */
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

loader.config({ monaco });

(window as Window & { monaco?: typeof monaco }).monaco ??= monaco;
