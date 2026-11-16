import type { Runner } from './git.ts';

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  dirty: boolean;
  defaultBranch: { name: string; source: 'origin-head' | 'local-branch' } | null;
  /** Local and remote branch names that look protected. */
  protectedBranches: string[];
  remote: { url: string; host: string | null } | null;
  commitConvention: { kind: 'conventional' | 'other' | 'unknown'; sampled: number; matching: number; examples: string[] };
  /** Path of info/exclude relative to the repo root, when git can say. */
  excludePath: string | null;
}

const PROTECTED = /^(main|master|develop|development|dev|trunk|production|prod|staging|stable|release([/-].+)?)$/;
const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: \S/;
const SAMPLE = 30;
const MIN_SAMPLE = 3;
const THRESHOLD = 0.6;

/** Never print credentials embedded in a remote URL. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@\s]*@/, '//');
}

export function remoteHost(url: string): string | null {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?([^/:\s]+)[:/]/i.exec(url)?.[1] ?? null;
}

export function classifyCommits(subjects: string[]): GitInfo['commitConvention'] {
  const matching = subjects.filter((s) => CONVENTIONAL.test(s)).length;
  const kind = subjects.length < MIN_SAMPLE ? 'unknown' : matching / subjects.length >= THRESHOLD ? 'conventional' : 'other';
  return { kind, sampled: subjects.length, matching, examples: subjects.slice(0, 3) };
}

export function detectGit(root: string, run: Runner): GitInfo {
  const ask = (...args: string[]): string | null => {
    try {
      const r = run(args, root);
      return r.status === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  const lines = (...args: string[]): string[] => (ask(...args) ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (ask('rev-parse', '--show-toplevel') === null) {
    return { isRepo: false, branch: null, dirty: false, defaultBranch: null, protectedBranches: [], remote: null, commitConvention: classifyCommits([]), excludePath: null };
  }
  const branch = ask('branch', '--show-current') || null;
  const locals = lines('branch', '--format=%(refname:short)');
  const remotes = lines('branch', '-r', '--format=%(refname:short)').filter((n) => n.includes('/') && !n.endsWith('/HEAD')).map((n) => n.replace(/^[^/]+\//, ''));
  const originHead = ask('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  const local = ['main', 'master'].find((n) => locals.includes(n));
  const url = ask('remote', 'get-url', 'origin');
  return {
    isRepo: true,
    branch,
    dirty: (ask('status', '--porcelain') ?? '') !== '',
    defaultBranch: originHead ? { name: originHead.replace(/^origin\//, ''), source: 'origin-head' } : local ? { name: local, source: 'local-branch' } : null,
    protectedBranches: [...new Set([...locals, ...remotes])].filter((n) => PROTECTED.test(n)).sort(),
    remote: url ? { url: redactUrl(url), host: remoteHost(url) } : null,
    commitConvention: classifyCommits(lines('log', `-n${SAMPLE}`, '--format=%s')),
    excludePath: ask('rev-parse', '--git-path', 'info/exclude'),
  };
}
