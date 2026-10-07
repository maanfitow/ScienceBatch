import type { SymbolEntry, WritingCategory } from '../../types/writing';

export interface TypstSymbolEntry extends SymbolEntry {
  /** Verified built-in identifier in Typst's `sym` module. */
  nativeIdentifier: string;
  /** The literal source emitted in a math context. */
  insertionSyntax: string;
}

type SymbolSeed = [nativeIdentifier: string, name: string, glyph: string, category: WritingCategory, aliases?: string[]];

const seeds: SymbolSeed[] = [
  ['alpha', 'Alpha', 'α', 'Greek letters', ['\\alpha']], ['beta', 'Beta', 'β', 'Greek letters', ['\\beta']],
  ['gamma', 'Gamma', 'γ', 'Greek letters', ['\\gamma']], ['Gamma', 'Capital gamma', 'Γ', 'Greek letters', ['\\Gamma']],
  ['delta', 'Delta', 'δ', 'Greek letters', ['\\delta']], ['Delta', 'Capital delta', 'Δ', 'Greek letters', ['\\Delta']],
  ['epsilon', 'Epsilon', 'ε', 'Greek letters', ['\\epsilon']], ['epsilon.alt', 'Variant epsilon', 'ϵ', 'Greek letters', ['varepsilon', '\\varepsilon']],
  ['theta', 'Theta', 'θ', 'Greek letters', ['\\theta']], ['theta.alt', 'Variant theta', 'ϑ', 'Greek letters', ['vartheta', '\\vartheta']],
  ['lambda', 'Lambda', 'λ', 'Greek letters', ['\\lambda']], ['Lambda', 'Capital lambda', 'Λ', 'Greek letters', ['\\Lambda']],
  ['mu', 'Mu', 'μ', 'Greek letters', ['\\mu']], ['xi', 'Xi', 'ξ', 'Greek letters', ['\\xi']], ['pi', 'Pi', 'π', 'Greek letters', ['\\pi']],
  ['rho', 'Rho', 'ρ', 'Greek letters', ['\\rho']], ['sigma', 'Sigma', 'σ', 'Greek letters', ['\\sigma']],
  ['Sigma', 'Capital sigma', 'Σ', 'Greek letters', ['\\Sigma']], ['phi', 'Phi', 'φ', 'Greek letters', ['\\phi']],
  ['phi.alt', 'Variant phi', 'ϕ', 'Greek letters', ['varphi', '\\varphi']], ['psi', 'Psi', 'ψ', 'Greek letters', ['\\psi']],
  ['omega', 'Omega', 'ω', 'Greek letters', ['\\omega']], ['Omega', 'Capital omega', 'Ω', 'Greek letters', ['\\Omega']],
  ['sum', 'Summation', '∑', 'Operators', ['\\sum']], ['product', 'Product', '∏', 'Operators', ['prod', '\\prod']],
  ['integral', 'Integral', '∫', 'Operators', ['int', '\\int']], ['integral.double', 'Double integral', '∬', 'Operators', ['iint', '\\iint']],
  ['integral.triple', 'Triple integral', '∭', 'Operators', ['iiint', '\\iiint']], ['integral.cont', 'Contour integral', '∮', 'Operators', ['oint', '\\oint']],
  ['partial', 'Partial differential', '∂', 'Operators', ['\\partial']], ['nabla', 'Nabla', '∇', 'Operators', ['gradient', '\\nabla']],
  ['times', 'Multiplication', '×', 'Operators', ['\\times']], ['dot.op', 'Dot operator', '⋅', 'Operators', ['dot', 'cdot', '\\cdot']],
  ['plus.minus', 'Plus or minus', '±', 'Operators', ['pm', '\\pm']], ['minus.plus', 'Minus or plus', '∓', 'Operators', ['mp', '\\mp']],
  ['lt.eq', 'Less than or equal to', '≤', 'Relations', ['leq', '\\leq', '\\le']],
  ['gt.eq', 'Greater than or equal to', '≥', 'Relations', ['geq', '\\geq', '\\ge']],
  ['eq.not', 'Not equal to', '≠', 'Relations', ['neq', '\\neq']], ['approx', 'Approximately equal to', '≈', 'Relations', ['\\approx']],
  ['equiv', 'Equivalent to', '≡', 'Relations', ['\\equiv']], ['arrow.r', 'Right arrow', '→', 'Arrows', ['rightarrow', '\\rightarrow', 'to']],
  ['arrow.l', 'Left arrow', '←', 'Arrows', ['leftarrow', '\\leftarrow', 'gets']],
  ['arrow.r.double', 'Right double arrow', '⇒', 'Arrows', ['Rightarrow', '\\Rightarrow', '\\implies']],
  ['arrow.l.double', 'Left double arrow', '⇐', 'Arrows', ['Leftarrow', '\\Leftarrow']],
  ['arrow.l.r.double', 'Left-right double arrow', '⇔', 'Arrows', ['Leftrightarrow', '\\Leftrightarrow']],
  ['forall', 'For all', '∀', 'Sets and logic', ['\\forall']], ['exists', 'There exists', '∃', 'Sets and logic', ['\\exists']],
  ['in', 'Element of', '∈', 'Sets and logic', ['\\in']], ['in.not', 'Not an element of', '∉', 'Sets and logic', ['notin', '\\notin']],
  ['subset', 'Subset', '⊂', 'Sets and logic', ['\\subset']], ['subset.eq', 'Subset or equal to', '⊆', 'Sets and logic', ['subseteq', '\\subseteq']],
  ['union', 'Union', '∪', 'Sets and logic', ['cup', '\\cup']], ['inter', 'Intersection', '∩', 'Sets and logic', ['cap', '\\cap']],
  ['infinity', 'Infinity', '∞', 'Miscellaneous', ['oo', '\\infty', 'infty']], ['dots', 'Ellipsis', '…', 'Miscellaneous', ['ldots', '\\dots']],
  ['dots.c', 'Centered ellipsis', '⋯', 'Miscellaneous', ['cdots', '\\cdots']],
];

export const TYPST_WRITING_SYMBOLS: TypstSymbolEntry[] = seeds.map(([nativeIdentifier, name, glyph, category, aliases = []]) => ({
  command: nativeIdentifier,
  nativeIdentifier,
  insertionSyntax: nativeIdentifier,
  name,
  glyph,
  category,
  aliases: [nativeIdentifier, ...aliases],
  packages: [],
}));

/** Search names, aliases, and native names, accepting Typst's optional symbol prefix. */
export function searchTypstSymbols(query: string, selectedCategory?: WritingCategory): TypstSymbolEntry[] {
  const needle = query.trim().toLocaleLowerCase().replace(/^(?:#?sym\.)/, '').replace(/^\\/, '');
  return TYPST_WRITING_SYMBOLS.filter((symbol) => {
    if (selectedCategory && symbol.category !== selectedCategory) return false;
    if (!needle) return true;
    return [symbol.name, symbol.nativeIdentifier, ...symbol.aliases]
      .some((value) => value.toLocaleLowerCase().replace(/^\\/, '').includes(needle));
  });
}
