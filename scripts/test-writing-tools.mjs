import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const {
  classifyLatexContext,
  classifyLatexRange,
  generateMatrix,
  generateTable,
  inspectPackageEligibility,
  inspectPackageLoadState,
  parseWritingStructureAt,
  planPackageAddition,
  requiredPackagesInSource,
  searchWritingSymbols,
  symbolInsertion,
  WritingGenerationError,
} = await import('../src/editor/writing/index.ts');

const context = (source, token, relative = 0) => classifyLatexContext(source, source.indexOf(token) + relative).context;
assert.equal(context('Text $x + \\alpha$ end', '\\alpha'), 'math-inline');
assert.equal(context('Text \\(x + \\alpha\\) end', '\\alpha'), 'math-inline');
assert.equal(context('Text \\[x + \\alpha\\] end', '\\alpha'), 'math-display');
assert.equal(context('\\begin{document}\\begin{align}x &= y\\end{align}', 'x &'), 'math-environment');
assert.equal(context('\\begin{document}\\verb|$ % \\begin{verbatim}| text', '$ %'), 'blocked');
assert.equal(context('\\begin{document}% $x$\ntext', '$x$'), 'blocked');
assert.equal(context('\\documentclass{article}\n\\begin{document}x', '\\documentclass'), 'blocked');
assert.equal(classifyLatexContext('\\documentclass{article}\n\\begin{document}', 0).context, 'blocked');
assert.equal(context('\\begin{document}$x \\text{plain}$', 'plain'), 'blocked');
assert.equal(context('\\begin{document}{ $x$ }', 'x'), 'math-inline');
assert.equal(context('\\begin{document}{\\(x\\)}', 'x'), 'math-inline');
assert.equal(context('\\begin{document}{\\begin{equation}x\\end{equation}}', 'x'), 'math-environment');
assert.equal(context('\\begin{document}\\begin{verbatim}$x$\\end{verbatim}', '$x$'), 'blocked');
assert.equal(context('\\begin{document}\\begin{comment}$x$\\end{comment}', '$x$'), 'blocked');
const closedDocument = '\\begin{document}x\\end{document}';
assert.equal(classifyLatexContext(closedDocument, closedDocument.length).context, 'blocked');
assert.equal(classifyLatexContext(closedDocument, closedDocument.indexOf('\\end{document}') + 3).context, 'blocked');
assert.equal(context('\\begin{document}\\$ literal \\\\$x$', 'x'), 'math-inline');
assert.equal(classifyLatexContext('\\begin{document}\\(broken$', 25).context, 'blocked');
assert.equal(context('\\begin{document}$x \\] y$', 'y'), 'blocked');
assert.equal(context('\\begin{document}\\begin{equation}x \\begin{align}y\\end{align}\\end{equation}', 'y'), 'blocked');
assert.equal(context('\\begin{document}$x \\begin{pmatrix}a&b\\end{pmatrix}$', 'a&b'), 'math-environment');
assert.equal(context('\\begin{document}\\begin{align}\\begin{pmatrix}a&b\\end{pmatrix}\\end{align}', 'a&b'), 'math-environment');
assert.equal(context('\\begin{document}\\alpha', '\\alpha', 2), 'blocked');
assert.equal(context('\\begin{document}\\begin{equation}x\\end{equation}', '\\begin{equation}', 4), 'blocked');
assert.equal(context('\\begin{document}\\(x\\)', '\\(', 1), 'blocked');
const escapedPunctuation = '\\begin{document}\\%';
assert.equal(classifyLatexContext(escapedPunctuation, escapedPunctuation.indexOf('\\%') + 1).context, 'blocked');
const doubledSlash = '\\begin{document}\\\\x';
assert.equal(classifyLatexContext(doubledSlash, doubledSlash.indexOf('\\\\') + 1).context, 'blocked');
const displayDelimiter = '\\begin{document}$$x$$';
assert.equal(classifyLatexContext(displayDelimiter, displayDelimiter.indexOf('$$') + 1).context, 'blocked');
const mismatchedEnvironment = '\\begin{document}\\begin{align}x\\end{equation}';
assert.equal(classifyLatexContext(mismatchedEnvironment, mismatchedEnvironment.indexOf('\\end{equation}') + '\\end{equation}'.length).context, 'blocked');
const crossed = '\\begin{document}before $x$ after';
assert.equal(classifyLatexRange(crossed, crossed.indexOf('before'), crossed.indexOf('after')).context, 'blocked');
const grouped = '\\begin{document}${x}$';
assert.equal(classifyLatexRange(grouped, grouped.lastIndexOf('{'), grouped.lastIndexOf('}')).context, 'blocked');
const balanced = '\\begin{document}${x}$';
assert.equal(classifyLatexRange(balanced, balanced.lastIndexOf('{'), balanced.lastIndexOf('}') + 1).context, 'math-inline');
assert.equal(symbolInsertion('\\alpha', 'text', 'abc', 1, 2).text, '\\(\\alpha\\)');
assert.equal(symbolInsertion('\\alpha', 'math-inline', 'xq', 1, 1).text, '\\alpha{}');

