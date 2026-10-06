import type { MathContext } from '../../types/writing';

const MATH_ENVS = new Set(['math', 'displaymath', 'equation', 'equation*', 'align', 'align*', 'aligned', 'alignedat', 'gather', 'gather*', 'gathered', 'multline', 'multline*', 'flalign', 'flalign*', 'alignat', 'alignat*', 'split', 'cases', 'array', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix']);
const SUBORDINATE_ENVS = new Set(['aligned', 'alignedat', 'gathered', 'split', 'cases', 'array', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix']);
const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'Verbatim', 'BVerbatim', 'LVerbatim', 'SaveVerbatim', 'lstlisting', 'minted', 'alltt', 'comment', 'filecontents', 'filecontents*']);
const TEXT_ARGUMENT_COMMANDS = new Set(['text', 'textrm', 'texttt', 'textbf', 'textit', 'mbox', 'url', 'path', 'detokenize', 'caption', 'section', 'subsection', 'title', 'author']);
const ENV_TOKEN = /^\\(begin|end)\s*\{([^}]+)\}/;
const COMMAND_TOKEN = /^\\([a-zA-Z]+)\*?/;

function slashCount(source: string, index: number): number {
  let count = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) count++;
  return count;
}
function isEscaped(source: string, index: number): boolean { return slashCount(source, index) % 2 === 1; }
function mode(stack: Array<{ env: string; context: MathContext }>, delimiter: MathContext | null): MathContext {
  const environmentContext = stack[stack.length - 1]?.context;
  if (environmentContext === 'math-environment' || environmentContext === 'blocked') return environmentContext;
  return delimiter ?? environmentContext ?? 'text';
}

interface ScanResult { context: MathContext; reason?: string; inPreamble: boolean }

