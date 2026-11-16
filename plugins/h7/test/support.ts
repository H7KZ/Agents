import type { Disk } from '../scripts/gitfiles.ts';
import type { Git } from '../scripts/git.ts';
import { makePaths, type Platform } from '../scripts/paths.ts';
import { pickDecision, scan } from '../scripts/scan.ts';
import { newState, type Ctx, type Decision, type ScanState } from '../scripts/types.ts';
import type { Dialect } from '../scripts/tokenize.ts';

export interface FakeGitState {
  root?: string | null;
  branch?: string | null;
  defaultBranch?: string | null;
  dirty?: boolean;
  ignored?: string[];
  staged?: string[];
  modified?: string[];
  untracked?: string[];
}

export interface Calls {
  list: string[];
}

export function fakeGit(state: FakeGitState = {}, calls: Calls = { list: [] }): Git {
  const record = <T>(name: string, value: T): T => {
    calls.list.push(name);
    return value;
  };
  return {
    repoRoot: () => record('repoRoot', state.root === undefined ? '/repo' : state.root),
    currentBranch: () => record('currentBranch', state.branch === undefined ? 'feature' : state.branch),
    defaultBranch: () => record('defaultBranch', state.defaultBranch ?? null),
    trackedDirty: () => record('trackedDirty', state.dirty ?? false),
    stagedFiles: () => record('stagedFiles', state.staged ?? []),
    modifiedFiles: () => record('modifiedFiles', state.modified ?? []),
    untrackedFiles: () => record('untrackedFiles', state.untracked ?? []),
    ignoredFiles: () => record('ignoredFiles', state.ignored ?? []),
  };
}

export interface Options extends FakeGitState {
  platform?: Platform;
  cwd?: string;
  home?: string;
  dialect?: Dialect;
  calls?: Calls;
  /** Paths that exist on the fake disk, mapped to their text (use '' for plain files). */
  files?: Record<string, string>;
  tmpDirs?: string[];
  state?: Partial<ScanState>;
}

const slash = (p: string): string => p.split(String.fromCharCode(92)).join('/').replace(/^[A-Za-z]:/, '');

export function fakeDisk(files: Record<string, string> = {}): Disk {
  const norm = Object.fromEntries(Object.entries(files).map(([k, v]) => [slash(k), v]));
  return {
    kind: (p) => (slash(p) in norm ? 'file' : null),
    read: (p) => norm[slash(p)] ?? null,
  };
}

export function makeCtx(options: Options = {}): Ctx {
  const platform = options.platform ?? 'posix';
  const win = platform === 'win32';
  return {
    cwd: options.cwd ?? (win ? 'C:\\work\\repo' : '/repo'),
    home: options.home ?? (win ? 'C:\\Users\\me' : '/home/me'),
    paths: makePaths(platform, (p) => p),
    git: fakeGit({ root: options.root === undefined ? (win ? 'C:/work/repo' : '/repo') : options.root, ...options }, options.calls),
    disk: fakeDisk(options.files),
    taint: { home: false },
    tmp: { dirs: options.tmpDirs ?? [] },
  };
}

export function decide(command: string, options: Options = {}): Decision | null {
  const ctx = makeCtx(options);
  return pickDecision(scan(command, options.dialect ?? 'sh', ctx, { ...newState(ctx.cwd), ...options.state }));
}

export function ruleOf(command: string, options: Options = {}): string | null {
  const decision = decide(command, options);
  return decision === null ? null : `${decision.decision}:${decision.rule}`;
}

/** A disk where /repo is a git repository and nothing else exists. */
export const repoDisk: Disk = {
  kind: (p) => (p.split(String.fromCharCode(92)).join('/').endsWith('/repo/.git') ? 'dir' : null),
  read: () => null,
};
