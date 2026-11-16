import { parseArgs, type ParsedArgs, type ParseSpec } from './command.ts';
import { ask, block, type Ctx, type Decision } from './types.ts';

const PROTECTED = new Set(['main', 'master', 'production', 'prod']);
const FORCE_FLAGS = ['--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror'];
const HOOK_SUBS = new Set(['commit', 'push', 'merge', 'rebase', 'am', 'cherry-pick', 'revert', 'pull', 'checkout', 'switch']);
const COMMIT_SPEC: ParseSpec = {
  valueShort: 'mFCct',
  attachedShort: 'Su',
  valueLong: ['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--cleanup', '--fixup', '--squash', '--trailer'],
};
const PUSH_SPEC: ParseSpec = { valueShort: 'o', valueLong: ['--repo', '--receive-pack', '--exec', '--push-option'] };
const DESTRUCTIVE_SPECS = new Map<string, ParseSpec>([
  ['checkout', { valueShort: 'bB', valueLong: ['--orphan', '--conflict', '--pathspec-from-file'] }],
  ['clean', { valueShort: 'e', valueLong: ['--exclude'] }],
  ['restore', { valueShort: 's', valueLong: ['--source', '--pathspec-from-file'] }],
]);
const SECRET_NAMES: [RegExp, string][] = [
  [/^\.env$/i, '.env file'],
  [/^\.env\..+$/i, '.env file'],
  [/\.pem$/i, 'PEM key or certificate'],
  [/\.key$/i, 'private key'],
  [/^id_rsa/i, 'SSH key'],
  [/^id_ed25519/i, 'SSH key'],
  [/\.p12$/i, 'PKCS#12 keystore'],
  [/\.pfx$/i, 'PKCS#12 keystore'],
  [/^credentials\.json$/i, 'credentials file'],
  [/^secrets\.(?:.+\.)?(?:json|ya?ml)$/i, 'secrets file'],
];
const SECRET_EXEMPT = /(?:\.(?:example|sample|template)|\.pub)$/i;
const HOOKS_ADVICE = 'Run the hooks and fix what they report. If a hook is wrong, ask the user before bypassing it.';

export interface GitCall {
  sub: string;
  args: string[];
  cwd: string;
  configs: string[];
  env: Record<string, string>;
}

export function parseGitCall(argv: string[], cwd: string, env: Record<string, string>, ctx: Ctx): GitCall {
  const configs: string[] = [];
  let at = cwd;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (arg === '-C') {
      const dir = ctx.paths.expand(argv[i + 1] ?? '', ctx.home);
      if (dir !== null && dir !== '') at = ctx.paths.resolve(at, dir);
      i += 2;
    } else if (arg === '-c') {
      configs.push(argv[i + 1] ?? '');
      i += 2;
    } else if (arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace' || arg === '--exec-path') {
      i += 2;
    } else if (arg.startsWith('-')) {
      i++;
    } else {
      break;
    }
  }
  return { sub: argv[i] ?? '', args: argv.slice(i + 1), cwd: at, configs, env };
}

export function secretKind(file: string): string | null {
  const base = file.split(/[\\/]/).pop() as string;
  if (SECRET_EXEMPT.test(base)) return null;
  for (const [pattern, kind] of SECRET_NAMES) {
    if (pattern.test(base)) return kind;
  }
  return null;
}

function skipHooks(call: GitCall): Decision | null {
  const parsed = parseArgs(call.args, call.sub === 'commit' ? COMMIT_SPEC : {});
  const hooked = HOOK_SUBS.has(call.sub);
  if (parsed.flags.includes('--no-verify')) {
    return block('skip-git-hooks', `--no-verify skips git hooks. ${HOOKS_ADVICE}`);
  }
  if (call.sub === 'commit' && parsed.flags.includes('-n')) {
    return block('skip-git-hooks', `git commit -n skips git hooks. ${HOOKS_ADVICE}`);
  }
  if (call.configs.some((c) => /^core\.hookspath=/i.test(c))) {
    return block('skip-git-hooks', `Overriding core.hooksPath disables git hooks. ${HOOKS_ADVICE}`);
  }
  if (hooked && call.env.HUSKY === '0') {
    return block('skip-git-hooks', `HUSKY=0 disables git hooks. ${HOOKS_ADVICE}`);
  }
  if (hooked && (call.env.SKIP ?? '') !== '') {
    return block('skip-git-hooks', `SKIP=${call.env.SKIP} disables pre-commit hooks. ${HOOKS_ADVICE}`);
  }
  return null;
}

