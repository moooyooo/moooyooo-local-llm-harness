import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { format, LOCALES, matchLocale, msg, placeholders, textOf, type Catalog, type MessageKey } from '../shared/i18n/index.js';
import { ja } from '../shared/i18n/ja.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('messages fill in their placeholders, including nested messages and lists', () => {
  assert.equal(format('ja', msg('error.noFolder', { path: '/x' })), '作業フォルダが存在しません: /x');
  assert.equal(
    format('ja', msg('settings.changed', { changes: [msg('settings.model', { from: 'a', to: 'b' }), msg('settings.web', { from: msg('common.off'), to: msg('common.on') })] })),
    '設定を変更しました: モデル a → b、Web 検索 オフ → オン',
  );
  assert.equal(format('ja', msg('error.noFolder')), '作業フォルダが存在しません: {path}', 'a missing value leaves the placeholder');
  assert.equal(textOf('ja', 'plain text'), 'plain text', 'plain strings pass through');
});

test('an unknown or partial language falls back to Japanese', () => {
  assert.equal(format('xx', msg('common.on')), 'オン');
  assert.equal(format('ja', { key: 'no.such.key' as MessageKey }), 'no.such.key');
});

test('the browser language picks an offered language, else the default', () => {
  assert.equal(matchLocale(['ja-JP', 'en-US']), 'ja');
  assert.equal(matchLocale(['fr-FR']), 'ja');
  assert.equal(matchLocale([]), 'ja');
});

test('every catalog translates only known keys and keeps their placeholders', () => {
  const source = ja as Catalog;
  for (const [locale, { messages }] of Object.entries(LOCALES)) {
    for (const [key, text] of Object.entries(messages)) {
      const original = source[key as MessageKey];
      assert.ok(original !== undefined, `${locale}: unknown key ${key}`);
      assert.deepEqual(placeholders(text!), placeholders(original!), `${locale}: placeholders of ${key}`);
    }
  }
});

/**
 * GUI text belongs in the catalogs, so a new language is only a new catalog. Japanese left in code (outside comments)
 * is almost always a string that skipped them. Server logs are for the person running it and may stay.
 */
test('no GUI text is written directly in the server or GUI code', () => {
  const JAPANESE = /[぀-ヿ一-鿿]/;
  const files = [
    ...readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => path.join('server', f)),
    ...readdirSync(path.join(ROOT, 'web/src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => path.join('web/src', f)),
  ];
  const offenders: string[] = [];
  for (const file of files) {
    readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = line.trim();
        if (!JAPANESE.test(code) || /^(\/\/|\*|\/\*|\{\/\*)/.test(code)) return;
        if (/console\.(log|error|warn)|const hint =/.test(code)) return;
        offenders.push(`${file}:${i + 1}: ${code.slice(0, 80)}`);
      });
  }
  assert.deepEqual(offenders, []);
});
