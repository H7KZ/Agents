import { assignmentsOf, nestedScript, parseSimple, type Simple } from './command.ts';
import { evaluateDelete, evaluateFind, isDeleter } from './rules-delete.ts';
import { evaluateDeploy } from './rules-deploy.ts';
import { aliasDefinitions, applyGitEffects, evaluateGit, parseGitCall, type GitCall } from './rules-git.ts';
import { evaluateIndirection, type Flow } from './rules-indirect.ts';
import { tokenize, type Dialect } from './tokenize.ts';
import { ask, cloneState, type Ctx, type Decision, type ScanState } from './types.ts';

export type { ScanState } from './types.ts';

const MAX_DEPTH = 6;
const MAX_CWDS = 8;
const DIRECTORY_CHANGERS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl']);
const ENV_SETTERS = new Set(['export', 'set', 'declare', 'typeset', 'readonly']);
const LEAVERS = new Set(['exit', 'return']);

/** Anything that can assign a variable the guard does not model; then no variable in a delete target is trusted. */
const ASSIGNERS = new RegExp(
  [
    String.raw`\b(?:read|local|declare|typeset|getopts|eval|mapfile|readarray)\b`,
    String.raw`\bprintf\s+-v\b`,
    String.raw`\b(?:for|select)\s+\w+\s+in\b`,
    String.raw`\$\{[^}]*:?=`,
    String.raw`\b(?:Set-Item|New-Item|Set-Variable|New-Variable|SetEnvironmentVariable|foreach|ForEach-Object)\b`,
    String.raw`\bset\s+/p\b`,
    String.raw`\$[A-Za-z_][\w:]*\s*[-+*/]?=`,
  ].join('|'),
  'i',
);

const REASSIGNABLE = ['TMPDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'];

/** Variables the command itself reassigns no longer hold their hook-time value, so they stay unresolved. */
function withReassigned(ctx: Ctx, env: Record<string, string>, assigns: boolean): Ctx {
  if (assigns) return { ...ctx, tmp: { ...ctx.tmp, vars: { '*': null } } };
  const names = Object.keys(env).map((name) => name.toUpperCase());
  const hit = REASSIGNABLE.filter((name) => names.includes(name));
  if (hit.length === 0) return ctx;
  return { ...ctx, tmp: { ...ctx.tmp, vars: { ...ctx.tmp.vars, ...Object.fromEntries(hit.map((name) => [name, null])) } } };
}

const isPipe = (op: string): boolean => op.endsWith('|') && !op.endsWith('||');

function changeDirectory(simple: Simple, state: ScanState, ctx: Ctx, mayFail: boolean): void {
  const target = simple.argv.find((arg) => !arg.startsWith('-') || arg === '-') ?? '~';
  if (target === '-') return;
  const expanded = ctx.paths.expand(target, ctx.home, ctx.tmp.vars);
  if (expanded === null || expanded === '') return;
  const before = [state.cwd, ...state.alt];
  const after = before.map((dir) => ctx.paths.resolve(dir, expanded));
  const all = [...new Set(mayFail ? [...after, ...before] : after)].slice(0, MAX_CWDS);
  state.cwd = all[0] as string;
  state.alt = all.slice(1);
}

function gitDecisions(simple: Simple, state: ScanState, ctx: Ctx, scanNested: (script: string, kind: Dialect) => Decision[]): Decision[] {
  const env = { ...state.env, ...simple.env };
  const found: Decision[] = [];
  const primary = parseGitCall(simple.argv, state.cwd, env, ctx, state);
  const calls: GitCall[] = [primary, ...state.alt.map((cwd) => parseGitCall(simple.argv, cwd, env, ctx, state))];
  for (const call of calls) {
    const decision = evaluateGit(call, ctx);
    if (decision) found.push(decision);
  }
  for (const { value } of aliasDefinitions(primary)) {
    found.push(...scanNested(value.startsWith('!') ? value.slice(1) : `git ${value}`, 'sh'));
    found.push(ask('git-alias', 'This defines a git alias; aliases can hide dangerous commands from the guard. Confirm with the user.'));
  }
  if (primary.shell !== null) found.push(...scanNested(primary.shell, 'sh'));
  applyGitEffects(primary, ctx);
  return found;
}