for (const command of ['\\alpha', '\\rightarrow', '\\infty']) {
  assert.ok(searchWritingSymbols(command).some((entry) => entry.command === command));
}
assert.ok(searchWritingSymbols('infinity').some((entry) => entry.command === '\\infty'));
assert.ok(searchWritingSymbols('sum').some((entry) => entry.command === '\\sum'));
assert.equal(searchWritingSymbols('not-a-real-symbol').length, 0);

for (const format of ['plain', 'grid', 'booktabs']) {
  const source = generateTable({
    rows: 2, columns: 2, cells: [['A_1 & {x}', 'B%'], ['1', '2']],
    alignment: ['l', 'c'], format, header: true,
    wrapInTable: true, caption: 'A & B', label: 'tab:test',
  });
  const parsed = parseWritingStructureAt(source, source.indexOf('A\\_1'));
  assert.ok(parsed?.compatible, `${format} generated table should parse: ${parsed?.reason}`);
  assert.equal(parsed.value.format, format);
  assert.equal(parsed.value.header, true);
  assert.equal(parsed.value.caption, 'A \\& B');
  assert.equal(parsed.value.captionLatex, true);
  assert.equal(parsed.value.label, 'tab:test');
  assert.deepEqual(parsed.value.cells, [['A\\_1 \\& \\{x\\}', 'B\\%'], ['1', '2']]);
  assert.equal(generateTable(parsed.value), source);
}

