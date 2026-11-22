import type { OutlineItem } from '../../types/sidebar';

export interface OutlineTreeNode {
  item: OutlineItem;
  depth: number;
  children: OutlineTreeNode[];
}

interface LatexSectionMeta {
  level: number;
  kindLabel: string;
}

const LATEX_SECTION_COMMANDS: Record<string, LatexSectionMeta> = {
  part: { level: 0, kindLabel: 'Part' },
  chapter: { level: 1, kindLabel: 'Ch' },
  section: { level: 2, kindLabel: 'H1' },
  subsection: { level: 3, kindLabel: 'H2' },
  subsubsection: { level: 4, kindLabel: 'H3' },
  paragraph: { level: 5, kindLabel: 'H4' },
  subparagraph: { level: 6, kindLabel: 'H5' },
};

const LATEX_FORMAT_COMMANDS = new Set([
  'textbf',
  'textit',
  'emph',
  'underline',
  'texttt',
  'textrm',
  'textsc',
  'textsf',
  'textnormal',
  'textup',
  'textsl',
  'mbox',
  'text',
]);

const LATEX_SECTION_NAMES =
  'part|chapter|subsubsection|subsection|section|subparagraph|paragraph';
const LATEX_HEADING_START_RE = new RegExp(
  `^\\\\(?:(${LATEX_SECTION_NAMES})|frametitle)(?![a-zA-Z@])`
);
const LATEX_BEGIN_FRAME_RE = /^\\begin\s*\{\s*frame\s*\}/;
const LATEX_IGNORED_ENV_RE = /^\\begin\s*\{\s*(verbatim\*?|lstlisting|comment)\s*\}/;
const LATEX_NEWCOMMAND_RE = /^\\(?:(?:re)?newcommand|providecommand)\*?(?![a-zA-Z@])/;
const LATEX_DEF_RE = /^\\(?:g|e|x)?def(?![a-zA-Z@])/;
const LATEX_VERB_RE = /^\\verb\*?([^\s*a-zA-Z])/;

function isAsciiLetter(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isLatexWordChar(ch: string | undefined): boolean {
  return isAsciiLetter(ch) || ch === '@';
}

function isHorizontalWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function getLineNumberAt(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lineStarts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high + 1;
}

function maskRangePreservingNewlines(chars: string[], start: number, end: number): void {
  const limit = Math.min(end, chars.length);
  for (let i = start; i < limit; i++) {
    if (chars[i] !== '\n') {
      chars[i] = ' ';
    }
  }
}

function skipLatexWhitespaceAndComments(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (isWhitespace(text[i])) {
      i++;
      continue;
    }
    if (text[i] === '%' && !isEscaped(text, i)) {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    break;
  }
  return i;
}

function readBalancedGroup(
  text: string,
  openIndex: number,
  openChar: '{' | '[',
  closeChar: '}' | ']',
  respectLatexComments = false
): { content: string; endIndex: number } | null {
  if (text[openIndex] !== openChar) return null;

  let depth = 0;
  let braceDepth = 0;
  let i = openIndex;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (respectLatexComments && ch === '%') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (openChar === '[') {
      if (ch === '{') {
        braceDepth++;
        i++;
        continue;
      }
      if (ch === '}' && braceDepth > 0) {
        braceDepth--;
        i++;
        continue;
      }
      if (braceDepth === 0) {
        if (ch === '[') {
          depth++;
        } else if (ch === ']') {
          depth--;
          if (depth === 0) {
            return {
              content: text.slice(openIndex + 1, i),
              endIndex: i + 1,
            };
          }
        }
      }
      i++;
      continue;
    }

    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return {
          content: text.slice(openIndex + 1, i),
          endIndex: i + 1,
        };
      }
    }

    i++;
  }

  return null;
}

function findLatexEnvironmentEnd(text: string, fromIndex: number, envName: string): number {
  const escapedEnv = envName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const endRe = new RegExp(`\\\\end\\s*\\{\\s*${escapedEnv}\\s*\\}`, 'g');
  endRe.lastIndex = fromIndex;
  const match = endRe.exec(text);
  return match ? match.index + match[0].length : text.length;
}

