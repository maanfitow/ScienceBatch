import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const [registryPath] = process.argv.slice(2);
if (!registryPath) throw new Error('Usage: node scripts/test-workspace-native-qa.mjs <registry.json>');
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const root = await mkdtemp(path.join(os.tmpdir(), 'sciencebatch-automation-qa-native-'));
const outputPath = path.join(root, 'preview.pdf');
const mainPath = path.join(root, 'main.tex');
const sectionPath = path.join(root, 'secondary.tex');
const stylePath = path.join(root, 'macros.sty');
const receiptPath = path.join(root, 'native-results.json');
const allowedRoots = [root];
let requestSequence = 0;
let passed = false;

await mkdir(root, { recursive: true });
await writeFile(mainPath, String.raw`\documentclass{article}
\usepackage{macros}
\begin{document}
MAINDISK \input{secondary.tex} \NativeMarker
\end{document}
`);
await writeFile(sectionPath, 'SECONDARYDISK\n');
await writeFile(stylePath, String.raw`\newcommand{\NativeMarker}{STYLEDISK}
`);

const request = (operation, args = {}, timeoutMs = 40_000) => {
  const id = `native-qa-${++requestSequence}`;
  const payload = JSON.stringify({ schemaVersion: 1, id, token: registry.token, operation, args });
  return new Promise((resolve, reject) => {
    const socket = net.connect(registry.port, registry.host, () => socket.write(`${payload}\n`));
    let buffered = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Timed out waiting for ${operation}`)); }, timeoutMs);
    socket.on('data', chunk => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try { resolve(JSON.parse(buffered.slice(0, newline))); } catch (error) { reject(error); }
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
};

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const computer = (...args) => JSON.parse(execFileSync('orca-ide', args, { encoding: 'utf8' }));
const appSnapshot = () => computer('computer', 'get-app-state', '--app', 'sciencebatch', '--no-screenshot', '--json').result.snapshot;
const clickAppElement = index => computer('computer', 'click', '--app', 'sciencebatch', '--element-index', String(index), '--no-screenshot', '--json');
const triggerEditCommand = label => {
  let snapshot = appSnapshot();
  const editIndex = Number(snapshot.treeText.match(/^\s*(\d+) push button Edit\s*$/m)?.[1]);
  assert.ok(Number.isInteger(editIndex), 'the native Edit menu is accessible');
  clickAppElement(editIndex);
  snapshot = appSnapshot();
  const commandIndex = Number(snapshot.treeText.match(new RegExp(`^\\s*(\\d+) push button ${label}\\s*$`, 'm'))?.[1]);
  assert.ok(Number.isInteger(commandIndex), `the native Edit menu exposes ${label}`);
  clickAppElement(commandIndex);
};
const successful = (reply, operation) => {
  assert.equal(reply.ok, true, `${operation} succeeds: ${reply.error?.code ?? ''} ${reply.error?.message ?? ''}`);
  return reply.data;
};
const currentContext = inspect => ({
  expectedProjectRoot: inspect.projectRoot,
  workspaceGeneration: inspect.workspaceGeneration,
  allowedRoots,
});
const applyText = async (inspect, document, source, replacement) => {
  const found = source.indexOf(document.from);
  assert.notEqual(found, -1, `source contains ${document.from}`);
  const context = currentContext(inspect);
  const reply = await request('workspace.apply', {
    ...context,
    documentId: document.id,
    expectedRevision: document.revision,
    start: found,
    end: found + document.from.length,
    text: document.to,
  });
  return successful(reply, 'workspace.apply');
};
const readDocument = async (inspect, documentId) => successful(await request('workspace.read', {
  ...currentContext(inspect), documentId,
}), 'workspace.read');
const compile = (inspect, jobId, options = {}) => request('workspace.compile', {
  ...currentContext(inspect),
  jobId,
  timeoutSeconds: 120,
  ...(options.outputPath ? { outputPath: options.outputPath } : {}),
  ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
});

try {
  const initial = successful(await request('workspace.inspect'), 'workspace.inspect');
  successful(await request('workspace.openProject', {
    expectedProjectRoot: initial.projectRoot,
    workspaceGeneration: initial.workspaceGeneration,
    allowedRoots,
    path: root,
  }), 'workspace.openProject');
  let inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  assert.equal(inspect.projectRoot, root);

  for (const file of ['secondary.tex', 'macros.sty']) {
    successful(await request('workspace.openFile', { ...currentContext(inspect), path: file }), `workspace.openFile(${file})`);
    inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  }
  const byName = name => {
    const document = inspect.documents.find(item => item.name === name);
    assert.ok(document, `${name} is an open editor document`);
    return document;
  };
  let main = byName('main.tex');
  let secondary = byName('secondary.tex');
  let style = byName('macros.sty');

  const mainRead = await readDocument(inspect, main.id);
  const secondRead = await readDocument(inspect, secondary.id);
  const styleRead = await readDocument(inspect, style.id);
  const appliedMain = await applyText(inspect, { ...main, from: 'MAINDISK', to: 'MAINOVERLAY' }, mainRead.content);
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  const staleEdit = await request('workspace.apply', {
    ...currentContext(inspect), documentId: main.id, expectedRevision: main.revision - 1,
    start: 0, end: 0, text: 'STALEEDIT',
  });
  assert.equal(staleEdit.ok, false);
  assert.equal(staleEdit.error.code, 'conflict.revision');
  const dirtyClose = await request('workspace.close', { ...currentContext(inspect), documentId: main.id });
  assert.equal(dirtyClose.ok, false);
  assert.equal(dirtyClose.error.code, 'conflict.dirty');
  triggerEditCommand('Undo');
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  assert.equal(main.revision, appliedMain.revision + 1, 'native Undo advances the document revision');
  assert.equal((await readDocument(inspect, main.id)).content, mainRead.content, 'native Undo restores the prior buffer');
  triggerEditCommand('Redo');
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  assert.equal(main.revision, appliedMain.revision + 2, 'native Redo advances the document revision');
  assert.ok((await readDocument(inspect, main.id)).content.includes('MAINOVERLAY'), 'native Redo restores the edit');
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  secondary = byName('secondary.tex');
  await applyText(inspect, { ...secondary, from: 'SECONDARYDISK', to: 'SECONDARYOVERLAY' }, secondRead.content);
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  style = byName('macros.sty');
  await applyText(inspect, { ...style, from: 'STYLEDISK', to: 'STYLEOVERLAY' }, styleRead.content);

  const firstCompile = successful(await compile(inspect, 'native-overlay-compile', { outputPath }), 'workspace.compile');
  assert.equal(firstCompile.pdfWritten, true, 'the current multi-buffer snapshot is exported');
  assert.match(await readFile(outputPath, 'latin1'), /^%PDF-/);
  let exportedPdf = await readFile(outputPath);
  assert.ok(exportedPdf.length > 1000, 'the exported PDF is non-empty');
  const extractPdfText = () => execFileSync('pdftotext', [outputPath, '-'], { encoding: 'utf8' });
  const overlayPdfText = extractPdfText();
  for (const marker of ['MAINOVERLAY', 'SECONDARYOVERLAY', 'STYLEOVERLAY']) {
    assert.ok(overlayPdfText.includes(marker), `the exported PDF contains the unsaved ${marker} buffer`);
  }

  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  const liveMain = await readDocument(inspect, main.id);
  await applyText(inspect, { ...main, from: 'MAINOVERLAY', to: 'SAVEONLYMARKER' }, liveMain.content);
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  successful(await request('workspace.save', {
    ...currentContext(inspect), documentId: main.id, expectedRevision: main.revision,
  }), 'workspace.save');
  assert.deepEqual(await readFile(outputPath), exportedPdf, 'explicit save does not run compilation or replace the PDF');

  const noOverwrite = await compile(inspect, 'native-no-overwrite', { outputPath, overwrite: false });
  assert.equal(noOverwrite.ok, false);
  assert.equal(noOverwrite.error.code, 'output.exists');
  assert.deepEqual(await readFile(outputPath), exportedPdf, 'a refused overwrite preserves the previous PDF');

  const invalidMain = await readDocument(inspect, main.id);
  await applyText(inspect, { ...main, from: 'SAVEONLYMARKER', to: String.raw`\undefinedNativeCommand` }, invalidMain.content);
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  const failedCompile = await compile(inspect, 'native-failed-compile', { outputPath, overwrite: true });
  assert.equal(failedCompile.ok, false);
  assert.equal(failedCompile.error.code, 'compile.document_failed');
  assert.ok(failedCompile.error.details.errors.some(item => item.severity === 'error'), 'compile failure includes error diagnostics');
  assert.deepEqual(await readFile(outputPath), exportedPdf, 'failed compilation preserves the previous PDF');

  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  const failedSource = await readDocument(inspect, main.id);
  await applyText(inspect, { ...main, from: String.raw`\undefinedNativeCommand`, to: 'SAVEONLYMARKER' }, failedSource.content);
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  const replacement = successful(await compile(inspect, 'native-explicit-overwrite', { outputPath, overwrite: true }), 'workspace.compile(overwrite)');
  assert.equal(replacement.pdfWritten, true, 'an explicit overwrite writes a successful compile');
  const overwrittenPdf = await readFile(outputPath);
  assert.notDeepEqual(overwrittenPdf, exportedPdf, 'an explicit successful overwrite replaces the previous PDF');
  assert.ok(extractPdfText().includes('SAVEONLYMARKER'), 'the overwritten PDF contains the saved source');
  exportedPdf = overwrittenPdf;

  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  const beforeStale = await readDocument(inspect, main.id);
  const slowSource = beforeStale.content.replace(String.raw`\undefinedNativeCommand`, String.raw`MAINOVERLAY
\newcount\nativecounter\nativecounter=0\loop\advance\nativecounter by 1\ifnum\nativecounter<10000000\repeat`);
  successful(await request('workspace.apply', {
    ...currentContext(inspect), documentId: main.id, expectedRevision: main.revision,
    start: 0, end: beforeStale.content.length, text: slowSource,
  }), 'workspace.apply(slow compile source)');
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  const slowCompile = compile(inspect, 'native-stale-compile', { outputPath, overwrite: true });
  await delay(100);
  const staleSource = await readDocument(inspect, main.id);
  const changed = await request('workspace.apply', {
    ...currentContext(inspect), documentId: main.id, expectedRevision: main.revision,
    start: staleSource.content.length, end: staleSource.content.length, text: '\n% changed during compilation\n',
  });
  successful(changed, 'workspace.apply during compilation');
  const staleResult = await slowCompile;
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.error.code, 'conflict.stale_result');
  assert.deepEqual(await readFile(outputPath), exportedPdf, 'a stale compile cannot overwrite the requested PDF');

  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  const cancellationSource = String.raw`\documentclass{article}\begin{document}\loop\iftrue\repeat\end{document}`;
  const currentMain = await readDocument(inspect, main.id);
  successful(await request('workspace.apply', {
    ...currentContext(inspect), documentId: main.id, expectedRevision: main.revision,
    start: 0, end: currentMain.content.length, text: cancellationSource,
  }), 'workspace.apply(cancellation source)');
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  const cancellationJob = 'native-cancellation';
  const pendingCancellation = compile(inspect, cancellationJob);
  await delay(200);
  successful(await request('workspace.cancel', { ...currentContext(inspect), jobId: cancellationJob }), 'workspace.cancel');
  const cancelled = await pendingCancellation;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'operation.interrupted');
  await delay(200);
  const workers = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' }).split('\n').filter(line => /sciencebatch(?:-cli)?.*--(?:compile|automation)-worker/.test(line));
  assert.equal(workers.length, 0, 'the isolated compiler worker is reaped after cancellation');

  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  const cancelledSource = await readDocument(inspect, main.id);
  successful(await request('workspace.apply', {
    ...currentContext(inspect), documentId: main.id, expectedRevision: main.revision,
    start: 0, end: cancelledSource.content.length, text: slowSource,
  }), 'workspace.apply(valid source after cancellation)');
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  const guardedCompile = compile(inspect, 'native-git-guard');
  await delay(100);
  const duringGuard = await request('workspace.apply', {
    ...currentContext(inspect), documentId: main.id, expectedRevision: main.revision,
    start: 0, end: 0, text: '% blocked while compile owns repository guard\n',
  });
  assert.equal(duringGuard.ok, false);
  assert.equal(duringGuard.error.code, 'git.locked');
  const guardedResult = await guardedCompile;
  assert.equal(guardedResult.ok, true, `the guarded compile completes: ${guardedResult.error?.code ?? ''}`);

  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  const beforeLargeEdit = await readDocument(inspect, main.id);
  const longComment = `%${'x'.repeat(2 * 1024 * 1024)}\n`;
  const started = performance.now();
  successful(await request('workspace.apply', {
    ...currentContext(inspect), documentId: main.id, expectedRevision: main.revision,
    start: beforeLargeEdit.content.length, end: beforeLargeEdit.content.length, text: longComment,
  }), 'workspace.apply(2 MiB comment)');
  const largeEditMs = performance.now() - started;
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  main = byName('main.tex');
  const afterLargeEdit = await readDocument(inspect, main.id);
  assert.ok(afterLargeEdit.content.endsWith(longComment), 'the complete 2 MiB edit is available through workspace.read');
  assert.ok(largeEditMs < 15_000, `the editor accepted a 2 MiB one-line comment in ${largeEditMs.toFixed(0)} ms`);
  const tooLarge = await request('workspace.apply', {
    ...currentContext(inspect), documentId: main.id, expectedRevision: main.revision,
    start: afterLargeEdit.content.length, end: afterLargeEdit.content.length, text: 'x'.repeat(8 * 1024 * 1024),
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.error.code, 'limit.text_bytes');

  let cleanLaTeX = successful(await request('workspace.inspect'), 'workspace.inspect');
  for (const document of cleanLaTeX.documents.filter(item => !item.saved)) {
    successful(await request('workspace.save', {
      ...currentContext(cleanLaTeX), documentId: document.id, expectedRevision: document.revision,
    }), 'workspace.save before Typst project');
    cleanLaTeX = successful(await request('workspace.inspect'), 'workspace.inspect');
  }
  successful(await request('workspace.close', currentContext(cleanLaTeX)), 'workspace.close before Typst project');

  const typstRoot = path.join(root, 'typst');
  await mkdir(typstRoot, { recursive: true });
  await writeFile(path.join(typstRoot, 'main.typ'), '#import "secondary.typ": second\n#text("TYPEMAIN")\n#second\n');
  await writeFile(path.join(typstRoot, 'secondary.typ'), '#let second = text("TYPESECONDARY")\n');
  let closed = successful(await request('workspace.inspect'), 'workspace.inspect');
  successful(await request('workspace.openProject', {
    expectedProjectRoot: closed.projectRoot,
    workspaceGeneration: closed.workspaceGeneration,
    allowedRoots,
    path: typstRoot,
  }), 'workspace.openProject(Typst)');
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  successful(await request('workspace.openFile', { ...currentContext(inspect), path: 'secondary.typ' }), 'workspace.openFile(Typst secondary)');
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  let typstMain = byName('main.typ');
  let typstSecondary = byName('secondary.typ');
  const typstMainRead = await readDocument(inspect, typstMain.id);
  const typstSecondaryRead = await readDocument(inspect, typstSecondary.id);
  await applyText(inspect, { ...typstMain, from: 'TYPEMAIN', to: 'TYPEOVERLAY' }, typstMainRead.content);
  inspect = successful(await request('workspace.inspect'), 'workspace.inspect');
  typstSecondary = byName('secondary.typ');
  await applyText(inspect, { ...typstSecondary, from: 'TYPESECONDARY', to: 'TYPESECOVERLAY' }, typstSecondaryRead.content);
  const typstOutput = path.join(typstRoot, 'preview.pdf');
  const typstResult = successful(await compile(inspect, 'native-typst-overlay', { outputPath: typstOutput }), 'workspace.compile(Typst)');
  assert.equal(typstResult.pdfWritten, true);
  const typstPdfText = execFileSync('pdftotext', [typstOutput, '-'], { encoding: 'utf8' });
  assert.ok(typstPdfText.includes('TYPEOVERLAY'), 'Typst PDF includes the unsaved main buffer');
  assert.ok(typstPdfText.includes('TYPESECOVERLAY'), 'Typst PDF includes the unsaved secondary buffer');

  const scenarios = [
    'Unsaved main, secondary, and .sty buffers were included in the compiled PDF.',
    'Native Undo and Redo restored the bridge edit while incrementing its revision; stale edits and dirty close were rejected.',
    'A compile-owned Git repository guard rejected a concurrent live edit with git.locked.',
    'Explicit save left the prior PDF unchanged.',
    'Failed compile returned compiler error diagnostics and preserved the prior PDF.',
    'Export refused an implicit overwrite and replaced the PDF after overwrite was explicit.',
    'A workspace edit during compilation rejected the stale result and preserved the prior PDF.',
    'Workspace cancellation returned operation.interrupted and reaped the isolated worker.',
    'The GUI accepted and returned a 2 MiB one-line edit; edits over 8 MiB were rejected.',
    'Typst compilation and export included unsaved main and secondary buffers.',
  ];
  await writeFile(receiptPath, `${JSON.stringify({ schemaVersion: 1, status: 'passed', root, outputPath, scenarios, largeEditMs }, null, 2)}\n`);
  passed = true;
  console.log(`Native workspace QA passed; receipt: ${receiptPath} (2 MiB edit: ${largeEditMs.toFixed(0)} ms).`);
} finally {
  try {
    let current = await request('workspace.inspect');
    if (current.ok && (current.data.projectRoot === root || current.data.projectRoot?.startsWith(`${root}/`))) {
      for (const document of current.data.documents.filter(item => !item.saved)) {
        await request('workspace.save', {
          ...currentContext(current.data),
          documentId: document.id,
          expectedRevision: document.revision,
        });
        current = await request('workspace.inspect');
      }
      await request('workspace.close', currentContext(current.data));
    }
  } catch {
    // Keep the temporary project cleanup independent from a disconnected app.
  }
  if (!passed) await rm(root, { recursive: true, force: true });
}
