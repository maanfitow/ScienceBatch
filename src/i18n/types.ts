import 'i18next';
import type { enResources } from './index';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: typeof enResources;
  }
}
