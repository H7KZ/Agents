import { parseArgs, type ParsedArgs, type ParseSpec } from './command.ts';
import { tokenize } from './tokenize.ts';
import { ask, block, expandIn, type Ctx, type Decision, type ScanState } from './types.ts';

const PROTECTED = new Set(['main', 'master', 'production', 'prod']);
const FORCE_FLAGS = ['--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror'];
const HOOK_SUBS = new Set(['commit', 'push', 'merge', 'rebase', 'am', 'cherry-pick', 'revert', 'pull', 'checkout', 'switch']);
const VALUE_GLOBALS = new Set(['--namespace', '--super-prefix', '--attr-source']);
const NO_VERIFY = { vocab: ['--no-verify'] };
const COMMIT_SPEC: ParseSpec = {
  valueShort: 'mFCct',
  attachedShort: 'Su',
  valueLong: ['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--cleanup', '--fixup', '--squash', '--trailer'],
  vocab: ['--no-verify', '--all'],
};
const PUSH_SPEC: ParseSpec = {
  valueShort: 'o',
  valueLong: ['--repo', '--receive-pack', '--exec', '--push-option'],
  vocab: ['--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '--all', '--branches', '--tags', '--no-verify'],
};
const DESTRUCTIVE_VOCAB = ['--force', '--hard', '--discard-changes', '--dry-run', '--staged', '--worktree'];
const DESTRUCTIVE_SPECS = new Map<string, ParseSpec>([
  ['reset', { vocab: DESTRUCTIVE_VOCAB }],
  ['checkout', { valueShort: 'bB', valueLong: ['--orphan', '--conflict', '--pathspec-from-file'], vocab: DESTRUCTIVE_VOCAB }],
  ['switch', { valueShort: 'cC', valueLong: ['--orphan', '--conflict'], vocab: DESTRUCTIVE_VOCAB }],
  ['clean', { valueShort: 'e', valueLong: ['--exclude'], vocab: DESTRUCTIVE_VOCAB }],
  ['restore', { valueShort: 's', valueLong: ['--source', '--pathspec-from-file'], vocab: DESTRUCTIVE_VOCAB }],
]);
const STASH_SPEC: ParseSpec = {
  valueShort: 'm',
  valueLong: ['--message', '--pathspec-from-file'],
  vocab: ['--staged', '--patch', '--keep-index', '--include-untracked', '--all'],
};
const PARTIAL_STASH = ['-S', '--staged', '-p', '--patch', '-k', '--keep-index', '--pathspec-from-file'];
const ADD_SPEC: ParseSpec = { valueLong: ['--pathspec-from-file'], vocab: ['--force', '--all', '--update', '--patch', '--add'] };
const BLOCK_SECRETS: [RegExp, string][] = [
  [/^\.env$/i, '.env file'],
  [/^\.env\.local$/i, '.env file'],
  [/^\.env\.(?:.+\.)?local$/i, '.env file'],
  [/^\.env\.production/i, 'production .env file'],
  [/^id_(?:rsa|ed25519|ecdsa|dsa)$/i, 'SSH private key'],
  [/\.(?:p12|pfx)$/i, 'PKCS#12 keystore'],
  [/\.(?:keystore|jks)$/i, 'Java keystore'],
  [/^credentials\.json$/i, 'credentials file'],
  [/^secrets\.(?:.+\.)?(?!(?:[cm]?[jt]sx?|md|py|go|rs|java|rb)$)[^.]+$/i, 'secrets file'],
  [/\.key$/i, 'private key'],
  [/^\.(?:netrc|pgpass)$/i, 'credentials file'],
];
const ASK_SECRETS: [RegExp, string][] = [
  [/^\.env\..+$/i, '.env variant'],
  [/\.pem$/i, 'PEM key or certificate'],
  [/^\.npmrc$/i, '.npmrc (may hold a token)'],
  [/\.tfvars$/i, 'Terraform variables file'],
];
const SECRET_EXEMPT = /(?:\.(?:example|sample|template)|\.pub)$/i;
/** Hook directories that are accepted without asking when set inside the repository. */
const HOOKS_ALLOWED = ['.husky', '.husky/_', '.githooks', '.git/hooks'];
const HOOKS_ADVICE = 'Run the hooks and fix what they report. If a hook is wrong, ask the user before bypassing it.';

export interface GitCall {
  sub: string;
  args: string[];
  cwd: string;
  configs: string[];
  envConfigs: string[];
  env: Record<string, string>;
  state: ScanState;
  /** True when -C, --git-dir or --work-tree could not be resolved statically. */
  unresolvedRepo: boolean;
  /** Body of a shell alias (`!...`) that the call runs, if any. */
  shell: string | null;
}

interface Globals {
  at: string;
  configs: string[];
  envConfigs: string[];
  unresolved: boolean;
  next: number;
}

function parseGlobals(argv: string[], cwd: string, ctx: Ctx): Globals {
  const out: Globals = { at: cwd, configs: [], envConfigs: [], unresolved: false, next: 0 };
  let gitDir: string | undefined;
  let workTree: string | undefined;
  const dirArg = (value: string): string | null => {
    const expanded = expandIn(ctx, value);
    if (expanded === null) out.unresolved = true;
    return expanded;
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    const attached = arg.startsWith('--') && eq !== -1;
    const value = attached ? arg.slice(eq + 1) : (argv[i + 1] ?? '');
    const width = attached ? 1 : 2;
    if (arg === '-C') {
      const dir = dirArg(value);
      if (dir !== null && dir !== '') out.at = ctx.paths.resolve(out.at, dir);
    } else if (arg === '-c') {
      out.configs.push(value);
    } else if (name === '--config-env') {
      out.envConfigs.push(value);
    } else if (name === '--git-dir') {
      gitDir = value;
    } else if (name === '--work-tree') {
      workTree = value;
    } else if (VALUE_GLOBALS.has(name)) {
      // consumes a value but does not change the repository
    } else if (arg.startsWith('-')) {
      i++;
      continue;
    } else {
      break;
    }
    i += width;
  }
  out.next = i;
  if (workTree !== undefined) {
    const dir = dirArg(workTree);
    if (dir !== null) out.at = ctx.paths.resolve(out.at, dir);
  } else if (gitDir !== undefined) {
    const dir = dirArg(gitDir);
    const parent = dir === null ? null : /(?:^|[\\/])\.git[\\/]*$/.exec(dir);
    if (dir !== null && parent) out.at = ctx.paths.resolve(out.at, dir.slice(0, parent.index) || '.');
    else out.unresolved = true;
  }
  return out;
}

function aliasMap(configs: string[], state: ScanState): Record<string, string> {
  const aliases = { ...state.aliases };
  for (const config of configs) {
    const match = /^alias\.([^=]+)=([\s\S]*)$/i.exec(config);
    if (match) aliases[(match[1] as string).toLowerCase()] = match[2] as string;
  }
  return aliases;
}

export function parseGitCall(argv: string[], cwd: string, env: Record<string, string>, ctx: Ctx, state: ScanState): GitCall {
  const globals = parseGlobals(argv, cwd, ctx);
  const aliases = aliasMap(globals.configs, state);
  let sub = argv[globals.next] ?? '';
  let args = argv.slice(globals.next + 1);
  let shell: string | null = null;
  for (let hops = 0; hops < 5 && Object.hasOwn(aliases, sub.toLowerCase()); hops++) {
    const value = aliases[sub.toLowerCase()] as string;
    if (value.startsWith('!')) {
      shell = value.slice(1);
      break;
    }
    const words = tokenize(value).segments[0] ?? [];
    sub = words[0] ?? '';
    args = [...words.slice(1), ...args];
  }
  return { sub, args, cwd: globals.at, configs: globals.configs, envConfigs: globals.envConfigs, env, state, unresolvedRepo: globals.unresolved, shell };
}

const CONFIG_SPEC: ParseSpec = { valueShort: 'f', valueLong: ['--file', '--type', '--blob', '--default', '--comment', '--value'] };
const CONFIG_READ_ONLY = ['--unset', '--unset-all', '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--remove-section', '--rename-section', '--edit', '-e'];
/** The keys the guard cares about: hook location and aliases. */
const CONFIG_KEY = /^(?:core\.hookspath|alias\..+)$/i;

interface ConfigWrite {
  key: string;
  value: string | undefined;
}

/**
 * Keys written by `git config`. Every positional is a candidate key (subcommand words such as set/get/add and values of
 * options like -f or --type are skipped by the parser), and the positional after a key is its value. `ambiguous` means a
 * key-looking word was swallowed as an option value, so the guard cannot tell what is being set.
 */
function configWrites(call: GitCall): { writes: ConfigWrite[]; ambiguous: boolean } {
  if (call.sub !== 'config') return { writes: [], ambiguous: false };
  const parsed = parseArgs(call.args, CONFIG_SPEC);
  const positionals = [...parsed.positionals, ...parsed.rest];
  const ambiguous = call.args.some((arg) => !arg.startsWith('-') && CONFIG_KEY.test(arg) && !positionals.includes(arg));
  if (parsed.flags.some((flag) => CONFIG_READ_ONLY.includes(flag))) return { writes: [], ambiguous };
  const writes: ConfigWrite[] = [];
  positionals.forEach((word, i) => {
    if (CONFIG_KEY.test(word)) writes.push({ key: word, value: positionals[i + 1] });
  });
  return { writes, ambiguous };
}

/** Alias bodies defined by this call (`-c alias.x=...` or `git config alias.x ...`). */
export function aliasDefinitions(call: GitCall): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const config of call.configs) {
    const match = /^alias\.([^=]+)=([\s\S]*)$/i.exec(config);
    if (match) out.push({ name: (match[1] as string).toLowerCase(), value: match[2] as string });
  }
  for (const { key, value } of configWrites(call).writes) {
    const match = /^alias\.(.+)$/i.exec(key);
    if (match && value !== undefined) out.push({ name: (match[1] as string).toLowerCase(), value });
  }
  return out;
}

