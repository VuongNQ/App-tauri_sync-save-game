import { useContext } from "react";

import type { Translate } from "./core";
import { I18nContext, type I18nContextValue } from "./context";

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

/** Shorthand for components that only need the translate function. */
export function useT(): Translate {
  return useI18n().t;
}
