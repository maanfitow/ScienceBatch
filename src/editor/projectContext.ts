/**
 * Project file registry for Monaco Editor autocompletion.
 * Stores relative paths of all files in the current active project.
 */
let activeProjectFiles: string[] = [];

export function setProjectFiles(files: string[]): void {
  activeProjectFiles = files;
}

export function getProjectFiles(): string[] {
  return activeProjectFiles;
}

export function getProjectImages(): string[] {
  const imageExtensions = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'pdf', 'gif'];
  return activeProjectFiles.filter((file) => {
    const ext = file.split('.').pop()?.toLowerCase();
    return ext && imageExtensions.includes(ext);
  });
}

export function getProjectBibFiles(): string[] {
  return activeProjectFiles.filter((file) => file.endsWith('.bib'));
}

export function getProjectClsFiles(): string[] {
  return activeProjectFiles.filter((file) => file.endsWith('.cls'));
}

export function getProjectStyFiles(): string[] {
  return activeProjectFiles.filter((file) => file.endsWith('.sty'));
}

export function getProjectSubfiles(engine: 'latex' | 'typst'): string[] {
  const ext = engine === 'typst' ? '.typ' : '.tex';
  return activeProjectFiles.filter((file) => file.endsWith(ext));
}

/**
 * Registry of custom macros extracted from project .cls, .sty, and secondary files.
 */
let projectCustomCommands = new Set<string>();

export function setProjectCustomCommands(commands: Set<string>): void {
  projectCustomCommands = commands;
}

export function getProjectCustomCommands(): Set<string> {
  return projectCustomCommands;
}

/**
 * Extracts macro names from LaTeX class (.cls), style (.sty), or source files.
 * Recognizes \newcommand, \renewcommand, \providecommand, \DeclareRobustCommand,
 * LaTeX3 \(New|Renew|Provide|Declare)DocumentCommand, \def, and \let definitions.
 */
export function extractMacrosFromSource(source: string): string[] {
  const discovered = new Set<string>();

  // 1. \newcommand{\foo}, \DeclareRobustCommand{\foo}, \NewDocumentCommand{\foo}
  const bracketRegex = /\\(?:(?:re|provide)?newcommand|DeclareRobustCommand|(?:New|Renew|Provide|Declare)DocumentCommand)\*?\s*\{?\\([a-zA-Z]+)\}?/g;
  let match: RegExpExecArray | null;
  while ((match = bracketRegex.exec(source)) !== null) {
    if (match[1]) discovered.add(match[1]);
  }

  // 2. \def\foo, \let\foo, \newcommand\foo
  const defRegex = /\\(?:def|let|(?:(?:re|provide)?newcommand|DeclareRobustCommand)\*?)\s*\\([a-zA-Z]+)/g;
  while ((match = defRegex.exec(source)) !== null) {
    if (match[1]) discovered.add(match[1]);
  }

  // 3. \newif\iffoo -> defines \iffoo, \footrue, \foofalse
  const newifRegex = /\\newif\s*\\if([a-zA-Z]+)/g;
  while ((match = newifRegex.exec(source)) !== null) {
    if (match[1]) {
      discovered.add(`if${match[1]}`);
      discovered.add(`${match[1]}true`);
      discovered.add(`${match[1]}false`);
    }
  }

  return Array.from(discovered);
}
