import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { isRunId, startIsUnattended } from './run-journal-core.ts';

/** Read-only view of the disk for the unattended check. `kind` is an lstat: a symlink is its own kind and is never followed. */
export interface Probe {
  kind(path: string): 'file' | 'dir' | 'link' | 'other' | null;
  /** At most `max` bytes from the start of a file, decoded as UTF-8; null when unreadable. */
  head(path: string, max: number): string | null;
}

export const HEAD_BYTES = 8192;
export const CURRENT_BYTES = 256;
/** Parent directories searched for `.h7/runs/CURRENT` (the hook's cwd may be a subdirectory). */
export const MAX_UP = 64;

/** A symlink is never followed; devices, pipes and sockets are 'other' and never read. */
export function classify(stat: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): 'file' | 'dir' | 'link' | 'other' {
  if (stat.isSymbolicLink()) return 'link';
  if (stat.isDirectory()) return 'dir';
  return stat.isFile() ? 'file' : 'other';
}

export const realProbe: Probe = {
  kind(path) {
    try {
      return classify(lstatSync(path));
    } catch {
      return null;
    }
  },
  head(path, max) {
    try {
      const fd = openSync(path, 'r');
      const buffer = Buffer.alloc(max);
      const length = readSync(fd, buffer, 0, max, 0);
      closeSync(fd);
      return buffer.toString('utf8', 0, length);
    } catch {
      return null;
    }
  },
};

function journalIsUnattended(runs: string, probe: Probe): boolean {
  const current = join(runs, 'CURRENT');
  const id = (probe.head(current, CURRENT_BYTES) ?? '').trim();
  if (!isRunId(id) || probe.kind(join(runs, id)) !== 'dir') return false;
  const journal = join(runs, id, 'journal.jsonl');
  if (probe.kind(journal) !== 'file') return false;
  const text = probe.head(journal, HEAD_BYTES) ?? '';
  const end = text.indexOf('\n');
  // A first line that does not fit in the bounded read is not a start event we wrote.
  if (end < 0 && Buffer.byteLength(text) >= HEAD_BYTES) return false;
  return startIsUnattended(end < 0 ? text : text.slice(0, end));
}

/**
 * True when H7_UNATTENDED=1 or the run `.h7/runs/CURRENT` points to (searched upward from cwd to the repository root) was started
 * with unattended: true. Reads only CURRENT and the first line of that journal, refuses symlinks on every part of the path, and answers
 * false (attended) for anything missing, corrupt or oversized: the check can only ever make the guard stricter, never weaker.
 */
export function isUnattended(env: Record<string, string | undefined>, cwd: string, probe: Probe = realProbe): boolean {
  if (env.H7_UNATTENDED === '1') return true;
  try {
    let dir = cwd;
    for (let step = 0; step < MAX_UP; step += 1) {
      const h7 = join(dir, '.h7');
      const runs = join(h7, 'runs');
      if (probe.kind(join(runs, 'CURRENT')) !== null) {
        return probe.kind(h7) === 'dir' && probe.kind(runs) === 'dir' && probe.kind(join(runs, 'CURRENT')) === 'file' && journalIsUnattended(runs, probe);
      }
      if (probe.kind(join(dir, '.git')) !== null) return false;
      const parent = join(dir, '..');
      if (parent === dir) return false;
      dir = parent;
    }
    return false;
  } catch {
    return false;
  }
}
