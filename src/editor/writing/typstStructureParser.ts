import type {
  ParsedTypstStructure,
  TypstAlignment,
  TypstMatrixDelimiter,
  TypstMatrixOptions,
  TypstTableFormat,
  TypstTableOptions,
} from '../../types/typstWriting';
import { validateTypstMatrixCell, validateTypstTableCell } from './typstStructureValidation';

type Group = { start: number; end: number; bodyStart: number; bodyEnd: number };
type Argument = { source: string; start: number; end: number };
type Call = { name: string; start: number; open: number; end: number; bodyStart: number; bodyEnd: number; args: Argument[] };
type ScanMode = 'markup' | 'math' | 'code';
type GroupFrame = { closing: string; mode: ScanMode; restoreMode?: ScanMode };

const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const alignments = new Set<TypstAlignment>(['left', 'center', 'right']);
const delimiters: Record<string, TypstMatrixDelimiter> = {
  '': 'none', '(': 'parentheses', '[': 'brackets', '{': 'braces', '|': 'single-bars', '‖': 'double-bars',
};

function isEscaped(source: string, index: number): boolean {
  let count = 0;
  while (index > 0 && source[index - 1] === '\\') { count++; index--; }
  return count % 2 === 1;
}

/** Scan a Typst group while treating strings, raw spans, and comments as opaque. */
function scanGroup(source: string, start: number, initialMode: ScanMode = source[start] === '[' ? 'markup' : 'code'): Group | null {
  const closing = pairs[source[start]];
  if (!closing) return null;
  let mode: ScanMode = initialMode;
  let mathGroupDepth: number | undefined;
  const stack: GroupFrame[] = [{ closing, mode }];
  for (let i = start + 1; i < source.length;) {
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i + 2);
      if (newline < 0) return null;
      i = newline + 1; continue;
    }
    if (source.startsWith('/*', i)) {
      const end = scanBlockComment(source, i);
      if (end < 0) return null;
      i = end; continue;
    }
    if (source[i] === '"' && mode !== 'markup') {
      const end = scanString(source, i);
      if (end < 0) return null;
      i = end; continue;
    }
    if (source[i] === '`') {
      const end = scanRaw(source, i);
      if (end < 0) return null;
      i = end; continue;
    }
    if (source[i] === '\\' && mode === 'markup') { i += 2; continue; }
    if (source[i] === '$' && mode !== 'code') {
      if (mode === 'markup') { mathGroupDepth = stack.length; mode = 'math'; }
      else {
        if (mathGroupDepth === undefined || stack.length !== mathGroupDepth) return null;
        mathGroupDepth = undefined; mode = 'markup';
      }
      i++; continue;
    }
    if (source[i] === '#' && mode !== 'code') {
      const codeEnd = codeGroupAt(source, i);
      if (codeEnd) {
        stack.push({ closing: pairs[source[codeEnd.open]], mode: 'code', restoreMode: mode });
        mode = 'code'; i = codeEnd.open + 1; continue;
      }
    }
    if (mode === 'markup') {
      if (source[i] === '[') { stack.push({ closing: ']', mode }); i++; continue; }
      if (source[i] === ']') {
        const group = stack.pop();
        if (group?.closing !== ']' || group.mode !== mode) return null;
        if (group.restoreMode) mode = group.restoreMode;
        if (stack.length === 0) return { start, end: i + 1, bodyStart: start + 1, bodyEnd: i };
        i++; continue;
      }
      i++; continue;
    }
    if (mode === 'code' && source[i] === '[') {
      stack.push({ closing: ']', mode: 'markup', restoreMode: 'code' });
      mode = 'markup'; i++; continue;
    }
    const expected = pairs[source[i]];
    if (expected) { stack.push({ closing: expected, mode }); i++; continue; }
    if (source[i] === ')' || source[i] === ']' || source[i] === '}') {
      const group = stack.pop();
      if (group?.closing !== source[i] || group.mode !== mode) return null;
      if (group.restoreMode) mode = group.restoreMode;
      if (stack.length === 0) return { start, end: i + 1, bodyStart: start + 1, bodyEnd: i };
    }
    i++;
  }
  return null;
}

function codeGroupAt(source: string, hash: number): { open: number } | null {
  let index = hash + 1;
  if (!/[\p{L}_]/u.test(source[index] ?? '')) return null;
  index++;
  while (index < source.length && /[\p{L}\p{N}_.-]/u.test(source[index])) index++;
  while (index < source.length && /\s/u.test(source[index]) && source[index] !== '\n') index++;
  return source[index] === '(' || source[index] === '{' ? { open: index } : null;
}

