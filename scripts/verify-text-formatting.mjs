import assert from 'node:assert/strict';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import ts from 'typescript';

const compileWorkerPath = process.argv[2];
if (!compileWorkerPath || process.argv.length !== 3) {
  console.error('Usage: node scripts/verify-text-formatting.mjs <compile-worker-binary>');
  process.exit(2);
}

const binaryPath = resolve(compileWorkerPath);
await access(binaryPath, constants.X_OK);
assert.ok((await stat(binaryPath)).isFile(), `Compile worker is not a file: ${binaryPath}`);

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dataModule = (javascript) => `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`;
const read = async (relative) => await (await import('node:fs/promises')).readFile(new URL(relative, import.meta.url), 'utf8');
const contextUrl = dataModule(transpile(await read('../src/editor/writing/context.ts')));
const typstContextUrl = dataModule(transpile(await read('../src/editor/writing/typstContext.ts')));
const plannerJavaScript = transpile(await read('../src/editor/writing/textFormatting.ts'))
  .replace("'./context'", JSON.stringify(contextUrl))
  .replace("'./typstContext'", JSON.stringify(typstContextUrl));
const { planTextFormatting } = await import(dataModule(plannerJavaScript));

function applyPlan(source, plan) {
  assert.ok(plan.enabled && plan.change, `Expected a formatting edit plan: ${plan.reason ?? 'no reason supplied'}`);
  const { start, end, text } = plan.change;
  return source.slice(0, start) + text + source.slice(end);
}

function select(source, selected) {
  const start = source.indexOf(selected);
  assert.notEqual(start, -1, `Could not find fixture selection: ${selected}`);
  return { start, end: start + selected.length, anchor: start, active: start + selected.length };
}

function emptyAt(source, marker) {
  const offset = source.indexOf(marker);
  assert.notEqual(offset, -1, `Could not find fixture caret marker: ${marker}`);
  return { start: offset, end: offset, anchor: offset, active: offset };
}

const fixtures = {
  latex: [],
  typst: [],
};

for (const language of ['latex', 'typst']) {
  const sourceText = language === 'latex' ? String.raw`Unicode café, 50\% \& \#` : String.raw`Unicode café, 50% \* \#`;
  const seed = `Before ${sourceText} after`;
  const boldPlan = planTextFormatting(language, seed, select(seed, sourceText), 'bold');
  const bold = applyPlan(seed, boldPlan);
  const boldWrapper = language === 'latex' ? String.raw`\textbf{${sourceText}}` : `#strong[${sourceText}]`;
  assert.ok(bold.includes(boldWrapper), `${language} bold planner output must use its canonical native wrapper.`);
  fixtures[language].push(bold);

  const emptySeed = 'Before  after';
  const emptyPlan = planTextFormatting(language, emptySeed, emptyAt(emptySeed, '  '), 'italic');
  const emptyWrapped = applyPlan(emptySeed, emptyPlan);
  const prefix = language === 'latex' ? String.raw`\textit{` : '#emph[';
  const closing = language === 'latex' ? '}' : ']';
  const typedAt = emptyPlan.change.selection.active;
  const typedSource = emptyWrapped.slice(0, typedAt) + 'typed café' + emptyWrapped.slice(typedAt);
  assert.ok(typedSource.includes(`${prefix}typed café${closing}`), `${language} empty wrapper must accept typing at the planned caret.`);
  fixtures[language].push(emptyWrapped, typedSource);

  const combinedSeed = 'Unicode café';
  const combinedBold = planTextFormatting(language, combinedSeed, select(combinedSeed, combinedSeed), 'bold');
  const boldSource = applyPlan(combinedSeed, combinedBold);
  const boldBodyStart = boldSource.indexOf(language === 'latex' ? '{' : '[') + 1;
  const boldBodyEnd = boldBodyStart + combinedSeed.length;
  const italic = planTextFormatting(language, boldSource, {
    start: boldBodyStart, end: boldBodyEnd, anchor: boldBodyStart, active: boldBodyEnd,
  }, 'italic');
  const combined = applyPlan(boldSource, italic);
  const combinedWrapper = language === 'latex'
    ? String.raw`\textbf{\textit{${combinedSeed}}}`
    : `#strong[#emph[${combinedSeed}]]`;
  assert.ok(combined.includes(combinedWrapper), `${language} planner must support nested Bold and Italic.`);
  fixtures[language].push(combined);

  const unwrapped = planTextFormatting(language, combined, select(combined, combinedWrapper), 'bold');
  const plain = applyPlan(combined, unwrapped);
  const expectedPlain = language === 'latex' ? String.raw`\textit{${combinedSeed}}` : `#emph[${combinedSeed}]`;
  assert.ok(plain.includes(expectedPlain), `${language} planner must remove only the selected canonical outer wrapper.`);
  fixtures[language].push(plain);
}

const typstPartialSeed = 'Typst prefixword suffix';
const partialRange = select(typstPartialSeed, 'fixwo');
const partial = applyPlan(typstPartialSeed, planTextFormatting('typst', typstPartialSeed, partialRange, 'bold'));
assert.equal(partial, 'Typst pre#strong[fixwo]rd suffix', 'Typst native functions must support formatting part of a word.');
fixtures.typst.push(partial);

function sourceFor(language, sourceFixtures) {
  if (language === 'latex') {
    return String.raw`\documentclass{article}
\begin{document}
${sourceFixtures.join('\n\n')}
\end{document}
`;
  }
  return sourceFixtures.join('\n\n') + '\n';
}

function compile(language, source) {
  const request = JSON.stringify({ engine: language, source, main_file: null, project_dir: null });
  let responseText;
  try {
    responseText = execFileSync(binaryPath, ['--compile-worker'], {
      input: request,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${language} compile-worker failed before returning a response: ${detail}`, { cause: error });
  }
  let response;
  try { response = JSON.parse(responseText); }
  catch (error) { throw new Error(`${language} compile-worker returned invalid JSON.`, { cause: error }); }
  assert.equal(response.success, true, `${language} text-formatting fixtures failed: ${JSON.stringify(response.errors ?? [])}`);
  assert.ok(Array.isArray(response.errors), `${language} compile response is missing its errors array.`);
  assert.equal(response.errors.length, 0, `${language} compile reported errors: ${JSON.stringify(response.errors)}`);
  assert.ok(Array.isArray(response.warnings), `${language} compile response is missing its warnings array.`);
  assert.equal(response.warnings.length, 0, `${language} compile reported warnings: ${JSON.stringify(response.warnings)}`);
  assert.ok(Array.isArray(response.pdf_bytes) && response.pdf_bytes.length > 5, `${language} compile-worker returned an empty PDF.`);
  assert.ok(response.pdf_bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255), `${language} PDF response contains invalid byte values.`);
  const bytes = Buffer.from(response.pdf_bytes);
  assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-', `${language} compile response does not contain a PDF header.`);
  return { pdfBytes: bytes.length, warnings: Array.isArray(response.warnings) ? response.warnings.length : null };
}

const results = {};
for (const language of ['latex', 'typst']) {
  results[language] = {
    plannerFixtures: fixtures[language].length,
    ...compile(language, sourceFor(language, fixtures[language])),
  };
}

console.log(JSON.stringify({ status: 'passed', compilation: 'explicit isolated compile-worker invocation with JSON stdin; no source or PDF files created by verifier', results }, null, 2));
