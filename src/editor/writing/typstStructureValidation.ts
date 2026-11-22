import { TypstStructureError } from '../../types/typstWriting';

type ValidationMode = 'content' | 'math';
type ActiveMode = 'content' | 'math' | 'code';
type Group = { close: string; open: string; mode: ActiveMode; rootCode: boolean; restoreMode?: ActiveMode };
const matchingClose: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Validate a cell as Typst markup content without interpreting its meaning. */
export function validateTypstTableCell(source: string): void {
  validateBalancedCell(source, 'content');
}

/** Validate one matrix cell as a single, structurally bounded math expression. */
export function validateTypstMatrixCell(source: string): void {
  validateBalancedCell(source, 'math');
}

function validateBalancedCell(source: string, mode: ValidationMode): void {
  if (/[\r\n\u2028\u2029]/u.test(source)) {
    throw new TypstStructureError('Cell content must stay on one line.');
  }

  const groups: Group[] = [];
  const initialMode: ActiveMode = mode;
  let activeMode: ActiveMode = initialMode;
  let mathGroupDepth: number | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (character === '"' && activeMode !== 'content') {
      index = scanString(source, index);
      continue;
    }
    if (character === '"' && activeMode === 'content' && groups.some((group) => group.restoreMode === 'code')) {
      throw new TypstStructureError('Quotes in content arguments inside code calls are ambiguous; wrap literal text in #text("...").');
    }

    if (character === '`') {
      if (activeMode !== 'content') throw new TypstStructureError('Raw content is not allowed in math or code expressions.');
      index = scanRaw(source, index);
      continue;
    }

    if (character === '/' && (next === '/' || next === '*')) {
      throw new TypstStructureError('Comments are not allowed inside a structure cell.');
    }

    if (character === '\\') {
      if (initialMode === 'math') throw new TypstStructureError('Code escapes are not allowed inside a matrix cell.');
      // Typst markup escapes punctuation; it cannot open a group or a separator.
      if (index + 1 >= source.length) throw new TypstStructureError('Cell content ends with an incomplete escape.');
      index += 1;
      continue;
    }

    if (character === '$' && activeMode !== 'code') {
      if (initialMode === 'math') throw new TypstStructureError('Do not add math delimiters inside a matrix cell.');
      if (activeMode === 'content') {
        mathGroupDepth = groups.length;
        activeMode = 'math';
      } else {
        if (groups.length !== mathGroupDepth) throw new TypstStructureError('Groups cannot cross a math delimiter inside a table cell.');
        activeMode = 'content';
        mathGroupDepth = undefined;
      }
      continue;
    }

    if (initialMode === 'math' && (character === '#' || character === '&')) {
      throw new TypstStructureError(character === '#' ? 'Code escapes are not allowed inside a matrix cell.' : 'Alignment points are not allowed inside a matrix cell.');
    }

    if (initialMode === 'content' && character === '#' && (activeMode === 'content' || activeMode === 'math')) {
      const codeCall = findCodeCallOpen(source, index + 1);
      if (codeCall !== null) {
        groups.push({ open: '(', close: ')', mode: 'code', rootCode: true, restoreMode: activeMode });
        activeMode = 'code';
        index = codeCall;
        continue;
      }
      if (next === '{') {
        groups.push({ open: '{', close: '}', mode: 'code', rootCode: true, restoreMode: activeMode });
        activeMode = 'code';
        index += 1;
        continue;
      }
    }

    if (activeMode === 'code' && character === '[') {
      groups.push({ open: '[', close: ']', mode: 'content', rootCode: false, restoreMode: 'code' });
      activeMode = 'content';
      continue;
    }

    const structuralGroups = activeMode === 'content' ? character === '[' : character in matchingClose;
    if (structuralGroups) {
      groups.push({ open: character, close: matchingClose[character], mode: activeMode, rootCode: false });
      continue;
    }

    const closesGroup = activeMode === 'content' ? character === ']' : character === ')' || character === ']' || character === '}';
    if (closesGroup) {
      const group = groups.pop();
      if (!group || group.mode !== activeMode || group.close !== character) throw new TypstStructureError('Cell content contains an unbalanced or cross-context group.');
      if (group.rootCode) activeMode = group.restoreMode ?? 'content';
      else if (group.restoreMode) activeMode = group.restoreMode;
      continue;
    }

    if (initialMode === 'math' && groups.length === 0 && (character === ',' || character === ';')) {
      throw new TypstStructureError('Top-level commas and semicolons are reserved for matrix structure.');
    }
  }

  if (groups.length > 0 || activeMode !== initialMode) throw new TypstStructureError('Cell content contains an unclosed group or math region.');
}

function findCodeCallOpen(source: string, identifierStart: number): number | null {
  let index = identifierStart;
  if (!/[\p{L}_]/u.test(source[index] ?? '')) return null;
  index += 1;
  while (index < source.length && /[\p{L}\p{N}_.-]/u.test(source[index])) index += 1;
  while (index < source.length && /\s/u.test(source[index])) index += 1;
  return source[index] === '(' ? index : null;
}

function scanString(source: string, quoteIndex: number): number {
  for (let index = quoteIndex + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      if (index + 1 >= source.length) throw new TypstStructureError('String literal ends with an incomplete escape.');
      index += 1;
      continue;
    }
    if (source[index] === '"') return index;
  }
  throw new TypstStructureError('Cell content contains an unclosed string literal.');
}

function scanRaw(source: string, openingIndex: number): number {
  let delimiterEnd = openingIndex;
  while (source[delimiterEnd + 1] === '`') delimiterEnd += 1;
  const delimiter = source.slice(openingIndex, delimiterEnd + 1);
  const closingIndex = source.indexOf(delimiter, delimiterEnd + 1);
  if (closingIndex < 0) throw new TypstStructureError('Cell content contains an unclosed raw span.');
  return closingIndex + delimiter.length - 1;
}

/** Encode literal text in a Typst string while preserving its exact value. */
export function encodeTypstString(value: string): string {
  return `"${value
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\0/gu, '\\u{0}')
    .replace(/\t/gu, '\\t')
    .replace(/\r/gu, '\\r')
    .replace(/\n/gu, '\\n')
    .replace(/\u2028/gu, '\\u{2028}')
    .replace(/\u2029/gu, '\\u{2029}')
  }"`;
}
