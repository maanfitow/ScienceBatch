import type { WritingChange, WritingLanguage } from '../../types/writing';
import { classifyLatexContext, classifyLatexRange } from './context';
import { classifyTypstContext, classifyTypstRange } from './typstContext';

export type TextFormattingKind = 'bold' | 'italic';

export interface TextFormattingSelection {
  start: number;
  end: number;
  anchor: number;
  active: number;
}

export interface TextFormattingPlan {
  enabled: boolean;
  active: boolean;
  reason?: string;
  change?: WritingChange;
}

interface Wrapper {
  kind: TextFormattingKind;
  start: number;
  bodyStart: number;
  bodyEnd: number;
  end: number;
  openEnd: number;
}

interface Delimiter {
  char: string;
  index: number;
  kind?: TextFormattingKind;
  openEnd?: number;
}

const LATEX_VERBATIM_ENVIRONMENTS = new Set(['verbatim', 'verbatim*', 'Verbatim', 'BVerbatim', 'LVerbatim', 'SaveVerbatim', 'lstlisting', 'minted', 'alltt', 'comment', 'filecontents', 'filecontents*']);
const LATEX_MACRO_DEFINITIONS = new Set(['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand']);

const unavailable = (reason: string, active = false): TextFormattingPlan => ({ enabled: false, active, reason });
const prefixFor = (language: WritingLanguage, kind: TextFormattingKind) => language === 'latex'
  ? kind === 'bold' ? '\\textbf{' : '\\textit{'
  : kind === 'bold' ? '#strong[' : '#emph[';
const closingFor = (language: WritingLanguage) => language === 'latex' ? '}' : ']';

function isHighSurrogate(char: string | undefined): boolean { return Boolean(char && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdbff); }
function isLowSurrogate(char: string | undefined): boolean { return Boolean(char && char.charCodeAt(0) >= 0xdc00 && char.charCodeAt(0) <= 0xdfff); }
function cutsSurrogate(source: string, offset: number): boolean { return isHighSurrogate(source[offset - 1]) && isLowSurrogate(source[offset]); }
function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) slashes++;
  return slashes % 2 === 1;
}

function latexEnvironmentToken(source: string, index: number): { kind: 'begin' | 'end'; name: string; end: number } | null {
  const sample = source.slice(index, index + 160);
  const match = sample.match(/^\\(begin|end)\s*\{([^}]+)\}/);
  return match ? { kind: match[1] as 'begin' | 'end', name: match[2], end: index + match[0].length } : null;
}

function latexVerbEnd(source: string, index: number): number | null {
  if (!source.startsWith('\\verb', index) || /[A-Za-z]/.test(source[index + 5] ?? '')) return null;
  let delimiterIndex = index + 5;
  if (source[delimiterIndex] === '*') delimiterIndex++;
  const delimiter = source[delimiterIndex];
  if (!delimiter || delimiter === '\n') return source.length;
  const close = source.indexOf(delimiter, delimiterIndex + 1);
  return close < 0 ? source.length : close + 1;
}

function skipLatexSpaceAndComments(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) { cursor++; continue; }
    if (source[cursor] === '%' && !isEscaped(source, cursor)) {
      const newline = source.indexOf('\n', cursor);
      cursor = newline < 0 ? source.length : newline + 1;
      continue;
    }
    break;
  }
  return cursor;
}

