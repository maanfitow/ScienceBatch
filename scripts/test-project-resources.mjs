#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const cli = resolve(option('--cli', 'src-tauri/target/debug/sciencebatch-cli'));
const projectArg = option('--project', undefined);
const matrixMode = process.argv.includes('--matrix');
const matrixRoot = resolve(option('--matrix-root', '/tmp/sciencebatch-resource-fixtures-3celjf13'));
const main = option('--main', 'main.tex');
const doPrepare = process.argv.includes('--prepare');
const doCompile = process.argv.includes('--compile');
const doCorruption = process.argv.includes('--corrupt');
const selection = option('--selection', '[{"kind":"pack","id":"latex-basic"}]');
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/test-project-resources.mjs --project DIR [--main REL] [--cli PATH] [--selection JSON] [--prepare] [--compile] [--corrupt]');
  console.log('       node scripts/test-project-resources.mjs --matrix --prepare --compile [--matrix-root DIR] [--cache-dir DIR] [--cli PATH]');
  console.log('The default run analyzes only. --prepare explicitly downloads selected pinned resources; --compile explicitly invokes the engine.');
  process.exit(0);
}
if (!projectArg && !matrixMode) throw new Error('--project is required unless --matrix is selected.');
if (matrixMode && (!doPrepare || !doCompile)) {
  throw new Error('--matrix requires both --prepare and --compile because every fixture run is explicit.');
}
const project = projectArg ? resolve(projectArg) : null;
const selectionValue = JSON.parse(selection);
if (!Array.isArray(selectionValue)) throw new Error('--selection must decode to a JSON array.');
const qaRoot = await mkdtemp(join(tmpdir(), 'sciencebatch-project-resources-'));
const cache = resolve(option('--cache-dir', join(qaRoot, 'cache')));
const receipts = join(qaRoot, 'receipts');
await mkdir(receipts);
const env = { ...process.env, TECTONIC_CACHE_DIR: cache };
const traceAvailable = process.platform === 'linux' && await commandAvailable('strace');
const results = {};

