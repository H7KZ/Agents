import { spawnSync } from 'node:child_process';

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

export function spawnRunner(args: string[], cwd: string): RunResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return { status: result.status, stdout: result.stdout ?? '' };
}

function nulList(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '');
}

export function createGit(run: Runner): Git {
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
    currentBranch: (cwd) => memo(`branch\0${cwd}`, () => text(['symbolic-ref', '--short', '-q', 'HEAD'], cwd)),
    defaultBranch: (cwd, remote) =>
      memo(`default\0${cwd}\0${remote}`, () => {
        const ref = text(['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`], cwd);
        return ref === null ? null : ref.replace(`${remote}/`, '');
      }),
    isDirty: (cwd) => memo(`dirty\0${cwd}`, () => text(['status', '--porcelain'], cwd) !== null),
    stagedFiles: (cwd) => memo(`staged\0${cwd}`, () => list(['diff', '--cached', '--name-only', '--diff-filter=d', '-z'], cwd)),
    modifiedFiles: (cwd) => memo(`modified\0${cwd}`, () => list(['diff', '--name-only', '--relative', '--diff-filter=d', '-z'], cwd)),
    untrackedFiles: (cwd) => memo(`untracked\0${cwd}`, () => list(['ls-files', '--others', '--exclude-standard', '-z'], cwd)),
  };
}