/** Returns the end of one balanced LaTeX group, or null when the group is malformed. */
function latexGroupEnd(source: string, start: number): number | null {
  if (source[start] !== '{') return null;
  let depth = 1;
  let verbatim: string | null = null;
  for (let index = start + 1; index < source.length; index++) {
    if (verbatim) {
      const close = `\\end{${verbatim}}`;
      if (source.startsWith(close, index)) { index += close.length - 1; verbatim = null; }
      continue;
    }
    const char = source[index];
    if (char === '%' && !isEscaped(source, index)) {
      const newline = source.indexOf('\n', index);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (char === '\\') {
      const verbEnd = latexVerbEnd(source, index);
      if (verbEnd !== null) { index = verbEnd - 1; continue; }
      const environment = latexEnvironmentToken(source, index);
      if (environment?.kind === 'begin' && LATEX_VERBATIM_ENVIRONMENTS.has(environment.name)) {
        verbatim = environment.name;
        index = environment.end - 1;
        continue;
      }
      if (source[index + 1]) index++;
      continue;
    }
    if ((char === '{' || char === '}') && isEscaped(source, index)) continue;
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return index + 1;
  }
  return null;
}

function latexMacroDefinitionEnd(source: string, command: string, commandEnd: number): number {
  let cursor = commandEnd;
  if (LATEX_MACRO_DEFINITIONS.has(command)) {
    if (source[cursor] === '*') cursor++;
    cursor = skipLatexSpaceAndComments(source, cursor);
    if (source[cursor] === '{') {
      const nameEnd = latexGroupEnd(source, cursor);
      if (nameEnd === null) return source.length;
      cursor = nameEnd;
    } else if (source[cursor] === '\\') {
      cursor++;
      while (/[A-Za-z]/.test(source[cursor] ?? '')) cursor++;
    } else return source.length;
    cursor = skipLatexSpaceAndComments(source, cursor);
    for (let optional = 0; optional < 2 && source[cursor] === '['; optional++) {
      let depth = 1;
      cursor++;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === '\\') { cursor += 2; continue; }
        if (source[cursor] === '[') depth++;
        else if (source[cursor] === ']') depth--;
        cursor++;
      }
      if (depth > 0) return source.length;
      cursor = skipLatexSpaceAndComments(source, cursor);
    }
  } else {
    cursor = skipLatexSpaceAndComments(source, cursor);
    if (source[cursor] !== '\\') return source.length;
    cursor++;
    while (/[A-Za-z]/.test(source[cursor] ?? '')) cursor++;
    while (cursor < source.length && source[cursor] !== '{') {
      if (source[cursor] === '%' && !isEscaped(source, cursor)) {
        const newline = source.indexOf('\n', cursor);
        if (newline < 0) return source.length;
        cursor = newline + 1;
      } else if (source[cursor] === '\\' && source[cursor + 1]) cursor += 2;
      else cursor++;
    }
  }
  const bodyEnd = latexGroupEnd(source, cursor);
  return bodyEnd ?? source.length;
}

function findLatexMacroDefinitionRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let comment = false;
  let verbatim: string | null = null;
  for (let index = 0; index < source.length;) {
    if (comment) { if (source[index] === '\n') comment = false; index++; continue; }
    if (verbatim) {
      const close = `\\end{${verbatim}}`;
      if (source.startsWith(close, index)) { index += close.length; verbatim = null; }
      else index++;
      continue;
    }
    if (source[index] === '%' && !isEscaped(source, index)) { comment = true; index++; continue; }
    if (source[index] !== '\\' || isEscaped(source, index)) { index++; continue; }
    const verbEnd = latexVerbEnd(source, index);
    if (verbEnd !== null) { index = verbEnd; continue; }
    const environment = latexEnvironmentToken(source, index);
    if (environment?.kind === 'begin' && LATEX_VERBATIM_ENVIRONMENTS.has(environment.name)) {
      verbatim = environment.name;
      index = environment.end;
      continue;
    }
    const command = source.slice(index + 1, index + 40).match(/^([A-Za-z]+)/)?.[1];
    if (!command) { index += Math.min(2, source.length - index); continue; }
    if (LATEX_MACRO_DEFINITIONS.has(command) || command === 'def') {
      const end = latexMacroDefinitionEnd(source, command, index + command.length + 1);
      ranges.push({ start: index, end });
      index = Math.max(index + command.length + 1, end);
    } else index += command.length + 1;
  }
  return ranges;
}

