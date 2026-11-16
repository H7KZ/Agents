import { assignmentsOf, nestedScript, parseSimple, wslCall, type Simple } from './command.ts';
import { evaluateDelete, evaluateFind, isDeleter } from './rules-delete.ts';
import { evaluateDeploy } from './rules-deploy.ts';
import { aliasDefinitions, applyGitEffects, evaluateGit, parseGitCall, type GitCall } from './rules-git.ts';
import { evaluateIndirection, type Flow } from './rules-indirect.ts';
import { tokenize, type Dialect } from './tokenize.ts';
import { ask, cloneState, expandIn, type Ctx, type Decision, type ScanState } from './types.ts';

export type { ScanState } from './types.ts';

const MAX_DEPTH = 6;
const MAX_CWDS = 8;
const DIRECTORY_CHANGERS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl']);
const ENV_SETTERS = new Set(['export', 'set', 'declare', 'typeset', 'readonly']);
const LEAVERS = new Set(['exit', 'return']);

/** Any mention of HOME or USERPROFILE (top level or nested, sticky) means ~ may no longer be the real home. */
const HOME_WORD = /\b(?:HOME|USERPROFILE)\b/i;
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]|~)/;
/** Git subcommands whose rules depend on the working directory. */
const CWD_GIT = new Set(['reset', 'clean', 'checkout', 'switch', 'restore', 'commit', 'add', 'stage', 'update-index', 'push']);

const unresolvedCwd = (what: string): Decision =>
  ask('unresolved-cwd', `${what} depends on the working directory, which an earlier cd made unknown. Use absolute paths or run it separately.`);

const isPipe = (op: string): boolean => op.endsWith('|') && !op.endsWith('||');

function changeDirectory(simple: Simple, state: ScanState, ctx: Ctx, mayFail: boolean): void {
  const target = simple.argv.find((arg) => !arg.startsWith('-') || arg === '-') ?? '~';
  const expanded = target === '-' ? null : expandIn(ctx, target);
  if (expanded === null || expanded === '') {
    state.cwdUnknown = true;
    return;
  }
  if (ABSOLUTE.test(expanded)) state.cwdUnknown = false;
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
  if (state.cwdUnknown === true && CWD_GIT.has(primary.sub)) found.push(unresolvedCwd(`git ${primary.sub}`));
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

/** True when a delete or find has a path argument that is relative (find with no path defaults to "."). */
function relativeTarget(simple: Simple): boolean {
  if (simple.name !== 'find') return simple.argv.some((arg) => !arg.startsWith('-') && !ABSOLUTE.test(arg));
  const starts: string[] = [];
  for (const arg of simple.argv) {
    if (arg.startsWith('-') || arg === '(' || arg === '!') break;
    starts.push(arg);
  }
  return starts.length === 0 || starts.some((arg) => !ABSOLUTE.test(arg));
}

function evaluateSimple(simple: Simple, state: ScanState, ctx: Ctx, flow: Flow, scanNested: (script: string, kind: Dialect) => Decision[]): Decision[] {
  const found: Decision[] = [];
  const indirect = evaluateIndirection(simple, flow);
  if (indirect) found.push(indirect);
  const cwds = [state.cwd, ...state.alt];
  // The ask is added alongside the normal rules, so a block still wins in pickDecision.
  if ((isDeleter(simple.name) || simple.name === 'find') && state.cwdUnknown === true && relativeTarget(simple)) {
    found.push(unresolvedCwd(`${simple.name} with a relative path`));
  }
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
  if (HOME_WORD.test(command)) ctx.taint.home = true;
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
    const flow: Flow = { piped: isPipe(op), input: tokens.inputs[index] as boolean, call: tokens.calls[index] as boolean, powershell: dialect === 'ps' };
    found.push(...evaluateSimple(simple, state, ctx, flow, scanNested));
    const inner = nestedScript(simple);
    if (inner) found.push(...scanNested(inner.script, inner.dialect));
    const wsl = wslCall(simple);
    if (wsl?.ask !== undefined) found.push(ask('wsl-exec', wsl.ask));
    if (wsl?.script !== undefined) {
      // The inner script acts in the Linux filesystem, not on the host: its working directory is unknown, the host's clean-tree knowledge does not
      // apply, and no decision may carry a host directory (so a dirty-tree snapshot is never taken for it and the block stays).
      ctx.taint.home = true;
      const inside: ScanState = { ...cloneState(state), cwdUnknown: true, trackedClean: undefined, untrackedClean: undefined };
      for (const decision of scan(wsl.script, 'sh', ctx, inside, depth + 1)) found.push({ decision: decision.decision, rule: decision.rule, reason: decision.reason });
    }
    // Only `cd x || exit` at the top level proves the later commands run in the new directory.
    if (LEAVERS.has(simple.name) && level === 0 && op === '||' && afterCd) state.alt = [];
    if (DIRECTORY_CHANGERS.has(simple.name)) {
      const next = tokens.ops[index + 1] ?? '';
      changeDirectory(simple, state, ctx, op.includes('||') || next.includes('||'));
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
