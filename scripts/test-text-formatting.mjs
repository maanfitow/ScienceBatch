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

const { planTextFormatting } = await import('../src/editor/writing/textFormatting.ts');
const selection = (start, end = start, anchor = start, active = end) => ({ start, end, anchor, active });
const exactSelection = (source, needle, reverse = false) => {
  const start = source.indexOf(needle);
  assert.notEqual(start, -1, `Missing fixture text ${needle}`);
  const end = start + needle.length;
  return reverse ? selection(start, end, end, start) : selection(start, end, start, end);
};
const changed = (language, source, range, kind) => {
  const plan = planTextFormatting(language, source, range, kind);
  assert.equal(plan.enabled, true, `${language} ${kind} should be enabled: ${plan.reason}`);
  assert.ok(plan.change, 'Enabled plans must contain a bounded source change.');
  return plan.change;
};
const blocked = (language, source, range, kind, reason) => {
  const plan = planTextFormatting(language, source, range, kind);
  assert.equal(plan.enabled, false, `${language} ${kind} unexpectedly enabled: ${source}`);
  assert.equal(plan.change, undefined, 'Blocked plans must not carry an edit.');
  if (reason) assert.match(plan.reason ?? '', reason);
  return plan;
};
const apply = (source, change) => source.slice(0, change.start) + change.text + source.slice(change.end);

for (const [language, kind, prefix, suffix] of [
  ['latex', 'bold', '\\textbf{', '}'],
  ['latex', 'italic', '\\textit{', '}'],
  ['typst', 'bold', '#strong[', ']'],
  ['typst', 'italic', '#emph[', ']'],
]) {
  const source = 'before words after';
  const range = exactSelection(source, 'words');
  const change = changed(language, source, range, kind);
  assert.equal(apply(source, change), `before ${prefix}words${suffix} after`);
  assert.deepEqual(change.selection, { anchor: range.start + prefix.length, active: range.start + prefix.length + 5 });
  const reverse = exactSelection(source, 'words', true);
  const reverseChange = changed(language, source, reverse, kind);
  assert.deepEqual(reverseChange.selection, { anchor: range.start + prefix.length + 5, active: range.start + prefix.length });

  const emptySource = 'caret';
  const emptyRange = selection(2);
  const emptyChange = changed(language, emptySource, emptyRange, kind);
  assert.equal(apply(emptySource, emptyChange), `ca${prefix}${suffix}ret`);
  assert.deepEqual(emptyChange.selection, { anchor: 2 + prefix.length, active: 2 + prefix.length });
}

for (const [language, kind, wrapper, body] of [
  ['latex', 'bold', '\\textbf{bold text}', 'bold text'],
  ['latex', 'italic', '\\textit{italic text}', 'italic text'],
  ['typst', 'bold', '#strong[bold text]', 'bold text'],
  ['typst', 'italic', '#emph[italic text]', 'italic text'],
]) {
  const prefixLength = wrapper.indexOf(body);
  const source = `before ${wrapper} after`;
  const base = source.indexOf(wrapper);
  const bodyStart = base + prefixLength;
  const bodyEnd = bodyStart + body.length;
  const bodyChange = changed(language, source, selection(bodyStart, bodyEnd), kind);
  assert.equal(bodyChange.text, body);
  assert.equal(apply(source, bodyChange), `before ${body} after`);
  assert.deepEqual(bodyChange.selection, { anchor: base, active: base + body.length });
  const reverseBody = changed(language, source, selection(bodyStart, bodyEnd, bodyEnd, bodyStart), kind);
  assert.deepEqual(reverseBody.selection, { anchor: base + body.length, active: base });

  const fullRange = selection(base, base + wrapper.length);
  const wholeChange = changed(language, source, fullRange, kind);
  assert.equal(wholeChange.text, body);
  assert.deepEqual(wholeChange.selection, { anchor: base, active: base + body.length });
  const reverseWhole = changed(language, source, selection(base, base + wrapper.length, base + wrapper.length, base), kind);
  assert.deepEqual(reverseWhole.selection, { anchor: base + body.length, active: base });

  const caret = changed(language, source, selection(bodyStart + 2), kind);
  assert.equal(caret.text, body);
  assert.deepEqual(caret.selection, { anchor: base + 2, active: base + 2 });
}

