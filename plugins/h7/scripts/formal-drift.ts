import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { spawnRunner, type Runner } from './git.ts';
import { findRoot } from './run-journal.ts';
import { isRunId } from './run-journal-core.ts';
import { pathProblem, writeAtomic } from './setup-files.ts';

export const KINDS = ['tla', 'statechart'] as const;
export type Kind = (typeof KINDS)[number];
export const MODEL_FILE = 'model.json';
export const DEFAULT_DIR = 'docs/formal';
export const MAX_GLOB = 200;
export const MAX_SOURCES = 100;

export interface Model {
  name: string;
  kind: Kind;
  /** The spec file (TLA+ module, or the statechart source). */
  spec: string;
  /** Optional TLC config next to the spec. */
  config?: string;
  /** The command that runs the check, from the repo root. */
  check: string;
  /** Globs of the code the model claims to describe. */
  sources: string[];
  /** Commit the model was last proven in sync with. */
  sync: string;
}

class Failure extends Error {}

/** A repo-relative forward-slash path or glob without traversal. Returns a problem or null. */
export function relativeProblem(value: unknown, what: string, glob: boolean): string | null {
  if (typeof value !== 'string' || value === '') return `${what} must be a non-empty string`;
  if (value.length > MAX_GLOB) return `${what} is longer than ${MAX_GLOB} characters`;
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').some((part) => part === '..' || part === '')) {
    return `${what} must be a repo-relative path with forward slashes and no '..': ${value}`;
  }
  if (glob && /[{}[\]!]/.test(value)) return `${what} may use only * ** and ? (no braces, classes or negation): ${value}`;
  return null;
}

/** Glob to regular expression: `*` and `?` stay inside a path segment, `**` crosses them, `**` followed by `/` may match no directory. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      i += 1;
      if (glob[i + 1] === '/') {
        i += 1;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export const matchesAny = (path: string, globs: RegExp[]): boolean => globs.some((glob) => glob.test(path));

/** Validates a model.json value; returns the model or every problem found. `dirName` is the directory the file sits in. */
export function parseModel(raw: unknown, dirName: string): { model: Model | null; errors: string[] } {
  const errors: string[] = [];
  const r = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (r.name !== dirName || !isRunId(dirName)) errors.push(`name must equal the directory name "${dirName}"`);
  if (!(KINDS as readonly string[]).includes(r.kind as string)) errors.push(`kind must be one of ${KINDS.join(', ')}`);
  const spec = relativeProblem(r.spec, 'spec', false);
  if (spec !== null) errors.push(spec);
  const config = r.config === undefined ? null : relativeProblem(r.config, 'config', false);
  if (config !== null) errors.push(config);
  if (typeof r.check !== 'string' || r.check.trim() === '') errors.push('check must be the non-empty command that runs the model');
  const sources = Array.isArray(r.sources) && r.sources.length > 0 && r.sources.length <= MAX_SOURCES ? r.sources : null;
  if (sources === null) errors.push(`sources must be a list of 1 to ${MAX_SOURCES} globs`);
  else errors.push(...sources.map((glob, i) => relativeProblem(glob, `sources[${i}]`, true)).filter((p): p is string => p !== null));
  if (typeof r.sync !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(r.sync)) errors.push('sync must be a full lowercase commit hash');
  return errors.length > 0 ? { model: null, errors } : { model: r as unknown as Model, errors };
}

export interface Change {
  path: string;
  /** Git status letter: A, M, D, R, C, T. */
  status: string;
  from?: string;
}

/** `git diff --name-status -z` output. Renames and copies carry the old path in `from`. */
export function parseNameStatus(stdout: string): Change[] {
  const parts = stdout.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i] as string;
    if (status === '') {
      i += 1;
      continue;
    }
    const letter = status.slice(0, 1);
    if (letter === 'R' || letter === 'C') {
      changes.push({ status: letter, from: parts[i + 1] as string, path: parts[i + 2] as string });
      i += 3;
    } else {
      changes.push({ status: letter, path: parts[i + 1] as string });
      i += 2;
    }
  }
  return changes;
}

/** Changes that touch a covered file, by its new or its old path. */
export function coveredChanges(changes: Change[], globs: RegExp[]): Change[] {
  return changes.filter((change) => matchesAny(change.path, globs) || (change.from !== undefined && matchesAny(change.from, globs)));
}

export type Status = 'in-sync' | 'drifted' | 'unknown-sync' | 'invalid';

export interface Report {
  name: string;
  status: Status;
  kind?: Kind;
  spec?: string;
  check?: string;
  sync?: string;
  /** Changes to covered files since the sync commit (committed, uncommitted and untracked). */
  changes: Change[];
  /** The spec, its config or model.json changed since the sync commit. */
  modelEdited: boolean;
  errors: string[];
}

const nul = (stdout: string): string[] => stdout.split('\0').filter((entry) => entry !== '');

export interface Repo {
  root: string;
  run: Runner;
}

function git(repo: Repo, args: string[]): string {
  const result = repo.run(args, repo.root);
  if (result.status !== 0) throw new Failure(`git ${args[0]} failed`);
  return result.stdout;
}

const safeLstat = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

export interface Found {
  name: string;
  file: string;
  raw: unknown;
  readError: string | null;
}