async function commandAvailable(name) {
  return new Promise((resolveResult) => {
    const child = spawn('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    child.once('close', (code) => resolveResult(code === 0));
    child.once('error', () => resolveResult(false));
  });
}

async function run(args, label, { trace = false, expectFailure = false } = {}) {
  const stdoutPath = join(receipts, `${label}.stdout.json`);
  const stderrPath = join(receipts, `${label}.stderr.log`);
  const tracePath = join(receipts, `${label}.connect.trace`);
  const command = trace && traceAvailable
    ? ['strace', ['-f', '-e', 'trace=connect', '-o', tracePath, cli, ...args]]
    : [cli, args];
  const child = spawn(command[0], command[1], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exit = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  const stdoutText = Buffer.concat(stdout).toString('utf8');
  const stderrText = Buffer.concat(stderr).toString('utf8');
  await Promise.all([writeFile(stdoutPath, stdoutText), writeFile(stderrPath, stderrText)]);
  let envelope;
  try {
    envelope = JSON.parse(stdoutText.trim());
  } catch (error) {
    throw new Error(`${label} did not emit one JSON envelope (${stdoutPath}): ${error}`);
  }
  if (expectFailure) {
    if (exit.code === 0 || envelope.ok) throw new Error(`${label} unexpectedly succeeded.`);
    return { ...exit, envelope, stdoutPath, stderrPath, tracePath: trace && traceAvailable ? tracePath : null };
  }
  if (exit.code !== 0 || !envelope.ok) {
    throw new Error(`${label} failed with ${envelope.error?.code ?? exit.code}: ${envelope.error?.message ?? ''} (${stdoutPath})`);
  }
  return { ...exit, envelope, stdoutPath, stderrPath, tracePath: trace && traceAvailable ? tracePath : null };
}

function resourceArgs(command, extra = []) {
  return [
    'resources', command,
    '--project', project,
    '--engine', 'latex',
    '--main', main,
    '--selection', JSON.stringify(selectionValue),
    ...extra,
    '--json',
  ];
}

function projectResourceArgs(selectedProject, selectedMain, selectedSelection, command, extra = []) {
  return [
    'resources', command,
    '--project', selectedProject,
    '--engine', 'latex',
    '--main', selectedMain,
    '--selection', JSON.stringify(selectedSelection),
    ...extra,
    '--json',
  ];
}

async function assertNoConnect(result) {
  if (!result.tracePath) return 'unverified (strace unavailable)';
  const trace = await readFile(result.tracePath, 'utf8');
  if (/connect\(/.test(trace)) throw new Error(`${result.tracePath} recorded a network connect() call.`);
  return 'zero connect() calls';
}

if (matrixMode) {
  const cases = [
    ['article-basic', join(matrixRoot, 'article'), [{ kind: 'pack', id: 'latex-basic' }]],
    ['IEEEtran', join(matrixRoot, 'IEEEtran'), [{ kind: 'pack', id: 'latex-ieeetran' }]],
    ['acmart', join(matrixRoot, 'acmart'), [{ kind: 'pack', id: 'latex-acmart' }]],
    ['llncs', join(matrixRoot, 'llncs'), [{ kind: 'pack', id: 'latex-llncs' }]],
    ['curve', join(matrixRoot, 'curve'), [{ kind: 'pack', id: 'latex-curve' }]],
    ['beamer', join(matrixRoot, 'beamer'), [{ kind: 'pack', id: 'latex-beamer' }]],
    ['fontawesome5', join(matrixRoot, 'fontawesome5'), [{ kind: 'pack', id: 'latex-fontawesome5' }]],
    ['simpleicons', join(matrixRoot, 'simpleicons'), []],
    ['academicons', join(matrixRoot, 'academicons'), [{ kind: 'pack', id: 'latex-academicons' }]],
    ['resume-fontspec', '/tmp/sciencebatch-resume-fontspec-fxgcfhrk', [
      { kind: 'package', id: 'cochineal' },
      { kind: 'package', id: 'cabin' },
      { kind: 'package', id: 'inconsolata' },
    ]],
  ];
  const matrix = [];
  for (const [name, selectedProject, selectedSelection] of cases) {
    if (!(await exists(join(selectedProject, main)))) {
      throw new Error(`Missing matrix fixture source: ${join(selectedProject, main)}`);
    }
    const analyze = await run(
      projectResourceArgs(selectedProject, main, selectedSelection, 'analyze'),
      `${name}-analyze`,
      { trace: true },
    );
    const analyzeNetwork = await assertNoConnect(analyze);
    const prepare = await run(
      projectResourceArgs(selectedProject, main, selectedSelection, 'prepare-project', [
        '--expected-plan-digest', analyze.envelope.data.planDigest,
      ]),
      `${name}-prepare`,
    );
    const compile = await run([
      'compile', '--project', selectedProject, '--engine', 'latex', '--main', main, '--json',
    ], `${name}-compile`, { trace: true });
    const compileNetwork = await assertNoConnect(compile);
    const hotAnalyze = await run(
      projectResourceArgs(selectedProject, main, selectedSelection, 'analyze'),
      `${name}-hot-analyze`,
    );
    const hot = await run(
      projectResourceArgs(selectedProject, main, selectedSelection, 'prepare-project', [
        '--expected-plan-digest', hotAnalyze.envelope.data.planDigest,
      ]),
      `${name}-hot-prepare`,
    );
    if (Number(hot.envelope.data.bytesDownloaded ?? -1) !== 0) {
      throw new Error(`${name} hot prepare transferred bytes.`);
    }
    if (compile.envelope.data.success !== true) {
      throw new Error(`${name} did not compile from the shared cache.`);
    }
    matrix.push({
      fixture: name,
      project: selectedProject,
      selection: selectedSelection,
      selectedResourceCount: prepare.envelope.data.plan?.summary?.totalResources,
      newlyPreparedFileCount: prepare.envelope.data.files,
      indexedBytes: prepare.envelope.data.incrementalStorageBytes,
      firstAttemptTransferEstimateBytes: prepare.envelope.data.firstAttemptTransferEstimateBytes,
      budgetChargedBytes: prepare.envelope.data.budgetChargedBytes,
      exactBytesDownloaded: prepare.envelope.data.bytesDownloaded,
      cacheVerifiedResourceCountAfterPreparation: prepare.envelope.data.plan?.summary?.cachedVerifiedResources,
      analyzeNetwork,
      compileNetwork,
      pdfByteLength: compile.envelope.data.pdfByteLength,
      hotBytesDownloaded: hot.envelope.data.bytesDownloaded,
      cacheBytesAfterFixture: await treeBytes(cache),
      planDigest: prepare.envelope.data.planDigest,
    });
  }
  const report = { qaRoot, cache, receipts, unionCacheBytes: await treeBytes(cache), matrix };
  await writeFile(join(receipts, 'matrix-summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const initialCache = await exists(cache);
results.analyze = await run(resourceArgs('analyze'), 'analyze', { trace: true });
results.analyze.network = await assertNoConnect(results.analyze);
results.plan = await run(resourceArgs('plan', [
  '--expected-input-digest', results.analyze.envelope.data.inputDigest,
]), 'plan', { trace: true });
results.plan.network = await assertNoConnect(results.plan);
results.list = await run(resourceArgs('list', [
  '--expected-plan-digest', results.plan.envelope.data.planDigest,
  '--limit', '20',
]), 'list', { trace: true });
results.list.network = await assertNoConnect(results.list);
if (!initialCache && await exists(cache)) throw new Error('Analysis created a cache directory.');
results.cacheUnchangedByAnalysis = !(await exists(cache));

const staleProject = join(qaRoot, 'stale-project');
await mkdir(staleProject);
const source = await readFile(join(project, main), 'utf8');
await writeFile(join(staleProject, main), source);
const staleAnalysis = await run([
  'resources', 'analyze', '--project', staleProject, '--engine', 'latex', '--main', main,
  '--selection', JSON.stringify(selectionValue), '--json',
], 'stale-analyze');
await writeFile(join(staleProject, main), `${source}\n% snapshot changed after analysis\n`);
const stalePrepare = await run([
  'resources', 'prepare-project', '--project', staleProject, '--engine', 'latex', '--main', main,
  '--selection', JSON.stringify(selectionValue), '--expected-plan-digest', staleAnalysis.envelope.data.planDigest,
  '--json',
], 'stale-prepare', { expectFailure: true });
results.stalePlanRejected = stalePrepare.envelope.error?.code;
if (!results.stalePlanRejected || await exists(cache)) {
  throw new Error('Stale preparation was not rejected before creating cache state.');
}

if (doPrepare) {
  results.prepare = await run(resourceArgs('prepare-project', [
    '--expected-plan-digest', results.plan.envelope.data.planDigest,
  ]), 'prepare', { trace: true });
  results.prepareData = results.prepare.envelope.data;
  if (!results.prepareData.prepared) throw new Error('Selective preparation did not report prepared=true.');
  if (results.prepareData.bytesDownloaded === undefined) {
    throw new Error('Preparation response omitted the bytesDownloaded field.');
  }
  const status = await run(['resources', 'status', '--json'], 'status');
  results.statusData = status.envelope.data;
  results.bundleCacheBytes = await treeBytes(cache);

  const hotPlan = await run(resourceArgs('analyze'), 'hot-analyze');
  const hotPrep = await run(resourceArgs('prepare-project', [
    '--expected-plan-digest', hotPlan.envelope.data.planDigest,
  ]), 'hot-prepare');
  results.hotPrepareData = hotPrep.envelope.data;
  if (Number(results.hotPrepareData.bytesDownloaded ?? -1) !== 0) {
    throw new Error('Hot preparation transferred bytes instead of reusing the verified cache.');
  }

  const mainSource = source;
  const reuseProject = join(qaRoot, 'reuse-project');
  await mkdir(dirname(join(reuseProject, main)), { recursive: true });
  await writeFile(join(reuseProject, main), mainSource);
  const reuseAnalyze = await run([
    'resources', 'analyze', '--project', reuseProject, '--engine', 'latex', '--main', main,
    '--selection', JSON.stringify(selectionValue), '--json',
  ], 'reuse-analyze');
  const reusePrep = await run([
    'resources', 'prepare-project', '--project', reuseProject, '--engine', 'latex', '--main', main,
    '--selection', JSON.stringify(selectionValue), '--expected-plan-digest', reuseAnalyze.envelope.data.planDigest,
    '--json',
  ], 'reuse-prepare');
  results.sharedCacheReuse = reusePrep.envelope.data;
  if (Number(results.sharedCacheReuse.bytesDownloaded ?? -1) !== 0) {
    throw new Error('Second project did not reuse the first project cache.');
  }

  if (doCorruption) {
    const bundleDigest = results.analyze.envelope.data.bundleDigest;
    const cacheData = join(cache, 'bundles', 'data', bundleDigest);
    const candidates = results.list.envelope.data.items
      .filter((entry) => entry.itemType === 'requirement' && entry.item?.path)
      .map((entry) => entry.item.path);
    const cachedPath = candidates[0];
    if (!cachedPath) throw new Error('Plan contains no indexed file for the corruption test.');
    const target = join(cacheData, cachedPath);
    const original = await readFile(target);
    if (original.length === 0) throw new Error('Selected corruption-test resource is empty.');
    await writeFile(target, Buffer.alloc(original.length, 0x58));
    const corruptAnalyze = await run(resourceArgs('analyze'), 'corrupt-analyze');
    results.corruptionDetected = corruptAnalyze.envelope.data.summary.invalidResources > 0;
    if (!results.corruptionDetected) throw new Error(`Corrupted cache entry ${cachedPath} was not reported invalid.`);
    const repaired = await run([
      'resources', 'prepare-project', '--project', project, '--engine', 'latex', '--main', main,
      '--selection', JSON.stringify(selectionValue),
      '--expected-plan-digest', corruptAnalyze.envelope.data.planDigest,
      '--json',
    ], 'corruption-repair');
    results.corruptionRepair = repaired.envelope.data;
    const verified = await readFile(target);
    if (!verified.equals(original)) throw new Error(`Preparation did not restore pinned bytes for ${cachedPath}.`);
  }
}

if (doCompile) {
  if (!doPrepare) throw new Error('--compile requires --prepare to ensure this isolated cache has the selected resources.');
  const compile = await run([
    'compile', '--project', project, '--engine', 'latex', '--main', main, '--json',
  ], 'offline-compile', { trace: true });
  results.compile = compile.envelope.data;
  results.compile.network = await assertNoConnect(compile);
}

results.evidence = {
  qaRoot,
  cache,
  receipts,
  traceAvailable,
  preparedResourceCacheBytes: results.bundleCacheBytes ?? null,
  firstAttemptTransferEstimateBytes: results.prepareData?.firstAttemptTransferEstimateBytes ?? null,
  budgetChargedBytes: results.prepareData?.budgetChargedBytes ?? null,
  exactSuccessfulBytesDownloaded: results.prepareData?.bytesDownloaded ?? null,
  hotBytesDownloaded: results.hotPrepareData?.bytesDownloaded ?? null,
};
await writeFile(join(receipts, 'summary.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.evidence, null, 2));

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function treeBytes(path) {
  if (!(await exists(path))) return 0;
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await treeBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}
