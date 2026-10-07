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

const { classifyTypstContext, classifyTypstRange } = await import('../src/editor/writing/typstContext.ts');
const { typstSymbolInsertion } = await import('../src/editor/writing/typstGenerate.ts');
const { searchTypstSymbols, TYPST_WRITING_SYMBOLS } = await import('../src/editor/writing/typstSymbols.ts');
const { getWritingSymbolAdapter } = await import('../src/editor/writing/adapters.ts');
const { registerTypstCompletion } = await import('../src/editor/typstCompletion.ts');

const at = (source, token, offset = 0) => classifyTypstContext(source, source.indexOf(token) + offset).context;

assert.equal(at('Text $alpha$ text', 'alpha'), 'math-inline');
assert.equal(at('Text $ alpha + beta $ text', 'alpha'), 'math-display');
assert.equal(at('[content [nested]]', 'nested'), 'text');
assert.equal(at('$x + #sqrt(2) + y$', '#sqrt'), 'blocked');
assert.equal(at('Text #strong[styled text] end', 'styled'), 'text');
assert.equal(at('Text \\$ not math', 'not'), 'text');
assert.equal(at('Text // $alpha$\n next', '$alpha'), 'blocked');
assert.equal(at('Text /* outer /* nested */ tail */ end', 'nested'), 'blocked');
assert.equal(at('Text "#alpha $x$" end', '$x'), 'blocked');
assert.equal(at('Text `#alpha $x$` end', '$x'), 'blocked');
assert.equal(at('Text ```typ\n#alpha $x$\n``` end', '$x'), 'blocked');
assert.equal(at('Text #alpha rest', '#alpha', 2), 'blocked');
assert.equal(at('#let x = 123\nText', '123'), 'blocked');
assert.equal(at('#let x = (\n  123\n)\nText', '123'), 'blocked');
assert.equal(at('#let x = (\n  // note\n  123\n)\nText', '123'), 'blocked');
assert.equal(at('#if true {\n  [inside code]\n}\nText', 'inside code'), 'blocked');
assert.equal(at('#context {\n  selected\n}\nText', 'selected'), 'blocked');
assert.equal(at('#let x =\n  selected\nBody', 'selected'), 'blocked');
assert.equal(at('#let x = 123\nText', 'Text'), 'text');
assert.equal(at('#strong("x")[markup]', 'x'), 'blocked');
assert.equal(at('#strong("x")[markup]', 'markup'), 'text');
assert.equal(at('#f(/* ) */ value)', 'value'), 'blocked');
assert.equal(at('#let x = (` ) `\n + 1)\nText', '+ 1'), 'blocked');
assert.equal(at('#sym.arrow.r text', 'arrow'), 'blocked');
assert.equal(at('#sym.arrow.r text', 'text'), 'text');
assert.equal(at('Text [unfinished', 'unfinished'), 'blocked');
assert.equal(at('Text $$ alpha $$', 'alpha'), 'blocked');
assert.equal(at('Text <sec:label> rest', 'label'), 'blocked');
assert.equal(at('See @sec:intro now', 'intro'), 'blocked');
assert.equal(at('Visit https://example.org/page now', 'example'), 'blocked');
assert.equal(classifyTypstContext('Text $unclosed', 8).context, 'blocked');
assert.equal(classifyTypstContext('$alphabet$', 5).context, 'blocked');
const mathAfterComment = 'Text /* $ */ $alpha$';
assert.equal(classifyTypstContext(mathAfterComment, mathAfterComment.indexOf('alpha')).context, 'math-inline');

const mixed = 'Text $alpha$ end';
assert.equal(classifyTypstRange(mixed, 0, mixed.indexOf('alpha')).context, 'blocked');
assert.equal(classifyTypstRange(mixed, mixed.indexOf('alpha'), mixed.indexOf('alpha') + 5).context, 'math-inline');
assert.equal(classifyTypstRange('Text alpha beta', 5, 10).context, 'text');
assert.equal(classifyTypstRange('Text [alpha] beta', 6, 12).context, 'blocked');

