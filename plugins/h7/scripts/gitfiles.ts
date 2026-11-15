import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface Disk {
  kind(path: string): 'dir' | 'file' | null;
  read(path: string): string | null;
}

export const realDisk: Disk = {
  kind(path) {
    try {
      return statSync(path).isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  },
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
};

export interface GitDirs {
  gitDir: string;
  commonDir: string;
}

export function findGitDirs(start: string, disk: Disk = realDisk): GitDirs | null {
  let dir = resolve(start);
  for (;;) {
    const dotGit = join(dir, '.git');
    const kind = disk.kind(dotGit);
    if (kind === 'dir') return withCommon(dotGit, disk);
    if (kind === 'file') {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(String(disk.read(dotGit)));
      if (pointer) return withCommon(isAbsolute(pointer[1] as string) ? (pointer[1] as string) : resolve(dir, pointer[1] as string), disk);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function withCommon(gitDir: string, disk: Disk): GitDirs {
  const common = disk.read(join(gitDir, 'commondir'))?.trim();
  return { gitDir, commonDir: common === undefined || common === '' ? gitDir : resolve(gitDir, common) };
}

function symbolicRef(text: string | null): string | null {
  const match = /^ref:\s*(\S+)/.exec(text ?? '');
  return match ? (match[1] as string) : null;
}

export function currentBranchOnDisk(start: string, disk: Disk = realDisk): string | null {
  const dirs = findGitDirs(start, disk);
  const ref = dirs === null ? null : symbolicRef(disk.read(join(dirs.gitDir, 'HEAD')));
  return ref !== null && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

export function remoteHeadOnDisk(start: string, remote: string, disk: Disk = realDisk): string | null {
  const dirs = findGitDirs(start, disk);
  if (dirs === null || !/^[\w.-]+$/.test(remote)) return null;
  const ref = symbolicRef(disk.read(join(dirs.commonDir, 'refs', 'remotes', remote, 'HEAD')));
  const prefix = `refs/remotes/${remote}/`;
  return ref !== null && ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}
