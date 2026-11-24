import { createElement, Fragment, type ReactNode } from "react";

import { en, type MessageKey } from "./en";
import { vi } from "./vi";

export type { MessageKey } from "./en";

export type Language = "en" | "vi";

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "vi", label: "Tiếng Việt" },
];

const STORAGE_KEY = "ui.language";

const DICTIONARIES: Record<Language, Record<MessageKey, string>> = { en, vi };

export type TranslateParams = Record<string, string | number>;

export type Translate = (key: MessageKey, params?: TranslateParams) => string;

function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "vi";
}

function readStoredLanguage(): Language | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLanguage(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Saved choice first, then the OS / WebView language, then English. */
function detectLanguage(): Language {
  const stored = readStoredLanguage();
  if (stored) return stored;
  const preferred = typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : [];
  return preferred.some((l) => l?.toLowerCase().startsWith("vi")) ? "vi" : "en";
}

// Module-level copy so plain helpers (formatLocalTime, formatDuration, ...) can
// follow the active language without a hook. The provider keeps it in sync.
let currentLanguage: Language = typeof window !== "undefined" ? detectLanguage() : "en";

export function getLanguage(): Language {
  return currentLanguage;
}

/** Saves the choice for this device and updates the module-level copy. */
export function persistLanguage(language: Language): void {
  currentLanguage = language;
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Storage can be unavailable; the choice still applies for this session.
  }
}

/** Applies a language chosen in another window (storage event) without re-saving it. */
export function adoptLanguage(language: Language): void {
  currentLanguage = language;
}

export { STORAGE_KEY as LANGUAGE_STORAGE_KEY, isLanguage };

/** BCP 47 locale used for dates and numbers. */
export function getLocale(language: Language = currentLanguage): string {
  return language === "vi" ? "vi-VN" : "en-US";
}

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Translate outside React (helpers, callbacks). Components should prefer `useT()`. */
export function translate(key: MessageKey, params?: TranslateParams, language: Language = currentLanguage): string {
  const template = DICTIONARIES[language][key] ?? en[key] ?? key;
  return interpolate(template, params);
}

/**
 * Splits an already-translated string on `{name}` placeholders and puts React
 * nodes in their place, so translators control word order around bold text,
 * code, buttons, etc. Example: richText(t("x"), { button: <strong>…</strong> }).
 */
export function richText(text: string, nodes: Record<string, ReactNode>): ReactNode {
  const parts = text.split(/\{(\w+)\}/g);
  return parts.map((part, i) => (i % 2 === 1 && part in nodes ? createElement(Fragment, { key: i }, nodes[part]) : part));
}

/** True when `value` is a known message key (e.g. a zod error message stored as a key). */
export function isMessageKey(value: string): value is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, value);
}
