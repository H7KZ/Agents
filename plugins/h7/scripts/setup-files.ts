import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

const USAGE = 'usage: setup-files.ts agents <file> <body-file> [--replace] [--write] | claude <file> [--write] | exclude <file> [--write]';

export function main(argv: string[], out: (text: string) => void, err: (text: string) => void): number {
  const [cmd, file, bodyFile] = argv.filter((a) => !a.startsWith('--'));
  const flags = argv.filter((a) => a.startsWith('--'));
  if (file === undefined || (cmd === 'agents' && bodyFile === undefined) || !['agents', 'claude', 'exclude'].includes(cmd as string)) {
    err(USAGE);
    return 2;
  }
  const existing = readOrNull(file);
  let result: Result;
  if (cmd === 'agents') {
    const body = readOrNull(bodyFile as string);
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
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, result.text);
  }
  out(JSON.stringify({ file, status: result.status, written, lines: lines(result.text), ...(result.existing === undefined ? {} : { existing: result.existing }) }));
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t));
}
