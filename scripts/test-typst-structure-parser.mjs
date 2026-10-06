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

const { parseTypstStructureAt } = await import('../src/editor/writing/typstStructureParser.ts');
const { generateTypstTable, generateTypstMatrix } = await import('../src/editor/writing/typstStructureGenerate.ts');

const caret = (source, marker, delta = 0) => source.indexOf(marker) + delta;
const parse = (source, marker) => parseTypstStructureAt(source, caret(source, marker));
const tableOptions = {
  rows: 2, columns: 2, cells: [['A # B', 'Value'], ['C:\\path\\file', 'two']],
  alignment: ['left', 'right'], format: 'booktabs', header: true,
};

for (const format of ['plain', 'grid', 'booktabs']) {
  const source = generateTypstTable({ ...tableOptions, format });
  const parsed = parse(source, 'A # B');
  assert.equal(parsed?.kind, 'table', `${format} table parses`);
  assert.equal(parsed?.compatible, true);
  assert.equal(parsed?.placement, 'markup');
  assert.equal(parsed?.value.format, format);
  assert.deepEqual(parsed?.value.cells, tableOptions.cells);
  assert.deepEqual(parsed?.value.alignment, ['left', 'right']);
  assert.equal(parsed?.value.header, true);
  assert.equal(parsed?.value.sourceCells?.[0]?.[0]?.source, '[#strong[#text("A # B")]]');
  assert.equal(parsed?.start, 0);
  assert.equal(parsed?.end, source.length);
  assert.equal(generateTypstTable(parsed.value, 'markup'), source, `${format} source round trip`);
}

const wrapped = generateTypstTable({
  ...tableOptions, format: 'grid', wrapInFigure: true, caption: 'A "quoted" caption', label: 'tbl-data_2',
});
const wrappedParsed = parse(wrapped, 'caption');
assert.equal(wrappedParsed?.kind, 'table');
assert.equal(wrappedParsed?.compatible, true);
assert.equal(wrappedParsed?.placement, 'markup');
assert.equal(wrappedParsed?.start, 0);
assert.equal(wrappedParsed?.end, wrapped.length);
assert.equal(wrappedParsed?.value.wrapInFigure, true);
assert.equal(wrappedParsed?.value.caption, 'A "quoted" caption');
assert.equal(wrappedParsed?.value.label, 'tbl-data_2');
assert.equal(generateTypstTable(wrappedParsed.value, 'markup'), wrapped);
const labelParsed = parseTypstStructureAt(wrapped, caret(wrapped, 'tbl-data_2'));
assert.equal(labelParsed?.start, 0);
assert.equal(labelParsed?.end, wrapped.length);
const emptyCaptionFigure = '#figure(table(columns: 1, align: (left), inset: 5pt, stroke: none, [x]), kind: table)';
const emptyCaptionParsed = parse(emptyCaptionFigure, 'x');
assert.equal(emptyCaptionParsed?.compatible, true);
assert.equal(emptyCaptionParsed?.value.wrapInFigure, true);
assert.equal(emptyCaptionParsed?.value.caption, '');

const manualTable = '#table(columns: 2, align: (left, center,), inset: 5pt, stroke: none, [#text("outer, [x] \\\"quoted\\\"")], [#strong("raw, cell")],)';
const manualTableParsed = parse(manualTable, 'raw, cell');
assert.equal(manualTableParsed?.compatible, true);
assert.deepEqual(manualTableParsed?.value.alignment, ['left', 'center']);
assert.equal(manualTableParsed?.value.cells[0][0], 'outer, [x] "quoted"');
assert.equal(manualTableParsed?.value.cellTypst?.[0]?.[1], true);
assert.equal(manualTableParsed?.value.sourceCells?.[0]?.[1]?.source, '[#strong("raw, cell")]');
assert.equal(manualTableParsed?.value.sourceCells?.[0]?.[1]?.content, '#strong("raw, cell")');