function findLatexIffalseEnd(text: string, fromIndex: number): number {
  let depth = 1;
  let i = fromIndex;

  while (i < text.length) {
    const ch = text[i];
    if (ch === '%' && !isEscaped(text, i)) {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (ch === '\\') {
      const rest = text.slice(i);
      const fiMatch = /^\\fi(?![a-zA-Z@])/.exec(rest);
      if (fiMatch) {
        depth--;
        i += fiMatch[0].length;
        if (depth === 0) {
          return i;
        }
        continue;
      }
      const ifMatch = /^\\if[a-zA-Z@]*(?![a-zA-Z@])/.exec(rest);
      if (ifMatch) {
        depth++;
        i += ifMatch[0].length;
        continue;
      }
      i += 2;
      continue;
    }
    i++;
  }

  return text.length;
}

function findLatexNewcommandEnd(text: string, start: number, commandLen: number): number | null {
  let i = skipLatexWhitespaceAndComments(text, start + commandLen);
  if (i >= text.length) return null;

  if (text[i] === '{') {
    const target = readBalancedGroup(text, i, '{', '}', true);
    if (!target) return null;
    i = target.endIndex;
  } else if (text[i] === '\\') {
    i++;
    if (isLatexWordChar(text[i])) {
      while (i < text.length && isLatexWordChar(text[i])) {
        i++;
      }
    } else if (i < text.length) {
      i++;
    }
  } else {
    return null;
  }

  i = skipLatexWhitespaceAndComments(text, i);
  if (text[i] === '[') {
    const nargs = readBalancedGroup(text, i, '[', ']', true);
    if (!nargs) return null;
    i = skipLatexWhitespaceAndComments(text, nargs.endIndex);
  }

  if (text[i] === '[') {
    const optDefault = readBalancedGroup(text, i, '[', ']', true);
    if (!optDefault) return null;
    i = skipLatexWhitespaceAndComments(text, optDefault.endIndex);
  }

  if (text[i] !== '{') return null;
  const body = readBalancedGroup(text, i, '{', '}', true);
  return body ? body.endIndex : null;
}

function findLatexDefEnd(text: string, start: number, commandLen: number): number | null {
  let i = skipLatexWhitespaceAndComments(text, start + commandLen);
  if (i >= text.length || text[i] !== '\\') return null;

  i++;
  if (isLatexWordChar(text[i])) {
    while (i < text.length && isLatexWordChar(text[i])) {
      i++;
    }
  } else if (i < text.length) {
    i++;
  }

  while (i < text.length) {
    const ch = text[i];
    if (ch === '%' && !isEscaped(text, i)) {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '{') {
      const body = readBalancedGroup(text, i, '{', '}', true);
      return body ? body.endIndex : null;
    }
    i++;
  }

  return null;
}

function preprocessLatex(content: string): { masked: string; commentOnlyLines: Set<number> } {
  const normalized = content.replace(/\r\n?/g, '\n');
  const chars = normalized.split('');
  const commentOnlyLines = new Set<number>();

  const rawLines = normalized.split('\n');
  for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
    if (rawLines[lineIdx].trimStart().startsWith('%')) {
      commentOnlyLines.add(lineIdx + 1);
    }
  }

  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];

    if (ch === '%' && !isEscaped(normalized, i)) {
      const start = i;
      while (i < normalized.length && normalized[i] !== '\n') {
        i++;
      }
      maskRangePreservingNewlines(chars, start, i);
      continue;
    }

    if (ch === '\\') {
      const rest = normalized.slice(i);

      const envMatch = LATEX_IGNORED_ENV_RE.exec(rest);
      if (envMatch) {
        const endIndex = findLatexEnvironmentEnd(normalized, i + envMatch[0].length, envMatch[1]);
        maskRangePreservingNewlines(chars, i, endIndex);
        i = endIndex;
        continue;
      }

      const iffalseMatch = /^\\iffalse(?![a-zA-Z@])/.exec(rest);
      if (iffalseMatch) {
        const endIndex = findLatexIffalseEnd(normalized, i + iffalseMatch[0].length);
        maskRangePreservingNewlines(chars, i, endIndex);
        i = endIndex;
        continue;
      }

      const newcmdMatch = LATEX_NEWCOMMAND_RE.exec(rest);
      if (newcmdMatch) {
        const endIndex = findLatexNewcommandEnd(normalized, i, newcmdMatch[0].length);
        if (endIndex !== null) {
          maskRangePreservingNewlines(chars, i, endIndex);
          i = endIndex;
          continue;
        }
      }

      const defMatch = LATEX_DEF_RE.exec(rest);
      if (defMatch) {
        const endIndex = findLatexDefEnd(normalized, i, defMatch[0].length);
        if (endIndex !== null) {
          maskRangePreservingNewlines(chars, i, endIndex);
          i = endIndex;
          continue;
        }
      }

      const verbMatch = LATEX_VERB_RE.exec(rest);
      if (verbMatch) {
        const delim = verbMatch[1];
        const closePos = normalized.indexOf(delim, i + verbMatch[0].length);
        const lineEnd = normalized.indexOf('\n', i);
        if (closePos !== -1 && (lineEnd === -1 || closePos < lineEnd)) {
          maskRangePreservingNewlines(chars, i, closePos + 1);
          i = closePos + 1;
          continue;
        }
      }

      i += 2;
      continue;
    }

    i++;
  }

  return { masked: chars.join(''), commentOnlyLines };
}

