import type { MathContext } from '../../types/writing';

export interface TypstContextResult { context: MathContext; reason?: string }
type Mode = 'text' | 'math-inline' | 'math-display' | 'blocked';

const blocked = (reason: string): TypstContextResult => ({ context: 'blocked', reason });
const isWord = (c: string | undefined) => Boolean(c && /[\p{L}\p{N}_]/u.test(c));

/**
 * A deliberately conservative Typst lexer for insertion eligibility. It recognizes
 * mode delimiters and opaque constructs; it does not parse or evaluate Typst code.
 */
export function classifyTypstContext(source: string, offset: number): TypstContextResult {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) return blocked('The cursor is outside the current document.');
  if (hasUnclosedGroupBefore(source, offset)) return blocked('An incomplete group makes the current Typst context uncertain.');
  let mode: Mode = 'text';
  let mathStart = -1;
  const stack: Array<{ char: string; context: Mode }> = [];
  let i = 0;
  const stopInside = (start: number, end: number, what: string): TypstContextResult | null =>
    offset > start && offset < end ? blocked(`The cursor is inside a ${what} token.`) : null;

  while (i < source.length) {
    if (offset === i && source[i] !== '#') {
      if (mode === 'blocked') return blocked('Writing tools are unavailable in comments, code, strings, raw content, labels, and URLs.');
      if ((mode === 'math-inline' || mode === 'math-display') && isInsideMathIdentifier(source, offset)) {
        return blocked('The cursor is inside an existing math identifier.');
      }
      return { context: mode };
    }
    const c = source[i];
    if (mode === 'blocked') {
      // The blocked mode is only used while consuming a bounded lexical token.
      mode = stack[stack.length - 1]?.context ?? 'text';
    }
    if (source.startsWith('/*', i)) {
      let depth = 1; let j = i + 2;
      while (j < source.length && depth) {
        if (source.startsWith('/*', j)) { depth++; j += 2; }
        else if (source.startsWith('*/', j)) { depth--; j += 2; }
        else j++;
      }
      if (depth) return blocked('The cursor is after an incomplete block comment.');
      const inside = stopInside(i, j, 'comment'); if (inside) return inside;
      if (offset === j) return blocked('Writing tools are unavailable at a comment boundary.');
      i = j; continue;
    }
    if (source.startsWith('//', i)) {
      let j = source.indexOf('\n', i); if (j < 0) j = source.length;
      const inside = stopInside(i, j, 'comment'); if (inside) return inside;
      if (offset <= j) return blocked('Writing tools are unavailable in comments.');
      i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let closed = false;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '"') { j++; closed = true; break; }
        j++;
      }
      const inside = stopInside(i, j, 'string'); if (inside) return inside;
      if (!closed) return blocked('The string is incomplete.');
      if (offset === j) return blocked('Writing tools are unavailable at a string boundary.');
      i = j; continue;
    }
    if (c === '`') {
      let n = 1; while (source[i + n] === '`') n++;
      const marker = '`'.repeat(n); const end = source.indexOf(marker, i + n);
      if (end < 0) return blocked('The raw span is incomplete.');
      const j = end + n; const inside = stopInside(i, j, 'raw span'); if (inside) return inside;
      if (offset === j) return blocked('Writing tools are unavailable at a raw span boundary.');
      i = j; continue;
    }
    // Typst uses one dollar sign for both equation kinds. Whitespace immediately
    // inside both ends distinguishes display from inline math.
    if (c === '$') {
      let j = i + 1; while (source[j] === '$') j++;
      const count = j - i;
      if (count !== 1) return blocked('Typst equations use a single dollar-sign delimiter.');
      const inside = stopInside(i, j, 'equation delimiter'); if (inside) return inside;
      if (mode === 'text') {
        const close = findEquationClose(source, j);
        if (close < 0) return blocked('The equation delimiter is incomplete.');
        const display = /\s/.test(source[j] ?? '') && /\s/.test(source[close - 1] ?? '');
        mode = display ? 'math-display' : 'math-inline'; mathStart = i;
      } else if (mode === 'math-inline' || mode === 'math-display') {
        const expectedDisplay = /\s/.test(source[mathStart + 1] ?? '') && /\s/.test(source[i - 1] ?? '');
        if (count !== 1 || expectedDisplay !== (mode === 'math-display')) return blocked('The equation delimiters are mismatched or incomplete.');
        mode = 'text'; mathStart = -1;
      } else return blocked('Nested equation delimiters are ambiguous.');
      i = j; continue;
    }
    if (c === '\\') {
      if (i + 1 >= source.length) return blocked('The escape sequence is incomplete.');
      const inside = stopInside(i, i + 2, 'escape'); if (inside) return inside;
      i += 2; continue;
    }
    // Labels and references are atomic markup syntax and never insertion points.
    if (mode === 'text' && c === '<') {
      const close = source.indexOf('>', i + 1);
      if (close >= 0 && !/[\s<>]/.test(source.slice(i + 1, close))) {
        const inside = stopInside(i, close + 1, 'label'); if (inside) return inside;
        if (offset === close + 1) return blocked('Writing tools are unavailable at a label boundary.');
        i = close + 1; continue;
      }
    }
    if (mode === 'text' && c === '@' && isWord(source[i + 1])) {
      let j = i + 1; while (j < source.length && /[\p{L}\p{N}_:-]/u.test(source[j])) j++;
      const inside = stopInside(i, j, 'reference'); if (inside) return inside;
      if (offset === j) return blocked('Writing tools are unavailable at a reference boundary.');
      i = j; continue;
    }
    if (mode === 'text' && /^[a-z][a-z0-9+.-]*:\/\//i.test(source.slice(i, i + 256))) {
      let j = i; while (j < source.length && !/[\s<>()[\]{}]/.test(source[j])) j++;
      const inside = stopInside(i, j, 'URL'); if (inside) return inside;
      if (offset === j) return blocked('Writing tools are unavailable at a URL boundary.');
      i = j; continue;
    }
    if (c === '#') {
      // Typst code escape: consume a bounded identifier / call. A following
      // content block is scanned as markup, while other code stays unavailable.
      let j = i + 1;
      if (!/[\p{L}_]/u.test(source[j] ?? '')) return blocked('The code expression is incomplete or ambiguous.');
      while (j < source.length && /[\p{L}\p{N}_-]/u.test(source[j])) j++;
      while (source[j] === '.' && /[\p{L}_]/u.test(source[j + 1] ?? '')) {
        j++;
        while (j < source.length && /[\p{L}\p{N}_-]/u.test(source[j])) j++;
      }
      let lookahead = j;
      while (/\s/.test(source[lookahead] ?? '') && source[lookahead] !== '\n') lookahead++;
      if (source[lookahead] === '(') {
        const parsed = consumeBalanced(source, lookahead, '(', ')');
        if (!parsed) return blocked('The code expression has unbalanced parentheses.');
        j = parsed;
        lookahead = j;
        while (/\s/.test(source[lookahead] ?? '') && source[lookahead] !== '\n') lookahead++;
      }
      const keyword = source.slice(i + 1).match(/^[\p{L}\p{N}_-]+/u)?.[0] ?? '';
      if (['let', 'set', 'show', 'import', 'include', 'if', 'else', 'for', 'while', 'return', 'break', 'continue', 'context', 'not'].includes(keyword)) {
        j = consumeCodeStatement(source, i + 1);
      } else if (source[lookahead] === '[') {
        const parsed = consumeBalanced(source, lookahead, '[', ']');
        if (!parsed) return blocked('The content block is incomplete.');
        if (offset === lookahead) return blocked('The cursor is on a content-block delimiter.');
        if (offset >= i && offset < lookahead) return blocked('The cursor is inside a code expression token.');
        i = lookahead + 1;
        stack.push({ char: ']', context: mode });
        mode = 'text';
        continue;
      } else if (source[lookahead] === '=' || source.startsWith('+=', lookahead) || source.startsWith('-=', lookahead)) {
        j = consumeCodeStatement(source, i + 1);
      }
      if (offset >= i && offset < j) return blocked('The cursor is inside a code expression token.');
      i = j; continue;
    }
    if (c === '[' || c === '{' || c === '(') {
      stack.push({ char: c === '[' ? ']' : c === '{' ? '}' : ')', context: mode });
      i++; continue;
    }
    if (c === ']' || c === '}' || c === ')') {
      const top = stack[stack.length - 1];
      if (!top || top.char !== c) return blocked('A group delimiter is unmatched or ambiguous.');
      stack.pop(); mode = top.context; i++; continue;
    }
    i++;
  }
  if (offset === source.length) {
    if (mode === 'math-inline' || mode === 'math-display') return blocked('The equation is incomplete.');
    return { context: stack.length ? 'blocked' : mode };
  }
  return blocked('The cursor is inside an unsupported Typst construct.');
}

