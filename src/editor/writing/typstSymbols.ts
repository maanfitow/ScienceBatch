import type { SymbolEntry, WritingCategory } from '../../types/writing';

export interface TypstSymbolEntry extends SymbolEntry {
  /** Verified built-in identifier in Typst's `sym` module. */
  nativeIdentifier: string;
  /** The literal source emitted in a math context. */
  insertionSyntax: string;
}

type SymbolSeed = [nativeIdentifier: string, name: string, glyph: string, category: WritingCategory, aliases?: string[]];

const seeds: SymbolSeed[] = [
  ['alpha', 'Alpha', 'α', 'greek', ['\\alpha']], ['beta', 'Beta', 'β', 'greek', ['\\beta']],
  ['gamma', 'Gamma', 'γ', 'greek', ['\\gamma']], ['Gamma', 'Capital gamma', 'Γ', 'greek', ['\\Gamma']],
  ['delta', 'Delta', 'δ', 'greek', ['\\delta']], ['Delta', 'Capital delta', 'Δ', 'greek', ['\\Delta']],
  ['epsilon', 'Epsilon', 'ε', 'greek', ['\\epsilon']], ['epsilon.alt', 'Variant epsilon', 'ϵ', 'greek', ['varepsilon', '\\varepsilon']],
  ['theta', 'Theta', 'θ', 'greek', ['\\theta']], ['theta.alt', 'Variant theta', 'ϑ', 'greek', ['vartheta', '\\vartheta']],
  ['lambda', 'Lambda', 'λ', 'greek', ['\\lambda']], ['Lambda', 'Capital lambda', 'Λ', 'greek', ['\\Lambda']],
  ['mu', 'Mu', 'μ', 'greek', ['\\mu']], ['xi', 'Xi', 'ξ', 'greek', ['\\xi']], ['pi', 'Pi', 'π', 'greek', ['\\pi']],
  ['rho', 'Rho', 'ρ', 'greek', ['\\rho']], ['sigma', 'Sigma', 'σ', 'greek', ['\\sigma']],
  ['Sigma', 'Capital sigma', 'Σ', 'greek', ['\\Sigma']], ['phi', 'Phi', 'φ', 'greek', ['\\phi']],
  ['phi.alt', 'Variant phi', 'ϕ', 'greek', ['varphi', '\\varphi']], ['psi', 'Psi', 'ψ', 'greek', ['\\psi']],
  ['omega', 'Omega', 'ω', 'greek', ['\\omega']], ['Omega', 'Capital omega', 'Ω', 'greek', ['\\Omega']],
  ['sum', 'Summation', '∑', 'operators', ['\\sum']], ['product', 'Product', '∏', 'operators', ['prod', '\\prod']],
  ['integral', 'Integral', '∫', 'operators', ['int', '\\int']], ['integral.double', 'Double integral', '∬', 'operators', ['iint', '\\iint']],
  ['integral.triple', 'Triple integral', '∭', 'operators', ['iiint', '\\iiint']], ['integral.cont', 'Contour integral', '∮', 'operators', ['oint', '\\oint']],
  ['partial', 'Partial differential', '∂', 'operators', ['\\partial']], ['nabla', 'Nabla', '∇', 'operators', ['gradient', '\\nabla']],
  ['times', 'Multiplication', '×', 'operators', ['\\times']], ['dot.op', 'Dot operator', '⋅', 'operators', ['dot', 'cdot', '\\cdot']],
  ['plus.minus', 'Plus or minus', '±', 'operators', ['pm', '\\pm']], ['minus.plus', 'Minus or plus', '∓', 'operators', ['mp', '\\mp']],
  ['lt.eq', 'Less than or equal to', '≤', 'relations', ['leq', '\\leq', '\\le']],
  ['gt.eq', 'Greater than or equal to', '≥', 'relations', ['geq', '\\geq', '\\ge']],
  ['eq.not', 'Not equal to', '≠', 'relations', ['neq', '\\neq']], ['approx', 'Approximately equal to', '≈', 'relations', ['\\approx']],
  ['equiv', 'Equivalent to', '≡', 'relations', ['\\equiv']], ['arrow.r', 'Right arrow', '→', 'arrows', ['rightarrow', '\\rightarrow', 'to']],
  ['arrow.l', 'Left arrow', '←', 'arrows', ['leftarrow', '\\leftarrow', 'gets']],
  ['arrow.r.double', 'Right double arrow', '⇒', 'arrows', ['Rightarrow', '\\Rightarrow', '\\implies']],
  ['arrow.l.double', 'Left double arrow', '⇐', 'arrows', ['Leftarrow', '\\Leftarrow']],
  ['arrow.l.r.double', 'Left-right double arrow', '⇔', 'arrows', ['Leftrightarrow', '\\Leftrightarrow']],
  ['forall', 'For all', '∀', 'logic', ['\\forall']], ['exists', 'There exists', '∃', 'logic', ['\\exists']],
  ['in', 'Element of', '∈', 'logic', ['\\in']], ['in.not', 'Not an element of', '∉', 'logic', ['notin', '\\notin']],
  ['subset', 'Subset', '⊂', 'logic', ['\\subset']], ['subset.eq', 'Subset or equal to', '⊆', 'logic', ['subseteq', '\\subseteq']],
  ['union', 'Union', '∪', 'logic', ['cup', '\\cup']], ['inter', 'Intersection', '∩', 'logic', ['cap', '\\cap']],
  ['infinity', 'Infinity', '∞', 'misc', ['oo', '\\infty', 'infty']], ['dots', 'Ellipsis', '…', 'misc', ['ldots', '\\dots']],
  ['dots.c', 'Centered ellipsis', '⋯', 'misc', ['cdots', '\\cdots']],
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
