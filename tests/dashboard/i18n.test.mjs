import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { LANGS, STRINGS, pickLanguage, translate } from '../../dashboard/i18n.js';

const dashboard = new URL('../../dashboard/', import.meta.url);

test('English and Spanish have exactly the same keys', () => {
  assert.deepEqual(LANGS, ['en', 'es']);
  assert.deepEqual(Object.keys(STRINGS.es).sort(), Object.keys(STRINGS.en).sort());
  for (const lang of LANGS) {
    for (const [k, v] of Object.entries(STRINGS[lang])) assert.ok(v.trim(), `${lang}.${k} is empty`);
  }
});

test('placeholders match between languages', () => {
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(STRINGS.en)) assert.deepEqual(ph(STRINGS.es[k]), ph(STRINGS.en[k]), k);
});

test('every key used in the dashboard exists', () => {
  const used = new Set();
  const html = readFileSync(new URL('index.html', dashboard), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-title|-aria)?="([\w]+)"/g)) used.add(m[1]);
  for (const file of readdirSync(dashboard).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(new URL(file, dashboard), 'utf8');
    for (const m of src.matchAll(/\bt\('([\w]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 40, `only found ${used.size} keys`);
  for (const k of used) assert.ok(k in STRINGS.en, `missing i18n key: ${k}`);
});

test('translate falls back and fills placeholders', () => {
  assert.equal(translate('es', 'speed'), 'Velocidad');
  assert.equal(translate('en', 'missingMsgs', { n: 3 }), '3 missing');
  assert.equal(translate('xx', 'speed'), 'Speed');
  assert.equal(translate('en', 'nope'), 'nope');
});

test('English is the default language', () => {
  assert.equal(pickLanguage('', null), 'en');
  assert.equal(pickLanguage('', 'es'), 'es');
  assert.equal(pickLanguage('?lang=es', 'en'), 'es');
  assert.equal(pickLanguage('?lang=fr', null), 'en');
});