export interface SecretClass {
  tier: 'block' | 'ask';
  kind: string;
}

export function classifySecret(file: string): SecretClass | null {
  const base = file.split(/[\\/]/).pop() as string;
  if (SECRET_EXEMPT.test(base)) return null;
  for (const [pattern, kind] of BLOCK_SECRETS) {
    if (pattern.test(base)) return { tier: 'block', kind };
  }
  for (const [pattern, kind] of ASK_SECRETS) {
    if (pattern.test(base)) return { tier: 'ask', kind };
  }
  return null;
}

export function secretKind(file: string): string | null {
  return classifySecret(file)?.kind ?? null;
}

function hooksPathValues(call: GitCall): (string | undefined)[] {
  const values: (string | undefined)[] = [];
  for (const config of call.configs) {
    const match = /^core\.hookspath=([\s\S]*)$/i.exec(config);
    if (match) values.push(match[1]);
  }
  for (const config of call.envConfigs) {
    const match = /^core\.hookspath=([\s\S]*)$/i.exec(config);
    if (match) values.push(call.env[match[1] as string]);
  }
  for (const { key, value } of configWrites(call).writes) {
    if (key.toLowerCase() === 'core.hookspath' && value !== undefined) values.push(value);
  }
  const count = Number.parseInt(call.env.GIT_CONFIG_COUNT ?? '', 10);
  for (let n = 0; n < (Number.isInteger(count) ? Math.min(count, 64) : 0); n++) {
    if (call.env[`GIT_CONFIG_KEY_${n}`]?.toLowerCase() === 'core.hookspath') values.push(call.env[`GIT_CONFIG_VALUE_${n}`]);
  }
  return values;
}