function scan(source: string, offset: number): ScanResult {
  const stop = Math.max(0, Math.min(offset, source.length));
  const envStack: Array<{ env: string; context: MathContext }> = [];
  const groupStack: Array<{ depth: number; context: MathContext }> = [];
  let delimiter: { context: MathContext; token: string } | null = null;
  let documentStarted = false;
  let comment = false;
  let reason: string | undefined;
  // Only text-command arguments live in this stack; ordinary brace groups never freeze math mode.
  const current = () => groupStack[groupStack.length - 1]?.context === 'blocked'
    ? 'blocked'
    : mode(envStack, delimiter?.context ?? null);

  for (let i = 0; i < stop;) {
    const c = source[i];
    if (comment) { if (c === '\n') comment = false; i++; continue; }
    const lastEnvironment = envStack[envStack.length - 1];
    const activeVerbatim = lastEnvironment?.context === 'blocked' ? lastEnvironment.env : null;
    if (activeVerbatim) {
      const closeToken = `\\end{${activeVerbatim}}`;
      if (source.startsWith(closeToken, i)) { envStack.pop(); i += closeToken.length; }
      else i++;
      continue;
    }
    // A doubled backslash is one control symbol, so a following percent/dollar is not escaped by it.
    if (c === '\\' && source[i + 1] === '\\') {
      if (stop > i && stop < i + 2) return { context: 'blocked', reason: 'The cursor is inside a two-character control symbol.', inPreamble: !documentStarted };
      i += 2; continue;
    }
    // Math delimiters are recognized before ordinary commands.
    if (source.startsWith('\\(', i) || source.startsWith('\\[', i)) {
      const token = source.slice(i, i + 2);
      if (stop > i && stop < i + token.length) return { context: 'blocked', reason: 'The cursor is inside a LaTeX delimiter token.', inPreamble: !documentStarted };
      const next = source[i + 1] === '(' ? 'math-inline' : 'math-display';
      if (!delimiter && current() !== 'text') return { context: 'blocked', reason: 'Nested math delimiters make this context ambiguous.', inPreamble: !documentStarted };
      if (delimiter && ((delimiter.token === '$' && token === '\\)') || (delimiter.token === '$$' && token === '\\]'))) return { context: 'blocked', reason: 'Mismatched math delimiters make this context ambiguous.', inPreamble: !documentStarted };
      if (delimiter && (delimiter.token === '\\(' && token !== '\\)' || delimiter.token === '\\[' && token !== '\\]')) return { context: 'blocked', reason: 'Mismatched math delimiters make this context ambiguous.', inPreamble: !documentStarted };
      delimiter = delimiter ? null : { context: next, token: token === '\\(' ? '\\(' : '\\[' };
      i += 2; continue;
    }
    if (source.startsWith('\\)', i) || source.startsWith('\\]', i)) {
      const token = source.slice(i, i + 2);
      if (stop > i && stop < i + token.length) return { context: 'blocked', reason: 'The cursor is inside a LaTeX delimiter token.', inPreamble: !documentStarted };
      if (!delimiter || delimiter.token !== (token === '\\)' ? '\\(' : '\\[')) return { context: 'blocked', reason: 'Mismatched math delimiters make this context ambiguous.', inPreamble: !documentStarted };
      delimiter = null; i += 2; continue;
    }
    if (c === '$' && !isEscaped(source, i)) {
      const next: MathContext = source[i + 1] === '$' ? 'math-display' : 'math-inline';
      const token = next === 'math-display' ? '$$' : '$';
      if (token.length === 2 && stop > i && stop < i + token.length) return { context: 'blocked', reason: 'The cursor is inside a two-character math delimiter.', inPreamble: !documentStarted };
      if (delimiter && (delimiter.token === '$' || delimiter.token === '$$')) {
        if (delimiter.token !== token) return { context: 'blocked', reason: 'Mismatched math delimiters make this context ambiguous.', inPreamble: !documentStarted };
        delimiter = null;
      } else if (delimiter) return { context: 'blocked', reason: 'Mismatched math delimiters make this context ambiguous.', inPreamble: !documentStarted };
      else if (current() !== 'text') return { context: 'blocked', reason: 'Nested math delimiters make this context ambiguous.', inPreamble: !documentStarted };
      else delimiter = { context: next, token };
      i += token.length; continue;
    }
    if (c === '%' && !isEscaped(source, i)) { comment = true; i++; continue; }

    if (c === '\\') {
      // Escaped punctuation is atomic: \$, \%, \{, and \} never act as syntax.
      if (source[i + 1] && !/[a-zA-Z]/.test(source[i + 1])) {
        if (stop > i && stop < i + 2) return { context: 'blocked', reason: 'The cursor is inside a two-character control symbol.', inPreamble: !documentStarted };
        i += 2; continue;
      }
      const env = source.slice(i).match(ENV_TOKEN);
      if (env) {
        if (stop > i && stop < i + env[0].length) return { context: 'blocked', reason: 'The cursor is inside an environment token.', inPreamble: !documentStarted };
        if (env[1] === 'begin') {
          const name = env[2];
          if (name === 'document') documentStarted = true;
          if (MATH_ENVS.has(name) && current() !== 'text' && !SUBORDINATE_ENVS.has(name)) return { context: 'blocked', reason: 'Nested math environments make this context ambiguous.', inPreamble: !documentStarted };
          envStack.push({ env: name, context: VERBATIM_ENVS.has(name) ? 'blocked' : MATH_ENVS.has(name) ? 'math-environment' : current() });
          i += env[0].length; continue;
        }
        if (envStack.length && envStack[envStack.length - 1].env !== env[2]) return { context: 'blocked', reason: 'Mismatched LaTeX environments make this context ambiguous.', inPreamble: !documentStarted };
        if (envStack.length) envStack.pop();
        else return { context: 'blocked', reason: 'An unmatched LaTeX environment ending makes this context ambiguous.', inPreamble: !documentStarted };
        if (env[2] === 'document') documentStarted = false;
        i += env[0].length; continue;
      }
      const command = source.slice(i).match(COMMAND_TOKEN);
      if (command && stop > i && stop < i + command[0].length) return { context: 'blocked', reason: 'The cursor is inside a LaTeX command token.', inPreamble: !documentStarted };
      if (command?.[1] === 'verb') {
        let content = i + command[0].length;
        if (source[content] === '*') content++;
        const delimiterChar = source[content];
        if (!delimiterChar || delimiterChar === '\n') return { context: 'blocked', reason: 'The inline verbatim command is incomplete.', inPreamble: !documentStarted };
        const close = source.indexOf(delimiterChar, content + 1);
        if (close < 0 || stop <= close) return { context: 'blocked', reason: 'Writing tools are unavailable inside inline verbatim content.', inPreamble: !documentStarted };
        i = close + 1; continue;
      }
      if (command && TEXT_ARGUMENT_COMMANDS.has(command[1])) {
        let opening = i + command[0].length;
        while (opening < stop && /\s/.test(source[opening])) opening++;
        if (source[opening] === '{') groupStack.push({ depth: 0, context: 'blocked' });
        i += command[0].length; continue;
      }
      i += command?.[0].length ?? 1; continue;
    }

    if (c === '{') {
      if (groupStack.length) groupStack[groupStack.length - 1].depth++;
      i++; continue;
    }
    if (c === '}' && groupStack.length) {
      const top = groupStack[groupStack.length - 1];
      if (--top.depth === 0) groupStack.pop();
      i++; continue;
    }
    i++;
  }
  const active = envStack[envStack.length - 1]?.context === 'blocked' ? 'blocked' : current();
  if (active === 'blocked') return { context: 'blocked', reason: 'Writing tools are unavailable inside verbatim content.', inPreamble: !documentStarted };
  const activeText = source.split('\n').map((line) => {
    for (let i = 0; i < line.length; i++) if (line[i] === '%' && !isEscaped(line, i)) return line.slice(0, i) + ' '.repeat(line.length - i);
    return line;
  }).join('\n');
  const documentStart = activeText.search(/\\begin\s*\{document\}/);
  const hasDocumentClass = /\\documentclass\b/.test(activeText.slice(0, documentStart < 0 ? activeText.length : documentStart));
  if (hasDocumentClass && (documentStart < 0 || stop < documentStart)) return { context: 'blocked', reason: 'The cursor is in the document preamble.', inPreamble: true };
  const documentEndMatch = [...activeText.matchAll(/\\end\s*\{document\}/g)].pop();
  if (documentEndMatch?.index !== undefined && stop >= documentEndMatch.index + documentEndMatch[0].length) return { context: 'blocked', reason: 'Writing tools are unavailable outside the document body.', inPreamble: false };
  const lineStart = source.lastIndexOf('\n', Math.max(0, stop - 1)) + 1;
  let comments = false;
  for (let i = lineStart; i < stop; i++) if (source[i] === '%' && !isEscaped(source, i)) { comments = true; break; }
  if (comments) return { context: 'blocked', reason: 'Writing tools are unavailable in comments.', inPreamble: !documentStarted };
  if (groupStack[groupStack.length - 1]?.context === 'blocked') return { context: 'blocked', reason: 'Writing tools are unavailable inside text command arguments.', inPreamble: !documentStarted };
  return { context: active, reason, inPreamble: !documentStarted };
}