function scanBlockComment(source: string, start: number): number {
  let depth = 1;
  for (let i = start + 2; i < source.length;) {
    if (source.startsWith('/*', i)) { depth++; i += 2; }
    else if (source.startsWith('*/', i)) { depth--; i += 2; if (!depth) return i; }
    else i++;
  }
  return -1;
}

function scanString(source: string, start: number): number {
  for (let i = start + 1; i < source.length;) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === '"') return i + 1;
    i++;
  }
  return -1;
}

function scanRaw(source: string, start: number): number {
  let markerEnd = start;
  while (source[markerEnd] === '`') markerEnd++;
  const marker = '`'.repeat(markerEnd - start);
  const close = source.indexOf(marker, markerEnd);
  return close < 0 ? -1 : close + marker.length;
}

function splitTopLevel(source: string, start: number, end: number, delimiter: ',' | ';', groupMode: ScanMode = 'code'): Argument[] | null {
  const items: Argument[] = [];
  let itemStart = start;
  for (let i = start; i < end;) {
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i + 2);
      if (newline < 0 || newline >= end) return null;
      i = newline + 1; continue;
    }
    if (source.startsWith('/*', i)) {
      const close = scanBlockComment(source, i);
      if (close < 0 || close > end) return null;
      i = close; continue;
    }
    if (source[i] === '"' || source[i] === '`') {
      const next = source[i] === '"' ? scanString(source, i) : scanRaw(source, i);
      if (next < 0 || next > end) return null;
      i = next; continue;
    }
    if (pairs[source[i]]) {
      const mode: ScanMode = source[i] === '[' && groupMode === 'code' ? 'markup' : groupMode;
      const group = scanGroup(source, i, mode);
      if (!group || group.end > end) return null;
      i = group.end; continue;
    }
    if (source[i] === delimiter) {
      items.push({ source: source.slice(itemStart, i).trim(), start: itemStart, end: i });
      itemStart = i + 1;
    }
    i++;
  }
  const last = source.slice(itemStart, end).trim();
  if (last) items.push({ source: last, start: itemStart, end });
  return items;
}