for (const environment of ['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix']) {
  const source = generateMatrix({ rows: 2, columns: 2, cells: [['a_{11}', '\\alpha'], ['0', 'x \\& y']], environment }, 'math-inline');
  const parsed = parseWritingStructureAt(source, source.indexOf('a_{11}'));
  assert.ok(parsed?.compatible, `${environment} generated matrix should parse: ${parsed?.reason}`);
  assert.equal(parsed.value.environment, environment);
  assert.deepEqual(parsed.value.cells, [['a_{11}', '\\alpha'], ['0', 'x \\& y']]);
}
const blankMatrix = generateMatrix({ rows: 2, columns: 2, cells: [['', ''], ['', '']] }, 'math-inline');
assert.deepEqual(parseWritingStructureAt(blankMatrix, blankMatrix.indexOf('matrix'))?.value.cells, [['', ''], ['', '']]);
const partialMatrix = generateMatrix({ rows: 2, columns: 2, cells: [['1', ''], ['', '2']] }, 'math-inline');
assert.deepEqual(parseWritingStructureAt(partialMatrix, partialMatrix.indexOf('matrix'))?.value.cells, [['1', ''], ['', '2']]);
const emptyLastColumnMatrix = generateMatrix({ rows: 2, columns: 1, cells: [['1'], ['']] }, 'math-inline');
assert.deepEqual(parseWritingStructureAt(emptyLastColumnMatrix, emptyLastColumnMatrix.indexOf('matrix'))?.value.cells, [['1'], ['']]);
const blankTable = generateTable({ rows: 2, columns: 2, cells: [['', ''], ['', '']], format: 'grid' });
assert.deepEqual(parseWritingStructureAt(blankTable, blankTable.indexOf('tabular'))?.value.cells, [['', ''], ['', '']]);
assert.match(generateMatrix({ rows: 1, columns: 1, cells: [['1']] }, 'text'), /^\\\[\n/);
assert.throws(() => generateMatrix({ rows: 1, columns: 1, cells: [['x & y']] }, 'math-inline'), WritingGenerationError);
assert.throws(() => generateMatrix({ rows: 1, columns: 1, cells: [['x \\\\ y']] }, 'math-inline'), WritingGenerationError);
assert.throws(() => generateTable({ rows: 1, columns: 1, cells: [['\\begin{pmatrix}a&b\\end{pmatrix}']], latexCells: true }), WritingGenerationError);
assert.throws(() => generateTable({ rows: 1, columns: 1, cells: [['a\nb']] }), WritingGenerationError);
assert.throws(() => generateTable({ rows: 1, columns: 1, cells: [['x']], wrapInTable: true, label: 'tab:x' }), /label requires.*caption/i);

const unsafeSources = [
  '\\begin{tabularx}{\\linewidth}{X}a\\end{tabularx}',
  '\\begin{tabular}{p{4cm}}a\\end{tabular}',
  '\\begin{tabular}{c}\\multicolumn{1}{c}{x}\\end{tabular}',
  '\\begin{tabular}{c}\n% hidden\na\\end{tabular}',
  '\\begin{tabular}{c}a\\\\[1ex]b\\end{tabular}',
  '\\begin{tabular}{c}a\\\\*b\\end{tabular}',
  '\\begin{tabular}{c}\\noalign{\\smallskip}a\\\\\\end{tabular}',
  '\\begin{tabular}{c}\\addlinespace a\\\\\\end{tabular}',
  '\\begin{tabular}{c}\\specialrule{1pt}{0pt}{0pt}a\\\\\\end{tabular}',
  '\\begin{tabular}{c}\\rowcolor{gray}a\\\\\\end{tabular}',
];
for (const source of unsafeSources) assert.equal(parseWritingStructureAt(source, source.indexOf('a'))?.compatible, false);
const matrixInVerbatim = '\\begin{document}\\begin{verbatim}\\begin{matrix}x&y\\\\\\end{matrix}\\end{verbatim}\\end{document}';
assert.equal(parseWritingStructureAt(matrixInVerbatim, matrixInVerbatim.indexOf('x'))?.compatible, false);
const tableInPreamble = '\\documentclass{article}\n\\begin{tabular}{c}x\\\\\\end{tabular}\n\\begin{document}';
assert.equal(parseWritingStructureAt(tableInPreamble, tableInPreamble.indexOf('x'))?.compatible, false);
const misplacedRules = '\\begin{tabular}{c}\n\\bottomrule\nx \\\\\n\\toprule\n\\end{tabular}';
assert.equal(parseWritingStructureAt(misplacedRules, misplacedRules.indexOf('x'))?.compatible, false);
const afterUnsupported = '\\begin{document}\\begin{tabularx}{\\linewidth}{X}a\\end{tabularx}\nbody';
assert.equal(parseWritingStructureAt(afterUnsupported, afterUnsupported.indexOf('body')), null);
const unicodeEscapedPercent = 'prefix 🧪 \\begin{tabular}{c}\n20\\% \\\\\n\\end{tabular} suffix';
assert.equal(parseWritingStructureAt(unicodeEscapedPercent, unicodeEscapedPercent.indexOf('20'))?.compatible, true);
const float = generateTable({ rows: 1, columns: 1, cells: [['x']], wrapInTable: true, caption: 'Caption' });
assert.equal(parseWritingStructureAt(float, float.indexOf('Caption'))?.compatible, true);

const packageSource = '\\documentclass{article}\n% \\usepackage{commented}\n\\usepackage[utf8]{inputenc}\n\\begin{document}body';
assert.equal(inspectPackageEligibility(packageSource).eligible, true);
const state = inspectPackageLoadState(packageSource, ['inputenc', 'amsmath']);
assert.deepEqual(state.loaded, ['inputenc']);
assert.deepEqual(state.missing, ['amsmath']);
const target = packageSource.indexOf('body');
const plan = planPackageAddition(packageSource, ['amsmath', 'inputenc'], { start: target, end: target, anchor: target, active: target });
assert.deepEqual(plan.packagesToAdd, ['amsmath']);
assert.equal(plan.change.start, packageSource.indexOf('\\begin{document}'));
assert.equal(plan.change.end, plan.change.start);
assert.equal(plan.change.selection.anchor, target + plan.change.text.length);
assert.equal(plan.change.selection.active, target + plan.change.text.length);
assert.equal(planPackageAddition(packageSource, ['amsmath'])?.packagesToAdd[0], 'amsmath');
assert.equal(planPackageAddition(packageSource.replace('\\begin{document}', '\\ifdefined\\x\\usepackage{conditional}\\fi\n\\begin{document}'), ['amsmath']), null);
assert.equal(inspectPackageLoadState(packageSource.replace('\\begin{document}', '\\ifdefined\\x\\usepackage{conditional}\\fi\n\\begin{document}'), ['conditional']).uncertain, true);
assert.equal(inspectPackageLoadState(packageSource.replace('\\begin{document}', '\\newcommand{\\loadmath}{\\usepackage{amsmath}}\n\\begin{document}'), ['amsmath']).loaded.includes('amsmath'), false);
assert.equal(inspectPackageLoadState(packageSource.replace('\\begin{document}', '\\usepackage{\\packageList}\n\\begin{document}'), ['amsmath']).uncertain, true);
assert.equal(planPackageAddition(packageSource.replace('article', 'customclass'), ['amsmath']), null);
assert.deepEqual(requiredPackagesInSource('\\begin{matrix}x\\end{matrix} \\toprule \\mathbb{R}'), ['amsmath', 'booktabs', 'amsfonts']);
assert.deepEqual(requiredPackagesInSource('% \\toprule\n\\oint'), []);
assert.equal(planPackageAddition('% \\documentclass{article}\n\\begin{document}', ['amsmath']), null);

console.log('Writing tools core tests passed.');
