#!/usr/bin/env node

import assert from 'node:assert/strict';
import { copyFile, cp, mkdtemp, mkdir, readFile, readdir, realpath, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const samplePng = join(repositoryRoot, 'src-tauri/embedded_packages/assets/sample.png');
const intermediateExtensions = new Set(['aux', 'bbl', 'bcf', 'blg', 'fdb_latexmk', 'fls', 'log', 'out', 'run.xml', 'synctex.gz', 'toc']);

function parseArgs(args) {
  let cliPath;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--help' || args[index] === '-h') return { help: true };
    if (args[index] === '--cli' && !cliPath && args[index + 1] && !args[index + 1].startsWith('--')) {
      cliPath = resolve(args[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete option: ${args[index]}`);
  }
  if (!cliPath) throw new Error('Pass the CLI executable explicitly with --cli PATH.');
  return { cliPath, help: false };
}

function usage() {
  process.stdout.write('Usage: node scripts/test-automation-cli.mjs --cli PATH\n');
}

function parseEnvelope(result, label) {
  let envelope;
  try {
    const lines = result.stdout.trimEnd().split(/\r?\n/);
    assert.equal(lines.length, 1, `${label}: expected one JSON line on stdout; got ${JSON.stringify(result.stdout)}`);
    envelope = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`${label}: invalid JSON stdout (${error.message}); stderr=${result.stderr}`);
  }
  assert.equal(envelope.schemaVersion, 1, `${label}: schemaVersion`);
  assert.equal(typeof envelope.command, 'string', `${label}: command`);
  assert.equal(typeof envelope.ok, 'boolean', `${label}: ok`);
  assert.ok(Array.isArray(envelope.diagnostics), `${label}: diagnostics array`);
  assert.ok(Object.hasOwn(envelope, 'error'), `${label}: error member`);
  return envelope;
}

function call(cliPath, args, options = {}) {
  const result = spawnSync(cliPath, [...args, '--json'], {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? 180_000,
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`sciencebatch-cli ${args[0]} failed to start: ${result.error.message}`);
  const envelope = parseEnvelope(result, args.join(' '));
  return { ...result, envelope };
}

function expectExit(result, code, label) {
  assert.equal(result.status, code, `${label}: exit status; envelope=${JSON.stringify(result.envelope)} stderr=${result.stderr}`);
  assert.equal(result.envelope.ok, code === 0, `${label}: envelope ok`);
  return result.envelope;
}

function extension(path) {
  const name = path.split('/').at(-1) ?? '';
  return name.includes('.') ? name.split('.').slice(1).join('.') : '';
}

function tracePid(line) {
  const match = line.match(/^\[pid\s+(\d+)\]\s+|^(\d+)\s+/);
  return Number(match?.[1] ?? match?.[2]);
}

function openedPath(line) {
  const openAt = line.match(/\bopenat(?:2)?\([^,]+,\s*"((?:\\.|[^"])*)"/);
  if (openAt) return openAt[1];
  const open = line.match(/\bopen\("((?:\\.|[^"])*)"/);
  if (open) return open[1];
  const created = line.match(/\bcreat\("((?:\\.|[^"])*)"/);
  return created?.[1];
}

function writePaths(line) {
  if (/\brename(?:at2?)?\(/.test(line)) {
    return [...line.matchAll(/"((?:\\.|[^"])*)"/g)].map(match => match[1]);
  }
  const path = openedPath(line);
  return path ? [path] : [];
}

function isIntermediatePath(path) {
  return [...intermediateExtensions].some(extension => path.toLowerCase().endsWith(`.${extension}`));
}

async function walk(directory, root = directory, result = []) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await walk(path, root, result);
    else result.push(path.slice(root.length + 1).replaceAll('\\', '/'));
  }
  return result.sort();
}

async function assertNoIntermediates(project) {
  const files = await walk(project);
  const found = files.filter(path => intermediateExtensions.has(extension(path)) || /\.sciencebatch-(?:pdf|apply)-.*\.(?:tmp|bak)$/.test(path));
  assert.deepEqual(found, [], `compiler intermediates remain in project: ${found.join(', ')}`);
}

async function sourceSnapshot(project) {
  const files = await walk(project);
  const snapshot = new Map();
  for (const file of files) {
    const full = join(project, file);
    const info = await stat(full);
    if (info.isFile()) snapshot.set(file, await readFile(full));
  }
  return snapshot;
}

async function assertSourceSnapshot(project, before, allowed = new Set()) {
  const afterFiles = await walk(project);
  for (const file of before.keys()) {
    assert.ok(afterFiles.includes(file), `compile removed project file ${file}`);
    assert.deepEqual(await readFile(join(project, file)), before.get(file), `compile changed project file ${file}`);
  }
  const added = afterFiles.filter(file => !before.has(file) && !allowed.has(file));
  assert.deepEqual(added, [], `compile wrote unrequested project files: ${added.join(', ')}`);
}

function findStrace() {
  const result = spawnSync('sh', ['-lc', 'command -v strace'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

async function processDetails(pid) {
  try {
    const args = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    const cwd = await realpath(`/proc/${pid}/cwd`);
    return { args: args.replaceAll('\0', ' '), cwd };
  } catch {
    return undefined;
  }
}

async function workersForProject(project) {
  if (process.platform !== 'linux') return [];
  const pids = (await readdir('/proc')).filter(entry => /^\d+$/.test(entry));
  const workers = [];
  for (const pid of pids) {
    const details = await processDetails(pid);
    if (details?.args.includes('--automation-worker') && details.cwd === project) workers.push(Number(pid));
  }
  return workers;
}

async function waitForWorker(project, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workers = await workersForProject(project);
    if (workers.length) return workers;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  return [];
}

async function waitForWorkerExit(project, pids, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = await workersForProject(project);
    if (active.every(pid => !pids.includes(pid))) return true;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  return false;
}

function spawnCli(cliPath, args, cwd) {
  return spawn(cliPath, [...args, '--json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function finishChild(child, timeoutMs = 15_000) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`sciencebatch-cli did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function expectSignalCancellation(cliPath, project, timeoutSeconds) {
  const child = spawnCli(cliPath, ['compile', '--project', project, '--main', 'infinite.tex', '--timeout', String(timeoutSeconds)], project);
  const workerPids = await waitForWorker(project);
  assert.ok(workerPids.length, 'infinite TeX compile started an isolated worker');
  child.kill('SIGINT');
  const result = await finishChild(child, 15_000);
  assert.equal(result.code, 130, `SIGINT exit status, stdout=${result.stdout}, stderr=${result.stderr}`);
  const envelope = parseEnvelope(result, 'SIGINT cancellation');
  assert.equal(envelope.error.code, 'operation.interrupted');
  if (process.platform === 'linux') {
    assert.ok(await waitForWorkerExit(project, workerPids), `SIGINT worker was not reaped: ${workerPids.join(',')}`);
  }
}

async function expectTimeout(cliPath, project) {
  const child = spawnCli(cliPath, ['compile', '--project', project, '--main', 'infinite.tex', '--timeout', '1'], project);
  const workerPids = await waitForWorker(project);
  assert.ok(workerPids.length, 'timeout fixture started an isolated worker');
  const result = await finishChild(child, 15_000);
  assert.equal(result.code, 124, `timeout exit status, stdout=${result.stdout}, stderr=${result.stderr}`);
  const envelope = parseEnvelope(result, 'compile timeout');
  assert.equal(envelope.error.code, 'operation.timeout');
  if (process.platform === 'linux') {
    assert.ok(await waitForWorkerExit(project, workerPids), `timed-out worker was not reaped: ${workerPids.join(',')}`);
  }
}

async function expectWorkerCrash(cliPath, project) {
  if (process.platform !== 'linux') {
    process.stdout.write('SKIP worker-crash/reap check: /proc is only inspected on Linux.\n');
    return;
  }
  const child = spawnCli(cliPath, ['compile', '--project', project, '--main', 'infinite.tex', '--timeout', '120'], project);
  const workerPids = await waitForWorker(project);
  assert.ok(workerPids.length, 'crash fixture started an isolated worker');
  for (const pid of workerPids) process.kill(pid, 'SIGKILL');
  const result = await finishChild(child, 15_000);
  assert.equal(result.code, 4, `worker crash exit status, stdout=${result.stdout}, stderr=${result.stderr}`);
  const envelope = parseEnvelope(result, 'killed worker');
  assert.equal(envelope.error.code, 'worker.crashed');
  assert.ok(await waitForWorkerExit(project, workerPids), `killed worker was not reaped: ${workerPids.join(',')}`);
}

async function runStrace(cliPath, project, mainFile, output, options = {}) {
  const strace = findStrace();
  if (!strace) {
    process.stdout.write('SKIP strace checks: strace is unavailable.\n');
    return;
  }
  const label = options.label ?? mainFile;
  const tracePath = join(dirname(project), `${label}.strace`);
  const result = spawnSync(strace, ['-f', '-qq', '-s', '65535', '-e', 'trace=network,open,openat,openat2,creat,rename,renameat,renameat2,execve', '-o', tracePath, cliPath,
    'compile', '--project', project, '--main', mainFile, '--output', output, '--json'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 16 * 1024 * 1024,
  });
  const expectedExit = options.expectedExit ?? 0;
  assert.equal(result.status, expectedExit, `straced ${label}: ${result.stdout} ${result.stderr}`);
  const envelope = parseEnvelope(result, `straced ${label}`);
  assert.equal(envelope.ok, expectedExit === 0);
  if (options.expectedError) assert.equal(envelope.error?.code, options.expectedError);
  const trace = await readFile(tracePath, 'utf8');
  assert.doesNotMatch(trace, /AF_INET6?\b/, `${label}: compile made no IPv4/IPv6 network syscalls`);
  const traceLines = trace.split(/\r?\n/);
  const workerRows = traceLines.filter(line => /\bexecve\(/.test(line) && line.includes('--automation-worker'));
  assert.ok(workerRows.length > 0, `${label}: trace contains the isolated worker execve`);
  const workerPids = [...new Set(workerRows.map(tracePid).filter(Number.isFinite))];
  assert.ok(workerPids.length > 0, `${label}: isolated worker exec has a parseable PID`);
  const projectRoot = await realpath(project);
  for (const pid of workerPids) {
    const rows = traceLines.filter(line => tracePid(line) === pid);
    const projectOpens = rows.filter(line => /\bopen(?:at|at2)?\(/.test(line)).filter(line => {
      const path = openedPath(line);
      if (!path) return false;
      const absolute = resolve(projectRoot, path);
      const projectRelative = relative(projectRoot, absolute);
      return projectRelative === '' || (!projectRelative.startsWith('..') && !projectRelative.startsWith('/'));
    });
    assert.deepEqual(projectOpens, [], `${label}: worker ${pid} opened project files from disk: ${projectOpens.join('\n')}`);
  }

  const writeCalls = traceLines.filter(line => /\b(?:open|openat|openat2)\(/.test(line)
    && /\bO_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND)\b/.test(line)
    || /\b(?:creat|rename|renameat|renameat2)\(/.test(line));
  const intermediateWrites = writeCalls.filter(line => writePaths(line).some(isIntermediatePath));
  assert.deepEqual(intermediateWrites, [], `${label}: compiler wrote intermediate files: ${intermediateWrites.join('\n')}`);
  await assertNoIntermediates(project);
  return { envelope, tracePath, trace };
}

async function copiedTectonicCache(cliPath, base, name) {
  const status = call(cliPath, ['resources', 'status']);
  const envelope = expectExit(status, 0, 'read Tectonic cache location');
  const sourceBundles = resolve(envelope.data.cacheDirectory);
  const sourceRoot = dirname(sourceBundles);
  const cacheRoot = join(base, name);
  await cp(sourceRoot, cacheRoot, { recursive: true, preserveTimestamps: true });
  return {
    root: cacheRoot,
    bundles: join(cacheRoot, sourceBundles.split(/[\\/]/).at(-1)),
  };
}

async function runOfflineCacheScenarios(cliPath, base, project) {
  const original = await copiedTectonicCache(cliPath, base, 'tectonic-cache-stale-check');
  const hashDirectory = join(original.bundles, 'hashes');
  const hashFiles = await readdir(hashDirectory);
  const hashName = hashFiles.find(name => name.endsWith('.tar'));
  assert.ok(hashName, `cached Tectonic bundle digest exists in ${hashDirectory}`);
  const checkPath = join(hashDirectory, hashName.replace(/\.tar$/, '.lock'));
  const digestPath = join(hashDirectory, hashName);
  const oldTime = new Date('2000-01-01T00:00:00Z');
  await writeFile(checkPath, '0');
  await utimes(checkPath, oldTime, oldTime);
  await runStrace(cliPath, project, 'main.tex', join(base, 'offline-stale-check.pdf'), {
    label: 'offline-stale-check',
    env: { TECTONIC_CACHE_DIR: original.root },
  });
  await writeFile(digestPath, `${'0'.repeat(64)}\n`);
  await utimes(digestPath, oldTime, oldTime);
  await runStrace(cliPath, project, 'main.tex', join(base, 'offline-stale-digest.pdf'), {
    label: 'offline-stale-digest',
    env: { TECTONIC_CACHE_DIR: original.root },
    expectedExit: 3,
    expectedError: 'cache.unavailable_offline',
  });

  const missingIndex = await copiedTectonicCache(cliPath, base, 'tectonic-cache-missing-index');
  const digest = (await readFile(join(missingIndex.bundles, 'hashes', hashName), 'utf8')).trim();
  await unlink(join(missingIndex.bundles, 'data', `${digest}.index`));
  await runStrace(cliPath, project, 'main.tex', join(base, 'offline-missing-index.pdf'), {
    label: 'offline-missing-index',
    env: { TECTONIC_CACHE_DIR: missingIndex.root },
    expectedExit: 3,
    expectedError: 'cache.unavailable_offline',
  });

  const missingDigest = await copiedTectonicCache(cliPath, base, 'tectonic-cache-missing-digest');
  await unlink(join(missingDigest.bundles, 'hashes', hashName));
  await runStrace(cliPath, project, 'main.tex', join(base, 'offline-missing-digest.pdf'), {
    label: 'offline-missing-digest',
    env: { TECTONIC_CACHE_DIR: missingDigest.root },
    expectedExit: 3,
    expectedError: 'cache.unavailable_offline',
  });
}

async function main() {
  assert.equal(tracePid('20789 execve("sciencebatch-cli", ["sciencebatch-cli", "--automation-worker"])'), 20789);
  assert.equal(tracePid('[pid 20790] execve("sciencebatch-cli", ["sciencebatch-cli", "--automation-worker"])'), 20790);
  const renamedPaths = writePaths('20791 renameat(AT_FDCWD, "main.tmp", AT_FDCWD, "main.aux") = 0');
  assert.equal(renamedPaths.some(isIntermediatePath), true, 'rename destination with an intermediate extension is detected');
  assert.equal(isIntermediatePath('document.fmt'), false, 'format files are not TeX intermediates');
  assert.equal(isIntermediatePath('document.pdf'), false, 'PDF outputs are not TeX intermediates');
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const cliPath = options.cliPath;
  const cliStat = await stat(cliPath);
  assert.ok(cliStat.isFile(), `CLI path is not a regular file: ${cliPath}`);
  const base = await mkdtemp(join(tmpdir(), 'sciencebatch-automation-cli-'));
  const latex = join(base, 'latex-project');
  const typst = join(base, 'typst-project');
  const syntax = join(base, 'syntax-project');
  const missing = join(base, 'missing-dependency-project');
  const missingImage = join(base, 'missing-image-project');
  const empty = join(base, 'empty-project');
  const malformed = join(base, 'malformed-config-project');
  const ambiguous = join(base, 'ambiguous-project');
  const infinite = join(base, 'infinite-project');
  const outside = join(base, 'outside');
  for (const directory of [latex, typst, syntax, missing, missingImage, empty, malformed, ambiguous, infinite, outside]) {
    await mkdir(directory, { recursive: true });
  }

  await mkdir(join(latex, 'sections'), { recursive: true });
  await mkdir(join(latex, 'assets'), { recursive: true });
  await mkdir(join(latex, 'refs'), { recursive: true });
  await copyFile(samplePng, join(latex, 'assets/sample.PNG'));
  await writeFile(join(latex, 'main.tex'), String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\input{sections/body.tex}
\includegraphics[width=1in]{assets/sample.PNG}
\bibliographystyle{plain}
\bibliography{refs/library}
\end{document}
`);
  await writeFile(join(latex, 'sections/body.tex'), 'A multifile citation appears here: \\cite{sample2024}.\n');
  await writeFile(join(latex, 'refs/library.bib'), '@article{sample2024, title={Local Reference}, author={Example, Ada}, journal={Fixture Journal}, year={2024}}\n');
  await writeFile(join(latex, 'notes.tex'), 'Original note text.\n');

  await mkdir(join(typst, 'sections'), { recursive: true });
  await mkdir(join(typst, 'assets'), { recursive: true });
  await copyFile(samplePng, join(typst, 'assets/sample.PNG'));
  await writeFile(join(typst, 'main.typ'), '#include "sections/body.typ"\n#image("assets/sample.PNG", width: 1in)\n#bibliography("refs.bib")\n');
  await writeFile(join(typst, 'sections/body.typ'), 'A local citation appears here: @sample2024.\n');
  await writeFile(join(typst, 'refs.bib'), '@article{sample2024, title = {Local Reference}, author = {Example, Ada}, date = {2024}, journal = {Fixture Journal}}\n');

  await mkdir(join(syntax, 'sections'), { recursive: true });
  await writeFile(join(syntax, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{sections/broken.tex}\n\\end{document}\n');
  await writeFile(join(syntax, 'sections/broken.tex'), 'first included line\n\\SciencebatchUnknownCommand\n');
  await writeFile(join(missing, 'main.tex'), '\\documentclass{article}\n\\usepackage{sciencebatchmissingpackageqa}\n\\begin{document}missing dependency\\end{document}\n');
  await writeFile(join(missingImage, 'main.tex'), '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\\includegraphics{assets/real-photo.png}\\end{document}\n');
  await writeFile(join(malformed, '.sciencebatch.json'), '{"engine":\n');
  await writeFile(join(ambiguous, 'a.tex'), '\\documentclass{article}\\begin{document}a\\end{document}\n');
  await writeFile(join(ambiguous, 'b.tex'), '\\documentclass{article}\\begin{document}b\\end{document}\n');
  await writeFile(join(infinite, 'infinite.tex'), '\\documentclass{article}\n\\begin{document}\n\\loop\\iftrue\\repeat\n\\end{document}\n');

  const version = spawnSync(cliPath, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(version.status, 0, `--version stdout=${version.stdout} stderr=${version.stderr}`);
  const versionEnvelope = parseEnvelope(version, 'version');
  assert.equal(versionEnvelope.command, 'version');

  const invalidUsage = call(cliPath, ['project', 'inspect'], { cwd: base });
  const usageEnvelope = expectExit(invalidUsage, 2, 'missing required project path');
  assert.equal(usageEnvelope.error.code, 'usage.invalid_argument');
  assert.doesNotMatch(invalidUsage.stdout, /(?:Usage|error):/i, 'usage prose stays off stdout');

  const missingProject = call(cliPath, ['project', 'inspect', '--project', join(base, 'does-not-exist')], { cwd: base });
  const unavailable = expectExit(missingProject, 3, 'unavailable project path');
  assert.equal(unavailable.error.code, 'io.project_unavailable');

  const projectPath = join(latex, 'sections', '..', '..', 'latex-project');
  const inspected = call(cliPath, ['project', 'inspect', '--project', projectPath, '--main', './main.tex'], { cwd: base });
  const inspection = expectExit(inspected, 0, 'normalized relative paths').data;
  assert.equal(await realpath(inspection.project), await realpath(latex));
  assert.ok(inspection.files.some(item => item.path === 'assets/sample.PNG'));

  const diagnosticsResult = call(cliPath, ['diagnostics', '--project', latex, '--main', 'main.tex'], { cwd: base });
  const diagnosticsData = expectExit(diagnosticsResult, 0, 'project diagnostics').data;
  assert.equal(await realpath(diagnosticsData.project), await realpath(latex));

  const latexBefore = await sourceSnapshot(latex);
  const latexPdf = join(base, 'latex.pdf');
  const latexCompile = call(cliPath, ['compile', '--project', projectPath, '--main', './main.tex', '--output', latexPdf], { cwd: base });
  const latexResult = expectExit(latexCompile, 0, 'multifile LaTeX image and bibliography').data;
  assert.equal(await realpath(latexResult.project), await realpath(latex));
  assert.equal(latexResult.engine, 'latex');
  assert.ok(latexResult.pdfWritten);
  assert.ok((await readFile(latexPdf)).subarray(0, 5).equals(Buffer.from('%PDF-')));
  await assertSourceSnapshot(latex, latexBefore);
  await assertNoIntermediates(latex);

  const typstBefore = await sourceSnapshot(typst);
  const typstPdf = join(base, 'typst.pdf');
  const typstCompile = call(cliPath, ['compile', '--project', typst, '--main', 'main.typ', '--output', typstPdf], { cwd: base });
  const typstResult = expectExit(typstCompile, 0, 'multifile Typst image and bibliography').data;
  assert.equal(typstResult.engine, 'typst');
  await assertSourceSnapshot(typst, typstBefore);
  await assertNoIntermediates(typst);

  const noteRead = call(cliPath, ['project', 'read', '--project', latex, '--file', 'notes.tex'], { cwd: base });
  const original = expectExit(noteRead, 0, 'read source').data;
  const nextText = 'Updated note text from the CLI.\n';
  const apply = call(cliPath, ['project', 'apply', '--project', latex, '--file', 'notes.tex', '--content', nextText, '--expected-sha256', original.sha256], { cwd: base });
  const applied = expectExit(apply, 0, 'hash-checked apply').data;
  assert.notEqual(applied.sha256, original.sha256);
  const staleApply = call(cliPath, ['project', 'apply', '--project', latex, '--file', 'notes.tex', '--content', 'stale update\n', '--expected-sha256', original.sha256], { cwd: base });
  assert.equal(expectExit(staleApply, 2, 'stale hash conflict').error.code, 'edit.hash_conflict');
  const search = call(cliPath, ['project', 'search', '--project', latex, '--query', 'Updated note text'], { cwd: base });
  assert.ok(expectExit(search, 0, 'search updated source').data.matches.some(item => item.file === 'notes.tex'));

  const escapedRead = call(cliPath, ['project', 'read', '--project', latex, '--file', '../../outside/secret.tex'], { cwd: base });
  assert.equal(expectExit(escapedRead, 2, 'project path escape').error.code, 'path.outside_project');

  const existingPdf = join(base, 'protected.pdf');
  const protectedBytes = Buffer.from('preserve this previous PDF exactly');
  await writeFile(existingPdf, protectedBytes);
  const noOverwrite = call(cliPath, ['compile', '--project', latex, '--main', 'main.tex', '--output', existingPdf], { cwd: base });
  assert.equal(expectExit(noOverwrite, 2, 'reject implicit overwrite').error.code, 'output.exists');
  assert.deepEqual(await readFile(existingPdf), protectedBytes);
  const failedOverwrite = call(cliPath, ['compile', '--project', syntax, '--main', 'main.tex', '--output', existingPdf, '--overwrite'], { cwd: base });
  assert.equal(expectExit(failedOverwrite, 1, 'failed compile with overwrite').error.code, 'compile.document_failed');
  assert.deepEqual(await readFile(existingPdf), protectedBytes, 'a failed compile preserves the previous output');
  const successfulOverwrite = call(cliPath, ['compile', '--project', latex, '--main', 'main.tex', '--output', existingPdf, '--overwrite'], { cwd: base });
  expectExit(successfulOverwrite, 0, 'explicit successful overwrite');
  assert.ok((await readFile(existingPdf)).subarray(0, 5).equals(Buffer.from('%PDF-')));

  const syntaxResult = call(cliPath, ['compile', '--project', syntax, '--main', 'main.tex'], { cwd: base });
  const syntaxEnvelope = expectExit(syntaxResult, 1, 'included-file syntax failure');
  assert.equal(syntaxEnvelope.error.code, 'compile.document_failed');
  const location = syntaxEnvelope.diagnostics.find(item => item.severity === 'error' && item.file?.endsWith('sections/broken.tex'));
  assert.ok(location, `compiler diagnostics should identify sections/broken.tex: ${JSON.stringify(syntaxEnvelope.diagnostics)}`);
  assert.ok(Number.isInteger(location.line) && location.line >= 1, `included-file diagnostic line must be known: ${JSON.stringify(location)}`);

  const missingResult = call(cliPath, ['compile', '--project', missing, '--main', 'main.tex'], { cwd: base });
  const missingEnvelope = expectExit(missingResult, 1, 'missing real TeX package');
  assert.equal(missingEnvelope.error.code, 'compile.document_failed');
  assert.equal((await walk(missing)).includes('sample.png'), false, 'missing dependencies do not create a sample asset');
  const missingImageResult = call(cliPath, ['compile', '--project', missingImage, '--main', 'main.tex'], { cwd: base });
  const missingImageEnvelope = expectExit(missingImageResult, 1, 'missing real image');
  assert.equal(missingImageEnvelope.error.code, 'compile.document_failed');
  const missingImageFiles = await walk(missingImage);
  assert.ok(!missingImageFiles.includes('sample.png') && !missingImageFiles.includes('assets/real-photo.png'), 'a missing real image does not create a sample or placeholder asset');

  const emptyResult = call(cliPath, ['project', 'inspect', '--project', empty], { cwd: base });
  assert.notEqual(expectExit(emptyResult, 0, 'empty project inspection').data.mainFile, 'main.tex');
  const createdProject = join(base, 'created-project');
  const createdResult = call(cliPath, ['project', 'create', '--project', createdProject, '--engine', 'typst', '--main', 'draft.typ'], { cwd: base });
  assert.equal(expectExit(createdResult, 0, 'create project').data.mainFile, 'draft.typ');
  assert.ok((await readFile(join(createdProject, 'draft.typ'), 'utf8')).length > 0);
  const malformedResult = call(cliPath, ['project', 'inspect', '--project', malformed], { cwd: base });
  assert.equal(expectExit(malformedResult, 2, 'malformed project config').error.code, 'project.config_invalid');
  const ambiguousResult = call(cliPath, ['project', 'inspect', '--project', ambiguous], { cwd: base });
  const ambiguousData = expectExit(ambiguousResult, 0, 'ambiguous project inspection').data;
  assert.equal(ambiguousData.mainFile, null, 'inspection must not guess among multiple main candidates');
  const ambiguousDiagnostics = call(cliPath, ['diagnostics', '--project', ambiguous], { cwd: base });
  assert.equal(expectExit(ambiguousDiagnostics, 2, 'ambiguous diagnostics').error.code, 'project.main_ambiguous');

  const symlinkPath = join(latex, 'linked-source.tex');
  try {
    await symlink(join(outside, 'secret.tex'), symlinkPath);
    await writeFile(join(outside, 'secret.tex'), 'private\n');
    const symlinkResult = call(cliPath, ['project', 'inspect', '--project', latex], { cwd: base });
    assert.equal(expectExit(symlinkResult, 2, 'symlink rejection').error.code, 'path.symlink_rejected');
    await unlink(symlinkPath);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP') {
      process.stdout.write(`SKIP symlink test: ${error.code}\n`);
    } else throw error;
  }
  if (process.platform !== 'win32') {
    const fifo = join(outside, 'special-file');
    const fifoCreated = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    if (fifoCreated.status === 0) {
      const specialProject = join(base, 'special-file-project');
      await mkdir(specialProject);
      await writeFile(join(specialProject, 'main.typ'), 'hello\n');
      const projectFifo = join(specialProject, 'special-file');
      const projectFifoCreated = spawnSync('mkfifo', [projectFifo], { encoding: 'utf8' });
      assert.equal(projectFifoCreated.status, 0, `create project FIFO: ${projectFifoCreated.stderr}`);
      const special = call(cliPath, ['project', 'inspect', '--project', specialProject], { cwd: base });
      assert.equal(expectExit(special, 2, 'special file rejection').error.code, 'path.symlink_rejected');
    } else {
      process.stdout.write('SKIP FIFO test: mkfifo is unavailable.\n');
    }
  }

  const beforeInfinite = await sourceSnapshot(infinite);
  await expectTimeout(cliPath, infinite);
  await expectSignalCancellation(cliPath, infinite, 120);
  await expectWorkerCrash(cliPath, infinite);
  await assertSourceSnapshot(infinite, beforeInfinite);
  await assertNoIntermediates(infinite);

  await runStrace(cliPath, latex, 'main.tex', join(base, 'strace-latex.pdf'), { label: 'strace-latex' });
  await runStrace(cliPath, typst, 'main.typ', join(base, 'strace-typst.pdf'), { label: 'strace-typst' });
  await runOfflineCacheScenarios(cliPath, base, latex);
  process.stdout.write(`Automation CLI fixture matrix passed. Fixtures: ${base}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
