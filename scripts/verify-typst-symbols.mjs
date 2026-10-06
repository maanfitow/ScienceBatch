import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import ts from 'typescript';

const compileWorkerPath = process.argv[2];
if (!compileWorkerPath || process.argv.length !== 3) {
  console.error('Usage: node scripts/verify-typst-symbols.mjs <compile-worker-binary>');
  process.exit(2);
}

const binaryPath = resolve(compileWorkerPath);
await access(binaryPath, constants.X_OK);
assert.ok((await stat(binaryPath)).isFile(), `Compile worker is not a file: ${binaryPath}`);

const catalogPath = new URL('../src/editor/writing/typstSymbols.ts', import.meta.url);
const catalogSource = await readFile(catalogPath, 'utf8');
const javascript = ts.transpileModule(catalogSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { TYPST_WRITING_SYMBOLS: symbols } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

assert.ok(Array.isArray(symbols) && symbols.length > 0, 'The Typst symbol catalog is empty.');
const identifiers = new Set();
for (const symbol of symbols) {
  assert.match(symbol.nativeIdentifier, /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/, `Unsafe or invalid native identifier: ${symbol.nativeIdentifier}`);
  assert.equal(symbol.command, symbol.nativeIdentifier, `${symbol.name} must use its native Typst identifier as the command.`);
  assert.equal(symbol.insertionSyntax, symbol.nativeIdentifier, `${symbol.name} must insert its native Typst identifier.`);
  assert.equal(symbol.packages.length, 0, `${symbol.name} must not require a package.`);
  assert.ok(!identifiers.has(symbol.nativeIdentifier), `Duplicate Typst identifier: ${symbol.nativeIdentifier}`);
  identifiers.add(symbol.nativeIdentifier);
}

const assertions = symbols.map(({ nativeIdentifier, glyph }) =>
  `#assert(str(sym.${nativeIdentifier}) == ${JSON.stringify(glyph)}, message: ${JSON.stringify(`${nativeIdentifier} glyph mismatch`)})`,
);
const mathExpressions = symbols.map(({ nativeIdentifier }) => `$${nativeIdentifier}$`);
const source = [...assertions, ...mathExpressions].join('\n\n');
const request = JSON.stringify({ engine: 'typst', source, main_file: null, project_dir: null });

let responseText;
try {
  responseText = execFileSync(binaryPath, ['--compile-worker'], {
    input: request,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`Typst compile-worker failed before returning a response: ${detail}`, { cause: error });
}

let response;
try {
  response = JSON.parse(responseText);
} catch (error) {
  throw new Error('Typst compile-worker returned invalid JSON.', { cause: error });
}

assert.equal(response.success, true, `Typst catalog validation failed: ${JSON.stringify(response.errors ?? [])}`);
assert.ok(Array.isArray(response.errors), 'Compile response is missing its errors array.');
assert.equal(response.errors.length, 0, `Typst compile reported errors: ${JSON.stringify(response.errors)}`);
assert.ok(Array.isArray(response.pdf_bytes), 'Compile response is missing its PDF byte array.');
assert.ok(response.pdf_bytes.length > 5, 'Compile response returned an empty PDF.');
assert.ok(response.pdf_bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255), 'PDF response contains invalid byte values.');
const pdfBytes = Buffer.from(response.pdf_bytes);
assert.equal(pdfBytes.subarray(0, 5).toString('ascii'), '%PDF-', 'Compile response bytes do not contain a PDF header.');

console.log(JSON.stringify({
  status: 'passed',
  symbols: symbols.length,
  pdfBytes: pdfBytes.length,
  warnings: Array.isArray(response.warnings) ? response.warnings.length : null,
}));