function hooksPath(call: GitCall, ctx: Ctx): Decision | null {
  let pending: Decision | null = null;
  if (configWrites(call).ambiguous) {
    pending = ask('skip-git-hooks', `git config names core.hooksPath or an alias in a position the guard cannot place, so it cannot tell what is being set. ${HOOKS_ADVICE}`);
  }
  for (const value of hooksPathValues(call)) {
    const expanded = value === undefined || value === '' ? null : expandIn(ctx, value);
    if (expanded === null) {
      pending ??= ask('skip-git-hooks', `core.hooksPath is set to a value the guard cannot resolve ("${value ?? ''}"). ${HOOKS_ADVICE}`);
      continue;
    }
    const root = ctx.paths.resolve(call.cwd, ctx.git.repoRoot(call.cwd) ?? call.cwd);
    const target = ctx.paths.resolve(root, expanded);
    if (!ctx.paths.isInside(root, target)) {
      return block('skip-git-hooks', `core.hooksPath "${value}" points outside the repository and disables its git hooks. ${HOOKS_ADVICE}`);
    }
    if (!HOOKS_ALLOWED.some((dir) => ctx.paths.same(target, ctx.paths.resolve(root, dir)))) {
      pending ??= ask('skip-git-hooks', `core.hooksPath "${value}" replaces the repository's git hooks with an unvetted directory. Only ${HOOKS_ALLOWED.join(', ')} are accepted without asking.`);
    }
  }
  return pending;
}

