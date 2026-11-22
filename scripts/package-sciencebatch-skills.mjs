#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(repositoryRoot, 'dist');
const archivePath = join(outputDirectory, 'sciencebatch-skills.tar.gz');
const entries = [
  'skills',
  'scripts/install-sciencebatch-skills.mjs',
  'docs/AUTOMATION.md',
  'docs/CLI_SPEC.md',
];

try {
  await mkdir(outputDirectory, { recursive: true });
  const result = spawnSync('tar', ['-czf', archivePath, '--', ...entries], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`tar exited with status ${result.status}`);
  }
  process.stdout.write(`Packaged Skills and installation documentation at ${archivePath}\n`);
} catch (error) {
  process.stderr.write(`Unable to package ScienceBatch Skills: ${error.message}\n`);
  process.exitCode = 1;
}