function hasUnmatchedLatexBraceBefore(source: string, offset: number): boolean {
  const stack: number[] = [];
  const unmatched: number[] = [];
  let comment = false;
  let verbatim: string | null = null;
  for (let index = 0; index < source.length; index++) {
    if (comment) { if (source[index] === '\n') comment = false; continue; }
    if (verbatim) {
      const close = `\\end{${verbatim}}`;
      if (source.startsWith(close, index)) { index += close.length - 1; verbatim = null; }
      continue;
    }
    const char = source[index];
    if (char === '%' && !isEscaped(source, index)) { comment = true; continue; }
    if (char === '\\') {
      const verbEnd = latexVerbEnd(source, index);
      if (verbEnd !== null) { index = verbEnd - 1; continue; }
      const environment = latexEnvironmentToken(source, index);
      if (environment?.kind === 'begin' && LATEX_VERBATIM_ENVIRONMENTS.has(environment.name)) {
        verbatim = environment.name;
        index = environment.end - 1;
        continue;
      }
      if (source[index + 1]) index++;
      continue;
    }
    if ((char === '{' || char === '}') && isEscaped(source, index)) continue;
    if (char === '{') stack.push(index);
    else if (char === '}') {
      if (stack.length) stack.pop();
    }
  }
  unmatched.push(...stack);
  return unmatched.some(index => index < offset);
}

/** Finds balanced canonical wrappers in one bounded scan; it does not evaluate macros or Typst code. */
function findWrappers(source: string, language: WritingLanguage): Wrapper[] {
  const open = language === 'latex' ? '{' : '[';
  const close = closingFor(language);
  const stack: Delimiter[] = [];
  const wrappers: Wrapper[] = [];
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\' && language === 'latex') {
      const bold = source.startsWith('\\textbf{', index);
      const italic = source.startsWith('\\textit{', index);
      if ((bold || italic) && !isEscaped(source, index)) {
        const kind: TextFormattingKind = bold ? 'bold' : 'italic';
        const prefixLength = bold ? '\\textbf{'.length : '\\textit{'.length;
        stack.push({ char: open, index, kind, openEnd: index + prefixLength });
        index += prefixLength - 1;
        continue;
      }
      if (source[index + 1]) index++;
      continue;
    }
    if (char === '#' && language === 'typst') {
      const bold = source.startsWith('#strong[', index);
      const italic = source.startsWith('#emph[', index);
      if ((bold || italic) && !isEscaped(source, index)) {
        const kind: TextFormattingKind = bold ? 'bold' : 'italic';
        const prefixLength = bold ? '#strong['.length : '#emph['.length;
        stack.push({ char: open, index, kind, openEnd: index + prefixLength });
        index += prefixLength - 1;
        continue;
      }
    }
    if (((language === 'latex' && (char === '{' || char === '}')) || (language === 'typst' && (char === '[' || char === ']'))) && isEscaped(source, index)) continue;
    if (char === open) {
      stack.push({ char, index });
      continue;
    }
    if (char !== close) continue;
    const top = stack[stack.length - 1];
    if (!top || top.char !== open) continue;
    stack.pop();
    if (top.kind !== undefined && top.openEnd !== undefined) {
      wrappers.push({ kind: top.kind, start: top.index, bodyStart: top.openEnd, bodyEnd: index, end: index + 1, openEnd: top.openEnd });
    }
  }
  return wrappers;
}

function unsupportedLatexFormatting(source: string, start: number, end: number): boolean {
  const paragraphStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const newline = source.indexOf('\n', end);
  const paragraphEnd = newline < 0 ? source.length : newline;
  const text = source.slice(paragraphStart, paragraphEnd);
  return /\\(?:emph|bfseries|itshape|bf|it)\b/.test(text);
}

function typstShorthandRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let lineStart = 0;
  while (lineStart <= source.length) {
    const lineEndFound = source.indexOf('\n', lineStart);
    const lineEnd = lineEndFound < 0 ? source.length : lineEndFound;
    const line = source.slice(lineStart, lineEnd);
    for (const marker of ['*', '_']) {
      for (let open = 0; open < line.length; open++) {
        if (line[open] !== marker || isEscaped(line, open)) continue;
        const before = line[open - 1];
        if (before && /[\p{L}\p{N}]/u.test(before)) continue;
        let close = open + 1;
        while (close < line.length) {
          const found = line.indexOf(marker, close);
          if (found < 0) break;
          if (!isEscaped(line, found) && found > open + 1) { close = found; break; }
          close = found + 1;
        }
        if (close >= line.length || line[close] !== marker) continue;
        const after = line[close + 1];
        if (after && /[\p{L}\p{N}]/u.test(after)) continue;
        if (/\s/.test(line[open + 1] ?? '') || /\s/.test(line[close - 1] ?? '')) continue;
        ranges.push({ start: lineStart + open, end: lineStart + close + 1 });
        open = close;
      }
    }
    if (lineEndFound < 0) break;
    lineStart = lineEnd + 1;
  }
  return ranges;
}

function containsOrTouches(start: number, end: number, range: { start: number; end: number }): boolean {
  return start === end ? start >= range.start && start <= range.end : start < range.end && end > range.start;
}