function parseCallAt(source: string, start: number, expectedName: string, groupMode: ScanMode = 'code'): Call | null {
  if (source.slice(start, start + expectedName.length) !== expectedName) return null;
  const before = source[start - 1];
  const afterName = source[start + expectedName.length];
  if (before && before !== '#' && /[\p{L}\p{N}_#.]/u.test(before)) return null;
  if (afterName && /[\p{L}\p{N}_]/u.test(afterName)) return null;
  let open = start + expectedName.length;
  while (/\s/.test(source[open] ?? '')) open++;
  const group = scanGroup(source, open, groupMode);
  if (!group || source[open] !== '(') return null;
  const args = splitTopLevel(source, group.bodyStart, group.bodyEnd, ',', groupMode);
  return args ? { name: expectedName, start, open, end: group.end, bodyStart: group.bodyStart, bodyEnd: group.bodyEnd, args } : null;
}

function cleanArgument(argument: Argument): string { return argument.source.trim(); }

function namedArgument(argument: Argument): { name: string; value: string } | null {
  const source = cleanArgument(argument);
  const colon = topLevelColon(source);
  if (colon < 0) return null;
  return { name: source.slice(0, colon).trim(), value: source.slice(colon + 1).trim() };
}

function topLevelColon(source: string): number {
  for (let i = 0; i < source.length;) {
    if (source[i] === '"' || source[i] === '`') {
      const next = source[i] === '"' ? scanString(source, i) : scanRaw(source, i);
      if (next < 0) return -1;
      i = next; continue;
    }
    if (pairs[source[i]]) { const group = scanGroup(source, i); if (!group) return -1; i = group.end; continue; }
    if (source[i] === ':') return i;
    i++;
  }
  return -1;
}

function hasComment(source: string, initialMode: ScanMode = 'code'): boolean {
  const stack: GroupFrame[] = [];
  let mode: ScanMode = initialMode;
  let mathGroupDepth: number | undefined;
  for (let i = 0; i < source.length;) {
    if (source.startsWith('//', i) || source.startsWith('/*', i)) return true;
    if (source[i] === '"' && mode !== 'markup') {
      const next = scanString(source, i);
      if (next < 0) return true;
      i = next; continue;
    }
    if (source[i] === '`') {
      const next = scanRaw(source, i);
      if (next < 0) return true;
      i = next; continue;
    }
    if (source[i] === '\\' && mode === 'markup') { i += 2; continue; }
    if (source[i] === '$' && mode !== 'code') {
      if (mode === 'markup') { mathGroupDepth = stack.length; mode = 'math'; }
      else {
        if (mathGroupDepth === undefined || stack.length !== mathGroupDepth) return true;
        mathGroupDepth = undefined; mode = 'markup';
      }
      i++; continue;
    }
    if (source[i] === '#' && mode !== 'code') {
      const codeEnd = codeGroupAt(source, i);
      if (codeEnd) {
        stack.push({ closing: pairs[source[codeEnd.open]], mode: 'code', restoreMode: mode });
        mode = 'code'; i = codeEnd.open + 1; continue;
      }
    }
    if (mode === 'markup') {
      if (source[i] === '[') { stack.push({ closing: ']', mode }); i++; continue; }
      if (source[i] === ']') {
        const group = stack.pop();
        if (group?.closing !== ']' || group.mode !== mode) return true;
        if (group.restoreMode) mode = group.restoreMode;
        i++; continue;
      }
      i++; continue;
    }
    if (mode === 'code' && source[i] === '[') {
      stack.push({ closing: ']', mode: 'markup', restoreMode: 'code' });
      mode = 'markup'; i++; continue;
    }
    if (pairs[source[i]]) { stack.push({ closing: pairs[source[i]], mode }); i++; continue; }
    if (source[i] === ')' || source[i] === ']' || source[i] === '}') {
      const group = stack.pop();
      if (group?.closing !== source[i] || group.mode !== mode) return true;
      if (group.restoreMode) mode = group.restoreMode;
      i++; continue;
    }
    i++;
  }
  return stack.length > 0;
}

function parseContentCell(argument: string, unwrapHeader = false): { source: string; content: string; isTypst: boolean } | null {
  const trimmed = argument.trim();
  const group = scanGroup(trimmed, 0);
  if (!group || group.end !== trimmed.length || trimmed[0] !== '[') return null;
  const body = trimmed.slice(1, -1).trim();
  const strongBody = unwrapHeader && body.startsWith('#strong') ? body.slice('#strong'.length).trim() : null;
  if (strongBody !== null) {
    const strongGroup = scanGroup(strongBody, 0);
    if (strongGroup && strongGroup.end === strongBody.length) {
      const inner = parseContentCell(strongBody);
      if (inner) return { source: trimmed, content: inner.content, isTypst: inner.isTypst };
    }
  }
  const textCall = parseCallAt(body, body.startsWith('#text') ? 1 : -1, 'text');
  if (textCall && textCall.start === 1 && textCall.end === body.length && textCall.args.length === 1) {
    const value = cleanArgument(textCall.args[0]);
    const decoded = decodeTypstString(value);
    if (decoded !== null) return { source: trimmed, content: decoded, isTypst: false };
  }
  return { source: trimmed, content: body, isTypst: true };
}

function decodeTypstString(source: string): string | null {
  const trimmed = source.trim();
  if (trimmed[0] !== '"' || scanString(trimmed, 0) !== trimmed.length) return null;
  let value = '';
  for (let i = 1; i < trimmed.length - 1; i++) {
    if (trimmed[i] !== '\\') { value += trimmed[i]; continue; }
    i++;
    const escaped = trimmed[i];
    if (escaped === 'n') value += '\n';
    else if (escaped === 'r') value += '\r';
    else if (escaped === 't') value += '\t';
    else if (escaped === '"' || escaped === '\\') value += escaped;
    else if (escaped === 'u' && trimmed[i + 1] === '{') {
      const close = trimmed.indexOf('}', i + 2);
      const digits = close < 0 ? '' : trimmed.slice(i + 2, close);
      if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) return null;
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
      value += String.fromCodePoint(codePoint);
      i = close;
    }
    else return null;
  }
  return value;
}

function parseIdentifier(source: string): string | null {
  const value = source.trim();
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : null;
}

function parseInteger(source: string): number | null {
  const value = source.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseMatrix(call: Call): TypstMatrixOptions | null {
  let delimiter: TypstMatrixDelimiter = 'none';
  let hasDelimiter = false;
  const contentArgs: Argument[] = [];
  for (const argument of call.args) {
    const named = namedArgument(argument);
    if (named) {
      if (contentArgs.length > 0) return null;
      if (named.name !== 'delim' || hasDelimiter) return null;
      const value = named.value.trim() === '#none' ? '' : decodeTypstString(named.value);
      if (value === null || !Object.prototype.hasOwnProperty.call(delimiters, value)) return null;
      delimiter = delimiters[value]; hasDelimiter = true;
    } else contentArgs.push(argument);
  }
  // Typst's omitted delimiter uses parentheses. Since the editor needs to
  // preserve an explicit supported choice, do not map inherited defaults to None.
  if (!hasDelimiter) return null;
  const rows = splitRowsFromArgs(contentArgs);
  if (!rows || rows.length < 1 || rows.length > 12 || rows.some((row) => row.length !== rows[0].length || row.length < 1 || row.length > 12)) return null;
  const sourceCells = rows.map((row) => row.map((cell) => ({
    source: cell.trim(),
    content: cell.trim() === '""' ? '' : cell.trim(),
  })));
  try { sourceCells.flat().forEach((cell) => validateTypstMatrixCell(cell.content)); } catch { return null; }
  return { rows: rows.length, columns: rows[0].length, cells: sourceCells.map((row) => row.map((cell) => cell.content)), delimiter, sourceCells };
}

function splitRowsFromArgs(args: Argument[]): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  for (const argument of args) {
    const value = cleanArgument(argument);
    if (!value) return null;
  const split = splitTopLevel(value, 0, value.length, ';', 'math');
    if (!split) return null;
    for (let i = 0; i < split.length; i++) {
      const rowSource = cleanArgument(split[i]);
      if (!rowSource) return null;
      const cells = splitTopLevel(rowSource, 0, rowSource.length, ',', 'math');
      if (!cells || !cells.length || cells.some((cell) => !cleanArgument(cell))) return null;
      row.push(...cells.map(cleanArgument));
      if (i < split.length - 1) { rows.push(row); row = []; }
    }
  }
  if (row.length) rows.push(row);
  return rows;
}

function parseTable(call: Call): TypstTableOptions | null {
  let columns: number | null = null;
  let alignment: TypstAlignment[] | undefined;
  let format: TypstTableFormat = 'plain';
  let header = false;
  const namedSeen = new Set<string>();
  const cells: Array<{ source: string; content: string; isTypst: boolean; header: boolean }> = [];
  const rules: Array<{ y: number; stroke: string; afterCells: number }> = [];
  let sawPositional = false;
  for (const argument of call.args) {
    const source = cleanArgument(argument);
    const named = namedArgument(argument);
    if (named) {
      if (sawPositional || namedSeen.has(named.name)) return null;
      namedSeen.add(named.name);
      if (named.name === 'columns') columns = parseInteger(named.value);
      else if (named.name === 'align') {
        const group = scanGroup(named.value, 0);
        if (!group || group.end !== named.value.length || named.value[0] !== '(') return null;
        const items = splitTopLevel(named.value, group.bodyStart, group.bodyEnd, ',');
        if (!items) return null;
        alignment = items.map((item) => parseIdentifier(cleanArgument(item)) as TypstAlignment);
        if (alignment.some((item) => !alignments.has(item))) return null;
      } else if (named.name === 'inset') {
        if (!/^5(?:\.0+)?pt$/.test(named.value)) return null;
      } else if (named.name === 'stroke') {
        if (named.value === 'none') format = 'plain';
        else if (/^0\.5pt$/.test(named.value)) format = 'grid';
        else return null;
      } else return null;
      continue;
    }
    const headerCall = parseCallAt(source, source.startsWith('table.header') ? 0 : -1, 'table.header');
    if (headerCall && headerCall.end === source.length) {
      if (header) return null;
      sawPositional = true;
      header = true;
      for (const cellArg of headerCall.args) {
        const cell = parseContentCell(cleanArgument(cellArg), true);
        if (!cell) return null;
        cells.push({ ...cell, header: true });
      }
      continue;
    }
    const ruleCall = parseCallAt(source, source.startsWith('table.hline') ? 0 : -1, 'table.hline');
    if (ruleCall && ruleCall.end === source.length) {
      const rule = parseRule(ruleCall);
      if (!rule) return null;
      sawPositional = true;
      rules.push({ ...rule, afterCells: cells.length });
      continue;
    }
    const cell = parseContentCell(source);
    if (!cell) return null;
    sawPositional = true;
    cells.push({ ...cell, header: false });
  }
  if (columns === null || columns < 1 || columns > 10 || !alignment || alignment.length !== columns || !cells.length) return null;
  if (!['columns', 'align', 'inset', 'stroke'].every((name) => namedSeen.has(name))) return null;
  if (cells.length % columns !== 0) return null;
  const rows = cells.length / columns;
  if (rows < 1 || rows > 20) return null;
  const cellRows = Array.from({ length: rows }, (_, row) => cells.slice(row * columns, (row + 1) * columns));
  if (cellRows.some((row, index) => row.some((cell) => cell.header) !== (header && index === 0))) return null;
  if (rules.length) {
    if (rules.some((rule) => rule.stroke !== '0.8pt' && rule.stroke !== '0.5pt')) return null;
    const expected: Array<{ y: number; stroke: string }> = [{ y: 0, stroke: '0.8pt' }];
    if (header && rows > 1) expected.push({ y: 1, stroke: '0.5pt' });
    expected.push({ y: rows, stroke: '0.8pt' });
    const expectedCellPositions = [0, ...(header && rows > 1 ? [columns] : []), cells.length];
    if (rules.length !== expected.length || rules.some((rule, index) => rule.y !== expected[index].y || rule.stroke !== expected[index].stroke || rule.afterCells !== expectedCellPositions[index])) return null;
    if (namedSeen.has('stroke') && call.args.some((argument) => namedArgument(argument)?.name === 'stroke' && cleanArgument(argument).endsWith('none')) === false) return null;
    format = 'booktabs';
  } else if ([...call.args].some((argument) => namedArgument(argument)?.name === 'stroke' && namedArgument(argument)?.value === '0.5pt')) {
    format = 'grid';
  }
  if (format === 'booktabs' && call.args.some((argument) => namedArgument(argument)?.name === 'stroke' && namedArgument(argument)?.value !== 'none')) return null;
  if (format !== 'booktabs' && rules.length > 0) return null;
  if (format === 'plain' && call.args.some((argument) => namedArgument(argument)?.name === 'stroke' && namedArgument(argument)?.value !== 'none')) return null;
  try {
    cells.forEach((cell) => {
      if (cell.isTypst) validateTypstTableCell(cell.content);
      else if (/[\r\n\u2028\u2029]/u.test(cell.content)) throw new Error('Line breaks are unsupported in table text cells.');
    });
  } catch { return null; }
  return {
    rows, columns, cells: cellRows.map((row) => row.map((cell) => cell.content)), alignment,
    format, header, cellTypst: cellRows.map((row) => row.map((cell) => cell.isTypst)),
    sourceCells: cellRows.map((row) => row.map((cell) => ({ ...cell }))),
  };
}

function parseRule(call: Call): { y: number; stroke: string } | null {
  let y: number | null = null;
  let stroke: string | null = null;
  for (const argument of call.args) {
    const named = namedArgument(argument);
    if (!named) return null;
    if (named.name === 'y' && y === null) y = parseInteger(named.value);
    else if (named.name === 'stroke' && stroke === null && /^(?:0\.5|0\.8)pt$/.test(named.value)) stroke = named.value;
    else return null;
  }
  return y === null || stroke === null ? null : { y, stroke };
}

function visibleCodeSpans(source: string): Array<{ start: number; end: number; kind: 'hash' | 'math' }> {
  const spans: Array<{ start: number; end: number; kind: 'hash' | 'math' }> = [];
  scanMarkupRange(source, 0, source.length, spans);
  return spans;
}

function scanMarkupRange(source: string, start: number, end: number, spans: Array<{ start: number; end: number; kind: 'hash' | 'math' }>): void {
  for (let index = start; index < end;) {
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 || newline >= end ? end : newline + 1; continue;
    }
    if (source.startsWith('/*', index)) {
      const close = scanBlockComment(source, index);
      index = close < 0 || close > end ? end : close; continue;
    }
    if (source[index] === '`') {
      const close = scanRaw(source, index);
      index = close < 0 || close > end ? end : close; continue;
    }
    if (source[index] === '$' && !isEscaped(source, index)) {
      let runEnd = index + 1;
      while (source[runEnd] === '$') runEnd++;
      if (runEnd - index !== 1) { index = runEnd; continue; }
      const close = findMathClose(source, runEnd, end);
      if (close < 0) return;
      spans.push({ start: index, end: close + 1, kind: 'math' });
      index = close + 1; continue;
    }
    if (source[index] === '#' && !isEscaped(source, index)) {
      const name = source.slice(index + 1, end).match(/^[A-Za-z_][A-Za-z0-9_.-]*/)?.[0];
      if (!name) {
        const opening = source[index + 1];
        if (opening === '"') {
          const close = scanString(source, index + 1);
          index = close < 0 || close > end ? end : close;
          continue;
        }
        if (opening === '(' || opening === '{') {
          const group = scanGroup(source, index + 1, 'code');
          if (!group || group.end > end) return;
          scanCodeRange(source, group.bodyStart, group.bodyEnd, spans);
          index = group.end; continue;
        }
        index++; continue;
      }
      const callStart = index + 1;
      const keyword = name.split('.')[0];
      if (keyword === 'table' || keyword === 'figure') spans.push({ start: index, end: index + name.length + 1, kind: 'hash' });
      let next = callStart + name.length;
      while (next < end && /[ \t\r]/u.test(source[next])) next++;
      if (['let', 'set', 'show', 'import', 'include', 'if', 'else', 'for', 'while', 'context', 'return', 'break', 'continue'].includes(keyword)) {
        index = scanCodeStatement(source, next, end); continue;
      }
      if (source[next] === '[') {
        const block = scanGroup(source, next);
        if (!block || block.end > end) return;
        scanMarkupRange(source, block.bodyStart, block.bodyEnd, spans);
        index = block.end; continue;
      }
      if (source[next] === '(' || source[next] === '{') {
        const group = scanGroup(source, next);
        if (!group || group.end > end) return;
        scanCodeRange(source, group.bodyStart, group.bodyEnd, spans);
        index = group.end; continue;
      }
      index = callStart + name.length; continue;
    }
    index++;
  }
}