const emptyWrappers = [
  ['latex', 'bold', '\\textbf{}', 8],
  ['latex', 'italic', '\\textit{}', 8],
  ['typst', 'bold', '#strong[]', 8],
  ['typst', 'italic', '#emph[]', 6],
];
for (const [language, kind, source, bodyOffset] of emptyWrappers) {
  const plan = planTextFormatting(language, source, selection(bodyOffset), kind);
  assert.equal(plan.enabled, true, `${source}: ${plan.reason}`);
  assert.equal(plan.active, true);
  assert.equal(plan.change.text, '');
  assert.equal(apply(source, plan.change), '');
  assert.deepEqual(plan.change.selection, { anchor: 0, active: 0 });
}

const nestedTypst = '#strong[#emph[styled]]';
const nestedItalicBody = exactSelection(nestedTypst, 'styled');
const removeInner = changed('typst', nestedTypst, nestedItalicBody, 'italic');
assert.equal(apply(nestedTypst, removeInner), '#strong[styled]');
assert.equal(removeInner.selection.anchor, '#strong['.length);
const removeOuter = changed('typst', nestedTypst, selection(nestedTypst.indexOf('styled') + 1), 'bold');
assert.equal(apply(nestedTypst, removeOuter), '#emph[styled]');
const oppositeWrapper = '#emph[italic]';
const nestedBold = changed('typst', oppositeWrapper, selection(0, oppositeWrapper.length), 'bold');
assert.equal(apply(oppositeWrapper, nestedBold), '#strong[#emph[italic]]');
const nestedLatex = '\\textbf{\\textit{styled}}';
const removeLatexItalic = changed('latex', nestedLatex, exactSelection(nestedLatex, 'styled'), 'italic');
assert.equal(apply(nestedLatex, removeLatexItalic), '\\textbf{styled}');
const removeLatexBold = changed('latex', nestedLatex, selection(nestedLatex.indexOf('styled') + 1), 'bold');
assert.equal(apply(nestedLatex, removeLatexBold), '\\textit{styled}');

const latexFakeCases = [
  ['$\\textbf{hello}$', /math|delimiter|protected/i],
  ['% \\textbf{hello}', /comment|protected|ambiguous/i],
  ['\\begin{verbatim}\\textbf{hello}\\end{verbatim}', /verbatim|protected|ambiguous/i],
  ['\\url{\\textbf{hello}}', /protected|ambiguous|URL/i],
];
for (const [source, reason] of latexFakeCases) blocked('latex', source, exactSelection(source, 'hello'), 'bold', reason);

const typstFakeCases = [
  ['`#strong[hello]`', /raw|protected|ambiguous/i],
  ['// #strong[hello]', /comment|protected|ambiguous/i],
  ['"#strong[hello]"', /string|protected|ambiguous/i],
  ['https://example.com/#strong[hello]', /URL|protected|ambiguous/i],
  ['$#strong[hello]$', /math|protected|ambiguous/i],
];
for (const [source, reason] of typstFakeCases) blocked('typst', source, exactSelection(source, 'hello'), 'bold', reason);
const escapedFake = '\\#strong[hello]';
const escapedFakeWhole = blocked('typst', escapedFake, selection(0, escapedFake.length), 'bold');
assert.equal(escapedFakeWhole.active, false, 'Escaped source must not report an active canonical wrapper.');

for (const [language, source, kind] of [
  ['latex', '\\textbf{hello $x$}', 'bold'],
  ['latex', '\\textbf{hello \\verb|raw|}', 'bold'],
  ['latex', '\\textbf{hello \\begin{verbatim}raw\\end{verbatim}}', 'bold'],
  ['latex', '\\textbf{hello \\custom{world}}', 'bold'],
  ['typst', '#strong[hello `raw`]', 'bold'],
  ['typst', '#strong[hello https://example.com after]', 'bold'],
]) {
  blocked(language, source, selection(source.indexOf('hello') + 2), kind, /protected|math|raw|URL|command|syntax|ambiguous/i);
  blocked(language, source, exactSelection(source, source.slice(source.indexOf('hello'), source.lastIndexOf(language === 'latex' ? '}' : ']'))), kind, /protected|math|raw|URL|command|syntax|ambiguous/i);
}

for (const [language, kind, prefix, body, suffix] of [
  ['latex', 'bold', '\\textbf{', 'hello \\% \\& \\#', '}'],
]) {
  const change = changed(language, body, selection(0, body.length), kind);
  assert.equal(change.text, `${prefix}${body}${suffix}`);
}
const escapedTypstSource = 'before safe \\# hash after';
const escapedTypstRange = exactSelection(escapedTypstSource, 'safe \\# hash');
assert.equal(changed('typst', escapedTypstSource, escapedTypstRange, 'italic').text, '#emph[safe \\# hash]');

