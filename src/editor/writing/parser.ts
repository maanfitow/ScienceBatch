import type { MatrixOptions, ParsedStructure, TableOptions } from '../../types/writing';
import { validateGroups } from './generate';
import { classifyLatexContext } from './context';

const TOKEN = /\\(begin|end)\s*\{([^}]+)\}/g;
const UNSUPPORTED = /\\(?:multicolumn|multirow|cline|cmidrule|newcolumntype|noalign|addlinespace|specialrule|rowcolor|begin\s*\{(?:tabularx|longtable|array)\})\b/;

function escaped(source: string, at: number): boolean {
  let count = 0;
  for (let i = at - 1; i >= 0 && source[i] === '\\'; i--) count++;
  return count % 2 === 1;
}
function uncommented(source: string): string {
  return source.split('\n').map((line) => {
    for (let i = 0; i < line.length; i++) if (line[i] === '%' && !escaped(line, i)) return line.slice(0, i) + ' '.repeat(line.length - i);
    return line;
  }).join('\n');
}
function matchingEnd(source: string, openStart: number, env: string): { end: number; closeStart: number } | null {
  const clean = uncommented(source);
  TOKEN.lastIndex = openStart;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(clean))) {
    if (escaped(clean, match.index) || match[2] !== env) continue;
    if (match[1] === 'begin') depth++;
    else if (--depth === 0) return { end: TOKEN.lastIndex, closeStart: match.index };
  }
  return null;
}
function group(source: string, start: number): { value: string; end: number } | null {
  let opening = start;
  while (/\s/.test(source[opening] ?? '')) opening++;
  if (source[opening] !== '{') return null;
  let depth = 1;
  for (let i = opening + 1; i < source.length; i++) {
    if (escaped(source, i)) continue;
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return { value: source.slice(opening + 1, i), end: i + 1 };
  }
  return null;
}
function splitRowsAndCells(body: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cellStart = 0;
  let depth = 0;
  let i = 0;
  const pushCell = (end: number) => { row.push(body.slice(cellStart, end).trim()); cellStart = end; };
  while (i < body.length) {
    const c = body[i];
    if (c === '%' && !escaped(body, i)) return null;
    if (depth === 0 && body.startsWith('\\\\', i)) {
      pushCell(i);
      rows.push(row); row = []; i += 2;
      if (body[i] === '*' || body[i] === '[') return null;
      if (body[i] === '\r') i++;
      if (body[i] === '\n') i++;
      while (body[i] === ' ' || body[i] === '\t') i++;
      cellStart = i; continue;
    }
    if (escaped(body, i)) { i++; continue; }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { if (--depth < 0) return null; i++; continue; }
    if (depth === 0 && c === '&') { pushCell(i); i++; cellStart = i; continue; }
    i++;
  }
  if (depth !== 0) return null;
  if (row.length > 0 || body.slice(cellStart).trim() || rows.length === 0) {
    pushCell(body.length);
    rows.push(row);
  }
  return rows;
}
function stripCanonicalRules(raw: string): { body: string; format: TableOptions['format']; rules: Array<{ name: string; afterRows: number }> } | null {
  const output: string[] = [];
  const rules: Array<{ name: string; afterRows: number }> = [];
  let format: TableOptions['format'] = 'plain';
  let afterRows = 0;
  for (const line of raw.split('\n')) {
    const token = line.trim();
    if (/^\\(?:hline|toprule|midrule|bottomrule)$/.test(token)) {
      const ruleFormat: TableOptions['format'] = token === '\\hline' ? 'grid' : 'booktabs';
      if (format !== 'plain' && format !== ruleFormat) return null;
      format = ruleFormat;
      rules.push({ name: token.slice(1), afterRows });
    } else {
      if (/\\(?:hline|toprule|midrule|bottomrule)\b/.test(line)) return null;
      output.push(line);
      if (/\\\\\s*$/.test(line)) afterRows++;
    }
  }
  return { body: output.join('\n').replace(/^\s*\n/, '').replace(/\n\s*$/, ''), format, rules };
}
function wholeCommandArgument(value: string, command: string): string | null {
  const trimmed = value.trim();
  const prefix = `\\${command}`;
  if (!trimmed.startsWith(prefix)) return null;
  const parsed = group(trimmed, prefix.length);
  return parsed && !trimmed.slice(parsed.end).trim() ? parsed.value : null;
}
function failure<T>(kind: 'table' | 'matrix', start: number, end: number, reason: string): ParsedStructure<T> {
  return { kind, start, end, value: null as T, compatible: false, reason };
}
function parseAt(source: string, offset: number): ParsedStructure<TableOptions | MatrixOptions> | null {
  const clean = uncommented(source);
  let parseOffset = offset;
  const floatStarts = [...clean.matchAll(/\\begin\s*\{table\}(?:\[[^\]]*\])?/g)];
  for (const float of floatStarts) {
    const floatStart = float.index ?? 0;
    const floatEnd = matchingEnd(source, floatStart, 'table');
    if (!floatEnd || offset < floatStart || offset > floatEnd.end) continue;
    const children = [...clean.slice(floatStart, floatEnd.end).matchAll(/\\begin\s*\{(tabular|tabularx|longtable|tabular\*)\}/g)];
    if (children.length !== 1 || children[0].index === undefined) return failure('table', floatStart, floatEnd.end, 'The floating table must contain exactly one supported tabular structure. Use Edit source to change it safely.');
    parseOffset = floatStart + children[0].index;
    break;
  }
  const unsupportedNames = new Set(['tabularx', 'longtable', 'tabular*', 'array', 'smallmatrix', 'dcases', 'rcases', 'drcases']);
  const unsupportedMatches = [...clean.matchAll(/\\begin\s*\{([^}]+)\}/g)];
  for (const match of unsupportedMatches) {
    const start = match.index ?? 0;
    const env = match[1];
    if (!unsupportedNames.has(env) || parseOffset < start) continue;
    const closing = matchingEnd(source, start, env);
    if (closing && parseOffset > closing.end) continue;
    return failure<TableOptions | MatrixOptions>(env.includes('tabular') || env === 'longtable' ? 'table' : 'matrix', start, closing?.end ?? source.length, closing ? 'This LaTeX environment is not supported by the writing tools. Use Edit source to change it safely.' : 'This LaTeX environment is not closed. Use Edit source to change it safely.');
  }
  const matches = [...clean.matchAll(/\\begin\s*\{(tabular|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}/g)];
  for (const match of matches) {
    const start = match.index ?? 0;
    const env = match[1];
    const closing = matchingEnd(source, start, env);
    if (!closing || parseOffset < start || parseOffset > closing.end) continue;
    const sourceContext = classifyLatexContext(source, start);
    if (sourceContext.context === 'blocked' || (env === 'tabular' && sourceContext.context !== 'text')) return failure(env === 'tabular' ? 'table' : 'matrix', start, closing.end, sourceContext.reason ?? 'This structure is not in a supported LaTeX context. Use Edit source to change it safely.');
    const beginEnd = start + match[0].length;
    const full = source.slice(start, closing.end);
    let hasComment = false;
    for (let i = 0; i < full.length; i++) if (full[i] === '%' && !escaped(full, i)) { hasComment = true; break; }
    if (UNSUPPORTED.test(full) || hasComment) return failure(env === 'tabular' ? 'table' : 'matrix', start, closing.end, 'This structure uses unsupported commands or comments. Use Edit source to change it safely.');
    if (env === 'tabular') {
      const alignGroup = group(source, beginEnd);
      if (!alignGroup || !/^[lcr|]+$/.test(alignGroup.value) || !/[lcr]/.test(alignGroup.value)) return failure('table', start, closing.end, 'Custom column specifications are not supported. Use Edit source to change it safely.');
      const rawBody = source.slice(alignGroup.end, closing.closeStart);
      const stripped = stripCanonicalRules(rawBody);
      if (!stripped) return failure('table', start, closing.end, 'Table rules must use supported standalone positions. Use Edit source to change it safely.');
      const hasPipes = alignGroup.value.includes('|');
      const pipeLayout = `|${alignGroup.value.replace(/\|/g, '').split('').join('|')}|`;
      if ((hasPipes && (alignGroup.value !== pipeLayout || stripped.format !== 'grid')) || (!hasPipes && !/^[lcr]+$/.test(alignGroup.value)) || (stripped.format === 'grid' && !hasPipes)) return failure('table', start, closing.end, 'Custom or partial border layouts are not supported. Use Edit source to change it safely.');
      const format: TableOptions['format'] = hasPipes ? 'grid' : stripped.format;
      const cells = splitRowsAndCells(stripped.body);
      if (!cells || cells.length === 0 || cells.some((row) => row.length !== cells[0].length)) return failure('table', start, closing.end, 'This table has unbalanced groups or inconsistent rows. Use Edit source to change it safely.');
      const columns = cells[0].length;
      const alignment = alignGroup.value.replace(/\|/g, '').split('') as Array<'l' | 'c' | 'r'>;
      if (!columns || columns > 10 || cells.length > 20 || alignment.length !== columns) return failure('table', start, closing.end, 'This table exceeds supported dimensions or has a custom column layout.');
      const firstRowHeader = cells[0].map((cell) => wholeCommandArgument(cell, 'textbf'));
      const header = firstRowHeader.every((cell) => cell !== null);
      const parsedCells = cells.map((row, ri) => row.map((cell, ci) => {
        if (header && ri === 0) return firstRowHeader[ci] ?? cell;
        return cell;
      }));
      const positions = stripped.rules.map((rule) => rule.afterRows);
      if (format === 'grid' && (stripped.rules.length !== parsedCells.length + 1 || stripped.rules.some((rule) => rule.name !== 'hline') || positions.some((position, i) => position !== i))) return failure('table', start, closing.end, 'Grid rules are not in supported positions. Use Edit source to change it safely.');
      const lastRule = stripped.rules[stripped.rules.length - 1];
      if (format === 'booktabs' && (stripped.rules[0]?.name !== 'toprule' || stripped.rules[0]?.afterRows !== 0 || lastRule?.name !== 'bottomrule' || lastRule.afterRows !== parsedCells.length || stripped.rules.slice(1, -1).some((rule) => rule.name !== 'midrule' || rule.afterRows !== 1) || stripped.rules.length > 3 || (stripped.rules.length === 3 && !header))) return failure('table', start, closing.end, 'Booktabs rules are not in supported positions. Use Edit source to change it safely.');
      if (format === 'plain' && stripped.rules.length > 0) return failure('table', start, closing.end, 'Plain tables cannot contain rules. Use Edit source to change it safely.');
      try { parsedCells.flat().forEach(validateGroups); } catch { return failure('table', start, closing.end, 'A table cell has an unbalanced group.'); }
      let structureStart = start;
      let structureEnd = closing.end;
      let caption: string | undefined;
      let label: string | undefined;
      const prefix = clean.slice(0, start);
      const wrapperMatches = [...prefix.matchAll(/\\begin\s*\{table\}(?:\[[^\]]*\])?/g)];
      const wrapper = wrapperMatches[wrapperMatches.length - 1];
      if (wrapper?.index !== undefined) {
        const wrapperEnd = matchingEnd(source, wrapper.index, 'table');
        if (wrapperEnd && wrapperEnd.end >= closing.end) {
          structureStart = wrapper.index; structureEnd = wrapperEnd.end;
          const opener = clean.slice(structureStart, start).match(/^\\begin\s*\{table\}\[htbp\]\s*\\centering\s*/);
          if (!opener) return failure('table', structureStart, structureEnd, 'The floating table wrapper uses unsupported placement or instructions. Use Edit source to change it safely.');
          let metadata = source.slice(structureStart + opener[0].length, start);
          if (metadata.startsWith('\\caption')) {
            const capGroup = group(metadata, '\\caption'.length);
            if (!capGroup) return failure('table', structureStart, structureEnd, 'The table caption is unbalanced. Use Edit source to change it safely.');
            caption = capGroup.value; metadata = metadata.slice(capGroup.end);
          }
          if (metadata.trimStart().startsWith('\\label')) {
            const lead = metadata.length - metadata.trimStart().length;
            metadata = metadata.slice(lead);
            const labelGroup = group(metadata, '\\label'.length);
            if (!metadata.startsWith('\\label') || !labelGroup) return failure('table', structureStart, structureEnd, 'The table label is unbalanced. Use Edit source to change it safely.');
            label = labelGroup.value; metadata = metadata.slice(labelGroup.end);
          }
          if (metadata.trim()) return failure('table', structureStart, structureEnd, 'The floating table contains unsupported metadata. Use Edit source to change it safely.');
          if (source.slice(closing.end, wrapperEnd.closeStart).trim()) return failure('table', structureStart, structureEnd, 'The floating table contains unsupported instructions. Use Edit source to change it safely.');
          if (label !== undefined && caption === undefined) return failure('table', structureStart, structureEnd, 'A table label requires a caption. Use Edit source to change it safely.');
        }
      }
      return { kind: 'table', start: structureStart, end: structureEnd, compatible: true, value: { rows: parsedCells.length, columns, cells: parsedCells, alignment, format, header, wrapInTable: structureStart !== start, caption, captionLatex: structureStart !== start, label, latexCells: true } };
    }
    const body = source.slice(beginEnd, closing.closeStart).replace(/^\s*\n/, '').replace(/\n\s*$/, '');
    const cells = splitRowsAndCells(body);
    if (!cells || cells.length === 0 || cells.some((row) => row.length !== cells[0].length)) return failure('matrix', start, closing.end, 'This matrix has unbalanced groups or inconsistent rows. Use Edit source to change it safely.');
    const columns = cells[0].length;
    if (!columns || columns > 12 || cells.length > 12) return failure('matrix', start, closing.end, 'This matrix exceeds supported dimensions.');
    try { cells.flat().forEach(validateGroups); } catch { return failure('matrix', start, closing.end, 'A matrix cell has an unbalanced group.'); }
    return { kind: 'matrix', start, end: closing.end, compatible: true, value: { rows: cells.length, columns, cells, environment: env as MatrixOptions['environment'] } };
  }
  const unclosed = [...clean.matchAll(/\\begin\s*\{(tabular|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}/g)].find((match) => (match.index ?? 0) <= parseOffset && !matchingEnd(source, match.index ?? 0, match[1]));
  return unclosed ? failure(unclosed[1] === 'tabular' ? 'table' : 'matrix', unclosed.index ?? 0, source.length, 'This structure is not closed. Use Edit source to change it safely.') : null;
}

/** Parses only a supported table or matrix containing the given UTF-16 offset. */
export function parseWritingStructureAt(source: string, offset: number): ParsedStructure<TableOptions | MatrixOptions> | null {
  return parseAt(source, offset);
}
