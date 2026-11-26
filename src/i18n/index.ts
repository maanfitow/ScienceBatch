import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { toast } from 'sonner';

import enCommon from '../locales/en/common.json';
import enMenu from '../locales/en/menu.json';
import enSidebar from '../locales/en/sidebar.json';
import enGit from '../locales/en/git.json';
import enResourcesNs from '../locales/en/resources.json';
import enEditor from '../locales/en/editor.json';
import enErrors from '../locales/en/errors.json';
import enWriting from '../locales/en/writing.json';

import esCommon from '../locales/es/common.json';
import esMenu from '../locales/es/menu.json';
import esSidebar from '../locales/es/sidebar.json';
import esGit from '../locales/es/git.json';
import esResourcesNs from '../locales/es/resources.json';
import esEditor from '../locales/es/editor.json';
import esErrors from '../locales/es/errors.json';
import esWriting from '../locales/es/writing.json';

export const SUPPORTED_LANGUAGES = ['en', 'es'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_STORAGE_KEY = 'sciencebatch:language';

export const enResources = {
  common: enCommon,
  menu: enMenu,
  sidebar: enSidebar,
  git: enGit,
  resources: enResourcesNs,
  editor: enEditor,
  errors: enErrors,
  writing: enWriting,
} as const;

export const esResources = {
  common: esCommon,
  menu: esMenu,
  sidebar: esSidebar,
  git: esGit,
  resources: esResourcesNs,
  editor: esEditor,
  errors: esErrors,
  writing: esWriting,
} as const;

export function normalizeLanguage(raw: string | null | undefined): SupportedLanguage {
  if (!raw) return 'en';
  return raw.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function resolveInitialLanguage(): SupportedLanguage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (saved === 'en' || saved === 'es') {
        return saved;
      }
    }
  } catch {
    // Ignore storage access errors in restricted environments.
  }

  if (typeof navigator !== 'undefined') {
    const candidate = navigator.language || navigator.languages?.[0];
    return normalizeLanguage(candidate);
  }

  return 'en';
}

export function getIntlLocale(language?: string): string {
  return normalizeLanguage(language ?? i18n.language) === 'es' ? 'es-ES' : 'en-US';
}

export function syncDocumentLocale(language: string): void {
  const normalized = normalizeLanguage(language);
  const title = i18n.t('common:appWindowTitle');

  if (typeof document !== 'undefined') {
    document.documentElement.lang = normalized;
    document.title = title;
  }

  try {
    if (isTauri()) {
      void getCurrentWindow().setTitle(title).catch(() => {
        // Ignore in mocked browser Tauri environments without window IPC.
      });
    }
  } catch {
    // Ignore when Tauri window APIs are unavailable.
  }
}

export async function setAppLanguage(language: SupportedLanguage): Promise<void> {
  const previous = normalizeLanguage(i18n.language);
  const normalized = normalizeLanguage(language);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
    }
  } catch {
    // Ignore storage access errors.
  }

  if (i18n.language !== normalized) {
    await i18n.changeLanguage(normalized);
  }
  syncDocumentLocale(normalized);

  if (
    previous !== normalized &&
    typeof window !== 'undefined' &&
    Boolean((window as { monaco?: unknown }).monaco)
  ) {
    toast.info(i18n.t('menu:language.monacoReloadTitle'), {
      description: i18n.t('menu:language.monacoReloadDesc'),
      duration: 8000,
      action: {
        label: i18n.t('menu:language.reloadNow'),
        onClick: () => window.location.reload(),
      },
    });
  }
}

const initialLanguage = resolveInitialLanguage();

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: enResources,
      es: esResources,
    },
    lng: initialLanguage,
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common', 'menu', 'sidebar', 'git', 'resources', 'editor', 'errors', 'writing'],
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  });

type GlobalTranslator = (
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
) => string;

(globalThis as { __sciencebatchTranslate?: GlobalTranslator }).__sciencebatchTranslate = (
  key,
  fallback,
  params,
) => i18n.t(key as never, { defaultValue: fallback, ...(params ?? {}) } as never) as unknown as string;

i18n.on('languageChanged', (lng) => {
  syncDocumentLocale(lng);
});

syncDocumentLocale(initialLanguage);

export default i18n;
