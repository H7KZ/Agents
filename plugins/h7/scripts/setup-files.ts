import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const BEGIN = '<!-- h7:begin -->';
export const END = '<!-- h7:end -->';
export const MAX_LINES = 150;

export type Status = 'created' | 'appended' | 'unchanged' | 'differs' | 'updated' | 'oversize';

export interface Result {
  status: Status;
  text: string;
  /** Existing block body when it differs from the new one. */
  existing?: string;
}

const lines = (text: string): number => text.replace(/\r?\n$/, '').split(/\r?\n/).length;
const eol = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');
const norm = (text: string): string => text.replace(/\r\n/g, '\n').trim();

function wrap(body: string, nl: string): string {
  return [BEGIN, ...norm(body).split('\n'), END].join(nl);
}

/**
 * Insert or update the marked h7 block. Content outside the markers is never touched.
 * Without `replace`, a differing block is reported (`differs`) and left alone.
 * A write that would leave the file over 150 lines (and longer than before) is refused (`oversize`).
 */
export function upsertBlock(existing: string | null, body: string, replace = false): Result {
  if (existing === null) return { status: 'created', text: `${wrap(body, '\n')}\n` };
  const nl = eol(existing);
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END, start + 1);
  let next: string;
  if (start !== -1 && end !== -1) {
    const current = existing.slice(start + BEGIN.length, end);
    if (norm(current) === norm(body)) return { status: 'unchanged', text: existing };
    if (!replace) return { status: 'differs', text: existing, existing: norm(current) };
    next = existing.slice(0, start) + wrap(body, nl) + existing.slice(end + END.length);
  } else {
    const base = existing === '' ? '' : (/\n$/.test(existing) ? existing : existing + nl) + nl;
    next = base + wrap(body, nl) + nl;
  }
  if (lines(next) > MAX_LINES && lines(next) > lines(existing)) return { status: 'oversize', text: existing };
  return { status: start !== -1 && end !== -1 ? 'updated' : 'appended', text: next };
}

/** Make sure CLAUDE.md contains a line `@AGENTS.md`; other content is kept. */
export function ensureImport(existing: string | null): Result {
  if (existing === null) return { status: 'created', text: '@AGENTS.md\n' };
  if (/^@AGENTS\.md\s*$/m.test(existing)) return { status: 'unchanged', text: existing };
  const nl = eol(existing);
  return { status: 'appended', text: `${existing}${existing === '' || /\n$/.test(existing) ? '' : nl}@AGENTS.md${nl}` };
}

/** Add `.h7/` to an info/exclude file. */
export function ensureExclude(existing: string | null): Result {
  if (existing === null) return { status: 'created', text: '.h7/\n' };
  if (/^\/?\.h7\/?\s*$/m.test(existing)) return { status: 'unchanged', text: existing };
  const nl = eol(existing);
  return { status: 'appended', text: `${existing}${existing === '' || /\n$/.test(existing) ? '' : nl}.h7/${nl}` };
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export type Lstat = (path: string) => { isSymbolicLink(): boolean } | null;

const safeLstat: Lstat = (path) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** Why a path must not be read or written, or null. Symlinks and anything resolving outside the repo root are refused. */
export function pathProblem(file: string, root: string, lstat: Lstat = safeLstat): string | null {
  const abs = resolve(root, file);
  if (lstat(abs)?.isSymbolicLink()) return `refusing symlink: ${file}`;
  let dir = dirname(abs);
  while (!existsSync(dir)) dir = dirname(dir);
  const rel = relative(realpathSync(root), realpathSync(dir));
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? `refusing path outside the repo: ${file}` : null;
}

/** Exclusive random temp file in the target directory, containment re-checked right before the rename. Throws on any refusal. */
export function writeAtomic(file: string, text: string, root: string, uuid: () => string = randomUUID, lstat: Lstat = safeLstat): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${uuid()}.h7tmp`;
  writeFileSync(temp, text, { flag: 'wx' });
  const problem = pathProblem(file, root, lstat);
  if (problem !== null) {
    unlinkSync(temp);
    throw new Error(problem);
  }
  try {
    renameSync(temp, file);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}

const USAGE = 'usage: setup-files.ts agents <file> <body-file> [--replace] [--write] | claude <file> [--write] | exclude <file> [--write]';

export function main(argv: string[], out: (text: string) => void, err: (text: string) => void, cwd: string = process.cwd()): number {
  const [cmd, file, bodyFile] = argv.filter((a) => !a.startsWith('--'));
  const flags = argv.filter((a) => a.startsWith('--'));
  if (file === undefined || (cmd === 'agents' && bodyFile === undefined) || !['agents', 'claude', 'exclude'].includes(cmd as string)) {
    err(USAGE);
    return 2;
  }
  for (const path of cmd === 'agents' ? [file, bodyFile as string] : [file]) {
    const problem = pathProblem(path, cwd);
    if (problem !== null) {
      err(problem);
      return 2;
    }
  }
  const existing = readOrNull(resolve(cwd, file));
  let result: Result;
  if (cmd === 'agents') {
    const body = readOrNull(resolve(cwd, bodyFile as string));
    if (body === null) {
      err(`cannot read ${bodyFile}`);
      return 2;
    }
    result = upsertBlock(existing, body, flags.includes('--replace'));
  } else {
    result = (cmd === 'claude' ? ensureImport : ensureExclude)(existing);
  }
  const changes = ['created', 'appended', 'updated'].includes(result.status);
  const written = changes && flags.includes('--write');
  if (written) {
    try {
      writeAtomic(resolve(cwd, file), result.text, cwd);
    } catch (error) {
      err((error as Error).message);
      return 2;
    }
  }
  out(JSON.stringify({ file, status: result.status, written, lines: lines(result.text), ...(result.existing === undefined ? {} : { existing: result.existing }) }));
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t));
}