function scanCodeRange(source: string, start: number, end: number, spans: Array<{ start: number; end: number; kind: 'hash' | 'math' }>): void {
  for (let index = start; index < end;) {
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 || newline >= end ? end : newline + 1; continue;
    }
    if (source.startsWith('/*', index)) {
      const close = scanBlockComment(source, index);
      index = close < 0 || close > end ? end : close; continue;
    }
    if (source[index] === '"' || source[index] === '`') {
      const close = source[index] === '"' ? scanString(source, index) : scanRaw(source, index);
      index = close < 0 || close > end ? end : close; continue;
    }
    if (source[index] === '[') {
      const block = scanGroup(source, index);
      if (!block || block.end > end) return;
      scanMarkupRange(source, block.bodyStart, block.bodyEnd, spans);
      index = block.end; continue;
    }
    if (source[index] === '#' && !isEscaped(source, index)) {
      const name = source.slice(index + 1, end).match(/^[A-Za-z_][A-Za-z0-9_.-]*/)?.[0];
      if (name) {
        const keyword = name.split('.')[0];
        if (keyword === 'table' || keyword === 'figure') spans.push({ start: index, end: index + name.length + 1, kind: 'hash' });
        let next = index + name.length + 1;
        while (next < end && /[ \t\r]/u.test(source[next])) next++;
        if (['let', 'set', 'show', 'import', 'include', 'if', 'else', 'for', 'while', 'context', 'return', 'break', 'continue'].includes(keyword)) {
          index = scanCodeStatement(source, next, end); continue;
        }
        if (source[next] === '[') {
          const block = scanGroup(source, next);
          if (!block || block.end > end) return;
          scanMarkupRange(source, block.bodyStart, block.bodyEnd, spans);
          index = block.end; continue;
        }
        if (source[next] === '(' || source[next] === '{') {
          const group = scanGroup(source, next);
          if (!group || group.end > end) return;
          scanCodeRange(source, group.bodyStart, group.bodyEnd, spans);
          index = group.end; continue;
        }
        index = next; continue;
      }
    }
    if (source[index] === '(' || source[index] === '{') {
      const group = scanGroup(source, index);
      if (!group || group.end > end) return;
      scanCodeRange(source, group.bodyStart, group.bodyEnd, spans);
      index = group.end; continue;
    }
    index++;
  }
}

