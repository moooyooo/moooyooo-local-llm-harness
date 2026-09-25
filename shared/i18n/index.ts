import { ja } from './ja.js';

/**
 * Every text the GUI shows, in catalogs per language (`ja.ts`, ...). Japanese is the source language: its catalog
 * defines the keys, and it fills in whatever another catalog hasn't translated yet.
 *
 * The server never sends finished sentences: it sends a `Msg` (a key plus values for the key's `{placeholders}`), and
 * the GUI turns it into text in the viewer's language, so saved history follows the language too.
 *
 * To add a language, copy `ja.ts` to e.g. `en.ts` (typed `Catalog`), translate the values, and register it in `LOCALES`.
 * Keep every `{placeholder}` of a message; `i18n.test.ts` checks that.
 */

export type MessageKey = keyof typeof ja;
/** A catalog may be partial while it is being translated. */
export type Catalog = Partial<Record<MessageKey, string>>;
/** A list of messages is joined with the language's `common.listSeparator`. */
export type ParamValue = string | number | Msg | Msg[];
export interface Msg {
  key: MessageKey;
  params?: Record<string, ParamValue>;
}
/** Text for the GUI: a message, or a plain string (e.g. an error from Ollama, or history saved before messages had keys). */
export type Text = string | Msg;

/** Languages the GUI offers; `name` is shown in the language picker. English and Chinese are planned. */
export const LOCALES = {
  ja: { name: '日本語', messages: ja as Catalog },
} satisfies Record<string, { name: string; messages: Catalog }>;
export type Locale = keyof typeof LOCALES;
export const DEFAULT_LOCALE: Locale = 'ja';

export function msg(key: MessageKey, params?: Msg['params']): Msg {
  return params ? { key, params } : { key };
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(LOCALES, value);
}

/** The text of a message in `locale`, falling back to Japanese, then to the key itself. */
export function format(locale: string, m: Msg): string {
  const catalog = isLocale(locale) ? LOCALES[locale].messages : undefined;
  const template = catalog?.[m.key] ?? (ja as Catalog)[m.key] ?? m.key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = m.params?.[name];
    return v === undefined ? whole : paramText(locale, v);
  });
}

export function textOf(locale: string, text: Text): string {
  return typeof text === 'string' ? text : format(locale, text);
}

function paramText(locale: string, v: ParamValue): string {
  if (Array.isArray(v)) return v.map((m) => format(locale, m)).join(format(locale, { key: 'common.listSeparator' }));
  return typeof v === 'object' ? format(locale, v) : String(v);
}

/** The best offered language for a list of BCP 47 tags (e.g. `navigator.languages`): exact, then by language. */
export function matchLocale(tags: readonly string[]): Locale {
  const ids = Object.keys(LOCALES) as Locale[];
  for (const tag of tags) {
    const exact = ids.find((id) => id.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const lang = tag.split('-')[0].toLowerCase();
    const byLang = ids.find((id) => id.split('-')[0].toLowerCase() === lang);
    if (byLang) return byLang;
  }
  return DEFAULT_LOCALE;
}

/** An error whose message is shown to the user, in the user's language. */
export class TextError extends Error {
  readonly text: Text;
  constructor(text: Text) {
    super(textOf(DEFAULT_LOCALE, text));
    this.text = text;
  }
}

/** Placeholder names in a template, for checking translations. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}
