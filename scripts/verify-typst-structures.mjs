import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import ts from 'typescript';

const compileWorkerPath = process.argv[2];
if (!compileWorkerPath || process.argv.length !== 3) {
  console.error('Usage: node scripts/verify-typst-structures.mjs <compile-worker-binary>');
  process.exit(2);
}

const binaryPath = resolve(compileWorkerPath);
await access(binaryPath, constants.X_OK);
assert.ok((await stat(binaryPath)).isFile(), `Compile worker is not a file: ${binaryPath}`);

const typesSource = await readFile(new URL('../src/types/typstWriting.ts', import.meta.url), 'utf8');
const validationSource = await readFile(new URL('../src/editor/writing/typstStructureValidation.ts', import.meta.url), 'utf8');
const generatorSource = await readFile(new URL('../src/editor/writing/typstStructureGenerate.ts', import.meta.url), 'utf8');
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const typesUrl = `data:text/javascript;base64,${Buffer.from(transpile(typesSource)).toString('base64')}`;
const validationJs = transpile(validationSource).replace("'../../types/typstWriting'", JSON.stringify(typesUrl));
const validationUrl = `data:text/javascript;base64,${Buffer.from(validationJs).toString('base64')}`;
const generatorJs = transpile(generatorSource)
  .replace("'../../types/typstWriting'", JSON.stringify(typesUrl))
  .replace("'./typstStructureValidation'", JSON.stringify(validationUrl));
const generatorUrl = `data:text/javascript;base64,${Buffer.from(generatorJs).toString('base64')}`;
const { generateTypstMatrix, generateTypstTable } = await import(generatorUrl);

const tableCells = [['Name', 'Value'], ['A # B', '"quoted"'], ['Backslash \\', 'brackets []']];
const fixtures = [
  generateTypstTable({ rows: 1, columns: 1, cells: [['']], format: 'plain' }),
  generateTypstTable({ rows: 1, columns: 1, cells: [['centered table']], wrapInFigure: true }),
  generateTypstTable({ rows: 2, columns: 2, cells: [['Text #', 'quoted "'], ['slash \\', '[brackets]']], alignment: ['left', 'right'], format: 'plain' }),
  generateTypstTable({ rows: 2, columns: 2, cells: [['1', '2'], ['3', '4']], format: 'grid' }),
  generateTypstTable({ rows: 3, columns: 2, cells: tableCells, alignment: ['center', 'right'], header: true, format: 'booktabs' }),
  generateTypstTable({
    rows: 2, columns: 3,
    cells: [
      ['#emph[raw]', '$"a,b]" + x$', '#align(center, [#text("A,B]")])'],
      ['escaped \\] and "quote', 'bare " quote', 'tail'],
    ],
    cellTypst: [[true, true, true], [true, true, true]],
    header: true,
  }),
  generateTypstTable({ rows: 1, columns: 2, cells: [['Only', 'header']], header: true, format: 'booktabs' }),
  generateTypstTable({ rows: 2, columns: 2, cells: [['A', 'B'], ['1', '2']], wrapInFigure: true, caption: 'Literal #, "quotes", and \\', label: 'tbl-verifier' }),
  ...['none', 'parentheses', 'brackets', 'braces', 'single-bars', 'double-bars'].map((delimiter, index) =>
    generateTypstMatrix({ rows: 2, columns: 2, cells: [['1', 'frac(1, 2)'], ['', `sqrt(${index + 1})`]], delimiter }),
  ),
  '#align(center, $ mat(delim: "[", 1, 2; 3, 4) $)',
];

const source = ['#set page(width: 18cm, height: auto, margin: 1cm)', ...fixtures].join('\n\n');
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

assert.equal(response.success, true, `Typst structure fixtures failed: ${JSON.stringify(response.errors ?? [])}`);
assert.ok(Array.isArray(response.errors), 'Compile response is missing its errors array.');
assert.equal(response.errors.length, 0, `Typst compile reported errors: ${JSON.stringify(response.errors)}`);
assert.ok(Array.isArray(response.pdf_bytes) && response.pdf_bytes.length > 5, 'Compile response returned an empty PDF.');
const pdfBytes = Buffer.from(response.pdf_bytes);
assert.equal(pdfBytes.subarray(0, 5).toString('ascii'), '%PDF-', 'Compile response bytes do not contain a PDF header.');

console.log(JSON.stringify({ status: 'passed', fixtures: fixtures.length, pdfBytes: pdfBytes.length, warnings: Array.isArray(response.warnings) ? response.warnings.length : null }));
