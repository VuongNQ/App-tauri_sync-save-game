import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  adoptLanguage,
  getLanguage,
  isLanguage,
  isMessageKey,
  LANGUAGE_STORAGE_KEY,
  persistLanguage,
  translate,
  type Language,
  type Translate,
} from "./core";
import { I18nContext, type I18nContextValue } from "./context";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(getLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // Keep the dashboard and the play-shortcut launcher window in step.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY && isLanguage(event.newValue)) {
        adoptLanguage(event.newValue);
        setLanguageState(event.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setLanguage = useCallback((next: Language) => {
    persistLanguage(next);
    setLanguageState(next);
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const t: Translate = (key, params) => translate(key, params, language);
    const tx = (text: string | null | undefined) => (text ? (isMessageKey(text) ? t(text) : text) : "");
    return { language, setLanguage, t, tx };
  }, [language, setLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
