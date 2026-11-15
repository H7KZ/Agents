import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { statSync } from 'node:fs';
import { currentBranchOnDisk, realDisk, remoteHeadOnDisk, type Disk } from './gitfiles.ts';

export interface RunResult {
  status: number | null;
  stdout: string;
}

export type Runner = (args: string[], cwd: string) => RunResult;

export interface Git {
  repoRoot(cwd: string): string | null;
  currentBranch(cwd: string): string | null;
  defaultBranch(cwd: string, remote: string): string | null;
  isDirty(cwd: string): boolean;
  stagedFiles(cwd: string): string[];
  modifiedFiles(cwd: string): string[];
  untrackedFiles(cwd: string): string[];
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

export function makeSpawnRunner(executable: string | null, baseEnv: NodeJS.ProcessEnv = process.env): Runner {
  return (args, cwd) => {
    if (executable === null) return { status: null, stdout: '' };
    const result = spawnSync(executable, [...SAFE_ARGS, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: hardenedEnv(baseEnv),
    });
    return { status: result.status, stdout: result.stdout ?? '' };
  };
}

export const spawnRunner: Runner = makeSpawnRunner(resolveGitPath(String(process.env.PATH), isFile));

function nulList(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '');
}

export function createGit(run: Runner, disk: Disk = realDisk): Git {
  const cache = new Map<string, unknown>();
  const memo = <T>(key: string, compute: () => T): T => {
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key) as T;
  };
  const text = (args: string[], cwd: string): string | null => {
    const result = run(args, cwd);
    const out = result.stdout.trim();
    return result.status === 0 && out !== '' ? out : null;
  };
  const list = (args: string[], cwd: string): string[] => {
    const result = run(args, cwd);
    return result.status === 0 ? nulList(result.stdout) : [];
  };

  return {
    repoRoot: (cwd) => memo(`root\0${cwd}`, () => text(['rev-parse', '--show-toplevel'], cwd)),
    currentBranch: (cwd) => memo(`branch|${cwd}`, () => currentBranchOnDisk(cwd, disk)),
    defaultBranch: (cwd, remote) => memo(`default|${cwd}|${remote}`, () => remoteHeadOnDisk(cwd, remote, disk)),
    isDirty: (cwd) => memo(`dirty\0${cwd}`, () => text(['status', '--porcelain'], cwd) !== null),
    stagedFiles: (cwd) => memo(`staged\0${cwd}`, () => list(['diff', '--cached', '--name-only', '--diff-filter=d', '-z'], cwd)),
    modifiedFiles: (cwd) => memo(`modified\0${cwd}`, () => list(['diff', '--name-only', '--relative', '--diff-filter=d', '-z'], cwd)),
    untrackedFiles: (cwd) => memo(`untracked\0${cwd}`, () => list(['ls-files', '--others', '--exclude-standard', '-z'], cwd)),
  };
}
