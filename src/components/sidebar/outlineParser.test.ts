import assert from 'node:assert/strict';
import test from 'node:test';

type OutlineParserModule = typeof import('./outlineParser');

let parserModulePromise: Promise<OutlineParserModule> | null = null;

function loadOutlineParser(): Promise<OutlineParserModule> {
  if (!parserModulePromise) {
    const parserUrl = new URL('./outlineParser.ts', import.meta.url).href;
    parserModulePromise = import(parserUrl) as Promise<OutlineParserModule>;
  }
  return parserModulePromise;
}

test('parseDocumentOutline (LaTeX): parses hierarchy, short args, starred, and multiline headings', async () => {
  const { parseDocumentOutline } = await loadOutlineParser();
  const tex = [
    '\\part{Foundations}',
    '\\chapter*{Preface}',
    '\\section[Short Intro]{\\textbf{Introduction} to \\emph{ScienceBatch} \\& \\texorpdfstring{$E=mc^2$}{E=mc2}}',
    '\\subsection[Multiline]{',
    '  Nested \\textit{Methods} with 100\\% \\_data\\$ \\#1',
    '}',
    '\\subsubsection{Fine Grain}',
    '\\paragraph{Detail Block}',
    '\\subparagraph{Subdetail}',
  ].join('\n');

  const items = parseDocumentOutline('latex', tex, '/doc/main.tex', 'main.tex');

  assert.equal(items.length, 7);
  assert.deepEqual(
    items.map((item) => ({
      title: item.title,
      level: item.level,
      kindLabel: item.kindLabel,
      line: item.line,
      starred: item.starred ?? false,
      rawCommand: item.rawCommand,
    })),
    [
      { title: 'Foundations', level: 0, kindLabel: 'Part', line: 1, starred: false, rawCommand: 'part' },
      { title: 'Preface', level: 1, kindLabel: 'Ch', line: 2, starred: true, rawCommand: 'chapter' },
      {
        title: 'Introduction to ScienceBatch & $E=mc^2$',
        level: 2,
        kindLabel: 'H1',
        line: 3,
        starred: false,
        rawCommand: 'section',
      },
      {
        title: 'Nested Methods with 100% _data$ #1',
        level: 3,
        kindLabel: 'H2',
        line: 4,
        starred: false,
        rawCommand: 'subsection',
      },
      { title: 'Fine Grain', level: 4, kindLabel: 'H3', line: 7, starred: false, rawCommand: 'subsubsection' },
      { title: 'Detail Block', level: 5, kindLabel: 'H4', line: 8, starred: false, rawCommand: 'paragraph' },
      { title: 'Subdetail', level: 6, kindLabel: 'H5', line: 9, starred: false, rawCommand: 'subparagraph' },
    ]
  );
});

test('parseDocumentOutline (LaTeX): skips comments, ignored blocks, and macro definitions', async () => {
  const { parseDocumentOutline } = await loadOutlineParser();
  const tex = [
    '% \\section{Commented Out}',
    '\\section{Real Start} % \\subsection{Trailing Comment}',
    '\\begin{verbatim}',
    '\\section{Inside Verbatim}',
    '\\end{verbatim}',
    '\\begin{lstlisting}[language=TeX]',
    '\\chapter{Inside Listing}',
    '\\end{lstlisting}',
    '\\begin{comment}',
    '\\section{Inside Comment Env}',
    '\\end{comment}',
    '\\iffalse',
    '\\section{Inside Iffalse}',
    '\\iftrue',
    '\\subsection{Nested If}',
    '\\fi',
    '\\fi',
    '\\newcommand{\\mysec}[1]{\\section*{#1}}',
    '\\renewcommand*{\\section}[1]{\\textbf{#1}}',
    '\\providecommand{\\helper}[1]{\\subsection{#1}}',
    '\\def\\customsec#1{\\section{#1}}',
    '\\section{Real End with 50\\% Gain}',
  ].join('\n');

  const items = parseDocumentOutline('latex', tex, '/doc/main.tex', 'main.tex');

  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Real Start');
  assert.equal(items[0].line, 2);
  assert.equal(items[1].title, 'Real End with 50% Gain');
  assert.equal(items[1].line, 22);
});