function scanCodeStatement(source: string, start: number, limit: number): number {
  for (let index = start; index < limit;) {
    if (source[index] === '\n') return index + 1;
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      return newline < 0 || newline >= limit ? limit : newline + 1;
    }
    if (source.startsWith('/*', index)) {
      const close = scanBlockComment(source, index);
      if (close < 0 || close > limit) return limit;
      index = close; continue;
    }
    if (source[index] === '"' || source[index] === '`') {
      const close = source[index] === '"' ? scanString(source, index) : scanRaw(source, index);
      if (close < 0 || close > limit) return limit;
      index = close; continue;
    }
    if (pairs[source[index]]) {
      const group = scanGroup(source, index);
      if (!group || group.end > limit) return limit;
      index = group.end; continue;
    }
    index++;
  }
  return limit;
}

function findMathClose(source: string, start: number, limit: number): number {
  for (let index = start; index < limit;) {
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 || newline >= limit ? limit : newline + 1; continue;
    }
    if (source.startsWith('/*', index)) {
      const close = scanBlockComment(source, index);
      if (close < 0 || close > limit) return -1;
      index = close; continue;
    }
    if (source[index] === '"' || source[index] === '`') {
      const close = source[index] === '"' ? scanString(source, index) : scanRaw(source, index);
      if (close < 0 || close > limit) return -1;
      index = close; continue;
    }
    if (source[index] === '#' && !isEscaped(source, index)) {
      const codeEnd = scanCodeExpression(source, index);
      if (codeEnd > index) { if (codeEnd > limit) return -1; index = codeEnd; continue; }
    }
    if (source[index] === '$' && !isEscaped(source, index)) return index;
    index++;
  }
  return -1;
}

