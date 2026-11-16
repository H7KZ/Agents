import { spawnRunner, type Runner } from './git.ts';

export type FileKind = 'source' | 'test' | 'other';

export interface ScopeFile {
  path: string;
  kind: FileKind;
  /** Changed (added or modified) line ranges in the working tree, inclusive, 1-based. */
  ranges: Array<[number, number]>;
  /** Untracked file: every line counts as changed. */
  whole: boolean;
}

export interface Scope {
  base: string;
  mergeBase: string;
  files: ScopeFile[];
  /** Things that weaken the scope but did not stop it (for example no merge base). */
  warnings: string[];
}

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|cs|rb|php|swift|c|h|cc|cpp|hpp)$/i;
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\//i;
const TEST_FILE = /(?:\.(?:test|spec|e2e)\.[^/.]+$|_test\.[^/.]+$|(?:^|\/)test_[^/]+$|Tests?\.[^/.]+$)/;

export function classify(path: string): FileKind {
  if (TEST_DIR.test(path) || TEST_FILE.test(path)) return 'test';
  return SOURCE_EXT.test(path) ? 'source' : 'other';
}

/** Added or modified line ranges per file from `git diff --unified=0`. Deleted files and pure deletions yield nothing. */
export function parseDiff(diff: string): Map<string, Array<[number, number]>> {
  const files = new Map<string, Array<[number, number]>>();
  let current: Array<[number, number]> | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a hunk the leading character is data: a added line `++ b/x` looks like a file header.
      const lead = line[0];
      if (lead === '-') oldLeft--;
      else if (lead === '+') newLeft--;
      else if (lead === ' ') {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = unquote(line.slice(4));
      current = null;
      if (target !== '/dev/null') {
        const path = target.replace(/^b\//, '');
        current = files.get(path) ?? [];
        files.set(path, current);
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null) continue;
    const start = Number(hunk[2]);
    oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
    newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    if (current !== null && newLeft > 0) current.push([start, start + newLeft - 1]);
  }
  return files;
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** A path as git prints it in a header: plain (maybe tab-terminated) or C-style quoted with octal bytes. */
export function unquote(token: string): string {
  if (!token.startsWith('"')) return token.replace(/\t.*$/, '');
  const chunks: Buffer[] = [];
  for (const m of token.slice(1, -1).matchAll(/\\([0-7]{3})|\\(.)|([^\\]+)/gs)) {
    if (m[1] !== undefined) chunks.push(Buffer.from([parseInt(m[1], 8)]));
    else if (m[2] !== undefined) chunks.push(Buffer.from(ESCAPES[m[2]] === undefined ? m[2] : [ESCAPES[m[2]] as number]));
    else chunks.push(Buffer.from(m[3] as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'];

function ok(run: Runner, cwd: string, args: string[]): string | null {
  const result = run(args, cwd);
  return result.status === 0 ? result.stdout : null;
}

/** Files changed against `base` (committed, staged, unstaged and untracked), with changed line ranges. Throws when git cannot answer. */
export function computeScope(run: Runner, startDir: string, base?: string): Scope {
  if (base?.startsWith('-')) throw new Error(`base ${base} looks like an option; pass --base <ref>`);
  const cwd = (ok(run, startDir, ['rev-parse', '--show-toplevel']) ?? '').trim();
  if (cwd === '') throw new Error('not inside a git repository');
  const resolved = base ?? CANDIDATES.find((name) => ok(run, cwd, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]) !== null);
  if (resolved === undefined) throw new Error('no base branch found (tried origin/main, origin/master, main, master); pass --base <ref>');
  if (ok(run, cwd, ['rev-parse', '--verify', '--quiet', `${resolved}^{commit}`]) === null) throw new Error(`base ${resolved} is not a commit; pass --base <ref>`);
  const found = ok(run, cwd, ['merge-base', 'HEAD', resolved]);
  const warnings = found === null ? [`no merge base between HEAD and ${resolved}; diffing against ${resolved} itself`] : [];
  const mergeBase = (found ?? resolved).trim();
  const diff = ok(run, cwd, ['-c', 'core.quotepath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', mergeBase]);
  if (diff === null) throw new Error('git diff failed; cannot compute the change scope');
  const untracked = ok(run, cwd, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z']);
  if (untracked === null) throw new Error('git ls-files failed; cannot compute the change scope');
  const files = new Map<string, ScopeFile>();
  for (const [path, ranges] of parseDiff(diff)) files.set(path, { path, kind: classify(path), ranges, whole: false });
  for (const path of untracked.split('\0').filter((p) => p !== '')) files.set(path, { path, kind: classify(path), ranges: [], whole: true });
  return { base: resolved, mergeBase, files: [...files.values()].sort((a, b) => Number(a.path > b.path) - Number(a.path < b.path)), warnings };
}

const USAGE = 'usage: verify-scope.ts [--base <ref>]';

export function main(argv: string[], out: (text: string) => void, err: (text: string) => void, cwd: string = process.cwd(), run: Runner = spawnRunner): number {
  const flag = argv.indexOf('--base');
  const base = flag === -1 ? undefined : argv[flag + 1];
  if (argv.length !== (flag === -1 ? 0 : 2) || (flag !== -1 && (base === undefined || base.startsWith('-')))) {
    err(USAGE);
    return 2;
  }
  try {
    out(JSON.stringify(computeScope(run, cwd, base)));
    return 0;
  } catch (error) {
    err((error as Error).message);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t));
}