test('parseDocumentOutline (LaTeX): captures labels inside heading or within 2 non-comment lines', async () => {
  const { parseDocumentOutline } = await loadOutlineParser();
  const tex = [
    '\\section{Inline Label \\label{sec:inline}}',
    '\\section{Same Line Label} \\label{sec:same}',
    '\\section{Commented Gap}',
    '% comment 1',
    '% comment 2',
    '\\label{sec:gap}',
    '\\section{Too Far}',
    'Line 1 of body',
    'Line 2 of body',
    '\\label{sec:body}',
    '\\section{Before Next}',
    '\\section{Next Heading} \\label{sec:next}',
  ].join('\n');

  const items = parseDocumentOutline('latex', tex, '/doc/main.tex', 'main.tex');

  assert.equal(items.length, 6);
  assert.equal(items[0].label, 'sec:inline');
  assert.equal(items[0].title, 'Inline Label');
  assert.equal(items[1].label, 'sec:same');
  assert.equal(items[2].label, 'sec:gap');
  assert.equal(items[3].label, undefined);
  assert.equal(items[4].label, undefined);
  assert.equal(items[5].label, 'sec:next');
});

test('parseDocumentOutline (LaTeX): supports Beamer frames and frametitle', async () => {
  const { parseDocumentOutline, buildOutlineTree } = await loadOutlineParser();
  const tex = [
    '\\section{Overview}',
    '\\begin{frame}{Welcome Slide}',
    '  Hello',
    '\\end{frame}',
    '\\begin{frame}[fragile]{Code \\texttt{Demo}}',
    '  World',
    '\\end{frame}',
    '\\begin{frame}[t]',
    '  \\frametitle{Standalone Frame Title}',
    '\\end{frame}',
  ].join('\n');

  const items = parseDocumentOutline('latex', tex, '/doc/slides.tex', 'slides.tex');

  assert.equal(items.length, 4);
  assert.equal(items[0].kindLabel, 'H1');
  assert.equal(items[1].kindLabel, 'Frame');
  assert.equal(items[1].level, 3);
  assert.equal(items[1].title, 'Welcome Slide');
  assert.equal(items[2].kindLabel, 'Frame');
  assert.equal(items[2].title, 'Code Demo');
  assert.equal(items[3].kindLabel, 'Frame');
  assert.equal(items[3].title, 'Standalone Frame Title');
  assert.equal(items[3].line, 9);

  const tree = buildOutlineTree(items);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].depth, 0);
  assert.equal(tree[0].children.length, 3);
  assert.equal(tree[0].children[0].depth, 1);

  // Frames without sections normalize to root depth 0
  const framesOnly = parseDocumentOutline(
    'latex',
    '\\begin{frame}{Slide 1}\n\\end{frame}\n\\begin{frame}{Slide 2}\n\\end{frame}',
    '/doc/deck.tex',
    'deck.tex'
  );
  const framesTree = buildOutlineTree(framesOnly);
  assert.equal(framesTree.length, 2);
  assert.equal(framesTree[0].depth, 0);
  assert.equal(framesTree[1].depth, 0);
});

test('parseDocumentOutline (Typst): parses ATX headings, programmatic #heading, labels, comments, and raw blocks', async () => {
  const { parseDocumentOutline } = await loadOutlineParser();
  const typst = [
    '// = Commented Heading',
    '/* = Block Comment Heading',
    '   /* == Nested Comment Heading */',
    '   === Still In Comment',
    '*/',
    '```typst',
    '= Raw Fenced Heading',
    '#heading[Raw Programmatic]',
    '```',
    '= *Introduction* to `Typst` // inline comment',
    '== #emph[Methodology] & _Analysis_ <sec:method>',
    '#heading[Programmatic Top] <top-lbl>',
    '#heading(level: 2, numbering: none)[Experiments]',
    '#heading(level: 2, outlined: false)[Table of Contents]',
    '====== Deepest Level',
  ].join('\n');

  const items = parseDocumentOutline('typst', typst, '/doc/paper.typ', 'paper.typ');

  assert.equal(items.length, 5);
  assert.deepEqual(
    items.map((item) => ({
      title: item.title,
      level: item.level,
      kindLabel: item.kindLabel,
      label: item.label,
      line: item.line,
    })),
    [
      {
        title: 'Introduction to Typst',
        level: 0,
        kindLabel: 'H1',
        label: undefined,
        line: 10,
      },
      {
        title: 'Methodology & Analysis',
        level: 1,
        kindLabel: 'H2',
        label: 'sec:method',
        line: 11,
      },
      {
        title: 'Programmatic Top',
        level: 0,
        kindLabel: 'H1',
        label: 'top-lbl',
        line: 12,
      },
      {
        title: 'Experiments',
        level: 1,
        kindLabel: 'H2',
        label: undefined,
        line: 13,
      },
      {
        title: 'Deepest Level',
        level: 5,
        kindLabel: 'H6',
        label: undefined,
        line: 15,
      },
    ]
  );
});

