import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourceUrl = async (path, replacements = []) => {
  let source = await readFile(new URL(path, import.meta.url), 'utf8');
  source = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [specifier, replacement] of replacements) source = source.replaceAll(specifier, replacement);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
};

const typesUrl = await sourceUrl('../src/types/typstWriting.ts');
const validationUrl = await sourceUrl('../src/editor/writing/typstStructureValidation.ts', [
  ["'../../types/typstWriting'", JSON.stringify(typesUrl)],
]);
const generatorUrl = await sourceUrl('../src/editor/writing/typstStructureGenerate.ts', [
  ["'../../types/typstWriting'", JSON.stringify(typesUrl)],
  ["'./typstStructureValidation'", JSON.stringify(validationUrl)],
]);
const { generateTypstMatrix, generateTypstTable } = await import(generatorUrl);
const { encodeTypstString, validateTypstMatrixCell, validateTypstTableCell } = await import(validationUrl);

assert.equal(encodeTypstString('quote " slash \\ hash # dollar $'), '"quote \\" slash \\\\ hash # dollar $"');
assert.equal(encodeTypstString('line\nnext'), '"line\\nnext"');

const baseTable = { rows: 2, columns: 2, cells: [['A # B', 'brackets []'], ['quote "', 'backslash \\']], alignment: ['left', 'right'] };
const plain = generateTypstTable(baseTable);
assert.match(plain, /#table\(/u);
assert.match(plain, /columns: 2/u);
assert.match(plain, /align: \(left, right\)/u);
assert.match(plain, /inset: 5pt/u);
assert.match(plain, /stroke: none/u);
assert.match(plain, /#text\("A # B"\)/u);
assert.match(generateTypstTable({ ...baseTable, format: 'grid' }), /stroke: 0\.5pt/u);

const booktabs = generateTypstTable({ ...baseTable, rows: 2, header: true, format: 'booktabs' });
assert.match(booktabs, /table\.hline\(y: 0, stroke: 0\.8pt\)/u);
assert.match(booktabs, /table\.header\(\[#strong\[#text\("A # B"\)\]\], \[#strong\[#text\("brackets \[\]"\)\]\]\)/u);
assert.match(booktabs, /table\.hline\(y: 1, stroke: 0\.5pt\)/u);
assert.match(booktabs, /table\.hline\(y: 2, stroke: 0\.8pt\)/u);
assert.equal((generateTypstTable({ ...baseTable, rows: 1, cells: [['Header', 'Value']], header: true, format: 'booktabs' }).match(/table\.hline/gu) ?? []).length, 2);

const wrapped = generateTypstTable({ ...baseTable, wrapInFigure: true, caption: 'literal # and "quote"', label: 'tab-results_1' });
assert.match(wrapped, /#figure\(/u);
assert.match(wrapped, /caption: \[#text\("literal # and \\"quote\\""\)\]/u);
assert.match(wrapped, /\) <tab-results_1>$/u);
assert.match(generateTypstTable({ ...baseTable, wrapInFigure: true }), /kind: table/u);
assert.throws(() => generateTypstTable({ ...baseTable, label: 'x' }), /figure wrapper/u);
assert.throws(() => generateTypstTable({ ...baseTable, wrapInFigure: true, caption: '', label: 'x' }), /caption/u);
assert.throws(() => generateTypstTable({ ...baseTable, label: '1bad', wrapInFigure: true, caption: 'Caption' }), /start with a letter/u);
assert.throws(() => generateTypstTable({ ...baseTable, rows: 21 }), /1–20 rows/u);
assert.throws(() => generateTypstTable({ ...baseTable, columns: 11 }), /1–20 rows/u);

const preservedTable = generateTypstTable({
  rows: 1, columns: 1, cells: [['#emph[ unchanged ]']], cellTypst: [[true]], header: false,
  sourceCells: [[{ source: '[#emph[ unchanged ]]', content: '#emph[ unchanged ]', isTypst: true, header: false }]],
});
assert.ok(preservedTable.includes('  [#emph[ unchanged ]],'), 'An unchanged Typst cell must retain its complete source argument.');
const preservedLiteral = generateTypstTable({
  rows: 1, columns: 1, cells: [['literal #[]$ \\ "']], header: false,
  sourceCells: [[{ source: `[#text(${encodeTypstString('literal #[]$ \\ "')})]`, content: 'literal #[]$ \\ "', isTypst: false, header: false }]],
});
assert.ok(preservedLiteral.includes('[#text("literal #[]$'), 'Literal punctuation in a Text cell must not be parsed as Typst markup.');
const preservedSmartQuote = generateTypstTable({
  rows: 1, columns: 1, cells: [['bare " quote']], cellTypst: [[true]],
  sourceCells: [[{ source: '[bare " quote]', content: 'bare " quote', isTypst: true, header: false }]],
});
assert.ok(preservedSmartQuote.includes('[bare " quote]'), 'An unmatched smartquote in a markup cell must remain literal during reopening.');
const preservedHeader = generateTypstTable({
  rows: 1, columns: 1, cells: [['Name']], header: true,
  sourceCells: [[{ source: '[#strong[#text("Name")]]', content: 'Name', isTypst: false, header: true }]],
});
assert.equal((preservedHeader.match(/#strong/gu) ?? []).length, 1, 'An unchanged full header argument must not receive a second strong wrapper.');
const toggledHeader = generateTypstTable({
  rows: 1, columns: 1, cells: [['Name']], header: false,
  sourceCells: [[{ source: '[#strong[#text("Name")]]', content: 'Name', isTypst: false, header: true }]],
});
assert.equal((toggledHeader.match(/#strong/gu) ?? []).length, 0, 'Turning off a parsed header must remove its semantic strong wrapper.');
const grownTable = generateTypstTable({
  rows: 2, columns: 2, cells: [['#emph[  keep  ]', ''], ['', '']],
  sourceCells: [[{ source: '[#emph[  keep  ]]', content: '#emph[  keep  ]', isTypst: true, header: false }, undefined], [undefined, undefined]],
});
assert.ok(grownTable.includes('[#emph[  keep  ]]'), 'Growing dimensions must retain exact source for untouched cells.');
const nestedTypstTable = generateTypstTable({
  rows: 2, columns: 3,
  cells: [
    ['#emph[raw]', '$"a,b]" + x$', '#align(center, [#text("A,B]")])'],
    ['escaped \\] and "quote', 'bare " quote', 'tail'],
  ],
  cellTypst: [[true, true, true], [true, true, true]],
  header: true,
});
assert.match(nestedTypstTable, /table\.header\(\[#strong\[#emph\[raw\]\]\]/u);
assert.ok(nestedTypstTable.includes('#align(center, [#text("A,B]")])'));
assert.ok(nestedTypstTable.includes('escaped \\] and "quote'));
const changedTable = generateTypstTable({
  rows: 1, columns: 1, cells: [['changed']], cellTypst: [[true]], header: false,
  sourceCells: [[{ source: '[#emph[ unchanged ]]', content: '#emph[ unchanged ]', isTypst: true, header: false }]],
});
assert.ok(changedTable.includes('  [changed],'), 'An edited Typst cell must use its current source.');

const matrixOptions = { rows: 2, columns: 2, cells: [['1', 'frac(1, 2)'], ['', 'sqrt(x + y)']] };
assert.equal(generateTypstMatrix(matrixOptions), '$ mat(delim: "(", 1, frac(1, 2); "", sqrt(x + y)) $');
assert.equal(generateTypstMatrix({ ...matrixOptions, delimiter: 'none' }, 'math-inline'), 'mat(delim: #none, 1, frac(1, 2); "", sqrt(x + y))');
assert.equal(generateTypstMatrix({ rows: 1, columns: 1, cells: [['']] }, 'math-inline', { source: '$x$', start: 2, end: 2 }), ' mat(delim: "(", "")');
assert.equal(generateTypstMatrix({ rows: 1, columns: 1, cells: [['1']] }, 'math-inline', { source: '$x$', start: 2, end: 2 }), ' mat(delim: "(", 1)');
assert.equal(generateTypstMatrix({ rows: 1, columns: 1, cells: [['1']] }, 'math-inline', { source: '$$x$', start: 3, end: 3 }), ' mat(delim: "(", 1)');
assert.equal(generateTypstMatrix({ rows: 1, columns: 1, cells: [['']] , sourceCells: [[{ source: '""', content: '""' }]] }), '$ mat(delim: "(", "") $');
assert.throws(() => generateTypstMatrix({ rows: 1, columns: 1, cells: [['1']] }, 'math-inline', { source: '$x$', start: 9, end: 9 }), /outside the current document/u);
const expectedDelimiters = new Map([
  ['parentheses', '"("'], ['brackets', '"["'], ['braces', '"{"'], ['single-bars', '"|"'], ['double-bars', '"‖"'],
]);
for (const [delimiter, syntax] of expectedDelimiters) {
  assert.ok(generateTypstMatrix({ rows: 1, columns: 1, cells: [['x']], delimiter }).includes(`delim: ${syntax}`));
}
assert.throws(() => generateTypstMatrix(matrixOptions, 'blocked'), /does not support matrix/u);
assert.throws(() => generateTypstMatrix({ ...matrixOptions, cells: [['a, b', '1'], ['', '2']] }), /Top-level commas/u);
assert.throws(() => generateTypstMatrix({ ...matrixOptions, cells: [['a; b', '1'], ['', '2']] }), /Top-level commas/u);
assert.throws(() => generateTypstMatrix({ ...matrixOptions, cells: [['f(a', '1'], ['', '2']] }), /unclosed group/u);
assert.throws(() => generateTypstMatrix({ ...matrixOptions, cells: [['#code', '1'], ['', '2']] }), /Code escapes/u);
assert.throws(() => generateTypstMatrix({ ...matrixOptions, cells: [['a & b', '1'], ['', '2']] }), /Alignment points/u);
assert.throws(() => generateTypstTable({ rows: 1, columns: 1, cells: [['two\nlines']] }), /one line/u);
validateTypstMatrixCell('f("a,b")');
validateTypstMatrixCell('f(a, b)');
validateTypstTableCell('#emph[balanced [markup]] + $x^2$');
validateTypstTableCell('#text("A, [bracket] and # hash")');
validateTypstTableCell('#foo([#text("A,B]")])');
validateTypstTableCell('$"a,b]" + x$');
validateTypstTableCell('bare " quote is literal markup');
assert.throws(() => validateTypstTableCell('#foo([hello "], [evil"])'), /Quotes in content arguments/u);
assert.throws(() => validateTypstTableCell('hello "], [evil"'), /unbalanced/u);
assert.throws(() => validateTypstTableCell('[x $y]$'), /cross-context/u);
assert.throws(() => validateTypstTableCell('unclosed ['), /unclosed group/u);
assert.throws(() => validateTypstTableCell('with // comment'), /Comments/u);
assert.throws(() => validateTypstTableCell('line\nbreak'), /one line/u);

console.log(JSON.stringify({ status: 'passed', tableStyles: 3, matrixDelimiters: 6, stringEncoding: 'passed', cellValidation: 'passed' }));
