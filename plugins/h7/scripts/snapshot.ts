import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './log.ts';
import type { Runner } from './git.ts';

export const BACKUP_PREFIX = 'refs/h7/backup/';
/** Backup refs kept; older ones are pruned after each snapshot. */
export const KEEP = 20;
/** Only names in the format this module writes are ever counted or pruned. */
export const BACKUP_NAME = /^refs\/h7\/backup\/\d{8}T\d{6}Z-\d{3}$/;

export interface SnapshotDeps {
  /** A git runner with room for `git add -A` on a big tree; takes an extra environment. */
  runner: Runner;
  now: () => Date;
  /** Removes the temporary index (best effort, never throws). */
  remove?: (path: string) => void;
  pid?: number;
}

export type SnapshotResult = { ok: true; ref: string } | { ok: false; reason: string };

const IDENTITY = {
  GIT_AUTHOR_NAME: 'h7 guard',
  GIT_AUTHOR_EMAIL: 'h7-guard@localhost',
  GIT_COMMITTER_NAME: 'h7 guard',
  GIT_COMMITTER_EMAIL: 'h7-guard@localhost',
};

export function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // a leftover temp file inside .git is harmless
  }
}

/** `YYYYMMDDTHHMMSSZ` in UTC. */
export function stamp(now: Date): string {
  return `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/**
 * Saves the worktree (tracked changes plus untracked, non-ignored files) as a commit on refs/h7/backup/<stamp>-<n>, using a temporary
 * index inside the git dir so neither the worktree nor the real index is touched. Any failing step returns ok:false and leaves nothing
 * the caller must trust: the guard then keeps its block rather than let unsnapshotted work be destroyed.
 */
export function takeSnapshot(root: string, command: string, deps: SnapshotDeps): SnapshotResult {
  const { runner, now } = deps;
  const remove = deps.remove ?? removeQuietly;
  let index = '';
  const attempt = (): SnapshotResult => {
    try {
      const gitDir = runner(['rev-parse', '--absolute-git-dir'], root);
      if (gitDir.status !== 0 || gitDir.stdout.trim() === '') return { ok: false, reason: 'cannot locate the git directory' };
      const head = runner(['rev-parse', '--verify', '-q', 'HEAD'], root);
      if (head.status !== 0) return { ok: false, reason: 'the repository has no commit to base a snapshot on' };
      const time = now();
      index = join(gitDir.stdout.trim(), `h7-snapshot-${deps.pid ?? process.pid}-${time.getTime()}.idx`);
      const env = { ...IDENTITY, GIT_INDEX_FILE: index };
      const step = (args: string[]): string | null => {
        const out = runner(args, root, env);
        return out.status === 0 ? out.stdout.trim() : null;
      };
      // Seed with HEAD so tracked files that are also gitignored are kept; add -A then records edits, deletions and new files.
      if (step(['read-tree', 'HEAD']) === null || step(['add', '-A']) === null) return { ok: false, reason: 'git could not stage the worktree into a temporary index' };
      const tree = step(['write-tree']);
      if (tree === null || tree === '') return { ok: false, reason: 'git write-tree failed' };
      const message = `h7 backup before: ${redact(command).replace(/\s+/g, ' ').slice(0, 200)}`;
      const commit = step(['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', 'HEAD', '-m', message]);
      if (commit === null || commit === '') return { ok: false, reason: 'git commit-tree failed' };
      const listed = runner(['for-each-ref', '--format=%(refname)', BACKUP_PREFIX], root);
      if (listed.status !== 0) return { ok: false, reason: 'cannot list existing backup refs' };
      const existing = listed.stdout.split('\n').filter((name) => BACKUP_NAME.test(name)).sort();
      const base = `${BACKUP_PREFIX}${stamp(time)}-`;
      const n = String(existing.filter((name) => name.startsWith(base)).length + 1).padStart(3, '0');
      const ref = `${base}${n}`;
      // The empty old value means "must not exist": a racing snapshot cannot be overwritten.
      if (runner(['update-ref', ref, commit, ''], root).status !== 0) return { ok: false, reason: 'git update-ref failed' };
      // Prune oldest first by stamp, keeping the newest KEEP including this one, and never the ref just created.
      for (const old of [...existing, ref].sort().slice(0, -KEEP)) if (old !== ref) runner(['update-ref', '-d', old], root);
      // A snapshot that does not resolve is no snapshot: the caller keeps its block.
      if (runner(['rev-parse', '--verify', '-q', ref + '^{commit}'], root).status !== 0) return { ok: false, reason: 'the new backup ref does not resolve' };
      return { ok: true, ref };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  };
  const result = attempt();
  if (index !== '') remove(index);
  return result;
}