function hasUnsafeStructure(language: WritingLanguage, source: string): boolean {
  if (language === 'latex') {
    if (/(?:\\\\|\\(?:begin|end)\s*\{)/.test(source)) return true;
    for (let index = 0; index < source.length; index++) if (source[index] === '&' && !isEscaped(source, index)) return true;
    return false;
  }
  for (let index = 0; index < source.length; index++) {
    if ((source[index] === '|' || source[index] === ';') && !isEscaped(source, index)) return true;
  }
  return false;
}

function hasUnsafeTypstSelection(source: string): boolean {
  for (let index = 0; index < source.length; index++) {
    if ('#[\]`'.includes(source[index]) && !isEscaped(source, index)) return true;
  }
  return false;
}

function cutsEscape(language: WritingLanguage, source: string, offset: number): boolean {
  if (source[offset - 1] !== '\\') return false;
  return language === 'latex' ? /[^a-zA-Z]/.test(source[offset] ?? '') : /[#$\[\]_*%&|]/.test(source[offset] ?? '');
}

function makeSelection(language: WritingLanguage, source: string, selection: TextFormattingSelection): { start: number; end: number; anchor: number; active: number } | null {
  const { start, end, anchor, active } = selection;
  if (![start, end, anchor, active].every(Number.isInteger) || start < 0 || end < start || end > source.length) return null;
  if (anchor < 0 || anchor > source.length || active < 0 || active > source.length) return null;
  if (Math.min(anchor, active) !== start || Math.max(anchor, active) !== end) return null;
  if ([start, end, anchor, active].some(offset => cutsSurrogate(source, offset) || cutsEscape(language, source, offset))) return null;
  return { start, end, anchor, active };
}

function mapUnwrappedOffset(offset: number, wrapper: Wrapper): number {
  const bodyOffset = Math.max(0, Math.min(wrapper.bodyEnd - wrapper.bodyStart, offset - wrapper.bodyStart));
  return wrapper.start + bodyOffset;
}

function planChange(start: number, end: number, text: string, newAnchor: number, newActive: number): WritingChange {
  return { start, end, text, selection: { anchor: newAnchor, active: newActive } };
}

function sanitizedSource(source: string, wrappers: Wrapper[]): string {
  const characters = source.split('');
  for (const wrapper of wrappers) {
    for (let index = wrapper.start; index < wrapper.bodyStart; index++) characters[index] = ' ';
    characters[wrapper.bodyEnd] = ' ';
  }
  return characters.join('');
}

function validatedTargetWrappers(language: WritingLanguage, source: string, wrappers: Wrapper[]): Wrapper[] {
  const trusted: Wrapper[] = [];
  // Check outer wrappers first and mask only validated ancestors, leaving protected syntax visible.
  const ordered = [...wrappers].sort((left, right) => (right.end - right.start) - (left.end - left.start));
  for (const wrapper of ordered) {
    const ancestors = trusted.filter(parent => parent.start < wrapper.start && parent.end > wrapper.end);
    const candidate = sanitizedSource(source, ancestors);
    if (language === 'latex') {
      if (classifyLatexContext(candidate, wrapper.start).context === 'text') trusted.push(wrapper);
      continue;
    }
    const opener = classifyTypstContext(candidate, wrapper.start);
    if (opener.reason !== 'The cursor is inside a code expression token.') continue;
    const nested = wrappers.filter(child => child.start > wrapper.start && child.end < wrapper.end);
    let visibleProbe = wrapper.bodyStart;
    for (let index = wrapper.bodyStart; index < wrapper.bodyEnd; index++) {
      if (nested.some(child => (index >= child.start && index < child.bodyStart) || (index >= child.bodyEnd && index < child.end))) continue;
      if (candidate[index] === '\\' && index + 1 < wrapper.bodyEnd) { index++; continue; }
      visibleProbe = index;
      break;
    }
    if (classifyTypstContext(candidate, visibleProbe).context === 'text') trusted.push(wrapper);
  }
  return wrappers.filter(wrapper => trusted.includes(wrapper));
}

function maskTypstEscapes(source: string, selection: TextFormattingSelection): string {
  const characters = source.split('');
  for (const match of source.matchAll(/\\[#$\[\]_*%&|]/g)) {
    const index = match.index ?? 0;
    const end = index + match[0].length;
    if (index >= selection.start && end <= selection.end && !isEscaped(source, index)) {
      characters[index] = ' ';
      characters[index + 1] = ' ';
    }
  }
  return characters.join('');
}

function hasParagraphBoundary(language: WritingLanguage, source: string): boolean {
  if (/\r?\n[ \t]*\r?\n/.test(source)) return true;
  return language === 'latex' && /\\(?:par|item)\b|\\begin\s*\{(?:itemize|enumerate|description|equation|align|tabular|table)/.test(source);
}

function isTypstUrlOffset(source: string, start: number, end: number): boolean {
  for (const match of source.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi)) {
    const urlStart = match.index ?? 0;
    const urlEnd = urlStart + match[0].length;
    if (start === end ? start >= urlStart && start < urlEnd : start < urlEnd && end > urlStart) return true;
  }
  return false;
}

function hasUnsafeFormattingContent(language: WritingLanguage, source: string, start: number, end: number): boolean {
  const content = source.slice(start, end);
  if (hasParagraphBoundary(language, content) || hasUnsafeStructure(language, content)) return true;
  if (language === 'latex') return /\\[a-zA-Z]+|\\[()[\]$]/.test(content);
  return hasUnsafeTypstSelection(content) || isTypstUrlOffset(source, start, end);
}

function classifyTextRange(language: WritingLanguage, source: string, start: number, end: number): { context: string; reason?: string } {
  return language === 'latex'
    ? classifyLatexRange(source, start, end)
    : classifyTypstRange(source, start, end);
}

/** Plans one bounded source edit for canonical native bold/italic markup. */
export function planTextFormatting(
  language: WritingLanguage,
  source: string,
  selection: TextFormattingSelection,
  kind: TextFormattingKind,
): TextFormattingPlan {
  const range = makeSelection(language, source, selection);
  if (!range) return unavailable('The selection or cursor is outside a valid UTF-16 source boundary.');
  const { start, end, anchor, active } = range;
  if (language === 'latex') {
    if (hasUnmatchedLatexBraceBefore(source, start) || hasUnmatchedLatexBraceBefore(source, end)) {
      return unavailable('Writing tools are unavailable inside an unmatched LaTeX brace group.');
    }
    const definition = findLatexMacroDefinitionRanges(source).find(candidate =>
      start === end ? start >= candidate.start && start < candidate.end : start < candidate.end && end > candidate.start,
    );
    if (definition) return unavailable('Writing tools are unavailable inside a LaTeX macro definition.');
  }
  const wrappers = findWrappers(source, language);
  const enclosingCandidates = wrappers.filter(wrapper =>
    start === end
      ? start >= wrapper.bodyStart && start <= wrapper.bodyEnd
      : (start >= wrapper.bodyStart && end <= wrapper.bodyEnd) || (start === wrapper.start && end === wrapper.end),
  );
  const involvedWrappers = wrappers.filter(wrapper =>
    enclosingCandidates.includes(wrapper)
      || enclosingCandidates.some(parent => wrapper.start > parent.start && wrapper.end < parent.end)
      || (start === end ? start >= wrapper.start && start <= wrapper.end : start < wrapper.end && end > wrapper.start),
  );
  if (involvedWrappers.length > 32) return unavailable('Formatting inside more than 32 nested or selected wrappers is not supported.');
  const trustedWrappers = validatedTargetWrappers(language, source, involvedWrappers);
  const untrustedOverlap = involvedWrappers.find(wrapper => !trustedWrappers.includes(wrapper) && containsOrTouches(start, end, wrapper));
  if (untrustedOverlap) return unavailable('This canonical-looking wrapper is inside protected or ambiguous source; edit it directly.');
  const sameKind = trustedWrappers.filter(wrapper => wrapper.kind === kind);
  const crossedWrapper = end > start && trustedWrappers.find(wrapper =>
    start < wrapper.end && end > wrapper.start
      && !(start >= wrapper.bodyStart && end <= wrapper.bodyEnd)
      && !(start <= wrapper.start && end >= wrapper.end),
  );
  if (crossedWrapper) return unavailable('Selections crossing a formatting wrapper boundary are not supported.');
  const supportedAncestors = trustedWrappers.filter(wrapper =>
    start === end
      ? start >= wrapper.bodyStart && start <= wrapper.bodyEnd
      : (start >= wrapper.bodyStart && end <= wrapper.bodyEnd) || (start === wrapper.start && end === wrapper.end) || (start <= wrapper.start && end >= wrapper.end),
  );
  const selectedWrapper = sameKind
    .filter(wrapper => (start === wrapper.start && end === wrapper.end) || (start === wrapper.bodyStart && end === wrapper.bodyEnd))
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
  const activeWrapper = selectedWrapper ?? (start === end
    ? sameKind.filter(wrapper => start >= wrapper.bodyStart && start <= wrapper.bodyEnd)
      .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0]
    : undefined);

  if (language === 'typst') {
    const shorthand = typstShorthandRanges(source).find(candidate => containsOrTouches(start, end, candidate));
    if (shorthand) return unavailable('This Typst emphasis uses shorthand syntax; edit the source directly.');
    if (isTypstUrlOffset(source, start, end)) return unavailable('Writing tools are unavailable inside URLs.');
  } else if (unsupportedLatexFormatting(source, start, end)) {
    return unavailable('This LaTeX paragraph uses a non-canonical font declaration; edit the source directly.', false);
  }

  const sameKindOverlap = sameKind.find(wrapper =>
    start === end
      ? start >= wrapper.bodyStart && start <= wrapper.bodyEnd
      : start < wrapper.bodyEnd && end > wrapper.bodyStart,
  );
  if (sameKindOverlap && !activeWrapper) {
    return unavailable('Select the complete formatted text to remove this style.', true);
  }
  if (activeWrapper) {
    if (activeWrapper.end - activeWrapper.start > 100_000 || hasParagraphBoundary(language, source.slice(activeWrapper.start, activeWrapper.end))) {
      return unavailable('Multi-paragraph or oversized formatted ranges are not supported.', true);
    }
    let candidateSource = sanitizedSource(source, trustedWrappers);
    if (language === 'typst') candidateSource = maskTypstEscapes(candidateSource, {
      start: activeWrapper.bodyStart,
      end: activeWrapper.bodyEnd,
      anchor: activeWrapper.bodyStart,
      active: activeWrapper.bodyEnd,
    });
    if (hasUnsafeFormattingContent(language, candidateSource, activeWrapper.bodyStart, activeWrapper.bodyEnd)) {
      return unavailable('The complete formatted body contains protected syntax; edit the source directly.', true);
    }
    const context = classifyTextRange(language, candidateSource, activeWrapper.bodyStart, activeWrapper.bodyEnd);
    if (context.context !== 'text') return unavailable(context.reason || 'This formatted source is protected or ambiguous.', true);
    const body = source.slice(activeWrapper.bodyStart, activeWrapper.bodyEnd);
    const nextAnchor = start === activeWrapper.start && end === activeWrapper.end
      ? anchor <= active ? activeWrapper.start : activeWrapper.start + body.length
      : mapUnwrappedOffset(anchor, activeWrapper);
    const nextActive = start === activeWrapper.start && end === activeWrapper.end
      ? anchor <= active ? activeWrapper.start + body.length : activeWrapper.start
      : mapUnwrappedOffset(active, activeWrapper);
    return {
      enabled: true,
      active: true,
      change: planChange(activeWrapper.start, activeWrapper.end, body, nextAnchor, nextActive),
    };
  }

  if (end > start && hasParagraphBoundary(language, source.slice(start, end))) return unavailable('Selections spanning multiple paragraphs are not supported.');
  if (end > start && hasUnsafeStructure(language, source.slice(start, end))) return unavailable('Selections containing structural separators are not supported.');

  // Mask only canonical wrapper ancestors of this selection. Protected constructs remain intact,
  // so the shared classifiers continue to reject math, comments, URLs, raw content, and code.
  for (const wrapper of supportedAncestors) {
    if (hasParagraphBoundary(language, source.slice(wrapper.start, wrapper.end))) return unavailable('Multi-paragraph formatting wrappers are not supported.');
  }
  let contextSource = sanitizedSource(source, trustedWrappers);
  if (language === 'typst' && end > start) contextSource = maskTypstEscapes(contextSource, range);
  const contextSelection = contextSource.slice(start, end);
  if (language === 'latex' && end > start && /\\[a-zA-Z]+|\\[()[\]$]/.test(contextSelection)) {
    return unavailable('Selections containing LaTeX commands or delimiters are not supported.');
  }
  if (language === 'typst' && end > start && hasUnsafeTypstSelection(contextSelection)) {
    return unavailable('Selections containing Typst code or markup delimiters are not supported.');
  }
  const context = classifyTextRange(language, contextSource, start, end);
  if (context.context !== 'text') return unavailable(context.reason || 'Text formatting is unavailable in this source context.');
  if (end > start && source.slice(start, end).trim().length === 0) return unavailable('Select non-whitespace text to apply formatting.');
  if (end > start && end - start > 100_000) return unavailable('Selections over 100,000 UTF-16 units are not supported.');

  const prefix = prefixFor(language, kind);
  const suffix = closingFor(language);
  const selectedText = source.slice(start, end);
  const text = `${prefix}${selectedText}${suffix}`;
  const prefixLength = prefix.length;
  const nextAnchor = start === end ? start + prefixLength : start + prefixLength + (anchor - start);
  const nextActive = start === end ? nextAnchor : start + prefixLength + (active - start);
  return {
    enabled: true,
    active: false,
    change: planChange(start, end, text, nextAnchor, nextActive),
  };
}
