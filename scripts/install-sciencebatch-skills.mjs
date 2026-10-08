#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, '..', 'skills');
const installedManifestName = 'sciencebatch-skills.manifest.json';

function usage() {
  process.stdout.write(`Usage: node scripts/install-sciencebatch-skills.mjs --destination DIR [--overwrite]\n\n`);
}

function parseArguments(args) {
  let destination;
  let overwrite = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      return { help: true };
    }
    if (argument === '--destination') {
      if (destination || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw new Error('--destination must be supplied once with a directory path.');
      }
      destination = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--overwrite') {
      if (overwrite) throw new Error('--overwrite may be supplied only once.');
      overwrite = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!destination) throw new Error('--destination is required; the installer has no default location.');
  return { destination, overwrite, help: false };
}

async function readManifest() {
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'manifest.json'), 'utf8'));
  if (
    manifest.package !== 'sciencebatch-skills' ||
    typeof manifest.version !== 'string' ||
    !Array.isArray(manifest.skills) ||
    manifest.skills.length !== 8 ||
    new Set(manifest.skills).size !== 8
  ) {
    throw new Error('The bundled Skill manifest is invalid.');
  }
  for (const skillName of manifest.skills) {
    if (!/^[a-z0-9-]+$/.test(skillName)) throw new Error(`Invalid Skill name in manifest: ${skillName}`);
    const skillPath = path.join(packageDirectory, skillName);
    const skillInfo = await lstat(skillPath);
    if (!skillInfo.isDirectory() || skillInfo.isSymbolicLink()) {
      throw new Error(`Skill source must be a regular directory: ${skillName}`);
    }
    const frontmatter = await readFile(path.join(skillPath, 'SKILL.md'), 'utf8');
    if (!frontmatter.startsWith('---\n') || !frontmatter.includes(`name: ${skillName}\n`)) {
      throw new Error(`Skill frontmatter does not match its manifest name: ${skillName}`);
    }
  }
  return manifest;
}

async function ensureNoSourceSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const details = await lstat(entryPath);
    if (details.isSymbolicLink()) throw new Error(`Bundled Skill contains a symlink: ${entryPath}`);
    if (details.isDirectory()) await ensureNoSourceSymlinks(entryPath);
    else if (!details.isFile()) throw new Error(`Bundled Skill contains an unsupported filesystem entry: ${entryPath}`);
  }
}

async function inspectTarget(targetPath, skillName, overwrite) {
  let details;
  try {
    details = await lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`Refusing to replace a non-directory or symlink: ${targetPath}`);
  }
  if (!overwrite) throw new Error(`Destination already contains ${skillName}; use --overwrite to replace this ScienceBatch Skill.`);
  const skillFrontmatter = await readFile(path.join(targetPath, 'SKILL.md'), 'utf8').catch(() => '');
  if (!skillFrontmatter.startsWith('---\n') || !skillFrontmatter.includes(`name: ${skillName}\n`)) {
    throw new Error(`Refusing to overwrite a directory that is not the matching ScienceBatch Skill: ${targetPath}`);
  }
  return true;
}

async function inspectManifest(targetPath, overwrite) {
  let details;
  try {
    details = await lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Refusing to replace a non-file or symlink: ${targetPath}`);
  }
  if (!overwrite) throw new Error(`Destination already contains ${installedManifestName}; use --overwrite to replace this ScienceBatch package.`);
  const existing = JSON.parse(await readFile(targetPath, 'utf8'));
  if (existing.package !== 'sciencebatch-skills') {
    throw new Error(`Refusing to overwrite an unrelated manifest: ${targetPath}`);
  }
  return true;
}

async function install(destinationArgument, overwrite) {
  const manifest = await readManifest();
  for (const skillName of manifest.skills) {
    await ensureNoSourceSymlinks(path.join(packageDirectory, skillName));
  }

  const destination = path.resolve(destinationArgument);
  await mkdir(destination, { recursive: true });
  const destinationDetails = await lstat(destination);
  if (destinationDetails.isSymbolicLink() || !destinationDetails.isDirectory()) {
    throw new Error('--destination must resolve to a real directory, not a symlink or file.');
  }
  const canonicalDestination = await realpath(destination);
  const replaceTargets = [];
  for (const skillName of manifest.skills) {
    const target = path.join(canonicalDestination, skillName);
    const existed = await inspectTarget(target, skillName, overwrite);
    replaceTargets.push({ name: skillName, target, existed });
  }
  const installedManifest = path.join(canonicalDestination, installedManifestName);
  const manifestExisted = await inspectManifest(installedManifest, overwrite);
  replaceTargets.push({ name: installedManifestName, target: installedManifest, existed: manifestExisted });

  const stage = path.join(canonicalDestination, `.sciencebatch-skills-stage-${process.pid}-${randomUUID()}`);
  await mkdir(stage, { recursive: false });
  const installed = [];
  let preserveStageForRecovery = false;
  try {
    for (const skillName of manifest.skills) {
      await cp(path.join(packageDirectory, skillName), path.join(stage, skillName), { recursive: true, errorOnExist: true, force: false });
    }
    await cp(path.join(packageDirectory, 'manifest.json'), path.join(stage, installedManifestName), { errorOnExist: true, force: false });

    for (const item of replaceTargets) {
      const backup = path.join(stage, `backup-${item.name}`);
      const staged = path.join(stage, item.name === installedManifestName ? installedManifestName : item.name);
      const record = { ...item, backup, movedOld: false, movedNew: false };
      installed.push(record);
      if (item.existed) {
        await rename(item.target, backup);
        record.movedOld = true;
      }
      await rename(staged, item.target);
      record.movedNew = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of installed.reverse()) {
      if (item.movedNew) {
        try {
          await rm(item.target, { recursive: true, force: true });
        } catch (rollbackError) {
          rollbackErrors.push(`could not remove ${item.target}: ${rollbackError.message}`);
        }
      }
      if (item.movedOld) {
        try {
          await rename(item.backup, item.target);
        } catch (rollbackError) {
          rollbackErrors.push(`could not restore ${item.backup} to ${item.target}: ${rollbackError.message}`);
        }
      }
    }
    if (rollbackErrors.length > 0) {
      preserveStageForRecovery = true;
      throw new Error(`Installation failed: ${error.message}. Rollback was incomplete; recovery files are preserved in ${stage}. ${rollbackErrors.join('; ')}`);
    }
    throw error;
  } finally {
    if (!preserveStageForRecovery) await rm(stage, { recursive: true, force: true });
  }
  process.stdout.write(`Installed ScienceBatch Skills ${manifest.version} to ${canonicalDestination}\n`);
  process.stdout.write(`Skills: ${manifest.skills.join(', ')}\n`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    usage();
  } else {
    await install(options.destination, options.overwrite);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
