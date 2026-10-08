import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const [registryPath, projectRoot] = process.argv.slice(2);
if (!registryPath || !projectRoot || !projectRoot.startsWith('/tmp/sciencebatch-automation-qa-')) {
  throw new Error('Usage: node scripts/test-workspace-live-bridge.mjs <registry.json> <temporary-project-root>');
}

const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const allowedRoots = [projectRoot];
const request = async (operation, args = {}) => {
  const id = `live-qa-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = JSON.stringify({ schemaVersion: 1, id, token: registry.token, operation, args });
  return await new Promise((resolve, reject) => {
    const socket = net.connect(registry.port, registry.host, () => socket.write(`${payload}\n`));
    let buffered = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Timed out waiting for ${operation}`)); }, 40_000);
    socket.on('data', chunk => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      const response = JSON.parse(buffered.slice(0, newline));
      socket.end();
      resolve(response);
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
};

const artifactFiles = async directory => {
  const found = new Map();
  const visit = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && /\.(aux|log|toc|out)$/i.test(entry.name)) {
        const metadata = await stat(full);
        found.set(full, `${metadata.size}:${metadata.mtimeMs}`);
      }
    }
  };
  await visit(directory);
  return found;
};

const beforeArtifacts = await artifactFiles(projectRoot);
const inspect = await request('workspace.inspect');
assert.equal(inspect.ok, true, 'workspace.inspect succeeds');
assert.equal(inspect.data.projectRoot, projectRoot, 'the fixture project is open');
const document = inspect.data.documents.find(item => item.path === inspect.data.mainFile || item.name === path.basename(inspect.data.mainFile));
assert.ok(document, 'the configured main source is open');

const context = { expectedProjectRoot: projectRoot, workspaceGeneration: inspect.data.workspaceGeneration, allowedRoots };
const read = await request('workspace.read', { ...context, documentId: document.id });
assert.equal(read.ok, true, 'workspace.read returns the live buffer');
const marker = `// live-bridge-regression-${Date.now()}\n`;
const applied = await request('workspace.apply', {
  ...context,
  documentId: document.id,
  expectedRevision: document.revision,
  start: 0,
  end: 0,
  text: marker,
});
assert.equal(applied.ok, true, `workspace.apply succeeds: ${applied.error?.code ?? ''}`);
assert.equal(applied.data.revision, document.revision + 1, 'the live document revision advances once');

const stale = await request('workspace.apply', {
  ...context,
  documentId: document.id,
  expectedRevision: document.revision,
  start: 0,
  end: 0,
  text: 'stale edit\n',
});
assert.equal(stale.ok, false, 'a stale revision is rejected');
assert.equal(stale.error.code, 'conflict.revision');

const dirtyClose = await request('workspace.close', { ...context, documentId: document.id });
assert.equal(dirtyClose.ok, false, 'a dirty document cannot be closed');
assert.equal(dirtyClose.error.code, 'conflict.dirty');

const saved = await request('workspace.save', {
  ...context,
  documentId: document.id,
  expectedRevision: applied.data.revision,
});
assert.equal(saved.ok, true, `workspace.save succeeds: ${saved.error?.code ?? ''}`);
assert.equal(saved.data.saved, true, 'the explicitly saved buffer is marked clean');
const after = await request('workspace.inspect');
assert.equal(after.ok, true);
assert.equal(after.data.documents.find(item => item.id === document.id)?.saved, true, 'the live document is clean after saving');
const diskSource = await readFile(path.join(projectRoot, inspect.data.mainFile), 'utf8');
assert.ok(diskSource.startsWith(marker), 'the explicit save wrote the test marker to the fixture source');
assert.deepEqual(await artifactFiles(projectRoot), beforeArtifacts, 'save did not create or change LaTeX/Typst intermediate artifacts');

console.log('Live workspace bridge checks passed: expected revision, dirty-close conflict, explicit save, and no disk intermediates.');
