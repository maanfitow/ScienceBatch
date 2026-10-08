#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node scripts/test-resource-preparation.mjs [--cli PATH] [--interrupt-after-seconds N] [--wait-deadline-seconds N]',
  );
  process.exit(0);
}

const cli = resolve(option('--cli', 'src-tauri/target/debug/sciencebatch-cli'));
const duration = Number(option('--interrupt-after-seconds', '20'));
const deadline = Number(option('--wait-deadline-seconds', '300'));
if (!Number.isFinite(duration) || duration < 1 || duration > 120) {
  throw new Error('--interrupt-after-seconds must be between 1 and 120.');
}
if (!Number.isFinite(deadline) || deadline < duration || deadline > 600) {
  throw new Error('--wait-deadline-seconds must be at least the interrupt delay and at most 600.');
}

const root = await mkdtemp(join(tmpdir(), 'sciencebatch-resource-qa-'));
const cache = join(root, 'cache');
const output = join(root, 'output');
await mkdir(output);
const env = { ...process.env, TECTONIC_CACHE_DIR: cache };

async function run(args, name, { interruptAfterMs, minResources, resourceDirectory } = {}) {
  const stdoutPath = join(output, `${name}.stdout.json`);
  const stderrPath = join(output, `${name}.stderr.log`);
  const child = spawn(cli, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdoutChunks = [];
  const stderrChunks = [];
  let finished = false;
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  const closed = new Promise((resolveClose, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      finished = true;
      resolveClose({ code, signal });
    });
  });
  if (interruptAfterMs !== undefined) {
    const started = Date.now();
    let published = 0;
    try {
      while (Date.now() - started < deadline * 1000) {
        if (finished) {
          throw new Error(`${name} exited before the interruption checkpoint.`);
        }
        published = (await walkFiles(await resourceDirectory())).size;
        if (Date.now() - started >= interruptAfterMs && published > minResources) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
      }
      if (published <= minResources) {
        throw new Error(`${name} did not publish a new resource before the ${deadline}s deadline.`);
      }
      child.kill('SIGINT');
    } catch (error) {
      if (!finished) child.kill('SIGINT');
      await closed;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      await Promise.all([writeFile(stdoutPath, stdout), writeFile(stderrPath, stderr)]);
      throw error;
    }
  }
  const result = await closed;
  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  await Promise.all([writeFile(stdoutPath, stdout), writeFile(stderrPath, stderr)]);
  let envelope;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`${name} did not return one JSON envelope; see ${stdoutPath}: ${error}`);
  }
  return { ...result, envelope, stdoutPath, stderrPath };
}

async function status(name) {
  const result = await run(['resources', 'status', '--json'], name);
  if (result.code !== 0 || !result.envelope.ok || !result.envelope.data) {
    throw new Error(`${name} failed: ${result.envelope.error?.message ?? 'invalid status response'}`);
  }
  return result;
}

async function resourceDirectory() {
  const dataRoot = join(cache, 'bundles', 'data');
  let entries;
  try {
    entries = await readdir(dataRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return join(dataRoot, 'not-yet-created');
    throw error;
  }
  const digest = entries.find((entry) => entry.isDirectory() && /^[a-f\d]{64}$/i.test(entry.name));
  return digest ? join(dataRoot, digest.name) : join(dataRoot, 'not-yet-created');
}

async function walkFiles(directory, prefix = '') {
  const outputFiles = new Map();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return outputFiles;
    throw error;
  }
  for (const entry of entries) {
    const relative = join(prefix, entry.name);
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, metadata] of await walkFiles(fullPath, relative)) {
        outputFiles.set(name, metadata);
      }
    } else if (entry.isFile() && !entry.name.includes('-tmp-pid')) {
      try {
        const metadata = await stat(fullPath);
        outputFiles.set(relative, { size: metadata.size, mtimeMs: metadata.mtimeMs });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return outputFiles;
}

const args = ['resources', 'prepare', '--engine', 'latex', '--json'];
const first = await run(args, 'prepare-first', {
  interruptAfterMs: duration * 1000,
  minResources: 0,
  resourceDirectory,
});
const statusFirst = await status('status-first');
const filesFirst = await walkFiles(await resourceDirectory());
const second = await run(args, 'prepare-resume', {
  interruptAfterMs: duration * 1000,
  minResources: filesFirst.size,
  resourceDirectory,
});
const statusSecond = await status('status-second');
const filesSecond = await walkFiles(await resourceDirectory());

const preserved = [...filesFirst].every(([name, previous]) => {
  const current = filesSecond.get(name);
  return current && current.size === previous.size && current.mtimeMs === previous.mtimeMs;
});
const result = {
  cacheDirectory: cache,
  outputDirectory: output,
  firstExit: first.code,
  firstError: first.envelope.error?.code,
  firstCachedFiles: statusFirst.envelope.data?.cachedFiles,
  firstIndexedFiles: statusFirst.envelope.data?.expectedFiles,
  firstResourceFiles: filesFirst.size,
  resumeExit: second.code,
  resumeError: second.envelope.error?.code,
  resumeCachedFiles: statusSecond.envelope.data?.cachedFiles,
  resumedReady: statusSecond.envelope.data?.ready,
  preservedPreviouslyCachedFiles: preserved,
  newFilesOnResume: [...filesSecond.keys()].filter((name) => !filesFirst.has(name)).length,
  stdoutFiles: [first.stdoutPath, second.stdoutPath],
  stderrFiles: [first.stderrPath, second.stderrPath],
};
console.log(JSON.stringify(result, null, 2));

if (
  first.code !== 130 ||
  second.code !== 130 ||
  first.envelope.error?.code !== 'operation.interrupted' ||
  second.envelope.error?.code !== 'operation.interrupted' ||
  statusFirst.envelope.data?.expectedFiles < 1 ||
  filesFirst.size < 1 ||
  !preserved ||
  result.newFilesOnResume < 1
) {
  process.exitCode = 1;
}
