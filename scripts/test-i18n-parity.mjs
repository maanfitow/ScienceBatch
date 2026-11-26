import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const LOCALES_DIR = path.resolve('src/locales');
const NAMESPACES = ['common', 'menu', 'sidebar', 'git', 'resources', 'editor', 'errors', 'writing'];

function flattenEntries(value, prefix = '') {
  const out = new Map();
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      for (const [k, v] of flattenEntries(child, nextPrefix)) {
        out.set(k, v);
      }
    }
    return out;
  }
  out.set(prefix, value);
  return out;
}

function extractPlaceholders(text) {
  const matches = [...String(text).matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  return [...new Set(matches)].sort();
}

let totalKeys = 0;

for (const ns of NAMESPACES) {
  const enPath = path.join(LOCALES_DIR, 'en', `${ns}.json`);
  const esPath = path.join(LOCALES_DIR, 'es', `${ns}.json`);
  const enJson = JSON.parse(await fs.readFile(enPath, 'utf8'));
  const esJson = JSON.parse(await fs.readFile(esPath, 'utf8'));

  const enFlat = flattenEntries(enJson);
  const esFlat = flattenEntries(esJson);

  const missingInEs = [...enFlat.keys()].filter((k) => !esFlat.has(k));
  const extraInEs = [...esFlat.keys()].filter((k) => !enFlat.has(k));

  assert.deepEqual(missingInEs, [], `Missing keys in es/${ns}.json: ${missingInEs.join(', ')}`);
  assert.deepEqual(extraInEs, [], `Extra keys in es/${ns}.json: ${extraInEs.join(', ')}`);

  for (const [key, enVal] of enFlat.entries()) {
    const esVal = esFlat.get(key);
    assert.equal(typeof enVal, 'string', `en/${ns}.json key ${key} must be a string`);
    assert.equal(typeof esVal, 'string', `es/${ns}.json key ${key} must be a string`);
    assert.ok(enVal.trim().length > 0, `en/${ns}.json key ${key} must not be empty`);
    assert.ok(esVal.trim().length > 0, `es/${ns}.json key ${key} must not be empty`);

    const enVars = extractPlaceholders(enVal);
    const esVars = extractPlaceholders(esVal);
    assert.deepEqual(
      esVars,
      enVars,
      `Placeholder mismatch in ${ns}:${key} — en=${JSON.stringify(enVars)} vs es=${JSON.stringify(esVars)}`,
    );
  }

  totalKeys += enFlat.size;
}

console.log(`i18n parity check passed across ${NAMESPACES.length} namespaces (${totalKeys} keys).`);