const smartQuoteCells = '#table(columns: 2, align: (left, right), inset: 5pt, stroke: none, [hello "], [evil"] ,)';
const smartQuoteParsed = parse(smartQuoteCells, 'evil');
assert.equal(smartQuoteParsed?.compatible, true);
assert.deepEqual(smartQuoteParsed?.value.cells, [['hello "', 'evil"']]);
assert.equal(smartQuoteParsed?.value.sourceCells?.[0]?.[1]?.source, '[evil"]');
const escapedBracketTable = '#table(columns: 1, align: (left), inset: 5pt, stroke: none, [literal \\] bracket])';
const escapedBracketParsed = parse(escapedBracketTable, 'literal');
assert.equal(escapedBracketParsed?.compatible, true);
assert.equal(escapedBracketParsed?.value.cells[0][0], 'literal \\] bracket');
const punctuationMarkup = '#table(columns: 1, align: (left), inset: 5pt, stroke: none, [hello (world])';
assert.equal(parse(punctuationMarkup, 'world')?.compatible, true);
const nestedMarkupArgument = '#table(columns: 1, align: (left), inset: 5pt, stroke: none, [#box([hello (world])])';
assert.equal(parse(nestedMarkupArgument, 'world')?.compatible, true);
const nestedTable = '#table(columns: 1, align: (left), inset: 5pt, stroke: none, [#table(columns: 1, align: (right), inset: 5pt, stroke: none, [inner])])';
const nestedTableParsed = parse(nestedTable, 'inner');
assert.equal(nestedTableParsed?.compatible, true);
assert.equal(nestedTableParsed?.start, nestedTable.lastIndexOf('#table'));
assert.equal(nestedTableParsed?.end, nestedTable.length - 2);

const complexTextTable = generateTypstTable({
  rows: 1, columns: 1, cells: [['A # [] $ " \\']], alignment: ['left'], format: 'plain',
});
const complexTextParsed = parse(complexTextTable, 'A #');
assert.equal(complexTextParsed?.compatible, true);
assert.equal(complexTextParsed?.value.cells[0][0], 'A # [] $ " \\');
assert.equal(generateTypstTable(complexTextParsed.value, 'markup'), complexTextTable);

const rawHeaderTable = generateTypstTable({
  rows: 1, columns: 1, cells: [['#strong("Raw header")']], alignment: ['left'], format: 'plain', header: true, cellTypst: [[true]],
});
const rawHeaderParsed = parse(rawHeaderTable, 'Raw header');
assert.equal(rawHeaderParsed?.compatible, true);
assert.equal(rawHeaderParsed?.value.cells[0][0], '#strong("Raw header")');
assert.equal(rawHeaderParsed?.value.sourceCells?.[0]?.[0]?.source, '[#strong[#strong("Raw header")]]');
assert.equal(rawHeaderParsed?.value.sourceCells?.[0]?.[0]?.content, '#strong("Raw header")');
assert.equal(generateTypstTable(rawHeaderParsed.value, 'markup'), rawHeaderTable);
const strongBodyTable = '#table(columns: 1, align: (left), inset: 5pt, stroke: none, [#strong[#text("bold body")]])';
const strongBodyParsed = parse(strongBodyTable, 'bold body');
assert.equal(strongBodyParsed?.compatible, true);
assert.equal(strongBodyParsed?.value.cells[0][0], '#strong[#text("bold body")]');
assert.equal(strongBodyParsed?.value.cellTypst?.[0]?.[0], true);
assert.equal(generateTypstTable(strongBodyParsed.value, 'markup').includes('[#strong[#text("bold body")]]'), true);
const strongCaption = '#figure(table(columns: 1, align: (left), inset: 5pt, stroke: none, [cell]), caption: [#strong[#text("caption")]], kind: table)';
const strongCaptionParsed = parse(strongCaption, 'cell');
assert.equal(strongCaptionParsed?.compatible, true);
assert.equal(strongCaptionParsed?.placement, 'code');
assert.equal(strongCaptionParsed?.value.wrapInFigure, undefined);

const crossModeCell = '#table(columns: 1, align: (left), inset: 5pt, stroke: none, [x $y])$';
const crossModeParsed = parse(crossModeCell, 'y');
assert.equal(crossModeParsed?.kind, 'table');
assert.equal(crossModeParsed?.compatible, false);