function lostWork(sub: string, parsed: ParsedArgs): string | null {
  const flags = parsed.flags;
  const force = flags.includes('-f') || flags.includes('--force');
  switch (sub) {
    case 'reset':
      return flags.includes('--hard') ? 'git reset --hard' : null;
    case 'clean':
      return force && !flags.includes('-n') && !flags.includes('--dry-run') ? 'git clean -f' : null;
    case 'checkout':
      return force || parsed.rest.length > 0 || parsed.positionals.includes('.') ? 'git checkout (discards file changes)' : null;
    case 'switch':
      return force || flags.includes('--discard-changes') ? 'git switch --discard-changes' : null;
    case 'restore': {
      const staged = flags.includes('--staged') || flags.includes('-S');
      const worktree = flags.includes('--worktree') || flags.includes('-W');
      return !staged || worktree ? 'git restore (discards file changes)' : null;
    }
    case 'stash': {
      const action = parsed.positionals[0];
      return action === 'drop' || action === 'clear' ? `git stash ${action}` : null;
    }
    default:
      return null;
  }
}

function destructive(call: GitCall, ctx: Ctx): Decision | null {
  const what = lostWork(call.sub, parseArgs(call.args, DESTRUCTIVE_SPECS.get(call.sub)));
  if (what === null || !ctx.git.trackedDirty(call.cwd)) return null;
  return block(
    'destructive-git-dirty',
    `${what} would destroy uncommitted changes. Commit them or run "git stash push -u" first; the command is allowed once the worktree is clean.`,
  );
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
  if (parsed.flags.some((f) => f === '--all' || f === '--mirror' || f === '--branches')) {
    targets.push({ name: '*', forced: globalForce, deleting: false });
  }
  for (const spec of specs) {
    const plus = spec.startsWith('+');
    const body = plus ? spec.slice(1) : spec;
    const colon = body.indexOf(':');
    const src = colon === -1 ? body : body.slice(0, colon);
    let dst = colon === -1 ? body : body.slice(colon + 1);
    if (colon === -1 && src === 'HEAD') dst = ctx.git.currentBranch(call.cwd) ?? '';
    const isBranch = dst.startsWith('refs/heads/') || !dst.startsWith('refs/');
    const name = dst.replace(/^refs\/heads\//, '');
    if (isBranch && name !== '') targets.push({ name, forced: plus || globalForce, deleting: deleteFlag || src === '' });
  }
  if (specs.length === 0 && targets.length === 0 && !deleteFlag && !parsed.flags.includes('--tags')) {
    const current = ctx.git.currentBranch(call.cwd);
    if (current !== null) targets.push({ name: current, forced: globalForce, deleting: false });
  }
  return targets;
}

function push(call: GitCall, ctx: Ctx): Decision | null {
  const parsed = parseArgs(call.args, PUSH_SPEC);
  const remote = parsed.positionals[0] ?? 'origin';
  let defaultBranch: string | null | undefined;
  const isProtected = (name: string): boolean => {
    if (name.includes('*') || PROTECTED.has(name) || name.startsWith('release/')) return true;
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
    pending ??= target.deleting
      ? ask('push-delete-protected', `This deletes protected branch "${target.name}" on the remote.`)
      : ask('push-protected', `This pushes directly to protected branch "${target.name}". Prefer a feature branch and a PR.`);
  }
  return pending;
}

function stagedCandidates(call: GitCall, ctx: Ctx): string[] {
  const parsed = parseArgs(call.args, COMMIT_SPEC);
  const all = parsed.flags.includes('-a') || parsed.flags.includes('--all');
  return [...ctx.git.stagedFiles(call.cwd), ...(all ? ctx.git.modifiedFiles(call.cwd) : []), ...parsed.positionals, ...parsed.rest];
}

function addCandidates(call: GitCall, ctx: Ctx): string[] {
  const parsed = parseArgs(call.args, { valueLong: ['--pathspec-from-file'] });
  const specs = [...parsed.positionals, ...parsed.rest];
  const updateOnly = parsed.flags.includes('-u') || parsed.flags.includes('--update');
  const everything = parsed.flags.includes('-A') || parsed.flags.includes('--all') || specs.some((s) => s === '.' || s === ':/' || s === '*');
  const prefixes = specs.map((s) => s.replace(/^\.\//, '').replace(/\/+$/, ''));
  const modified = ctx.git.modifiedFiles(call.cwd);
  const pool = updateOnly ? modified : [...ctx.git.untrackedFiles(call.cwd), ...modified];
  const matched = everything || updateOnly ? pool : pool.filter((f) => prefixes.some((p) => f === p || f.startsWith(`${p}/`)));
  return [...specs, ...matched];
}

function secrets(call: GitCall, ctx: Ctx): Decision | null {
  const files = call.sub === 'commit' ? stagedCandidates(call, ctx) : addCandidates(call, ctx);
  for (const file of files) {
    const kind = secretKind(file);
    if (kind !== null) {
      return block(
        'secrets-commit',
        `"${file}" looks like a ${kind}. Do not commit secrets: add it to .gitignore, unstage it ("git restore --staged"), and commit a .env.example with placeholders instead.`,
      );
    }
  }
  return null;
}

export function evaluateGit(call: GitCall, ctx: Ctx): Decision | null {
  const checked = skipHooks(call) ?? destructive(call, ctx) ?? (call.sub === 'commit' || call.sub === 'add' ? secrets(call, ctx) : null);
  if (checked) return checked;
  return call.sub === 'push' ? push(call, ctx) : null;
}