function scanCodeExpression(source: string, start: number): number {
  let index = start + 1;
  if (source[index] === '"') return scanString(source, index);
  if (source[index] === '(' || source[index] === '{') {
    const group = scanGroup(source, index, 'code');
    return group?.end ?? source.length;
  }
  if (!/[\p{L}_]/u.test(source[index] ?? '')) return start;
  index++;
  while (index < source.length && /[\p{L}\p{N}_.-]/u.test(source[index])) index++;
  while (index < source.length && /\s/u.test(source[index]) && source[index] !== '\n') index++;
  const opening = source[index];
  if (opening === '(' || opening === '[' || opening === '{') {
    const group = scanGroup(source, index);
    return group?.end ?? source.length;
  }
  return index;
}

function parseFigureWrapper(source: string, figure: Call, cursor: number): ParsedTypstStructure | null {
  if (figure.args.length < 1) return null;
  const first = figure.args[0];
  const firstRaw = source.slice(first.start, first.end);
  const firstOffset = first.start + (firstRaw.search(/\S|$/));
  const firstEnd = first.start + firstRaw.trimEnd().length;
  const tableInFigure = parseCallAt(source, firstOffset, 'table');
  if (!tableInFigure || tableInFigure.end !== firstEnd) return null;
  const tableValue = parseTable(tableInFigure);
  if (!tableValue) return { kind: 'table', start: tableInFigure.start, end: tableInFigure.end, compatible: false, reason: 'This table uses dynamic dimensions, custom tracks, merged cells, or unsupported cell options. Edit this structure directly in the source.' };
  let caption: string | undefined;
  let kind: string | undefined;
  let wrapperCompatible = true;
  for (const argument of figure.args.slice(1)) {
    const arg = cleanArgument(argument);
    const colon = topLevelColon(arg);
    if (colon < 0) { wrapperCompatible = false; break; }
    const key = arg.slice(0, colon).trim();
    const value = arg.slice(colon + 1).trim();
    if (key === 'kind' && kind === undefined) kind = decodeTypstString(value) ?? value;
    else if (key === 'caption' && caption === undefined) {
      const content = parseContentCell(value);
      if (!content || content.isTypst) { wrapperCompatible = false; break; }
      caption = content.content;
    } else { wrapperCompatible = false; break; }
  }
  if (kind !== 'table' || !wrapperCompatible || hasComment(source.slice(figure.start - 1, figure.end))) {
    if (cursor < tableInFigure.start || cursor > tableInFigure.end) return null;
    return { kind: 'table', start: tableInFigure.start, end: tableInFigure.end, value: tableValue, compatible: true, placement: 'code' };
  }
  let end = figure.end;
  let label: string | undefined;
  let index = end;
  while (/\s/.test(source[index] ?? '')) index++;
  if (source[index] === '<') {
    const close = source.indexOf('>', index + 1);
    if (close < 0) return { kind: 'table', start: tableInFigure.start, end: tableInFigure.end, value: tableValue, compatible: true, placement: 'code' };
    label = source.slice(index + 1, close);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(label)) return { kind: 'table', start: tableInFigure.start, end: tableInFigure.end, value: tableValue, compatible: true, placement: 'code' };
    end = close + 1;
  }
  if (label && !caption?.trim()) {
    if (cursor < tableInFigure.start || cursor > tableInFigure.end) return null;
    return { kind: 'table', start: tableInFigure.start, end: tableInFigure.end, value: tableValue, compatible: true, placement: 'code' };
  }
  tableValue.wrapInFigure = true;
  tableValue.caption = caption ?? '';
  tableValue.label = label;
  const start = figure.start - 1;
  return cursor >= start && cursor <= end
    ? { kind: 'table', start, end, value: tableValue, compatible: true, placement: 'markup' }
    : null;
}

