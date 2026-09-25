import { createElement, Fragment, type ReactNode } from 'react';
import {
  DEFAULT_LOCALE,
  format,
  isLocale,
  LOCALES,
  matchLocale,
  textOf,
  type Locale,
  type MessageKey,
  type Msg,
  type Text,
} from '../../shared/i18n';

/**
 * The GUI's language. App sets it on every render from the settings, so every component that calls `t` during that
 * render uses it; catalogs and how to add a language are in shared/i18n.
 */
let current: Locale = DEFAULT_LOCALE;

export function setLocale(locale: Locale) {
  current = locale;
  if (document.documentElement.lang !== locale) document.documentElement.lang = locale;
}

/** A message in the current language. */
export function t(key: MessageKey, params?: Msg['params']): string {
  return format(current, { key, params });
}

/** Text from the server (a message, or a plain string) in the current language. */
export function tx(text: Text | undefined): string {
  return text === undefined ? '' : textOf(current, text);
}

/** Like `t`, but placeholders may be elements (e.g. bold or code), wherever the language puts them. */
export function tNodes(key: MessageKey, nodes: Record<string, ReactNode>): ReactNode {
  const parts = format(current, { key }).split(/\{(\w+)\}/); // odd indexes are placeholder names
  return createElement(Fragment, null, ...parts.map((p, i) => (i % 2 ? (nodes[p] ?? `{${p}}`) : p)));
}

/** The saved language if it is still offered, else the best match for the browser's languages. */
export function preferredLocale(saved: unknown): Locale {
  return isLocale(saved) ? saved : matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

export const LANGUAGES = Object.entries(LOCALES).map(([id, l]) => ({ id: id as Locale, name: l.name }));