function consumeBalanced(source: string, start: number, open: string, close: string): number | null {
  if (source[start] !== open) return null;
  const groups: string[] = [];
  for (let i = start; i < source.length; i++) {
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i);
      if (newline < 0) return null;
      i = newline; continue;
    }
    if (source.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) return null;
      i--; continue;
    }
    if (source[i] === '"') {
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === '"') break;
      }
      if (source[i - 1] !== '"') return null;
      i--; continue;
    }
    if (source[i] === '`') {
      let count = 1; while (source[i + count] === '`') count++;
      const marker = '`'.repeat(count); const end = source.indexOf(marker, i + count);
      if (end < 0) return null;
      i = end + count - 1; continue;
    }
    if (source[i] === '\\') { i++; continue; }
    const c = source[i];
    if (c === '[' || c === '{' || c === '(') groups.push(c === '[' ? ']' : c === '{' ? '}' : ')');
    else if (c === ']' || c === '}' || c === ')') {
      if (groups[groups.length - 1] !== c) return null;
      groups.pop();
      if (groups.length === 0) return c === close ? i + 1 : null;
    }
  }
  return null;
}

function consumeCodeStatement(source: string, start: number): number {
  const groups: string[] = [];
  let i = start;
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i);
      if (groups.length === 0) return newline < 0 ? source.length : newline;
      if (newline < 0) return source.length;
      i = newline + 1; continue;
    }
    if (source.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) return source.length;
      continue;
    }
    if (source[i] === '"') {
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === '"') break;
      }
      continue;
    }
    if (source[i] === '`') {
      let count = 1; while (source[i + count] === '`') count++;
      const marker = '`'.repeat(count); const end = source.indexOf(marker, i + count);
      if (end < 0) return source.length;
      i = end + count; continue;
    }
    if (source[i] === '\\') { i += 2; continue; }
    const c = source[i];
    if (c === '\n' && groups.length === 0) {
      let previous = i - 1;
      while (previous >= start && /[ \t\r]/.test(source[previous])) previous--;
      if (/[=+*/,:\\-]/.test(source[previous] ?? '')) { i++; continue; }
      return i;
    }
    if (c === '[' || c === '{' || c === '(') groups.push(c === '[' ? ']' : c === '{' ? '}' : ')');
    else if ((c === ']' || c === '}' || c === ')') && groups[groups.length - 1] === c) groups.pop();
    i++;
  }
  return source.length;
}

