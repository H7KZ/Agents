import type { Simple } from './command.ts';
import { expandBraces } from './braces.ts';
import { commandName } from './command.ts';
import { ask, block, type Ctx, type Decision } from './types.ts';

const DELETERS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);
const CMD_STYLE = new Set(['del', 'erase', 'rd', 'rmdir']);
const CMD_RECURSIVE_ALONE = new Set(['rd', 'rmdir']);
const EXEC_DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'remove-item', 'del']);
const SKIP_VALUE = /^-(?:inc|exc|fil|str|cred)/i;
const BROAD_GLOB = /^(?:\.?\*+|\*+\.\*)$/;

type Kind = 'root' | 'home' | 'repo' | 'gitdir' | 'outside';

const KIND_TEXT: Record<Kind, string> = {
  root: 'the filesystem root',
  home: 'the home directory',
  repo: 'the repository root',
  gitdir: "the repository's .git directory",
  outside: 'a path outside the repository',
};

export function isDeleter(name: string): boolean {
  return DELETERS.has(name);
}

interface Flags {
  recursive: boolean;
  force: boolean;
  cmdRecursive: boolean;
  whatIf: boolean;
  targets: string[];
}

function isPathParam(token: string): boolean {
  const param = token.slice(1).toLowerCase();
  return (param.length >= 2 && 'path'.startsWith(param)) || (param !== '' && 'literalpath'.startsWith(param));
}

function applyShortFlag(token: string, flags: Flags, value: string): void {
  const body = token.slice(1);
  const lower = body.toLowerCase();
  if (body === '') return;
  if (lower.length >= 2 && 'whatif'.startsWith(lower)) {
    // Only a bare -WhatIf or -WhatIf:$true is a dry run; -WhatIf:$false (or anything else) deletes for real.
    if (value === '' || value.toLowerCase() === '$true') flags.whatIf = true;
  }
  else if ('recurse'.startsWith(lower)) flags.recursive = true;
  else if ('force'.startsWith(lower)) flags.force = true;
  else {
    for (const ch of body) {
      if (ch === 'r' || ch === 'R') flags.recursive = true;
      if (ch === 'f') flags.force = true;
    }
  }
}

/** GNU long options may be abbreviated to any unique prefix (--rec, --for). */
function isLong(arg: string, full: string): boolean {
  const name = arg.split('=')[0] as string;
  return name.length >= 3 && full.startsWith(name);
}

function parseDeleteArgs(name: string, argv: string[]): Flags {
  const flags: Flags = { recursive: false, force: false, cmdRecursive: false, whatIf: false, targets: [] };
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const cmdFlag = CMD_STYLE.has(name) && /^\/[a-z]$/i.test(arg) ? arg[1]?.toLowerCase() : undefined;
    if (literal) {
      flags.targets.push(arg);
    } else if (arg === '--') {
      literal = true;
    } else if (cmdFlag !== undefined) {
      if (cmdFlag === 's') {
        flags.recursive = true;
        flags.cmdRecursive = true;
      }
      if (cmdFlag === 'q' || cmdFlag === 'f') flags.force = true;
    } else if (arg.startsWith('--') && arg.length > 2) {
      if (isLong(arg, '--recursive')) flags.recursive = true;
      else if (isLong(arg, '--force')) flags.force = true;
    } else if (arg === '--' || arg === '-') {
      continue;
    } else if (arg.startsWith('-')) {
      const colon = arg.indexOf(':');
      const token = colon === -1 ? arg : arg.slice(0, colon);
      if (isPathParam(token)) {
        const value = colon === -1 ? argv[++i] : arg.slice(colon + 1);
        if (value !== undefined && value !== '') flags.targets.push(value);
      } else if (SKIP_VALUE.test(token)) {
        if (colon === -1) i++;
      } else {
        applyShortFlag(token, flags, colon === -1 ? '' : arg.slice(colon + 1));
      }
    } else {
      flags.targets.push(arg);
    }
  }
  return flags;
}

function insideTemp(resolved: string, ctx: Ctx, allowTempItself: boolean): boolean {
  return ctx.tmp.dirs.some((dir) => ctx.paths.isInside(dir, resolved) && (allowTempItself || !ctx.paths.same(dir, resolved)));
}

function classify(resolved: string, ctx: Ctx, root: string, home: string, glob: boolean): Kind | null {
  if (ctx.paths.isFsRoot(resolved)) return 'root';
  if (ctx.paths.same(resolved, home)) return 'home';
  if (ctx.paths.same(resolved, root)) return 'repo';
  if (insideTemp(resolved, ctx, glob)) return null;
  if (ctx.paths.same(resolved, ctx.paths.resolve(root, '.git'))) return 'gitdir';
  if (!ctx.paths.isInside(root, resolved)) return 'outside';
  return null;
}

const UNRESOLVED = 'it uses an unexpanded variable or command substitution';
const TOO_MANY = 'it has too many brace alternatives to check';
const BROAD = 'the glob matches everything in the repository root';

