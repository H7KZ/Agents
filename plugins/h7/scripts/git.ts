import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { statSync } from 'node:fs';
import { currentBranchOnDisk, findGitDirs, realDisk, remoteHeadOnDisk, type Disk } from './gitfiles.ts';

export interface RunResult {
  status: number | null;
  stdout: string;
}

export type Runner = (args: string[], cwd: string) => RunResult;

export interface Git {
  /** Repository top level, or null when cwd is not inside a repository. Throws when git cannot answer. */
  repoRoot(cwd: string): string | null;
  currentBranch(cwd: string): string | null;
  defaultBranch(cwd: string, remote: string): string | null;
  /** Tracked files with staged or unstaged changes (untracked files do not count). */
  trackedDirty(cwd: string): boolean;
  /** The lists below are relative to the repository root and are empty outside a repository. */
  stagedFiles(cwd: string): string[];
  modifiedFiles(cwd: string): string[];
  untrackedFiles(cwd: string): string[];
  ignoredFiles(cwd: string): string[];
}

const SAFE_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', `core.hooksPath=${devNull}`, '-c', 'protocol.ext.allow=never'];

export function resolveGitPath(pathEnv: string, isFile: (path: string) => boolean): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    for (const name of ['git.exe', 'git']) {
      const candidate = join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function hardenedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

export function makeSpawnRunner(executable: string | null, baseEnv: NodeJS.ProcessEnv = process.env, spawn: typeof spawnSync = spawnSync): Runner {
  return (args, cwd) => {
    if (executable === null) return { status: null, stdout: '' };
    const result = spawn(executable, [...SAFE_ARGS, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: hardenedEnv(baseEnv),
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new Error(`git ${args[0]} timed out`);
    return { status: result.status, stdout: result.stdout ?? '' };
  };
}

export const spawnRunner: Runner = makeSpawnRunner(resolveGitPath(String(process.env.PATH), isFile));

function nulList(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '');
}

/** Any failure to get an answer from git throws, so the guard asks instead of treating the repo as clean. */
export function createGit(run: Runner, disk: Disk = realDisk): Git {
  const cache = new Map<string, unknown>();
  const memo = <T>(parts: string[], compute: () => T): T => {
    const key = JSON.stringify(parts);
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key) as T;
  };
  const exec = (args: string[], cwd: string): string => {
    const result = run(args, cwd);
    if (result.status !== 0) throw new Error(`git ${args[0]} failed (status ${result.status}); cannot inspect the repository`);
    return result.stdout;
  };
  const repoRoot = (cwd: string): string | null =>
    memo(['root', cwd], () => {
      if (findGitDirs(cwd, disk) === null) return null;
      const root = exec(['rev-parse', '--show-toplevel'], cwd).trim();
      if (root === '') throw new Error('git rev-parse returned no repository root');
      return root;
    });
  const inRoot = <T>(name: string, cwd: string, empty: T, compute: (root: string) => T): T =>
    memo([name, cwd], () => {
      const root = repoRoot(cwd);
      return root === null ? empty : compute(root);
    });
  const list = (args: string[]) => (cwd: string): string[] => inRoot(args.join(' '), cwd, [], (root) => nulList(exec(args, root)));

  return {
    repoRoot,
    currentBranch: (cwd) => memo(['branch', cwd], () => currentBranchOnDisk(cwd, disk)),
    defaultBranch: (cwd, remote) => memo(['default', cwd, remote], () => remoteHeadOnDisk(cwd, remote, disk)),
    trackedDirty: (cwd) => inRoot('dirty', cwd, false, (root) => exec(['status', '--porcelain', '--untracked-files=no'], root).trim() !== ''),
    stagedFiles: list(['diff', '--cached', '--name-only', '--diff-filter=d', '-z']),
    modifiedFiles: list(['diff', '--name-only', '--diff-filter=d', '-z']),
    untrackedFiles: list(['ls-files', '--others', '--exclude-standard', '-z']),
    ignoredFiles: list(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']),
  };
}