/** Model files one level below `dir` (`<dir>/<name>/model.json`); links are never followed. */
export function findModels(root: string, dir: string): Found[] {
  const base = join(root, dir);
  if (safeLstat(base)?.isDirectory() !== true) return [];
  const found: Found[] = [];
  for (const name of readdirSync(base).sort()) {
    const file = join(base, name, MODEL_FILE);
    const entry = safeLstat(join(base, name)) as Stats; // listed a moment ago; a vanished entry surfaces as an error
    if (!entry.isSymbolicLink() && !entry.isDirectory()) continue;
    const stat = safeLstat(file);
    let raw: unknown = null;
    let readError: string | null = null;
    if (entry.isSymbolicLink()) readError = 'model directory is a symlink: not followed';
    else if (stat === null) readError = `${MODEL_FILE} is missing`;
    else if (stat.isSymbolicLink() || !stat.isFile()) readError = `${MODEL_FILE} is not a regular file`;
    else {
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        readError = `${MODEL_FILE} is not valid JSON`;
      }
    }
    found.push({ name, file: posix.join(dir, name, MODEL_FILE), raw, readError });
  }
  return found;
}

/** Drift report for every model under `dir`. Throws only when git cannot answer. */
export function checkModels(repo: Repo, dir: string, found: Found[]): Report[] {
  const valid = found.map((f) => ({ f, ...(f.readError === null ? parseModel(f.raw, f.name) : { model: null, errors: [f.readError] }) }));
  if (!valid.some((v) => v.model !== null)) return valid.map((v) => ({ name: v.f.name, status: 'invalid', changes: [], modelEdited: false, errors: v.errors }));
  const tracked = nul(git(repo, ['ls-files', '-z']));
  const untracked = nul(git(repo, ['ls-files', '-z', '--others', '--exclude-standard']));
  return valid.map(({ f, model, errors }): Report => {
    if (model === null) return { name: f.name, status: 'invalid', changes: [], modelEdited: false, errors };
    const globs = model.sources.map(globToRegExp);
    const empty = model.sources.filter((_, i) => !tracked.some((path) => (globs[i] as RegExp).test(path)));
    const base = { name: model.name, kind: model.kind, spec: model.spec, check: model.check, sync: model.sync, changes: [], modelEdited: false };
    if (empty.length > 0) return { ...base, status: 'invalid', errors: empty.map((glob) => `sources glob matches no tracked file (typo, or the code moved): ${glob}`) };
    if (repo.run(['cat-file', '-e', `${model.sync}^{commit}`], repo.root).status !== 0) {
      return { ...base, status: 'unknown-sync', errors: ['the sync commit is not in this repository: rerun the check, update the model from the code, then stamp'] };
    }
    const changes = [
      ...parseNameStatus(git(repo, ['diff', '--name-status', '-z', '-M', '--no-textconv', '--no-ext-diff', model.sync, '--'])),
      ...untracked.map((path): Change => ({ status: 'A', path })),
    ];
    const own = [model.spec, model.config ?? model.spec, join(dir, model.name, MODEL_FILE).split('\\').join('/')];
    const covered = coveredChanges(changes, globs);
    return {
      ...base,
      status: covered.length > 0 ? 'drifted' : 'in-sync',
      changes: covered,
      modelEdited: changes.some((change) => own.includes(change.path)),
      errors: [],
    };
  });
}

/** Exit code: 2 any invalid model, 1 drift, unknown sync or no model at all (nothing checked is not in sync), else 0. */
export function overall(reports: Report[]): number {
  if (reports.length === 0) return 1;
  if (reports.some((r) => r.status === 'invalid')) return 2;
  return reports.every((r) => r.status === 'in-sync') ? 0 : 1;
}

/** `model.json` with `sync` replaced, same key order, two-space indent. */
export function stampedText(raw: unknown, sync: string): string {
  return `${JSON.stringify({ ...(raw as Record<string, unknown>), sync }, null, 2)}\n`;
}

const USAGE = ['usage: formal-drift.ts check [--dir <dir>]', '       formal-drift.ts stamp <name> [--dir <dir>]'].join('\n');

export interface Env {
  out(text: string): void;
  err(text: string): void;
  cwd: string;
  run: Runner;
}

export function main(argv: string[], env: Env): number {
  try {
    const [cmd, ...args] = argv;
    let dir = DEFAULT_DIR;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] as string;
      if (arg === '--dir' && args[i + 1] !== undefined) {
        dir = args[i + 1] as string;
        i += 1;
      } else if (arg.startsWith('--')) throw new Failure(`unknown option or missing value: ${arg}\n${USAGE}`);
      else rest.push(arg);
    }
    if ((cmd !== 'check' || rest.length > 0) && (cmd !== 'stamp' || rest.length !== 1)) throw new Failure(USAGE);
    const root = findRoot(env.cwd, { lstat: safeLstat });
    if (root === null) throw new Failure('not inside a git repository');
    const dirProblem = relativeProblem(dir, '--dir', false) ?? pathProblem(dir, root);
    if (dirProblem !== null) throw new Failure(dirProblem);
    const repo: Repo = { root, run: env.run };
    const found = findModels(root, dir);
    if (cmd === 'check') {
      const reports = checkModels(repo, dir, found);
      env.out(JSON.stringify({ dir, ...(reports.length === 0 ? { status: 'no-models' } : {}), head: reports.length === 0 ? null : git(repo, ['rev-parse', 'HEAD']).trim(), models: reports }));
      return overall(reports);
    }
    const [name] = rest as [string];
    const target = found.find((f) => f.name === name);
    if (target === undefined) throw new Failure(`no such model: ${name}`);
    const [report] = checkModels(repo, dir, [target]) as [Report];
    if (report.status === 'invalid') throw new Failure(`model ${name} is invalid: ${report.errors.join('; ')}`);
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    writeAtomic(resolve(root, target.file), stampedText(target.raw, head), root);
    env.out(JSON.stringify({ name, previous: report.sync, sync: head, file: target.file }));
    return 0;
  } catch (error) {
    env.err(error instanceof Failure ? error.message : `formal-drift failed: ${(error as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t), cwd: process.cwd(), run: spawnRunner });
}