test('buildOutlineTree: normalizes top-level depth to 0 and handles skipped levels', async () => {
  const { parseDocumentOutline, buildOutlineTree } = await loadOutlineParser();
  const tex = [
    '\\section{Experience}',
    '\\subsubsection{Nested Detail}',
    '\\subsection{Role One}',
    '\\section{Education}',
  ].join('\n');

  const items = parseDocumentOutline('latex', tex, '/doc/resume.tex', 'resume.tex');
  const tree = buildOutlineTree(items);

  assert.equal(tree.length, 2);
  assert.equal(tree[0].item.title, 'Experience');
  assert.equal(tree[0].depth, 0);
  assert.equal(tree[0].children.length, 2);
  assert.equal(tree[0].children[0].item.title, 'Nested Detail');
  assert.equal(tree[0].children[0].depth, 1);
  assert.equal(tree[0].children[1].item.title, 'Role One');
  assert.equal(tree[0].children[1].depth, 1);
  assert.equal(tree[1].item.title, 'Education');
  assert.equal(tree[1].depth, 0);
});

test('findActiveOutlineId: matches last heading with line <= cursorLine or null', async () => {
  const { parseDocumentOutline, findActiveOutlineId } = await loadOutlineParser();
  const tex = [
    '% preamble',
    '\\section{Intro}',
    'text',
    '\\subsection{Motivation}',
    'more text',
    '\\section{Conclusion}',
  ].join('\n');

  const items = parseDocumentOutline('latex', tex, '/doc/main.tex', 'main.tex');

  assert.equal(findActiveOutlineId(items, null), null);
  assert.equal(findActiveOutlineId(items, undefined), null);
  assert.equal(findActiveOutlineId(items, 1), null);
  assert.equal(findActiveOutlineId(items, 2), items[0].id);
  assert.equal(findActiveOutlineId(items, 3), items[0].id);
  assert.equal(findActiveOutlineId(items, 4), items[1].id);
  assert.equal(findActiveOutlineId(items, 5), items[1].id);
  assert.equal(findActiveOutlineId(items, 6), items[2].id);
  assert.equal(findActiveOutlineId(items, 100), items[2].id);
  assert.equal(findActiveOutlineId([], 5), null);
});

test('parseDocumentOutline: handles edge cases for LaTeX formatting/comments and Typst URLs/multiline #heading', async () => {
  const { parseDocumentOutline } = await loadOutlineParser();

  const tex = [
    '\\section[Short % comment in short arg',
    ']{%',
    '  \\textsc{Small} \\textrm{Roman} \\\\ \\texorpdfstring{\\textbf{Math}}{Plain}',
    '}',
    '\\begin{frame}[t][fragile]{Multi Option Frame}',
    '\\end{frame}',
  ].join('\n');

  const texItems = parseDocumentOutline('latex', tex, '/doc/edge.tex', 'edge.tex');
  assert.equal(texItems.length, 2);
  assert.equal(texItems[0].title, 'Small Roman Math');
  assert.equal(texItems[0].line, 1);
  assert.equal(texItems[1].title, 'Multi Option Frame');
  assert.equal(texItems[1].kindLabel, 'Frame');

  const typst = [
    '= See https://typst.app // trailing comment',
    '#heading(',
    '  level: 3,',
    ')[#strong[Bold] Multiline] <lbl:multi>',
    '#heading(level: 2, body: [Named Body])',
  ].join('\n');

  const typstItems = parseDocumentOutline('typst', typst, '/doc/edge.typ', 'edge.typ');
  assert.equal(typstItems.length, 3);
  assert.equal(typstItems[0].title, 'See https://typst.app');
  assert.equal(typstItems[0].kindLabel, 'H1');
  assert.equal(typstItems[1].title, 'Bold Multiline');
  assert.equal(typstItems[1].level, 2);
  assert.equal(typstItems[1].kindLabel, 'H3');
  assert.equal(typstItems[1].label, 'lbl:multi');
  assert.equal(typstItems[1].line, 2);
  assert.equal(typstItems[2].title, 'Named Body');
  assert.equal(typstItems[2].level, 1);
  assert.equal(typstItems[2].kindLabel, 'H2');
});
