import { LATEX_COMMANDS } from '../latexData';
import type { SymbolEntry, WritingCategory } from '../../types/writing';

const CATEGORY_BY_COMMAND: Record<string, WritingCategory> = {};
export const WRITING_CATEGORIES: WritingCategory[] = ['Greek letters', 'Operators', 'Relations', 'Arrows', 'Sets and logic', 'Miscellaneous'];
const category = (names: string, value: WritingCategory) => names.split(/\s+/).forEach((name) => { CATEGORY_BY_COMMAND[`\\${name}`] = value; });
category('alpha beta gamma Gamma delta Delta epsilon varepsilon zeta eta theta Theta lambda Lambda mu nu xi pi rho sigma Sigma tau phi varphi Phi psi Psi omega Omega', 'Greek letters');
category('sum int iint iiint oint prod lim partial nabla', 'Operators');
category('infty dots cdots vdots ddots', 'Miscellaneous');
category('times cdot pm mp', 'Operators');
category('leq geq neq approx equiv', 'Relations');
category('rightarrow Leftarrow Rightarrow Leftrightarrow', 'Arrows');
category('forall exists in notin subset subseteq cup cap', 'Sets and logic');

const GLYPHS: Record<string, string> = {
  '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\Gamma': 'Γ', '\\delta': 'δ', '\\Delta': 'Δ', '\\epsilon': 'ε', '\\varepsilon': 'ϵ', '\\theta': 'θ', '\\lambda': 'λ', '\\mu': 'μ', '\\pi': 'π', '\\sigma': 'σ', '\\Sigma': 'Σ', '\\phi': 'ϕ', '\\varphi': 'φ', '\\omega': 'ω', '\\Omega': 'Ω',
  '\\sum': '∑', '\\int': '∫', '\\iint': '∬', '\\iiint': '∭', '\\oint': '∮', '\\prod': '∏', '\\lim': 'lim', '\\infty': '∞', '\\partial': '∂', '\\nabla': '∇',
  '\\leq': '≤', '\\geq': '≥', '\\neq': '≠', '\\approx': '≈', '\\equiv': '≡', '\\rightarrow': '→', '\\Leftarrow': '⇐', '\\Rightarrow': '⇒', '\\Leftrightarrow': '⇔', '\\forall': '∀', '\\exists': '∃', '\\in': '∈', '\\notin': '∉', '\\subset': '⊂', '\\subseteq': '⊆', '\\cup': '∪', '\\cap': '∩', '\\times': '×', '\\cdot': '·', '\\pm': '±', '\\mp': '∓', '\\dots': '…', '\\cdots': '⋯', '\\vdots': '⋮', '\\ddots': '⋱',
};
const PACKAGE_BY_COMMAND: Record<string, string[]> = {
  '\\iint': ['amsmath'], '\\iiint': ['amsmath'], '\\boxed': ['amsmath'], '\\mathbb': ['amsfonts'],
  '\\leq': [], '\\geq': [], '\\neq': [], '\\subset': [], '\\subseteq': [], '\\notin': [], '\\varphi': [],
};

const SIMPLE_MATH_COMMANDS = new Set(['\\sum', '\\int', '\\iint', '\\iiint', '\\oint', '\\prod', '\\lim']);
const usableCommand = (insertText: string, name: string) => (insertText === name || SIMPLE_MATH_COMMANDS.has(name)) && /^\\[a-zA-Z]+$/.test(name);
export const WRITING_SYMBOLS: SymbolEntry[] = LATEX_COMMANDS
  .filter((item) => usableCommand(item.insertText, item.name) && CATEGORY_BY_COMMAND[item.name] !== undefined)
  .map((item) => ({
    command: item.name,
    name: item.detail.replace(/\s*\([^)]*\)\s*$/, '').trim(),
    glyph: GLYPHS[item.name] ?? item.detail.match(/\(([^)]+)\)/)?.[1] ?? item.name,
    category: CATEGORY_BY_COMMAND[item.name],
    aliases: [item.name.replace(/^\\/, ''), item.documentation.split(/[.(:]/)[0].toLowerCase(), ...(item.name === '\\infty' ? ['infinity'] : [])],
    packages: PACKAGE_BY_COMMAND[item.name] ?? [],
  }));

export function searchWritingSymbols(query: string, selectedCategory?: WritingCategory): SymbolEntry[] {
  const needle = query.trim().toLocaleLowerCase().replace(/^\\/, '');
  return WRITING_SYMBOLS.filter((symbol) => {
    if (selectedCategory && symbol.category !== selectedCategory) return false;
    if (!needle) return true;
    return [symbol.name, symbol.command, ...symbol.aliases].some((value) => value.toLocaleLowerCase().replace(/^\\/, '').includes(needle));
  });
}