function unwrapLatexMacros(input: string): string {
  let out = '';
  let i = 0;

  while (i < input.length) {
    if (input[i] === '\\') {
      const rest = input.slice(i);
      const texOrPdfMatch = /^\\texorpdfstring(?![a-zA-Z@])\s*/.exec(rest);
      if (texOrPdfMatch) {
        const firstArgStart = i + texOrPdfMatch[0].length;
        const firstArg = readBalancedGroup(input, firstArgStart, '{', '}');
        if (firstArg) {
          let secondStart = firstArg.endIndex;
          while (secondStart < input.length && isWhitespace(input[secondStart])) {
            secondStart++;
          }
          const secondArg = readBalancedGroup(input, secondStart, '{', '}');
          if (secondArg) {
            out += unwrapLatexMacros(firstArg.content);
            i = secondArg.endIndex;
            continue;
          }
        }
      }

      const labelMatch = /^\\label(?![a-zA-Z@])\s*/.exec(rest);
      if (labelMatch) {
        const arg = readBalancedGroup(input, i + labelMatch[0].length, '{', '}');
        if (arg) {
          i = arg.endIndex;
          continue;
        }
      }

      const cmdMatch = /^\\([a-zA-Z@]+)\s*/.exec(rest);
      if (cmdMatch && LATEX_FORMAT_COMMANDS.has(cmdMatch[1])) {
        const argStart = i + cmdMatch[0].length;
        const arg = readBalancedGroup(input, argStart, '{', '}');
        if (arg) {
          out += unwrapLatexMacros(arg.content);
          i = arg.endIndex;
          continue;
        }
      }

      if (i + 1 < input.length && input[i + 1] === '\\') {
        out += ' ';
        i += 2;
        continue;
      }

      if (i + 1 < input.length && '&%_$#{}'.includes(input[i + 1])) {
        out += input[i + 1];
        i += 2;
        continue;
      }

      if (i + 1 < input.length && input[i + 1] === ' ') {
        out += ' ';
        i += 2;
        continue;
      }
    }

    out += input[i];
    i++;
  }

  return out;
}

function extractFirstLatexLabel(text: string): string | undefined {
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      const rest = text.slice(i);
      const match = /^\\label(?![a-zA-Z@])\s*/.exec(rest);
      if (match) {
        const arg = readBalancedGroup(text, i + match[0].length, '{', '}');
        if (arg) {
          const trimmed = arg.content.trim();
          if (trimmed.length > 0) {
            return trimmed;
          }
          i = arg.endIndex;
          continue;
        }
      }
      i += 2;
      continue;
    }
    i++;
  }
  return undefined;
}

