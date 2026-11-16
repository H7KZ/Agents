import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, isAbsolute, sep } from 'node:path';

/**
 * A pristine copy of a commit for the coverage baseline: `git archive <ref> | tar -x` into the OS temp dir. Nothing is created next to the repo
 * and no worktree metadata lands in its .git. `remove` only deletes directories this tool made (h7-base- prefix, directly inside the temp dir).
 */
export const PREFIX = 'h7-base-';

export type Spawn = (command: string, args: string[], cwd: string) => { status: number | null; stderr: string };

export const realSpawn: Spawn = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  return { status: result.status, stderr: result.stderr ?? '' };
};

export interface Env {
  spawn: Spawn;
  tmp: string;
  mkdtemp(prefix: string): string;
  rm(dir: string): void;
}

export const realEnv: Env = {
  spawn: realSpawn,
  tmp: tmpdir(),
  mkdtemp: (prefix) => mkdtempSync(prefix),
  rm: (dir) => rmSync(dir, { recursive: true, force: true }),
};

export function create(ref: string, cwd: string, env: Env = realEnv): string {
  if (ref === '' || ref.startsWith('-')) throw new Error(`bad ref: ${JSON.stringify(ref)}`);
  const dir = env.mkdtemp(join(env.tmp, PREFIX));
  const tar = `${dir}${sep}base.tar`;
  try {
    const archive = env.spawn('git', ['archive', '--format=tar', `--output=${tar}`, ref], cwd);
    if (archive.status !== 0) throw new Error(`git archive ${ref} failed: ${archive.stderr.trim()}`);
    const extract = env.spawn('tar', ['-xf', 'base.tar'], dir);
    if (extract.status !== 0) throw new Error(`tar failed: ${extract.stderr.trim()}`);
    env.rm(tar);
  } catch (error) {
    env.rm(dir);
    throw error;
  }
  return dir;
}

export function remove(dir: string, env: Env = realEnv, real: (p: string) => string = realpathSync): void {
  const target = real(dir);
  const rel = relative(real(env.tmp), dirname(target));
  if (!basename(target).startsWith(PREFIX) || rel !== '' || isAbsolute(rel)) throw new Error(`refusing to remove ${dir}: not an h7 baseline directory directly inside the temp dir`);
  env.rm(target);
}

const USAGE = 'usage: baseline-tree.ts create <ref> | remove <dir>';

export function main(argv: string[], out: (text: string) => void, err: (text: string) => void, cwd: string = process.cwd(), env: Env = realEnv): number {
  const [cmd, arg, ...rest] = argv;
  if ((cmd !== 'create' && cmd !== 'remove') || arg === undefined || rest.length > 0) {
    err(USAGE);
    return 2;
  }
  try {
    if (cmd === 'create') out(create(arg, cwd, env).split(sep).join('/'));
    else remove(arg, env);
    return 0;
  } catch (error) {
    err((error as Error).message);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t));
}
