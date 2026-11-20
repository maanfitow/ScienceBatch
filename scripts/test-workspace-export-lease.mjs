import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/editor/workspaceExportLease.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { WorkspaceExportLease } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

const lease = new WorkspaceExportLease();
assert.equal(lease.acquire('export-1', true), false, 'Git updates prevent acquiring the export freeze');
assert.equal(lease.acquire('export-1', false), true, 'the export freeze is acquired atomically');
assert.equal(lease.id, 'export-1');
assert.equal(lease.active, true);
assert.equal(lease.acquire('export-2', false), false, 'a second export cannot overlap the frozen snapshot');
assert.equal(lease.release('export-2'), false, 'another request cannot release the active export freeze');
assert.equal(lease.id, 'export-1', 'the active lease remains held through the commit');
assert.equal(lease.release('export-1'), true, 'the owning request releases the freeze');
assert.equal(lease.active, false);

console.log('Workspace export lease exclusivity and ownership checks passed.');