function cleanLatexTitle(rawTitle: string): { title: string; label?: string } {
  const label = extractFirstLatexLabel(rawTitle);
  const unwrapped = unwrapLatexMacros(rawTitle);
  const title = unwrapped.replace(/\s+/g, ' ').trim();
  return { title, label };
}

function findNextHeadingOffset(masked: string, fromIndex: number): number {
  let i = fromIndex;
  while (i < masked.length) {
    if (masked[i] === '\\') {
      const rest = masked.slice(i);
      if (LATEX_HEADING_START_RE.test(rest) || LATEX_BEGIN_FRAME_RE.test(rest)) {
        return i;
      }
      i += 2;
      continue;
    }
    i++;
  }
  return masked.length;
}

function findTrailingLatexLabel(
  masked: string,
  lineStarts: number[],
  commentOnlyLines: Set<number>,
  afterOffset: number
): string | undefined {
  const nextHeadingOffset = findNextHeadingOffset(masked, afterOffset);
  const closingLine = getLineNumberAt(lineStarts, Math.max(0, afterOffset - 1));
  const closingLineEndOffset =
    closingLine < lineStarts.length ? lineStarts[closingLine] : masked.length;

  const sameLineLimit = Math.min(closingLineEndOffset, nextHeadingOffset);
  const sameLineLabel = extractFirstLatexLabel(masked.slice(afterOffset, sameLineLimit));
  if (sameLineLabel) {
    return sameLineLabel;
  }

  let nonCommentLinesChecked = 0;
  let lineNum = closingLine + 1;

  while (lineNum <= lineStarts.length && nonCommentLinesChecked < 2) {
    const lineStart = lineStarts[lineNum - 1];
    if (lineStart >= nextHeadingOffset) {
      break;
    }

    const rawLineEnd = lineNum < lineStarts.length ? lineStarts[lineNum] : masked.length;
    const lineLimit = Math.min(rawLineEnd, nextHeadingOffset);

    if (!commentOnlyLines.has(lineNum)) {
      nonCommentLinesChecked++;
      const label = extractFirstLatexLabel(masked.slice(lineStart, lineLimit));
      if (label) {
        return label;
      }
    }

    lineNum++;
  }

  return undefined;
}

function createUniqueItemId(filePath: string, line: number, lineCounts: Map<number, number>): string {
  const count = (lineCounts.get(line) ?? 0) + 1;
  lineCounts.set(line, count);
  return count === 1 ? `${filePath}-${line}` : `${filePath}-${line}-${count}`;
}