function parseCandidate(source: string, start: number, name: string, cursor: number, kind: 'table' | 'matrix'): ParsedTypstStructure | null {
  const groupMode: ScanMode = kind === 'matrix' ? 'math' : 'code';
  const call = parseCallAt(source, start, name, groupMode);
  if (!call) {
    const opening = source.indexOf('(', start + name.length);
    if (opening < 0 || cursor < start || cursor > source.length) return null;
    const reason = 'This structure has an unclosed call. Edit this structure directly in the source.';
    return { kind, start, end: source.length, compatible: false, reason };
  }
  if (kind === 'table' && (cursor < call.start || cursor > call.end)) return null;
  const containsComment = hasComment(source.slice(call.start, call.end), groupMode);
  if (containsComment) return cursor >= call.start && cursor <= call.end
    ? { kind, start: call.start, end: call.end, compatible: false, reason: 'This structure contains comments or unsupported syntax. Edit this structure directly in the source.' }
    : null;
  if (kind === 'table') {
    const value = parseTable(call);
    if (!value) return { kind, start: call.start, end: call.end, compatible: false, reason: 'This table uses dynamic dimensions, custom tracks, merged cells, or unsupported cell options. Edit this structure directly in the source.' };
    const figureStart = source.lastIndexOf('#figure', call.start);
    if (figureStart >= 0) {
      const figure = parseCallAt(source, figureStart + 1, 'figure');
      if (figure && call.start >= figure.open && call.end <= figure.end) {
        const firstArgument = figure.args[0];
        if (firstArgument) {
          const firstRaw = source.slice(firstArgument.start, firstArgument.end);
          const firstStart = firstArgument.start + firstRaw.search(/\S|$/);
          const firstEnd = firstArgument.start + firstRaw.trimEnd().length;
          const directTable = parseCallAt(source, firstStart, 'table');
          if (directTable?.start === call.start && directTable.end === call.end && directTable.end === firstEnd) {
            const wrapped = parseFigureWrapper(source, figure, cursor);
            if (wrapped) return wrapped;
          }
        }
      }
    }
    return { kind, start: call.start, end: call.end, value, compatible: true, placement: 'markup' };
  }
  const value = parseMatrix(call);
  if (!value) return cursor >= call.start && cursor <= call.end
    ? { kind, start: call.start, end: call.end, compatible: false, reason: 'This matrix uses unsupported arguments or unbalanced cell content. Edit this structure directly in the source.' }
    : null;
  let startOffset = call.start;
  let endOffset = call.end;
  let placement: 'math' | 'display' = 'math';
  const left = source.slice(0, call.start).match(/\$\s+$/);
  const right = source.slice(call.end).match(/^\s+\$/);
  if (left && right) {
    const wrapperStart = call.start - left[0].length;
    const wrapperEnd = call.end + right[0].length;
    if (source[wrapperStart] === '$' && source[wrapperEnd - 1] === '$' && cursor >= wrapperStart && cursor <= wrapperEnd) {
      startOffset = wrapperStart; endOffset = wrapperEnd; placement = 'display';
    }
  }
  return cursor >= startOffset && cursor <= endOffset
    ? { kind, start: startOffset, end: endOffset, value, compatible: true, placement }
    : null;
}

