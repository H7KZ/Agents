import type { Git } from './git.ts';
import type { Disk } from './gitfiles.ts';
import type { Paths } from './paths.ts';

export interface Decision {
  decision: 'block' | 'ask';
  rule: string;
  reason: string;
  /** The directory the command acts in, resolved per call (-C and cd included); absent when it cannot be trusted. */
  dir?: string;
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
  /** Shared and sticky: set once HOME or USERPROFILE is mentioned anywhere, so ~ cannot be trusted. */
  taint: { home: boolean };
  tmp: TempInfo;
}

/** What earlier commands in the same chain have already changed. */
export interface ScanState {
  cwd: string;
  /** True after a cd whose target could not be resolved; relative deletes and cwd-dependent git ask. */
  cwdUnknown?: boolean;
  /** Other directories the shell may be in after `cd x || ...`. */
  alt: string[];
  env: Record<string, string>;
  /** Current branch after `git checkout|switch`; null means unknown or detached. Undefined: ask git. */
  branch?: string | null;
  /** Set once an earlier command in the chain stashed, reset or committed tracked changes away. */
  trackedClean?: boolean;
  untrackedClean?: boolean;
  /** The repository root the two flags above were learned in; another repository in the same chain is asked about again. */
  cleanRoot?: string | null;
  /** Paths added to the index earlier in the chain. */
  staged: string[];
  /** Git aliases defined earlier in the chain. */
  aliases: Record<string, string>;
}

export function newState(cwd: string, env: Record<string, string> = {}): ScanState {
  return { cwd, alt: [], cwdUnknown: false, env, staged: [], aliases: {} };
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

/** Expands a leading ~ unless the command assigns HOME; variable references always stay unresolved (null). */
export function expandIn(ctx: Ctx, word: string): string | null {
  return ctx.paths.expand(word, ctx.taint.home ? null : ctx.home);
}

/** Marks a destructive-git-dirty reason whose loss includes ignored files: a snapshot cannot hold those, so the block stays. */
export const IGNORED_LOSS = ' (includes ignored files, which no snapshot can hold)';
