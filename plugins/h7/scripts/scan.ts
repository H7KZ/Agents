import { assignmentsOf, nestedScript, parseSimple, type Simple } from './command.ts';
import { evaluateDelete, isDeleter } from './rules-delete.ts';
import { evaluateDeploy } from './rules-deploy.ts';
import { evaluateGit, parseGitCall } from './rules-git.ts';
import { tokenize, type Dialect } from './tokenize.ts';
import { ask, type Ctx, type Decision } from './types.ts';

export interface ScanState {
  cwd: string;
  env: Record<string, string>;
}

const MAX_DEPTH = 6;
const DIRECTORY_CHANGERS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl']);
const ENV_SETTERS = new Set(['export', 'set', 'declare', 'typeset', 'readonly']);

function evaluateSimple(simple: Simple, env: Record<string, string>, cwd: string, ctx: Ctx): Decision | null {
  if (simple.name === 'git') return evaluateGit(parseGitCall(simple.argv, cwd, env, ctx), ctx);
  if (isDeleter(simple.name)) return evaluateDelete(simple, cwd, ctx);
  return evaluateDeploy(simple);
}

function changeDirectory(simple: Simple, state: ScanState, ctx: Ctx): void {
  const target = simple.argv.find((arg) => !arg.startsWith('-') || arg === '-') ?? '~';
  if (target === '-') return;
  const expanded = ctx.paths.expand(target, ctx.home);
  if (expanded !== null && expanded !== '') state.cwd = ctx.paths.resolve(state.cwd, expanded);
}

export function scan(command: string, dialect: Dialect, ctx: Ctx, state: ScanState, depth = 0): Decision[] {
  if (depth > MAX_DEPTH) {
    return [ask('unscannable-command', 'The command nests shells too deeply to inspect. Run it as separate, simple commands.')];
  }
  const tokens = tokenize(command, dialect);
  const found: Decision[] = [];
  const scanNested = (script: string, kind: Dialect): void => {
    found.push(...scan(script, kind, ctx, { cwd: state.cwd, env: { ...state.env } }, depth + 1));
  };
  for (const words of tokens.segments) {
    const simple = parseSimple(words);
    if (simple.name === '') {
      Object.assign(state.env, simple.env);
      continue;
    }
    const decision = evaluateSimple(simple, { ...state.env, ...simple.env }, state.cwd, ctx);
    if (decision) found.push(decision);
    const inner = nestedScript(simple);
    if (inner) scanNested(inner.script, inner.dialect);
    if (DIRECTORY_CHANGERS.has(simple.name)) changeDirectory(simple, state, ctx);
    if (ENV_SETTERS.has(simple.name)) Object.assign(state.env, assignmentsOf(simple));
  }
  for (const script of tokens.nested) scanNested(script, dialect);
  return found;
}

export function pickDecision(decisions: Decision[]): Decision | null {
  return decisions.find((d) => d.decision === 'block') ?? decisions[0] ?? null;
}
