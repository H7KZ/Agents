import type { Git } from './git.ts';
import type { Paths } from './paths.ts';

export interface Decision {
  decision: 'block' | 'ask';
  rule: string;
  reason: string;
}

export interface Ctx {
  cwd: string;
  home: string;
  paths: Paths;
  git: Git;
}

export function block(rule: string, reason: string): Decision {
  return { decision: 'block', rule, reason };
}

export function ask(rule: string, reason: string): Decision {
  return { decision: 'ask', rule, reason };
}
