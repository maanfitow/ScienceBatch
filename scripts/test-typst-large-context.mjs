import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/editor/writing/typstContext.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { classifyTypstContext } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const longComment = `//${'x'.repeat(2 * 1024 * 1024)}`;
const start = performance.now();
const commentContext = classifyTypstContext(longComment, longComment.length);
const elapsedMs = performance.now() - start;

assert.equal(commentContext.context, 'blocked', 'a large comment remains an unavailable writing context');
assert.ok(elapsedMs < 1500, `2 MiB Typst context classification should remain bounded (took ${elapsedMs.toFixed(1)} ms)`);

console.log(`Large Typst context classification passed (${elapsedMs.toFixed(1)} ms for a 2 MiB comment).`);