function skipHooks(call: GitCall, ctx: Ctx): Decision | null {
  const parsed = parseArgs(call.args, call.sub === 'commit' ? COMMIT_SPEC : call.sub === 'push' ? PUSH_SPEC : NO_VERIFY);
  const hooked = HOOK_SUBS.has(call.sub);
  if (parsed.flags.includes('--no-verify')) {
    return block('skip-git-hooks', `--no-verify skips git hooks. ${HOOKS_ADVICE}`);
  }
  if (call.sub === 'commit' && parsed.flags.includes('-n')) {
    return block('skip-git-hooks', `git commit -n skips git hooks. ${HOOKS_ADVICE}`);
  }
  const hooks = hooksPath(call, ctx);
  if (hooks) return hooks;
  if (hooked && call.env.HUSKY === '0') {
    return block('skip-git-hooks', `HUSKY=0 disables git hooks. ${HOOKS_ADVICE}`);
  }
  if (hooked && (call.env.SKIP ?? '') !== '') {
    return block('skip-git-hooks', `SKIP=${call.env.SKIP} disables pre-commit hooks. ${HOOKS_ADVICE}`);
  }
  return null;
}

type Scope = 'tracked' | 'untracked' | 'ignored';

interface Loss {
  what: string;
  scope: Scope;
}