const nestedManual = '#figure(\n  table(columns: 1, align: (left), inset: 5pt, stroke: none, [cell]),\n  caption: [custom caption],\n  kind: table,\n  supplement: [Table],\n)';
const nestedCursor = caret(nestedManual, 'cell');
const nestedParsed = parseTypstStructureAt(nestedManual, nestedCursor);
assert.equal(nestedParsed?.kind, 'table');
assert.equal(nestedParsed?.compatible, true);
assert.equal(nestedParsed?.placement, 'code');
assert.equal(nestedParsed?.start, nestedManual.indexOf('table('));
assert.equal(nestedParsed?.end, nestedManual.indexOf('),\n  caption') + 1);
assert.equal(parseTypstStructureAt(nestedManual, caret(nestedManual, 'supplement')), null);

const tableLookalikes = [
  'Text #text("#table(columns: 1)")',
  '`#table(columns: 1)`',
  '// #table(columns: 1)\ntext',
  '/* #table(columns: 1) */ text',
  'table(columns: 1)',
  '#let value = "#table(columns: 1)"\nText',
  '#table(columns: 1, align: (left), inset: 5pt, stroke: none, fill: "#table(columns: 1, align: (left), inset: 5pt, stroke: none, [fake])", [actual])',
];
for (const source of tableLookalikes.slice(0, 6)) assert.equal(parseTypstStructureAt(source, Math.max(0, source.indexOf('table'))), null);
const hiddenFake = tableLookalikes[6];
assert.equal(parseTypstStructureAt(hiddenFake, hiddenFake.indexOf('[fake]') + 2)?.compatible, false);
const anonymousCodeLookalikes = [
  '#{ let value = "#table(columns: 1, align: (left), inset: 5pt, stroke: none, [fake])" }',
  '#("#table(columns: 1, align: (left), inset: 5pt, stroke: none, [fake])")',
  '#"#table(columns: 1, align: (left), inset: 5pt, stroke: none, [fake])"',
];
for (const source of anonymousCodeLookalikes) {
  assert.equal(parseTypstStructureAt(source, source.indexOf('[fake]') + 2), null);
}
const actualBeforeFakeAfter = `${generateTypstTable({ rows: 1, columns: 1, cells: [['before']], alignment: ['left'] })}\n#("#table(columns: 1, align: (left), inset: 5pt, stroke: none, [fake])")\n${generateTypstTable({ rows: 1, columns: 1, cells: [['after']], alignment: ['right'] })}`;
assert.equal(parseTypstStructureAt(actualBeforeFakeAfter, actualBeforeFakeAfter.indexOf('[fake]') + 2), null);
const afterAnonymous = parseTypstStructureAt(actualBeforeFakeAfter, actualBeforeFakeAfter.indexOf('after'));
assert.equal(afterAnonymous?.compatible, true);
assert.equal(afterAnonymous?.value.cells[0][0], 'after');

const unsupported = [
  '#table(columns: count, align: (left,), inset: 5pt, stroke: none, [x])',
  '#table(columns: 1, align: (left,), inset: 5pt, stroke: none, ..cells)',
  '#table(columns: 1, align: (left,), inset: 5pt, stroke: none, table.cell(colspan: 2)[x])',
  '#table(columns: 1, align: (left,), inset: 5pt, stroke: none, [x], /* comment */)',
  '#table(columns: 1, align: (left,), inset: 5pt, stroke: none, [x], fill: red)',
];
for (const source of unsupported) {
  const result = parseTypstStructureAt(source, Math.max(0, source.indexOf('columns')));
  assert.equal(result?.kind, 'table');
  assert.equal(result?.compatible, false);
  assert.match(result?.reason ?? '', /Edit source/);
}

for (const [delimiter, sourceValue] of [
  ['none', '#none'], ['parentheses', '"("'], ['brackets', '"["'], ['braces', '"{"'],
  ['single-bars', '"|"'], ['double-bars', '"‖"'],
]) {
  const source = generateTypstMatrix({ rows: 2, columns: 2, cells: [['f(1, 2)', 'x'], ['"a,b"', '']], delimiter }, 'text');
  const parsed = parse(source, 'f(1, 2)');
  assert.equal(parsed?.kind, 'matrix', `${delimiter} matrix parses`);
  assert.equal(parsed?.compatible, true);
  assert.equal(parsed?.placement, 'display');
  assert.equal(parsed?.value.delimiter, delimiter);
  assert.equal(parsed?.value.cells[0][0], 'f(1, 2)');
  assert.equal(parsed?.value.cells[1][1], '');
  assert.equal(parsed?.start, 0);
  assert.equal(parsed?.end, source.length);
  assert.ok(source.includes(`delim: ${sourceValue}`));
  assert.equal(generateTypstMatrix(parsed.value, 'text'), source, `${delimiter} source round trip`);
}

