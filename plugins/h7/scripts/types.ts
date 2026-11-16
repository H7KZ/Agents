import type { Git } from './git.ts';
import type { Disk } from './gitfiles.ts';
import type { Paths } from './paths.ts';

export interface Decision {
  decision: 'block' | 'ask';
  rule: string;
  reason: string;
}

export interface TempInfo {
  /** Canonical temporary directories; deletes strictly inside them are allowed. */
  dirs: string[];
}

export interface Ctx {
  cwd: string;
  home: string;
  paths: Paths;
  git: Git;
  disk: Disk;
  tmp: TempInfo;
}

/** What earlier commands in the same chain have already changed. */
export interface ScanState {
  cwd: string;
  /** Other directories the shell may be in after `cd x || ...`. */
  alt: string[];
  env: Record<string, string>;
  /** Current branch after `git checkout|switch`; null means unknown or detached. Undefined: ask git. */
  branch?: string | null;
  /** Set once an earlier command in the chain stashed, reset or committed tracked changes away. */
  trackedClean?: boolean;
  untrackedClean?: boolean;
  /** Paths added to the index earlier in the chain. */
  staged: string[];
  /** Git aliases defined earlier in the chain. */
  aliases: Record<string, string>;
}

export function newState(cwd: string, env: Record<string, string> = {}): ScanState {
  return { cwd, alt: [], env, staged: [], aliases: {} };
}

export function cloneState(state: ScanState): ScanState {
  return { ...state, alt: [...state.alt], env: { ...state.env }, staged: [...state.staged], aliases: { ...state.aliases } };
}

export function block(rule: string, reason: string): Decision {
  return { decision: 'block', rule, reason };
}

export function ask(rule: string, reason: string): Decision {
  return { decision: 'ask', rule, reason };
}
