import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';

const created: string[] = [];

export function tmpDir(prefix = 'h7-test-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export function cleanupTmp(): void {
  after(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runNode(script: string, args: string[], options: { input?: string; env?: Record<string, string | undefined>; cwd?: string } = {}): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    input: options.input ?? '',
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

export function initRepo(dir: string): string {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export const MUTATION = process.env.H7_MUTATION === '1';

export const SLOW = MUTATION ? { skip: 'skipped in mutation runs (spawns processes)' } : {};

export function runs(full: number): number {
  return MUTATION ? 20 : full;
}