function usesPaths(parsed: ParsedArgs, call: GitCall, ctx: Ctx): boolean {
  if (parsed.rest.length > 0) return true;
  return parsed.positionals.some(
    (p) => p === '.' || p === './' || p.startsWith(':') || /[*?[]/.test(p) || ctx.disk.kind(ctx.paths.resolve(call.cwd, p)) !== null,
  );
}

function lostWork(call: GitCall, parsed: ParsedArgs, ctx: Ctx): Loss | null {
  const flags = parsed.flags;
  const force = flags.includes('-f') || flags.includes('--force');
  switch (call.sub) {
    case 'reset':
      return flags.includes('--hard') ? { what: 'git reset --hard', scope: 'tracked' } : null;
    case 'clean':
      if (!force || flags.includes('-n') || flags.includes('--dry-run')) return null;
      return { what: 'git clean -f', scope: flags.includes('-x') || flags.includes('-X') ? 'ignored' : 'untracked' };
    case 'checkout':
      return force || usesPaths(parsed, call, ctx) ? { what: 'git checkout (discards file changes)', scope: 'tracked' } : null;
    case 'switch':
      return force || flags.includes('--discard-changes') ? { what: 'git switch --discard-changes', scope: 'tracked' } : null;
    case 'restore': {
      const staged = flags.includes('--staged') || flags.includes('-S');
      const worktree = flags.includes('--worktree') || flags.includes('-W');
      return !staged || worktree ? { what: 'git restore (discards file changes)', scope: 'tracked' } : null;
    }
    default:
      return null;
  }
}

function hasTrackedChanges(call: GitCall, ctx: Ctx): boolean {
  return call.state.trackedClean === undefined ? ctx.git.trackedDirty(call.cwd) : !call.state.trackedClean;
}

function hasUntracked(call: GitCall, ctx: Ctx, ignored: boolean): boolean {
  if (call.state.untrackedClean !== undefined) return !call.state.untrackedClean;
  return ctx.git.untrackedFiles(call.cwd).length > 0 || (ignored && ctx.git.ignoredFiles(call.cwd).length > 0);
}

function destructive(call: GitCall, ctx: Ctx): Decision | null {
  const loss = lostWork(call, parseArgs(call.args, DESTRUCTIVE_SPECS.get(call.sub)), ctx);
  if (loss === null) return null;
  if (call.unresolvedRepo) {
    return ask('destructive-git-unresolved', `${loss.what} targets a repository the guard cannot resolve (-C, --git-dir or --work-tree). Confirm with the user.`);
  }
  const dirty = loss.scope === 'tracked' ? hasTrackedChanges(call, ctx) : hasUntracked(call, ctx, loss.scope === 'ignored');
  if (!dirty) return null;
  const files = loss.scope === 'tracked' ? 'uncommitted changes' : 'untracked files';
  return block(
    'destructive-git-dirty',
    `${loss.what} would destroy ${files}. Commit them or run "git stash push -u" first; the command is allowed once the worktree is clean.`,
  );
}

function isProtectedName(name: string): boolean {
  return PROTECTED.has(name) || name.startsWith('release/');
}

function historyRewrite(call: GitCall): Decision | null {
  const parsed = parseArgs(call.args, { vocab: ['--force', '--prune', '--expire', '--expire-unreachable'] });
  const { sub } = call;
  const first = parsed.positionals[0];
  if (sub === 'stash' && (first === 'drop' || first === 'clear')) {
    return ask('git-stash-drop', `git stash ${first} permanently discards stashed work. Confirm with the user.`);
  }
  if (sub === 'filter-branch' || sub === 'filter-repo') {
    return ask('git-history-rewrite', `git ${sub} rewrites history across the repository. Confirm with the user.`);
  }
  if (sub === 'reflog' && first === 'expire' && (parsed.options.get('--expire') === 'now' || parsed.options.get('--expire-unreachable') === 'now')) {
    return ask('git-history-rewrite', 'git reflog expire --expire=now removes the recovery net. Confirm with the user.');
  }
  if (sub === 'gc' && parsed.options.get('--prune') === 'now') {
    return ask('git-history-rewrite', 'git gc --prune=now permanently drops unreachable objects. Confirm with the user.');
  }
  const forced = parsed.flags.some((f) => f === '--force' || f === '-f' || f === '-M' || f === '-C');
  if (sub === 'branch' && forced && parsed.positionals.some(isProtectedName)) {
    return ask('git-protected-ref', 'This force-moves a protected branch. Confirm with the user.');
  }
  if (sub === 'update-ref') {
    const ref = parsed.positionals.find((p) => p.startsWith('refs/heads/'));
    if (ref !== undefined && isProtectedName(ref.slice('refs/heads/'.length))) {
      return ask('git-protected-ref', `git update-ref rewrites protected branch "${ref}". Confirm with the user.`);
    }
  }
  return null;
}

interface Target {
  name: string;
  forced: boolean;
  deleting: boolean;
}

function pushTargets(call: GitCall, parsed: ParsedArgs, ctx: Ctx): Target[] {
  const targets: Target[] = [];
  const specs = parsed.positionals.slice(1);
  const globalForce = parsed.flags.some((f) => FORCE_FLAGS.includes(f));
  const deleteFlag = parsed.flags.includes('--delete') || parsed.flags.includes('-d');
  const branch = (): string | null => (call.state.branch === undefined ? ctx.git.currentBranch(call.cwd) : call.state.branch);
  if (parsed.flags.some((f) => f === '--all' || f === '--mirror' || f === '--branches')) {
    targets.push({ name: '*', forced: globalForce, deleting: false });
  }
  for (const spec of specs) {
    const plus = spec.startsWith('+');
    const body = plus ? spec.slice(1) : spec;
    const colon = body.indexOf(':');
    const src = colon === -1 ? body : body.slice(0, colon);
    let dst = colon === -1 ? body : body.slice(colon + 1);
    if (colon === -1 && src === 'HEAD') dst = branch() ?? '';
    const isBranch = dst.startsWith('refs/heads/') || !dst.startsWith('refs/');
    const name = dst.replace(/^refs\/heads\//, '');
    if (isBranch && name !== '') targets.push({ name, forced: plus || globalForce, deleting: deleteFlag || src === '' });
  }
  if (specs.length === 0 && targets.length === 0 && !deleteFlag && !parsed.flags.includes('--tags')) {
    const current = branch();
    if (current !== null) targets.push({ name: current, forced: globalForce, deleting: false });
  }
  return targets;
}

function push(call: GitCall, ctx: Ctx): Decision | null {
  const parsed = parseArgs(call.args, PUSH_SPEC);
  const remote = parsed.positionals[0] ?? 'origin';
  let defaultBranch: string | null | undefined;
  const isProtected = (name: string): boolean => {
    if (name.includes('*') || isProtectedName(name)) return true;
    defaultBranch ??= ctx.git.defaultBranch(call.cwd, remote);
    return defaultBranch === name;
  };
  let pending: Decision | null = null;
  for (const target of pushTargets(call, parsed, ctx)) {
    if (!isProtected(target.name)) continue;
    if (target.forced) {
      return block(
        'force-push-protected',
        `Force push to protected branch "${target.name}" can destroy shared history. Push to a feature branch and open a PR, or use a revert commit.`,
      );
    }
    if (target.deleting) {
      return block('push-delete-protected', `This deletes protected branch "${target.name}" on the remote. Ask the user to do it.`);
    }
    pending ??= ask('push-protected', `This pushes directly to protected branch "${target.name}". Prefer a feature branch and a PR.`);
  }
  return pending;
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    const close = c === '[' ? glob.indexOf(']', i + 2) : -1;
    if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else if (close !== -1) {
      const inner = glob.slice(i + 1, close).replace(/^!/, '^').replaceAll('\\', '\\\\');
      out += `[${inner}]`;
      i = close;
    } else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}(?:/.*)?$`, 'i');
}

/** Turns a user pathspec into a repository-root-relative one; null when it cannot match inside the repository. */
function rootRelative(spec: string, root: string, call: GitCall, ctx: Ctx): string | null {
  if (spec.startsWith(':/')) return spec.slice(2).replace(/^\/+/, '');
  const expanded = expandIn(ctx, spec) ?? spec;
  return ctx.paths.relative(root, ctx.paths.resolve(call.cwd, expanded));
}

function matchesSpec(file: string, rel: string): boolean {
  return rel === '' || file === rel || file.startsWith(`${rel.replace(/\/+$/, '')}/`) || globToRegExp(rel).test(file);
}

function addCandidates(call: GitCall, ctx: Ctx): string[] {
  const parsed = parseArgs(call.args, ADD_SPEC);
  const specs = [...parsed.positionals, ...parsed.rest];
  const literal = specs.filter((spec) => !/[*?[]/.test(spec) && !spec.startsWith(':'));
  const root = ctx.git.repoRoot(call.cwd);
  if (root === null) return literal;
  const magic = specs.some((s) => s.startsWith(':') && !s.startsWith(':/'));
  const wholeTree = parsed.flags.includes('-A') || parsed.flags.includes('--all') || parsed.flags.includes('-u') || parsed.flags.includes('--update');
  const updateOnly = parsed.flags.includes('-u') || parsed.flags.includes('--update');
  const force = parsed.flags.includes('-f') || parsed.flags.includes('--force');
  const modified = ctx.git.modifiedFiles(call.cwd);
  const pool = updateOnly ? modified : [...ctx.git.untrackedFiles(call.cwd), ...modified, ...(force ? ctx.git.ignoredFiles(call.cwd) : [])];
  const rels = specs.map((spec) => rootRelative(spec, root, call, ctx)).filter((rel): rel is string => rel !== null);
  const wantAll = magic || (wholeTree && specs.length === 0);
  const matched = wantAll ? pool : pool.filter((file) => rels.some((rel) => matchesSpec(file, rel)));
  return [...literal, ...matched];
}

function stagedCandidates(call: GitCall, ctx: Ctx): string[] {
  const parsed = parseArgs(call.args, COMMIT_SPEC);
  const all = parsed.flags.includes('-a') || parsed.flags.includes('--all');
  return [...ctx.git.stagedFiles(call.cwd), ...call.state.staged, ...(all ? ctx.git.modifiedFiles(call.cwd) : []), ...parsed.positionals, ...parsed.rest];
}

function indexCandidates(call: GitCall): string[] {
  const parsed = parseArgs(call.args, { valueLong: ['--cacheinfo'], vocab: ['--add', '--cacheinfo'] });
  if (!parsed.flags.includes('--add') && !parsed.flags.includes('--cacheinfo')) return [];
  const cached = [...parsed.options.values()].map((v) => v.split(',').pop() as string);
  return [...parsed.positionals, ...parsed.rest, ...cached];
}

function secretCandidates(call: GitCall, ctx: Ctx): string[] {
  if (call.sub === 'commit') return stagedCandidates(call, ctx);
  if (call.sub === 'update-index') return indexCandidates(call);
  return addCandidates(call, ctx);
}

function privateKeyInside(file: string, call: GitCall, ctx: Ctx): boolean {
  const root = ctx.git.repoRoot(call.cwd) ?? call.cwd;
  const candidates = [ctx.paths.resolve(root, file), ctx.paths.resolve(call.cwd, file)];
  return candidates.some((path) => /PRIVATE KEY/.test(ctx.disk.read(path) ?? ''));
}

function secrets(call: GitCall, ctx: Ctx): Decision | null {
  let pending: Decision | null = null;
  for (const file of secretCandidates(call, ctx)) {
    const found = classifySecret(file);
    if (found === null) continue;
    if (found.tier === 'block' || privateKeyInside(file, call, ctx)) {
      return block(
        'secrets-commit',
        `"${file}" looks like a ${found.kind}. Do not commit secrets: add it to .gitignore, unstage it ("git restore --staged"), and commit a .env.example with placeholders instead.`,
      );
    }
    pending ??= ask('secrets-ambiguous', `"${file}" may contain secrets (${found.kind}). Confirm with the user that it is safe to commit.`);
  }
  return pending;
}

const SECRET_SUBS = new Set(['commit', 'add', 'stage', 'update-index']);

export function evaluateGit(call: GitCall, ctx: Ctx): Decision | null {
  const checked =
    skipHooks(call, ctx) ?? destructive(call, ctx) ?? (SECRET_SUBS.has(call.sub) ? secrets(call, ctx) : null) ?? historyRewrite(call);
  if (checked) return checked;
  return call.sub === 'push' ? push(call, ctx) : null;
}

function branchAfter(call: GitCall, ctx: Ctx): string | null | undefined {
  const parsed = parseArgs(call.args, DESTRUCTIVE_SPECS.get(call.sub));
  if (call.sub === 'checkout' && usesPaths(parsed, call, ctx)) return undefined;
  const created = ['-b', '-B', '-c', '-C', '--orphan'].map((flag) => parsed.options.get(flag)).find((v) => v !== undefined);
  if (created !== undefined) return created;
  if (parsed.flags.includes('--detach') || parsed.flags.includes('-d')) return null;
  const target = parsed.positionals[0];
  if (target === undefined) return undefined;
  return target === '-' ? null : target;
}

/** Records what a git command changes so later commands in the same chain see it. */
export function applyGitEffects(call: GitCall, ctx: Ctx): void {
  const { state } = call;
  const parsed = parseArgs(call.args, call.sub === 'commit' ? COMMIT_SPEC : DESTRUCTIVE_SPECS.get(call.sub));
  const flags = parsed.flags;
  for (const { name, value } of aliasDefinitions(call)) state.aliases[name] = value;
  switch (call.sub) {
    case 'checkout':
    case 'switch': {
      const branch = branchAfter(call, ctx);
      if (branch !== undefined) state.branch = branch;
      if (lostWork(call, parsed, ctx) !== null) state.trackedClean = true;
      break;
    }
    case 'reset':
    case 'restore':
      if (lostWork(call, parsed, ctx) !== null) state.trackedClean = true;
      break;
    case 'clean':
      if (lostWork(call, parsed, ctx) !== null) state.untrackedClean = true;
      break;
    case 'commit':
      if (flags.includes('-a') || flags.includes('--all')) state.trackedClean = true;
      break;
    case 'stash': {
      const stash = parseArgs(call.args, STASH_SPEC);
      const action = stash.positionals[0];
      if (action === 'pop' || action === 'apply' || action === 'branch') {
        state.trackedClean = false;
      } else if (action === undefined || action === 'push' || action === 'save') {
        const partial =
          stash.flags.some((f) => PARTIAL_STASH.includes(f)) || stash.rest.length > 0 || (action === 'push' && stash.positionals.length > 1);
        if (partial) {
          // A partial stash leaves some changes behind: whether the tree is clean is unknown, so ask git again.
          state.trackedClean = undefined;
          state.untrackedClean = undefined;
        } else {
          state.trackedClean = true;
          if (stash.flags.some((f) => f === '-u' || f === '-a' || f === '--include-untracked' || f === '--all')) state.untrackedClean = true;
        }
      }
      break;
    }
    case 'add':
    case 'stage':
    case 'update-index':
      state.staged.push(...parseArgs(call.args, ADD_SPEC).positionals);
      break;
    default:
      break;
  }
}