function evaluateSimple(simple: Simple, state: ScanState, ctx: Ctx, flow: Flow, scanNested: (script: string, kind: Dialect) => Decision[]): Decision[] {
  const found: Decision[] = [];
  const indirect = evaluateIndirection(simple, flow);
  if (indirect) found.push(indirect);
  const cwds = [state.cwd, ...state.alt];
  if (simple.name === 'git') {
    found.push(...gitDecisions(simple, state, ctx, scanNested));
  } else if (isDeleter(simple.name)) {
    for (const cwd of cwds) {
      const decision = evaluateDelete(simple, cwd, ctx, flow.piped);
      if (decision) found.push(decision);
    }
  } else if (simple.name === 'find') {
    for (const cwd of cwds) {
      const decision = evaluateFind(simple, cwd, ctx);
      if (decision) found.push(decision);
    }
  } else {
    const decision = evaluateDeploy(simple);
    if (decision) found.push(decision);
  }
  return found;
}

export function scan(command: string, dialect: Dialect, ctx: Ctx, state: ScanState, depth = 0): Decision[] {
  if (depth > MAX_DEPTH) {
    return [ask('unscannable-command', 'The command nests shells too deeply to inspect. Run it as separate, simple commands.')];
  }
  if (depth === 0) state.assigns = ASSIGNERS.test(command);
  const tokens = tokenize(command, dialect);
  const found: Decision[] = [];
  const scanNested = (script: string, kind: Dialect): Decision[] => scan(script, kind, ctx, cloneState(state), depth + 1);
  const saved: { depth: number; state: ScanState }[] = [];
  let previousDepth = 0;
  let afterCd = false;
  tokens.segments.forEach((words, index) => {
    const level = tokens.depths[index] as number;
    while (saved.length > 0 && level < (saved[saved.length - 1] as { depth: number }).depth) {
      const before = [state.cwd, ...state.alt];
      Object.assign(state, (saved.pop() as { state: ScanState }).state);
      // Unbalanced parentheses (for example case patterns) make the structure ambiguous: keep both sets.
      if (tokens.ambiguous) state.alt = [...new Set([...state.alt, ...before])].filter((dir) => dir !== state.cwd).slice(0, MAX_CWDS - 1);
    }
    for (let entering = previousDepth + 1; entering <= level; entering++) saved.push({ depth: entering, state: cloneState(state) });
    previousDepth = level;
    const op = tokens.ops[index] as string;
    const simple = parseSimple(words);
    if (simple.name === '') {
      Object.assign(state.env, simple.env);
      afterCd = false;
      return;
    }
    const here = withReassigned(ctx, { ...state.env, ...simple.env }, state.assigns === true);
    const flow: Flow = { piped: isPipe(op), input: tokens.inputs[index] as boolean, call: tokens.calls[index] as boolean, powershell: dialect === 'ps' };
    found.push(...evaluateSimple(simple, state, here, flow, scanNested));
    const inner = nestedScript(simple);
    if (inner) found.push(...scanNested(inner.script, inner.dialect));
    // Only `cd x || exit` at the top level proves the later commands run in the new directory.
    if (LEAVERS.has(simple.name) && level === 0 && op === '||' && afterCd) state.alt = [];
    if (DIRECTORY_CHANGERS.has(simple.name)) {
      const next = tokens.ops[index + 1] ?? '';
      changeDirectory(simple, state, here, op.includes('||') || next.includes('||'));
    }
    afterCd = DIRECTORY_CHANGERS.has(simple.name);
    if (ENV_SETTERS.has(simple.name)) Object.assign(state.env, assignmentsOf(simple));
  });
  for (const script of tokens.nested) found.push(...scanNested(script, dialect));
  return found;
}

export function pickDecision(decisions: Decision[]): Decision | null {
  return decisions.find((d) => d.decision === 'block') ?? decisions[0] ?? null;
}
