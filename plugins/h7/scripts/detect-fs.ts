import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/** Directories that never hold project sources worth scanning. */
export const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', '.nuxt', '.output', '.turbo', '.nx', '.venv', 'venv', 'dist', 'build', 'target', 'vendor', 'coverage',
  '__pycache__', '.stryker-tmp', '.h7', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle', 'out',
]);

export interface Limits {
  maxDepth: number;
  maxFiles: number;
}

export const DEFAULT_LIMITS: Limits = { maxDepth: 4, maxFiles: 20000 };

export type ReadDir = (dir: string) => Dirent[];

export interface Repo {
  root: string;
  /** Files relative to root, forward slashes, sorted per directory. */
  files: string[];
  truncated: boolean;
  read(rel: string): string | null;
  has(rel: string): boolean;
}

const defaultReadDir: ReadDir = (dir) => readdirSync(dir, { withFileTypes: true });

/** Bounded, deterministic directory walk. Unreadable directories are skipped. */
export function openRepo(root: string, limits: Limits = DEFAULT_LIMITS, readDir: ReadDir = defaultReadDir): Repo {
  const files: string[] = [];
  let truncated = false;
  const walk = (rel: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readDir(join(root, rel));
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (!entry.isDirectory()) {
        if (files.length >= limits.maxFiles) {
          truncated = true;
          return;
        }
        files.push(path);
      } else if (!SKIP_DIRS.has(entry.name) && depth < limits.maxDepth) walk(path, depth + 1);
    }
  };
  walk('', 0);
  const set = new Set(files);
  return {
    root,
    files,
    truncated,
    has: (rel) => set.has(rel),
    read(rel) {
      try {
        return readFileSync(join(root, rel), 'utf8');
      } catch {
        return null;
      }
    },
  };
}