const equation = '$x + mat(delim: "[", frac(1, 2), a; b, c) + y$';
const equationParsed = parse(equation, 'frac');
assert.equal(equationParsed?.compatible, true);
assert.equal(equationParsed?.placement, 'math');
assert.equal(equationParsed?.start, equation.indexOf('mat('));
assert.equal(equationParsed?.end, equation.indexOf(') + y') + 1);
assert.deepEqual(equationParsed?.value.cells, [['frac(1, 2)', 'a'], ['b', 'c']]);
const nestedMatrix = '$mat(delim: "(", mat(delim: "[", a, b), c)$';
const nestedMatrixParsed = parse(nestedMatrix, 'a, b');
assert.equal(nestedMatrixParsed?.kind, 'matrix');
assert.equal(nestedMatrixParsed?.compatible, true);
assert.equal(nestedMatrixParsed?.start, nestedMatrix.indexOf('mat(', nestedMatrix.indexOf('mat(') + 4));
assert.equal(nestedMatrixParsed?.end, nestedMatrix.indexOf('), c') + 1);
const quotedMathGroups = '$mat(delim: "(", f(["a]b"]), c)$';
const quotedMathParsed = parse(quotedMathGroups, 'a]b');
assert.equal(quotedMathParsed?.compatible, true);
assert.equal(quotedMathParsed?.value.cells[0][0], 'f(["a]b"])');

const inlineMatrix = '$mat(delim: "(", a, b)$';
const inlineParsed = parse(inlineMatrix, 'a');
assert.equal(inlineParsed?.compatible, true);
assert.equal(inlineParsed?.placement, 'math');
assert.equal(inlineParsed?.start, inlineMatrix.indexOf('mat('));
assert.equal(inlineParsed?.end, inlineMatrix.indexOf(')$') + 1);
assert.equal(parseTypstStructureAt('$ mat(delim: "(", a, b) $', 2)?.placement, 'display');
assert.equal(generateTypstMatrix(inlineParsed.value, 'math-inline'), 'mat(delim: "(", a, b)');

const omittedDelimiter = '$mat(1, 2; 3, 4)$';
assert.equal(parse(omittedDelimiter, 'mat')?.compatible, false);
const emptySeparator = '$mat(delim: "(", a,, b)$';
assert.equal(parse(emptySeparator, 'mat')?.compatible, false);

const mathLookalikes = ['$"mat(1, 2)"$', '$`mat(1, 2)`$', '$text$ mat(1, 2)'];
for (const source of mathLookalikes) assert.equal(parseTypstStructureAt(source, Math.max(0, source.indexOf('mat'))), null);
assert.equal(parseTypstStructureAt('$#("mat(delim: \"(\", a, b)")$', 8), null);
assert.equal(parseTypstStructureAt('$#(mat(delim: "(", a, b))$', 10), null);
const commentedMatrix = '$mat(1, /* x */ 2)$';
assert.equal(parse(commentedMatrix, 'mat')?.compatible, false);
assert.equal(parseTypstStructureAt('$$ mat(delim: "(", a, b) $$', 5), null);
assert.equal(parseTypstStructureAt('$#call(mat(delim: "(", a, b))$', 9), null);

const invalidMatrix = '$mat(delim: "(", a, b; c, #bad)$';
const invalidMatrixParsed = parse(invalidMatrix, 'bad');
assert.equal(invalidMatrixParsed?.kind, 'matrix');
assert.equal(invalidMatrixParsed?.compatible, false);
assert.match(invalidMatrixParsed?.reason ?? '', /Edit source/);

const malformed = '#table(columns: 2, align: (left, right), inset: 5pt, stroke: none, [unfinished';
const malformedParsed = parse(malformed, 'unfinished');
assert.equal(malformedParsed?.kind, 'table');
assert.equal(malformedParsed?.compatible, false);

console.log('Typst structure parser checks passed.');