export function parseLatexOutline(
  content: string,
  filePath: string,
  fileName: string
): OutlineItem[] {
  const { masked, commentOnlyLines } = preprocessLatex(content);
  const lineStarts = buildLineStarts(masked);
  const items: OutlineItem[] = [];
  const lineCounts = new Map<number, number>();

  let i = 0;
  while (i < masked.length) {
    if (masked[i] !== '\\') {
      i++;
      continue;
    }

    const rest = masked.slice(i);

    const frameMatch = LATEX_BEGIN_FRAME_RE.exec(rest);
    if (frameMatch) {
      const startLine = getLineNumberAt(lineStarts, i);
      let cursor = skipLatexWhitespaceAndComments(masked, i + frameMatch[0].length);

      while (cursor < masked.length && masked[cursor] === '[') {
        const optArg = readBalancedGroup(masked, cursor, '[', ']');
        if (!optArg) break;
        cursor = skipLatexWhitespaceAndComments(masked, optArg.endIndex);
      }

      if (cursor < masked.length && masked[cursor] === '{') {
        const titleArg = readBalancedGroup(masked, cursor, '{', '}');
        if (titleArg) {
          const { title, label: innerLabel } = cleanLatexTitle(titleArg.content);
          if (title.length > 0) {
            const label =
              innerLabel ??
              findTrailingLatexLabel(masked, lineStarts, commentOnlyLines, titleArg.endIndex);

            const item: OutlineItem = {
              id: createUniqueItemId(filePath, startLine, lineCounts),
              title,
              level: 3,
              line: startLine,
              filePath,
              fileName,
              rawCommand: 'frame',
              kindLabel: 'Frame',
            };
            if (label) {
              item.label = label;
            }
            items.push(item);
          }
          i = titleArg.endIndex;
          continue;
        }
      }

      i += frameMatch[0].length;
      continue;
    }

    const headingMatch = LATEX_HEADING_START_RE.exec(rest);
    if (headingMatch) {
      const startLine = getLineNumberAt(lineStarts, i);
      const command = headingMatch[1] ?? 'frametitle';
      let cursor = i + headingMatch[0].length;

      while (cursor < masked.length && isWhitespace(masked[cursor])) {
        cursor++;
      }

      let starred = false;
      if (masked[cursor] === '*') {
        starred = true;
        cursor++;
      }

      cursor = skipLatexWhitespaceAndComments(masked, cursor);

      if (masked[cursor] === '[') {
        const shortArg = readBalancedGroup(masked, cursor, '[', ']');
        if (shortArg) {
          cursor = skipLatexWhitespaceAndComments(masked, shortArg.endIndex);
        }
      }

      if (masked[cursor] === '{') {
        const titleArg = readBalancedGroup(masked, cursor, '{', '}');
        if (titleArg) {
          const { title, label: innerLabel } = cleanLatexTitle(titleArg.content);
          if (title.length > 0) {
            const meta =
              command === 'frametitle'
                ? { level: 3, kindLabel: 'Frame' }
                : LATEX_SECTION_COMMANDS[command];
            const label =
              innerLabel ??
              findTrailingLatexLabel(masked, lineStarts, commentOnlyLines, titleArg.endIndex);

            const item: OutlineItem = {
              id: createUniqueItemId(filePath, startLine, lineCounts),
              title,
              level: meta.level,
              line: startLine,
              filePath,
              fileName,
              rawCommand: command,
              kindLabel: meta.kindLabel,
            };
            if (label) {
              item.label = label;
            }
            if (starred) {
              item.starred = true;
            }
            items.push(item);
          }
          i = titleArg.endIndex;
          continue;
        }
      }

      i += headingMatch[0].length;
      continue;
    }

    i += 2;
  }

  return items;
}

