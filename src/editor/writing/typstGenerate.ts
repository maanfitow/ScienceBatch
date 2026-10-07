import type { MathContext } from '../../types/writing';
import type { TypstSymbolEntry } from './typstSymbols';

export interface TypstInsertionResult { text: string; reason?: string }

const boundaryCharacter = (character: string | undefined) => Boolean(character && /[\p{L}\p{N}_]/u.test(character));

/** Generate only native Typst source; this function never emits LaTeX. */
export function typstSymbolInsertion(
  symbol: string | TypstSymbolEntry,
  context: MathContext,
  source: string,
  start: number,
  end: number,
): TypstInsertionResult {
  if (context === 'blocked' || context === 'math-environment') return { text: '', reason: 'This Typst context does not support symbol insertion.' };
  if (start < 0 || end < start || end > source.length) return { text: '', reason: 'The selection is outside the current document.' };
  const identifier = typeof symbol === 'string' ? symbol : symbol.nativeIdentifier;
  if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(identifier)) return { text: '', reason: 'Choose a verified built-in Typst symbol.' };
  if (context === 'text') return { text: `$${identifier}$` };

  if (start === end && isInsideMathIdentifier(source, start)) {
    return { text: '', reason: 'Place the cursor between math identifiers or select the complete identifier before inserting.' };
  }
  const before = source[start - 1];
  const after = source[end];
  // Typst math tokenization joins alphabetic names and dotted fields. Spaces
  // around those boundaries preserve a standalone native symbol identifier.
  const leftSpace = boundaryCharacter(before) || before === '.';
  const rightSpace = boundaryCharacter(after) || after === '.';
  return { text: `${leftSpace ? ' ' : ''}${identifier}${rightSpace ? ' ' : ''}` };
}

function isInsideMathIdentifier(source: string, offset: number): boolean {
  const word = (character: string | undefined) => Boolean(character && /[\p{L}\p{N}_]/u.test(character));
  const left = source[offset - 1]; const right = source[offset];
  if (word(left) && word(right)) return true;
  if (word(left) && right === '.' && word(source[offset + 1])) return true;
  return left === '.' && word(source[offset - 2]) && word(right);
}
