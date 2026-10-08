import { copyFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repositoryRoot, 'src-tauri', 'Cargo.toml');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result.stdout;
}

try {
  const requestedProfile = process.argv.slice(2);
  if (requestedProfile.length > 1 || requestedProfile.some(value => value !== '--debug' && value !== '--release')) {
    throw new Error('Pass at most one profile flag: --debug or --release.');
  }
  if (requestedProfile.includes('--debug') && requestedProfile.includes('--release')) {
    throw new Error('The CLI build profile cannot be both debug and release.');
  }

  const rustInfo = run('rustc', ['-vV']);
  const target = process.env.TAURI_ENV_TARGET_TRIPLE
    ?? rustInfo.match(/^host: (.+)$/m)?.[1];
  if (!target) throw new Error('Unable to determine the Rust target triple.');
  const host = rustInfo.match(/^host: (.+)$/m)?.[1];

  const metadata = JSON.parse(run('cargo', ['metadata', '--manifest-path', manifestPath, '--no-deps', '--format-version', '1']));
  const targetDirectory = metadata.target_directory;
  const release = requestedProfile.includes('--release')
    || (!requestedProfile.includes('--debug') && process.env.TAURI_ENV_DEBUG !== 'true');
  const profile = release ? 'release' : 'debug';
  const buildArgs = ['build', '--manifest-path', manifestPath, '--bin', 'sciencebatch-cli'];
  if (target !== host) buildArgs.push('--target', target);
  if (release) buildArgs.push('--release');

  // A clean Rust check must not need a previously generated Tauri sidecar.
  run('cargo', buildArgs, { env: { ...process.env, TAURI_CONFIG: '{"bundle":{"externalBin":[]}}' } });

  const extension = target.includes('windows') ? '.exe' : '';
  const builtCli = target === host
    ? join(targetDirectory, profile, `sciencebatch-cli${extension}`)
    : join(targetDirectory, target, profile, `sciencebatch-cli${extension}`);
  const sidecarDirectory = join(repositoryRoot, 'src-tauri', 'binaries');
  const sidecarPath = join(sidecarDirectory, `sciencebatch-cli-${target}${extension}`);
  await mkdir(dirname(sidecarPath), { recursive: true });
  await copyFile(builtCli, sidecarPath);
  process.stderr.write(`Prepared ${sidecarPath}\n`);
} catch (error) {
  process.stderr.write(`Unable to prepare the ScienceBatch CLI sidecar: ${error.message}\n`);
  process.exitCode = 1;
}