function preprocessTypst(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n');
  const chars = normalized.split('');

  let i = 0;
  let inString = false;

  while (i < normalized.length) {
    const ch = normalized[i];
    const atLineStart = i === 0 || normalized[i - 1] === '\n';

    if (atLineStart) {
      let wsEnd = i;
      while (wsEnd < normalized.length && isHorizontalWhitespace(normalized[wsEnd])) {
        wsEnd++;
      }
      if (normalized.startsWith('```', wsEnd)) {
        let fenceLen = 0;
        while (normalized[wsEnd + fenceLen] === '`') {
          fenceLen++;
        }
        const fenceStart = i;
        let scan = normalized.indexOf('\n', wsEnd + fenceLen);
        if (scan === -1) {
          maskRangePreservingNewlines(chars, fenceStart, normalized.length);
          break;
        }
        scan++;
        let closedAt = normalized.length;
        while (scan < normalized.length) {
          let lineWsEnd = scan;
          while (lineWsEnd < normalized.length && isHorizontalWhitespace(normalized[lineWsEnd])) {
            lineWsEnd++;
          }
          if (normalized.startsWith('`'.repeat(fenceLen), lineWsEnd)) {
            let closeTicks = 0;
            while (normalized[lineWsEnd + closeTicks] === '`') {
              closeTicks++;
            }
            const afterTicks = lineWsEnd + closeTicks;
            const lineEnd = normalized.indexOf('\n', afterTicks);
            const restOfLine = normalized.slice(afterTicks, lineEnd === -1 ? normalized.length : lineEnd);
            if (restOfLine.trim() === '') {
              closedAt = lineEnd === -1 ? normalized.length : lineEnd;
              break;
            }
          }
          const nextNl = normalized.indexOf('\n', scan);
          if (nextNl === -1) break;
          scan = nextNl + 1;
        }
        maskRangePreservingNewlines(chars, fenceStart, closedAt);
        i = closedAt;
        inString = false;
        continue;
      }
    }

    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      } else if (ch === '\n') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }

    if (ch === '`') {
      const tickStart = i;
      let tickCount = 0;
      while (normalized[i + tickCount] === '`') {
        tickCount++;
      }
      if (tickCount >= 3) {
        const closePos = normalized.indexOf('`'.repeat(tickCount), i + tickCount);
        const endPos = closePos === -1 ? normalized.length : closePos + tickCount;
        maskRangePreservingNewlines(chars, tickStart, endPos);
        i = endPos;
        continue;
      }
      const lineEnd = normalized.indexOf('\n', i + tickCount);
      const closePos = normalized.indexOf('`'.repeat(tickCount), i + tickCount);
      if (closePos !== -1 && (lineEnd === -1 || closePos < lineEnd)) {
        i = closePos + tickCount;
        continue;
      }
      i += tickCount;
      continue;
    }

    if (ch === '/' && normalized[i + 1] === '*') {
      const commentStart = i;
      let depth = 1;
      i += 2;
      while (i < normalized.length && depth > 0) {
        if (normalized[i] === '/' && normalized[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (normalized[i] === '*' && normalized[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      maskRangePreservingNewlines(chars, commentStart, i);
      continue;
    }

    if (ch === '/' && normalized[i + 1] === '/') {
      const isUrlScheme = i > 0 && normalized[i - 1] === ':';
      if (!isUrlScheme) {
        const commentStart = i;
        while (i < normalized.length && normalized[i] !== '\n') {
          i++;
        }
        maskRangePreservingNewlines(chars, commentStart, i);
        continue;
      }
    }

    i++;
  }

  return chars.join('');
}

function readBalancedTypstDelimiter(
  text: string,
  openIndex: number,
  openChar: '(' | '[',
  closeChar: ')' | ']'
): { content: string; endIndex: number } | null {
  if (text[openIndex] !== openChar) return null;

  let depth = 0;
  let i = openIndex;
  let inString = false;

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }

    if (ch === '`') {
      let ticks = 0;
      while (text[i + ticks] === '`') {
        ticks++;
      }
      const closePos = text.indexOf('`'.repeat(ticks), i + ticks);
      if (closePos !== -1) {
        i = closePos + ticks;
        continue;
      }
      i += ticks;
      continue;
    }

    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return {
          content: text.slice(openIndex + 1, i),
          endIndex: i + 1,
        };
      }
    }

    i++;
  }

  return null;
}

function unwrapTypstInlineCalls(input: string): string {
  let out = '';
  let i = 0;

  while (i < input.length) {
    if (input[i] === '#') {
      const rest = input.slice(i);
      const match = /^#(?:emph|strong|underline|smallcaps|strike)\s*(?=\[)/.exec(rest);
      if (match) {
        const bracketStart = i + match[0].length;
        const body = readBalancedTypstDelimiter(input, bracketStart, '[', ']');
        if (body) {
          out += unwrapTypstInlineCalls(body.content);
          i = body.endIndex;
          continue;
        }
      }
    }
    out += input[i];
    i++;
  }

  return out;
}

