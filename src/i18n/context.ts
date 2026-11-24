import { createContext } from "react";

import type { Language, Translate } from "./core";

export interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translate;
  /** Translates `value` when it is a message key, otherwise returns it unchanged. */
  tx: (value: string | null | undefined) => string;
}

export const I18nContext = createContext<I18nContextValue | null>(null);
