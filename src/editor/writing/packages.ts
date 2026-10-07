import type { PackageEditPlan, WritingChange } from '../../types/writing';

export interface PackageEligibility { eligible: boolean; reason?: string; preambleStart?: number; preambleEnd?: number }
interface PackageScan { loaded: Set<string>; uncertain: boolean }
const COMMAND_REQUIREMENTS: Record<string, string[]> = {
  mathbb: ['amsfonts'], iint: ['amsmath'], iiint: ['amsmath'], boxed: ['amsmath'],
};

function isEscaped(source: string, at: number): boolean {
  let n = 0;
  for (let i = at - 1; i >= 0 && source[i] === '\\'; i--) n++;
  return n % 2 === 1;
}
function uncommented(source: string): string {
  return source.split('\n').map((line) => {
    for (let i = 0; i < line.length; i++) if (line[i] === '%' && !isEscaped(line, i)) return line.slice(0, i) + ' '.repeat(line.length - i);
    return line;
  }).join('\n');
}
function skipSpace(source: string, from: number): number {
  let i = from;
  while (/\s/.test(source[i] ?? '')) i++;
  return i;
}
function balancedGroupEnd(source: string, opening: number): number {
  if (source[opening] !== '{') return -1;
  let depth = 1;
  for (let i = opening + 1; i < source.length; i++) {
    if (isEscaped(source, i)) continue;
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Counts literal package declarations at top level and flags macro or conditional package loading. */
function scanPackages(source: string): PackageScan {
  const text = uncommented(source);
  const loaded = new Set<string>();
  let uncertain = false;
  for (let i = 0; i < text.length;) {
    if (text[i] !== '\\' || isEscaped(text, i)) {
      if (text[i] === '{') {
        const end = balancedGroupEnd(text, i);
        if (end > 0) {
          if (/\\(?:usepackage|RequirePackage)\b/.test(text.slice(i, end))) uncertain = true;
          i = end; continue;
        }
      }
      i++; continue;
    }
    const command = text.slice(i).match(/^\\([a-zA-Z@]+)\*?/);
    if (!command) { i++; continue; }
    const name = command[1];
    if (/^if/.test(name) || name === 'AtBeginDocument' || name === 'AtEndPreamble') uncertain = true;
    const commandEnd = i + command[0].length;
    if (name === 'usepackage' || name === 'RequirePackage') {
      let argumentStart = skipSpace(text, commandEnd);
      if (text[argumentStart] === '[') {
        const optionEnd = text.indexOf(']', argumentStart + 1);
        if (optionEnd < 0) { uncertain = true; i = commandEnd; continue; }
        argumentStart = skipSpace(text, optionEnd + 1);
      }
      const end = balancedGroupEnd(text, argumentStart);
      if (end < 0) { uncertain = true; i = commandEnd; continue; }
      const list = text.slice(argumentStart + 1, end - 1).split(',').map((item) => item.trim());
      if (list.some((item) => !/^[a-zA-Z0-9_-]+$/.test(item))) uncertain = true;
      else list.forEach((item) => loaded.add(item));
      i = end; continue;
    }
    i = commandEnd;
  }
  return { loaded, uncertain };
}

export function inspectPackageEligibility(source: string): PackageEligibility {
  const activeSource = uncommented(source);
  const documentStart = activeSource.search(/\\begin\s*\{document\}/);
  const classMatch = activeSource.match(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^}]+\}/);
  if (documentStart < 0 || !classMatch || classMatch.index === undefined || classMatch.index > documentStart) {
    return { eligible: false, reason: 'A recognizable main-document preamble is required to add packages.' };
  }
  const className = classMatch[0].match(/\{([^}]+)\}$/)?.[1]?.trim();
  if (className && !new Set(['article', 'report', 'book', 'letter', 'proc', 'slides']).has(className)) return { eligible: false, reason: 'The document class may load packages conditionally, so package additions cannot be verified safely.' };
  const preamble = source.slice(0, documentStart);
  if (scanPackages(preamble).uncertain) return { eligible: false, reason: 'Package loading depends on conditional or macro logic that cannot be verified safely.' };
  return { eligible: true, preambleStart: 0, preambleEnd: documentStart };
}

export function planPackageAddition(source: string, requestedPackages: string[], range?: { start: number; end: number; anchor?: number; active?: number }): PackageEditPlan | null {
  const eligibility = inspectPackageEligibility(source);
  if (!eligibility.eligible || eligibility.preambleEnd === undefined) return null;
  if (range && (range.start < 0 || range.end < range.start || range.end > source.length)) return null;
  const preamble = uncommented(source.slice(0, eligibility.preambleEnd));
  const scan = scanPackages(preamble);
  if (scan.uncertain) return null;
  const requested = requestedPackages.map((name) => name.trim());
  if (requested.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name))) return null;
  const packagesToAdd = [...new Set(requested.filter((name) => !scan.loaded.has(name)))];
  if (packagesToAdd.length === 0) return { change: { start: eligibility.preambleEnd, end: eligibility.preambleEnd, text: '' }, packagesToAdd: [], verified: true };
  const insertAt = eligibility.preambleEnd;
  const prefix = insertAt > 0 && source[insertAt - 1] !== '\n' ? '\n' : '';
  const text = `${prefix}\\usepackage{${packagesToAdd.join(',')}}\n`;
  const shift = (value: number | undefined) => value === undefined ? undefined : value >= insertAt ? value + text.length : value;
  const selection = range?.anchor !== undefined && range.active !== undefined
    ? { anchor: shift(range.anchor)!, active: shift(range.active)! }
    : undefined;
  const change: WritingChange = { start: insertAt, end: insertAt, text, selection };
  return { change, packagesToAdd, verified: true };
}

export function inspectPackageLoadState(source: string, packages: string[]): { loaded: string[]; missing: string[]; uncertain: boolean } {
  const preambleEnd = uncommented(source).search(/\\begin\s*\{document\}/);
  const preamble = preambleEnd < 0 ? source : source.slice(0, preambleEnd);
  const scan = scanPackages(preamble);
  const className = uncommented(preamble).match(/\\documentclass(?:\[[^\]]*\])?\s*\{([^}]+)\}/)?.[1];
  const knownClasses = new Set(['article', 'report', 'book', 'letter', 'proc', 'slides']);
  const uncertain = scan.uncertain || Boolean(className && !knownClasses.has(className.trim()));
  return {
    loaded: packages.filter((name) => scan.loaded.has(name)),
    missing: packages.filter((name) => !scan.loaded.has(name)),
    uncertain,
  };
}

export function requiredPackagesInSource(source: string): string[] {
  const required = new Set<string>();
  const activeSource = uncommented(source);
  if (/\\begin\s*\{(?:matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}/.test(activeSource)) required.add('amsmath');
  if (/\\(?:toprule|midrule|bottomrule)\b/.test(activeSource)) required.add('booktabs');
  for (const match of activeSource.matchAll(/\\([a-zA-Z]+)\b/g)) {
    const names = COMMAND_REQUIREMENTS[match[1]];
    names?.forEach((name) => required.add(name));
  }
  return [...required];
}