const escapedBracketBody = 'hello \\] world';
const escapedBracketSource = `#strong[${escapedBracketBody}]`;
const escapedBracketCaret = changed('typst', escapedBracketSource, selection(escapedBracketSource.indexOf('hello') + 2), 'bold');
assert.equal(escapedBracketCaret.text, escapedBracketBody);
assert.equal(apply(escapedBracketSource, escapedBracketCaret), escapedBracketBody);

const unicode = 'café 🚀';
const unicodeRange = selection(0, unicode.length);
const unicodeChange = changed('latex', unicode, unicodeRange, 'bold');
assert.equal(unicodeChange.text, `\\textbf{${unicode}}`);
blocked('latex', unicode, selection(6), 'bold');

const softNewline = 'first line\nsecond line';
assert.equal(changed('latex', softNewline, selection(0, softNewline.length), 'bold').text, `\\textbf{${softNewline}}`);
assert.equal(changed('typst', softNewline, selection(0, softNewline.length), 'bold').text, `#strong[${softNewline}]`);
blocked('latex', 'first line\n\nsecond line', selection(0, 'first line\n\nsecond line'.length), 'bold', /paragraph/i);
blocked('typst', 'first line\n\nsecond line', selection(0, 'first line\n\nsecond line'.length), 'bold', /paragraph/i);
blocked('latex', 'alpha & beta', selection(0, 12), 'bold', /structural/i);
blocked('latex', 'alpha \\\\ beta', selection(0, 13), 'bold', /structural/i);
blocked('typst', 'a | b', selection(0, 5), 'bold', /structural/i);
blocked('latex', '\\documentclass{article}\n\\textbf{preamble}', exactSelection('\\documentclass{article}\n\\textbf{preamble}', 'preamble'), 'bold');
blocked('latex', '{hello', exactSelection('{hello', 'hello'), 'bold', /unmatched.*brace/i);
for (const definition of [
  '\\newcommand{\\foo}{hello}',
  '\\renewcommand{\\foo}{hello}',
  '\\providecommand{\\foo}{hello}',
  '\\DeclareRobustCommand{\\foo}{hello}',
  '\\def\\foo#1{hello}',
]) blocked('latex', definition, exactSelection(definition, 'hello'), 'bold', /macro definition/i);
const definitionThenText = '\\newcommand{\\foo}{hello}\nplain text';
assert.equal(changed('latex', definitionThenText, exactSelection(definitionThenText, 'plain text'), 'bold').text, '\\textbf{plain text}');
const commentedDefinitionThenText = '\\newcommand{\\foo}% definition note\n{hello}\nplain text';
assert.equal(changed('latex', commentedDefinitionThenText, exactSelection(commentedDefinitionThenText, 'plain text'), 'bold').text, '\\textbf{plain text}');
const balancedTextGroup = '{hello}';
assert.equal(changed('latex', balancedTextGroup, exactSelection(balancedTextGroup, 'hello'), 'bold').text, '\\textbf{hello}');
const commentBrace = '% { comment\nplain text';
assert.equal(changed('latex', commentBrace, exactSelection(commentBrace, 'plain text'), 'bold').text, '\\textbf{plain text}');
const commentedDefinition = '% \\newcommand{\\foo}{hello}\nplain text';
assert.equal(changed('latex', commentedDefinition, exactSelection(commentedDefinition, 'plain text'), 'bold').text, '\\textbf{plain text}');
const verbBrace = '\\verb|{| plain text';
assert.equal(changed('latex', verbBrace, exactSelection(verbBrace, 'plain text'), 'bold').text, '\\textbf{plain text}');
const laterUnmatched = 'plain text {later';
assert.equal(changed('latex', laterUnmatched, exactSelection(laterUnmatched, 'plain text'), 'bold').text, '\\textbf{plain text}');
blocked('latex', '\\textit{a long phrase}', selection(9, 13), 'italic', /complete formatted text/i);
blocked('typst', '*bold*', exactSelection('*bold*', 'bold'), 'bold', /shorthand/i);
const unsupportedBoldShorthand = planTextFormatting('typst', '*bold*', exactSelection('*bold*', 'bold'), 'bold');
assert.equal(unsupportedBoldShorthand.active, false, 'Unsupported shorthand does not set canonical active state.');
blocked('typst', '_italic_', exactSelection('_italic_', 'italic'), 'italic', /shorthand/i);
blocked('latex', '\\textbf{malformed', exactSelection('\\textbf{malformed', 'malformed'), 'bold');
blocked('typst', '#strong[malformed', exactSelection('#strong[malformed', 'malformed'), 'bold');
blocked('latex', 'alpha beta', selection(1, 99), 'bold');
blocked('latex', 'alpha beta', selection(5, 1, 1, 5), 'bold');

console.log('Text formatting planner regressions passed.');
