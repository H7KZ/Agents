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
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/\t.*$/, '');
      current = null;
      if (target !== '/dev/null') {
        const path = target.replace(/^b\//, '');
        current = files.get(path) ?? [];
        files.set(path, current);
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null || current === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) current.push([start, start + count - 1]);
  }
  return files;
}

const CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'];

function ok(run: Runner, cwd: string, args: string[]): string | null {
  const result = run(args, cwd);
  return result.status === 0 ? result.stdout : null;
}

/** Files changed against `base` (committed, staged, unstaged and untracked), with changed line ranges. Throws when git cannot answer. */
export function computeScope(run: Runner, cwd: string, base?: string): Scope {
  const resolved = base ?? CANDIDATES.find((name) => ok(run, cwd, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]) !== null);
  if (resolved === undefined) throw new Error('no base branch found (tried origin/main, origin/master, main, master); pass --base <ref>');
  if (ok(run, cwd, ['rev-parse', '--verify', '--quiet', `${resolved}^{commit}`]) === null) throw new Error(`base ${resolved} is not a commit; pass --base <ref>`);
  const mergeBase = (ok(run, cwd, ['merge-base', 'HEAD', resolved]) ?? resolved).trim();
  const diff = ok(run, cwd, ['-c', 'core.quotepath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', mergeBase]);
  if (diff === null) throw new Error('git diff failed; cannot compute the change scope');
  const untracked = ok(run, cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked === null) throw new Error('git ls-files failed; cannot compute the change scope');
  const files = new Map<string, ScopeFile>();
  for (const [path, ranges] of parseDiff(diff)) files.set(path, { path, kind: classify(path), ranges, whole: false });
  for (const path of untracked.split('\0').filter((p) => p !== '')) files.set(path, { path, kind: classify(path), ranges: [], whole: true });
  return { base: resolved, mergeBase, files: [...files.values()].sort((a, b) => Number(a.path > b.path) - Number(a.path < b.path)) };
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
