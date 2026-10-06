import type { MathContext, SymbolEntry, WritingCategory } from '../../types/writing';
import { classifyLatexContext, classifyLatexRange, symbolInsertion as latexSymbolInsertion } from './context';
import { searchWritingSymbols } from './symbols';
import { classifyTypstContext, classifyTypstRange } from './typstContext';
import { searchTypstSymbols, TYPST_WRITING_SYMBOLS, type TypstSymbolEntry } from './typstSymbols';
import { typstSymbolInsertion } from './typstGenerate';

export interface WritingSymbolAdapter {
  language: 'latex' | 'typst';
  previewKind: 'latex' | 'glyph';
  supportsStructures: boolean;
  classifyContext(source: string, offset: number): { context: MathContext; reason?: string };
  classifyRange(source: string, start: number, end: number): { context: MathContext; reason?: string };
  searchSymbols(query: string, category?: WritingCategory): SymbolEntry[];
  symbolInsertion(command: string, context: MathContext, source: string, start: number, end: number): { text: string; reason?: string };
}

const latexAdapter: WritingSymbolAdapter = {
  language: 'latex',
  previewKind: 'latex',
  supportsStructures: true,
  classifyContext: classifyLatexContext,
  classifyRange: classifyLatexRange,
  searchSymbols: searchWritingSymbols,
  symbolInsertion: latexSymbolInsertion,
};

const typstAdapter: WritingSymbolAdapter = {
  language: 'typst',
  previewKind: 'glyph',
  supportsStructures: true,
  classifyContext: classifyTypstContext,
  classifyRange: classifyTypstRange,
  searchSymbols: searchTypstSymbols,
  symbolInsertion(command, context, source, start, end) {
    const entry = TYPST_WRITING_SYMBOLS.find((symbol) => symbol.nativeIdentifier === command) as TypstSymbolEntry | undefined;
    if (!entry) return { text: '', reason: 'Choose a symbol from the Typst catalog.' };
    return typstSymbolInsertion(entry, context, source, start, end);
  },
};

export function getWritingSymbolAdapter(language: 'latex' | 'typst'): WritingSymbolAdapter {
  return language === 'typst' ? typstAdapter : latexAdapter;
}