function cleanTypstTitle(rawTitle: string): string {
  let cleaned = unwrapTypstInlineCalls(rawTitle);
  cleaned = cleaned.replace(/`([^`\n]+)`/g, '$1');
  cleaned = cleaned.replace(/\*([^\s*](?:[^*\n]*[^\s*])?)\*/g, '$1');
  cleaned = cleaned.replace(
    /(^|[\s(["'])_([^\s_](?:[^_\n]*[^\s_])?)_(?=$|[\s.,;:!?)\]"'])/g,
    '$1$2'
  );
  return cleaned.replace(/\s+/g, ' ').trim();
}

function extractTypstHeadingBodyFromArgs(argsText: string): string | null {
  const bodyNamedMatch = /\bbody\s*:\s*/.exec(argsText);
  if (bodyNamedMatch) {
    const valueStart = bodyNamedMatch.index + bodyNamedMatch[0].length;
    if (argsText[valueStart] === '[') {
      const bracketed = readBalancedTypstDelimiter(argsText, valueStart, '[', ']');
      if (bracketed) return bracketed.content;
    }
    if (argsText[valueStart] === '"') {
      const strMatch = /^"((?:[^"\\]|\\.)*)"/.exec(argsText.slice(valueStart));
      if (strMatch) return strMatch[1];
    }
  }

  let i = 0;
  while (i < argsText.length) {
    while (i < argsText.length && isWhitespace(argsText[i])) i++;
    if (i >= argsText.length) break;

    if (argsText[i] === '[') {
      const bracketed = readBalancedTypstDelimiter(argsText, i, '[', ']');
      if (bracketed) return bracketed.content;
    }
    if (argsText[i] === '"') {
      const strMatch = /^"((?:[^"\\]|\\.)*)"/.exec(argsText.slice(i));
      if (strMatch) return strMatch[1];
    }

    while (i < argsText.length && argsText[i] !== ',') {
      if (argsText[i] === '(') {
        const grp = readBalancedTypstDelimiter(argsText, i, '(', ')');
        if (grp) {
          i = grp.endIndex;
          continue;
        }
      }
      if (argsText[i] === '[') {
        const grp = readBalancedTypstDelimiter(argsText, i, '[', ']');
        if (grp) {
          i = grp.endIndex;
          continue;
        }
      }
      i++;
    }
    if (argsText[i] === ',') i++;
  }

  return null;
}

function extractTrailingTypstLabel(text: string): { text: string; label?: string } {
  const labelMatch = /\s*<([a-zA-Z0-9_.:-]+)>\s*$/.exec(text);
  if (!labelMatch) {
    return { text };
  }
  return {
    text: text.slice(0, labelMatch.index),
    label: labelMatch[1],
  };
}

export function parseTypstOutline(
  content: string,
  filePath: string,
  fileName: string
): OutlineItem[] {
  const masked = preprocessTypst(content);
  const lineStarts = buildLineStarts(masked);
  const items: OutlineItem[] = [];
  const lineCounts = new Map<number, number>();

  let i = 0;
  let inString = false;

  while (i < masked.length) {
    const atLineStart = i === 0 || masked[i - 1] === '\n';

    if (atLineStart) {
      inString = false;
      let wsEnd = i;
      while (wsEnd < masked.length && isHorizontalWhitespace(masked[wsEnd])) {
        wsEnd++;
      }

      const lineEnd = masked.indexOf('\n', wsEnd);
      const effectiveLineEnd = lineEnd === -1 ? masked.length : lineEnd;
      const trimmedLine = masked.slice(wsEnd, effectiveLineEnd);

      const atxMatch = /^(={1,6})\s+(.+)$/.exec(trimmedLine);
      if (atxMatch) {
        const lineNum = getLineNumberAt(lineStarts, i);
        const equalCount = atxMatch[1].length;
        const { text: withoutLabel, label } = extractTrailingTypstLabel(atxMatch[2]);
        const title = cleanTypstTitle(withoutLabel);

        if (title.length > 0) {
          const item: OutlineItem = {
            id: createUniqueItemId(filePath, lineNum, lineCounts),
            title,
            level: equalCount - 1,
            line: lineNum,
            filePath,
            fileName,
            rawCommand: atxMatch[1],
            kindLabel: `H${equalCount}`,
          };
          if (label) {
            item.label = label;
          }
          items.push(item);
        }

        i = effectiveLineEnd + 1;
        continue;
      }
    }

    const ch = masked[i];

    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      } else if (ch === '\n') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }

    if (ch === '`') {
      let ticks = 0;
      while (masked[i + ticks] === '`') ticks++;
      const closePos = masked.indexOf('`'.repeat(ticks), i + ticks);
      if (closePos !== -1) {
        i = closePos + ticks;
        continue;
      }
      i += ticks;
      continue;
    }

    if (ch === '#' && masked.startsWith('#heading', i)) {
      const prevChar = i > 0 ? masked[i - 1] : undefined;
      const nextChar = masked[i + 8];
      const validBefore = !prevChar || !/[a-zA-Z0-9_]/.test(prevChar);
      const validAfter = !nextChar || !/[a-zA-Z0-9_-]/.test(nextChar);

      if (validBefore && validAfter) {
        const startLine = getLineNumberAt(lineStarts, i);
        let cursor = i + 8;
        while (cursor < masked.length && isWhitespace(masked[cursor])) {
          cursor++;
        }

        let headingLevel = 1;
        let outlined = true;
        let argsText: string | null = null;
        let endCursor = cursor;

        if (masked[cursor] === '(') {
          const argsGroup = readBalancedTypstDelimiter(masked, cursor, '(', ')');
          if (argsGroup) {
            argsText = argsGroup.content;
            endCursor = argsGroup.endIndex;
            if (/\boutlined\s*:\s*false\b/.test(argsText)) {
              outlined = false;
            }
            const levelMatch = /\blevel\s*:\s*(\d+)\b/.exec(argsText);
            if (levelMatch) {
              headingLevel = Math.max(1, parseInt(levelMatch[1], 10));
            }
            cursor = endCursor;
            while (cursor < masked.length && isWhitespace(masked[cursor])) {
              cursor++;
            }
          }
        }

        let rawTitle: string | null = null;
        if (masked[cursor] === '[') {
          const bodyGroup = readBalancedTypstDelimiter(masked, cursor, '[', ']');
          if (bodyGroup) {
            rawTitle = bodyGroup.content;
            endCursor = bodyGroup.endIndex;
          }
        } else if (argsText !== null) {
          rawTitle = extractTypstHeadingBodyFromArgs(argsText);
        }

        if (outlined && rawTitle !== null) {
          const lineEnd = masked.indexOf('\n', endCursor);
          const trailingSlice = masked.slice(
            endCursor,
            lineEnd === -1 ? masked.length : lineEnd
          );
          const labelMatch = /^\s*<([a-zA-Z0-9_.:-]+)>/.exec(trailingSlice);
          const label = labelMatch ? labelMatch[1] : undefined;
          if (labelMatch) {
            endCursor += labelMatch[0].length;
          }

          const title = cleanTypstTitle(rawTitle);
          if (title.length > 0) {
            const item: OutlineItem = {
              id: createUniqueItemId(filePath, startLine, lineCounts),
              title,
              level: headingLevel - 1,
              line: startLine,
              filePath,
              fileName,
              rawCommand: 'heading',
              kindLabel: `H${headingLevel}`,
            };
            if (label) {
              item.label = label;
            }
            items.push(item);
          }
        }

        i = Math.max(i + 8, endCursor);
        continue;
      }
    }

    i++;
  }

  return items;
}

export function parseDocumentOutline(
  engine: 'latex' | 'typst',
  content: string,
  filePath: string,
  fileName: string
): OutlineItem[] {
  if (engine === 'typst') {
    return parseTypstOutline(content, filePath, fileName);
  }
  return parseLatexOutline(content, filePath, fileName);
}

export function buildOutlineTree(items: OutlineItem[]): OutlineTreeNode[] {
  const roots: OutlineTreeNode[] = [];
  const stack: OutlineTreeNode[] = [];

  for (const item of items) {
    while (stack.length > 0 && stack[stack.length - 1].item.level >= item.level) {
      stack.pop();
    }

    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    const node: OutlineTreeNode = {
      item,
      depth: parent ? parent.depth + 1 : 0,
      children: [],
    };

    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }

    stack.push(node);
  }

  return roots;
}

export function findActiveOutlineId(
  items: OutlineItem[],
  cursorLine: number | null | undefined
): string | null {
  if (cursorLine === null || cursorLine === undefined || !Number.isFinite(cursorLine)) {
    return null;
  }

  let activeId: string | null = null;
  for (const item of items) {
    if (item.line <= cursorLine) {
      activeId = item.id;
    }
  }
  return activeId;
}