function checkWord(word: string, cwd: string, ctx: Ctx, root: string, home: string): string | null {
  const expanded = ctx.paths.expand(word, ctx.home);
  if (expanded === null) return UNRESOLVED;
  const glob = /[*?[]/.exec(expanded);
  if (!glob) {
    const kind = classify(ctx.paths.resolve(cwd, expanded), ctx, root, home, false);
    return kind === null ? null : `it is ${KIND_TEXT[kind]}`;
  }
  const prefix = expanded.slice(0, glob.index);
  const cut = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  const dir = ctx.paths.resolve(cwd, cut === -1 ? '.' : prefix.slice(0, cut + 1));
  const kind = classify(dir, ctx, root, home, true);
  const broad = BROAD_GLOB.test(expanded.slice(cut + 1));
  if (kind === 'repo') return broad ? BROAD : null;
  return kind === null ? null : `the glob is in ${KIND_TEXT[kind]}`;
}

function problems(word: string, cwd: string, ctx: Ctx, root: string, home: string): string[] {
  const variants = expandBraces(word);
  if (variants === null) return [TOO_MANY];
  return variants.flatMap((variant) => checkWord(variant, cwd, ctx, root, home) ?? []);
}

const SOFT = new Set([UNRESOLVED, TOO_MANY, BROAD]);

function locations(ctx: Ctx): { root: string; home: string } {
  return { root: ctx.paths.resolve(ctx.cwd, ctx.git.repoRoot(ctx.cwd) ?? ctx.cwd), home: ctx.paths.resolve(ctx.cwd, ctx.home) };
}

export function evaluateDelete(simple: Simple, cwd: string, ctx: Ctx, piped = false): Decision | null {
  const flags = parseDeleteArgs(simple.name, simple.argv);
  if (flags.whatIf) return null;
  const wipes =
    simple.name === 'rm'
      ? flags.recursive
      : CMD_RECURSIVE_ALONE.has(simple.name)
        ? flags.cmdRecursive || (flags.recursive && flags.force)
        : flags.recursive && flags.force;
  if (!wipes && !(piped && (flags.recursive || flags.force) && flags.targets.length === 0)) return null;
  if (flags.targets.length === 0) {
    return ask('recursive-delete-unresolved', 'Recursive delete with no literal target (piped, parenthesised or missing path) cannot be checked. Use a literal path inside the repository, e.g. rm -rf dist.');
  }
  const { root, home } = locations(ctx);
  let soft: Decision | null = null;
  for (const target of flags.targets) {
    for (const why of problems(target, cwd, ctx, root, home)) {
      const reason = `Recursive delete of "${target}" refused: ${why}.`;
      if (why === BROAD) {
        soft ??= ask('recursive-delete-broad', `${reason} Name the specific entries to remove, e.g. rm -rf dist build.`);
      } else if (SOFT.has(why)) {
        soft ??= ask('recursive-delete-unresolved', `${reason} Use a literal path inside the repository, e.g. rm -rf dist.`);
      } else {
        return block('recursive-delete', `${reason} Delete only specific paths inside the repository (e.g. rm -rf node_modules dist), or ask the user to run it.`);
      }
    }
  }
  return soft;
}

const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/** Commands that run another command, so what -exec really does cannot be seen: treated like a delete. */
const OPAQUE_EXEC = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'pwsh', 'powershell', 'cmd', 'sudo', 'doas', 'env', 'xargs', 'busybox',
  'nice', 'nohup', 'timeout', 'time', 'command', 'exec', 'eval',
]);

function findDeletes(argv: string[]): boolean {
  return argv.some((arg, i) => {
    if (arg === '-delete') return true;
    const exec = FIND_ACTIONS.has(arg) ? commandName(argv[i + 1] ?? '') : '';
    return EXEC_DELETERS.has(exec) || OPAQUE_EXEC.has(exec);
  });
}

function findStarts(argv: string[]): string[] {
  const starts: string[] = [];
  for (const arg of argv) {
    if (/^-[HLPO]$/.test(arg) || /^-D./.test(arg)) continue;
    if (arg.startsWith('-') || arg === '(' || arg === '!') break;
    starts.push(arg);
  }
  return starts.length === 0 ? ['.'] : starts;
}

export function evaluateFind(simple: Simple, cwd: string, ctx: Ctx): Decision | null {
  if (!findDeletes(simple.argv)) return null;
  const { root, home } = locations(ctx);
  let unresolved = false;
  let inside = false;
  for (const start of findStarts(simple.argv)) {
    const expanded = ctx.paths.expand(start, ctx.home);
    if (expanded === null) {
      unresolved = true;
      continue;
    }
    const resolved = ctx.paths.resolve(cwd, expanded);
    if (insideTemp(resolved, ctx, true)) continue;
    const kind = classify(resolved, ctx, root, home, false);
    if (kind !== null && kind !== 'repo') {
      return block('recursive-delete', `find ${start} -delete would delete files in ${KIND_TEXT[kind]}. Delete only specific paths inside the repository, or ask the user to run it.`);
    }
    inside = true;
  }
  if (!inside && !unresolved) return null;
  return ask('find-delete', 'find with -delete or -exec rm removes whatever matches. Confirm the start path and filters with the user, or delete specific paths with rm.');
}