/** Parse the smallest supported Typst table or matrix that contains the cursor. */
export function parseTypstStructureAt(source: string, cursorOffset: number): ParsedTypstStructure | null {
  if (!Number.isInteger(cursorOffset) || cursorOffset < 0 || cursorOffset > source.length) return null;
  const spans = visibleCodeSpans(source);
  const candidates: ParsedTypstStructure[] = [];
  for (const span of spans) {
    if (span.kind === 'hash') {
      const name = source.slice(span.start + 1, span.end);
      if (name === 'table') {
        const result = parseCandidate(source, span.start, '#table', cursorOffset, 'table');
        if (result) candidates.push(result);
      } else if (name === 'figure' && source[span.start] === '#') {
        const figure = parseCallAt(source, span.start + 1, 'figure');
        if (figure) {
          const result = parseFigureWrapper(source, figure, cursorOffset);
          if (result) candidates.push(result);
        }
      }
      continue;
    }
    const mathSource = source.slice(span.start + 1, span.end - 1);
    for (let offset = 0; offset < mathSource.length;) {
      if (mathSource[offset] === '#') {
        const codeEnd = scanCodeExpression(mathSource, offset);
        offset = codeEnd > offset ? codeEnd : offset + 1;
        continue;
      }
      if (mathSource[offset] === '"' || mathSource[offset] === '`') {
        const next = mathSource[offset] === '"' ? scanString(mathSource, offset) : scanRaw(mathSource, offset);
        if (next < 0) break;
        offset = next; continue;
      }
      if (/[A-Za-z_]/.test(mathSource[offset])) {
        const name = mathSource.slice(offset).match(/^[A-Za-z_][A-Za-z0-9_.-]*/)?.[0] ?? '';
        if (name === 'mat' && (offset === 0 || !/[\p{L}\p{N}_#.]/u.test(mathSource[offset - 1]))) {
          const absolute = span.start + 1 + offset;
          const result = parseCandidate(source, absolute, 'mat', cursorOffset, 'matrix');
          if (result) candidates.push(result);
        }
        offset += name.length || 1;
      } else offset++;
    }
  }
  const containingCandidates = candidates.filter((candidate) => candidate.start <= cursorOffset && cursorOffset <= candidate.end);
  if (!containingCandidates.length) return null;
  containingCandidates.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  return containingCandidates[0];
}
