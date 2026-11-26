import { MONACO_ES_MESSAGES } from './monacoEsDictionary';

const LANGUAGE_STORAGE_KEY = 'sciencebatch:language';

export interface ILocalizedString {
  value: string;
  original: string;
}

/**
 * Resolves the active Monaco NLS language (`'es'` or `'en'`) from persisted
 * app preferences, falling back to `navigator.language`. Safe in DOM, Web
 * Worker (`editor.worker`), and Node/SSR contexts.
 */
export function getNLSLanguage(): 'es' | 'en' {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (saved) {
        return saved.toLowerCase().startsWith('es') ? 'es' : 'en';
      }
    }
  } catch {
    // Ignore storage access errors in Web Workers or restricted contexts.
  }

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
      return navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en';
    }
  } catch {
    // Ignore navigator access errors.
  }

  return 'en';
}

/**
 * Returns the global VS Code / Monaco NLS message table when populated.
 */
export function getNLSMessages(): string[] | undefined {
  return (globalThis as { _VSCODE_NLS_MESSAGES?: string[] })._VSCODE_NLS_MESSAGES;
}

function _format(message: string, args: unknown[]): string {
  if (args.length === 0) {
    return message;
  }

  return message.replace(/\{(\d+)\}/g, (match, indexStr: string) => {
    const index = Number(indexStr);
    const arg = args[index];
    if (typeof arg === 'string') {
      return arg;
    }
    if (
      typeof arg === 'number' ||
      typeof arg === 'boolean' ||
      arg === undefined ||
      arg === null
    ) {
      return String(arg);
    }
    return match;
  });
}

function lookupMessage(index: number, fallback: string | null | undefined): string {
  const message = getNLSMessages()?.[index];
  if (typeof message === 'string') {
    return message;
  }
  if (typeof fallback === 'string') {
    return fallback;
  }
  throw new Error(`!!! NLS MISSING: ${index} !!!`);
}

function translateMessage(base: string): string {
  if (getNLSLanguage() === 'es') {
    return MONACO_ES_MESSAGES[base] ?? base;
  }
  return base;
}

/**
 * Drop-in replacement for `monaco-editor/esm/vs/nls.js#localize`.
 */
export function localize(
  data: unknown,
  message: string | null | undefined,
  ...args: unknown[]
): string {
  const base = typeof data === 'number' ? lookupMessage(data, message) : (message ?? '');
  return _format(translateMessage(base), args);
}

/**
 * Drop-in replacement for `monaco-editor/esm/vs/nls.js#localize2`.
 */
export function localize2(
  data: unknown,
  originalMessage: string,
  ...args: unknown[]
): ILocalizedString {
  const base = typeof data === 'number' ? lookupMessage(data, originalMessage) : originalMessage;
  const localized = translateMessage(base);
  const value = _format(localized, args);
  return {
    value,
    original: originalMessage === localized ? value : _format(originalMessage, args),
  };
}