export interface ContextResult { context: MathContext; reason?: string }

/** Classifies a Monaco UTF-16 offset without interpreting macros or expanding user definitions. */
export function classifyLatexContext(source: string, offset: number): ContextResult {
  const result = scan(source, offset);
  return { context: result.context, reason: result.reason };
}

export function classifyLatexRange(source: string, start: number, end: number): ContextResult {
  if (start < 0 || end < start || end > source.length) return { context: 'blocked', reason: 'The selection is outside the current document.' };
  const first = scan(source, start);
  if (first.context === 'blocked') return { context: 'blocked', reason: first.reason };
  if (start !== end) {
    const selected = source.slice(start, end);
    let slashes = 0;
    let braceDepth = 0;
    for (let i = 0; i < selected.length; i++) {
      const c = selected[i];
      if (c === '%' && slashes % 2 === 0) return { context: 'blocked', reason: 'Selections containing comments are not supported.' };
      if (c === '$' && slashes % 2 === 0) return { context: 'blocked', reason: 'The selection crosses a text or math boundary.' };
      if (c === '\\' && slashes % 2 === 0) {
        const token = selected.slice(i, i + 2);
        if (['\\(', '\\)', '\\[', '\\]'].includes(token) || /^\\(?:begin|end)\s*\{(?:math|displaymath|equation\*?|align\*?|aligned|alignedat|gather\*?|gathered|multline\*?|flalign\*?|alignat\*?|split|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases|array)\}/.test(selected.slice(i)) || /^\\(?:text|textrm|texttt|textbf|textit|mbox|url|path|detokenize|caption|section|subsection|title|author)\*?(?:\s*\{)/.test(selected.slice(i))) {
          return { context: 'blocked', reason: 'The selection crosses a text or math boundary.' };
        }
      }
      if (c === '{' && slashes % 2 === 0) braceDepth++;
      if (c === '}' && slashes % 2 === 0 && --braceDepth < 0) return { context: 'blocked', reason: 'The selection crosses a brace-group boundary.' };
      if (c === '\\') slashes++; else slashes = 0;
    }
    if (braceDepth !== 0) return { context: 'blocked', reason: 'The selection crosses a brace-group boundary.' };
  }
  const last = scan(source, end);
  if (last.context === 'blocked') return { context: 'blocked', reason: last.reason };
  if (last.context !== first.context) return { context: 'blocked', reason: 'The selection crosses a text or math boundary.' };
  return { context: first.context };
}

export function symbolInsertion(command: string, context: MathContext, source: string, _start: number, end: number): { text: string; reason?: string } {
  if (context === 'blocked') return { text: '', reason: 'This LaTeX context does not support symbol insertion.' };
  if (context !== 'text') return { text: `${command}${/^[a-zA-Z]/.test(source.slice(end)) ? '{}' : ''}` };
  return { text: `\\(${command}\\)` };
}