const alpha = TYPST_WRITING_SYMBOLS.find((item) => item.nativeIdentifier === 'alpha');
assert.ok(alpha);
assert.equal(alpha.packages.length, 0);
assert.equal(alpha.insertionSyntax, 'alpha');
assert.equal(typstSymbolInsertion(alpha, 'text', 'ab', 1, 1).text, '$alpha$');
assert.equal(typstSymbolInsertion(alpha, 'math-inline', '$x$', 2, 2).text, ' alpha');
assert.equal(typstSymbolInsertion(alpha, 'math-inline', '$x$', 1, 1).text, 'alpha ');
assert.equal(typstSymbolInsertion(alpha, 'math-inline', '$alphabet$', 5, 5).reason?.includes('complete identifier'), true);
assert.equal(typstSymbolInsertion(alpha, 'math-inline', '$alphabet$', 1, 9).text, 'alpha');
assert.equal(typstSymbolInsertion(alpha, 'math-inline', '$x.$', 2, 2).text, ' alpha ');
assert.equal(typstSymbolInsertion(alpha, 'math-inline', '$arrow.r$', 6, 6).reason?.includes('complete identifier'), true);
assert.equal(typstSymbolInsertion(alpha, 'math-inline', '$arrow.r$', 7, 7).reason?.includes('complete identifier'), true);
assert.equal(typstSymbolInsertion(alpha, 'math-inline', '$arrow.r$', 1, 8).text, 'alpha');
assert.equal(typstSymbolInsertion('arrow.r', 'math-display', 'x.', 1, 1).text, ' arrow.r ');
assert.equal(typstSymbolInsertion(alpha, 'blocked', '', 0, 0).text, '');

for (const [query, expected] of [
  ['alpha', 'alpha'], ['\\alpha', 'alpha'], ['#sym.alpha', 'alpha'], ['sym.arrow.r', 'arrow.r'], ['infinity', 'infinity'],
]) assert.ok(searchTypstSymbols(query).some((item) => item.nativeIdentifier === expected), `search ${query}`);
assert.equal(searchTypstSymbols('not-a-symbol').length, 0);
assert.ok(searchTypstSymbols('\\alpha').some((item) => item.nativeIdentifier === 'alpha'));
assert.ok(searchTypstSymbols('', 'Arrows').every((item) => item.category === 'Arrows'));

const typst = getWritingSymbolAdapter('typst');
assert.equal(typst.language, 'typst');
assert.equal(typst.previewKind, 'glyph');
assert.equal(typst.supportsStructures, true);
assert.equal(typst.symbolInsertion('alpha', 'text', '', 0, 0).text, '$alpha$');
const latex = getWritingSymbolAdapter('latex');
assert.equal(latex.language, 'latex');
assert.equal(latex.supportsStructures, true);
assert.equal(latex.symbolInsertion('\\alpha', 'text', '', 0, 0).text, '\\(\\alpha\\)');

const providers = [];
const fakeMonaco = {
  languages: {
    CompletionItemKind: { File: 1, Reference: 2, Value: 3, Snippet: 4 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 1 },
    registerCompletionItemProvider(_language, provider) {
      providers.push(provider);
      return { dispose() {} };
    },
  },
};
registerTypstCompletion(fakeMonaco);
const complete = (source, cursorOffset = source.length) => {
  const position = { lineNumber: 1, column: cursorOffset + 1 };
  const line = source.split('\n').at(-1);
  return providers.at(-1).provideCompletionItems({
    getLineContent: () => line,
    getValue: () => source,
    getOffsetAt: () => cursorOffset,
    getWordUntilPosition: () => ({ word: '', startColumn: position.column }),
  }, position).suggestions;
};
assert.ok(complete('Text #sym.al').some((item) => item.label === '#sym.alpha' && item.insertText === 'alpha'));
const nestedMarkupCompletion = 'Text #strong[Text #sym.al]';
assert.ok(complete(nestedMarkupCompletion, nestedMarkupCompletion.lastIndexOf(']')).some((item) => item.label === '#sym.alpha'));
assert.ok(complete('$al$', 3).some((item) => item.label === 'alpha' && item.insertText === 'alpha'));
const rawCompletion = 'Text `#sym.al`';
assert.equal(complete(rawCompletion, rawCompletion.lastIndexOf('`')).some((item) => item.label === '#sym.alpha'), false);
assert.equal(complete('Text // #sym.al').some((item) => item.label === '#sym.alpha'), false);
const stringCompletion = 'Text "#sym.al"';
assert.equal(complete(stringCompletion, stringCompletion.lastIndexOf('"')).some((item) => item.label === '#sym.alpha'), false);

console.log('Typst writing tool core checks passed.');