function isInsideMathIdentifier(source: string, offset: number): boolean {
  const left = source[offset - 1]; const right = source[offset];
  if (isWord(left) && isWord(right)) return true;
  if (isWord(left) && right === '.' && isWord(source[offset + 1])) return true;
  return left === '.' && isWord(source[offset - 2]) && isWord(right);
}

function findEquationClose(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i);
      if (newline < 0) return -1;
      i = newline + 1; continue;
    }
    if (source.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) return -1;
      continue;
    }
    if (source[i] === '"') {
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === '"') break;
      }
      continue;
    }
    if (source[i] === '`') {
      let n = 1; while (source[i + n] === '`') n++;
      const marker = '`'.repeat(n); const end = source.indexOf(marker, i + n);
      if (end < 0) return -1;
      i = end + n; continue;
    }
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === '$') return i;
    i++;
  }
  return -1;
}

function hasUnclosedGroupBefore(source: string, offset: number): boolean {
  const stack: Array<{ close: string; index: number }> = [];
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i);
      i = newline < 0 ? source.length : newline + 1; continue;
    }
    if (source.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) return i >= offset;
      continue;
    }
    if (source[i] === '"') {
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === '"') break;
      }
      continue;
    }
    if (source[i] === '`') {
      let n = 1; while (source[i + n] === '`') n++;
      const marker = '`'.repeat(n); const close = source.indexOf(marker, i + n);
      if (close < 0) return i >= offset;
      i = close + n; continue;
    }
    if (source[i] === '\\') { i += 2; continue; }
    const c = source[i];
    if (c === '[' || c === '{' || c === '(') stack.push({ close: c === '[' ? ']' : c === '{' ? '}' : ')', index: i });
    else if (c === ']' || c === '}' || c === ')') {
      if (stack[stack.length - 1]?.close !== c) return i < offset;
      stack.pop();
    }
    i++;
  }
  return stack.some(({ index }) => index < offset);
}

export function classifyTypstRange(source: string, start: number, end: number): TypstContextResult {
  if (start < 0 || end < start || end > source.length) return blocked('The selection is outside the current document.');
  const first = classifyTypstContext(source, start);
  if (first.context === 'blocked') return first;
  if (start !== end) {
    const selected = source.slice(start, end);
    if (selected.includes('$') || /(?:\/\/|\/\*|#|<[^>]*>|@[\w:-]+|`)/.test(selected)) return blocked('The selection crosses a mode boundary or protected Typst token.');
    let balance = 0;
    for (let i = 0; i < selected.length; i++) {
      if (selected[i] === '"') return blocked('Selections containing strings are not supported.');
      if (selected[i] === '[' || selected[i] === '{' || selected[i] === '(') balance++;
      if (selected[i] === ']' || selected[i] === '}' || selected[i] === ')') balance--;
      if (balance < 0) return blocked('The selection crosses a group boundary.');
    }
    if (balance !== 0) return blocked('The selection crosses a group boundary.');
  }
  const last = classifyTypstContext(source, end);
  if (last.context === 'blocked') return last;
  if (first.context !== last.context) return blocked('The selection crosses a markup or math boundary.');
  return { context: first.context };
}
