import type { Simple } from './command.ts';
import { ask, block, type Ctx, type Decision } from './types.ts';

const DELETERS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);
const CMD_STYLE = new Set(['del', 'erase', 'rd', 'rmdir']);
const CMD_RECURSIVE_ALONE = new Set(['rd', 'rmdir']);
const SKIP_VALUE = /^-(?:inc|exc|fil|str|cred)/i;
const BROAD_GLOB = /^(?:\.?\*+|\*+\.\*)$/;

type Kind = 'root' | 'home' | 'repo' | 'outside';

const KIND_TEXT: Record<Kind, string> = {
  root: 'the filesystem root',
  home: 'the home directory',
  repo: 'the repository root',
  outside: 'a path outside the repository',
};

export function isDeleter(name: string): boolean {
  return DELETERS.has(name);
}

interface Flags {
  recursive: boolean;
  force: boolean;
  cmdRecursive: boolean;
  targets: string[];
}

function isPathParam(token: string): boolean {
  const param = token.slice(1).toLowerCase();
  return (param.length >= 2 && 'path'.startsWith(param)) || (param !== '' && 'literalpath'.startsWith(param));
}

function applyShortFlag(token: string, flags: Flags): void {
  const body = token.slice(1);
  const lower = body.toLowerCase();
  if (body === '') return;
  if ('recurse'.startsWith(lower)) flags.recursive = true;
  else if ('force'.startsWith(lower)) flags.force = true;
  else {
    for (const ch of body) {
      if (ch === 'r' || ch === 'R') flags.recursive = true;
      if (ch === 'f') flags.force = true;
    }
  }
}

function parseDeleteArgs(name: string, argv: string[]): Flags {
  const flags: Flags = { recursive: false, force: false, cmdRecursive: false, targets: [] };
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
    } else if (arg === '--recursive') {
      flags.recursive = true;
    } else if (arg === '--force') {
      flags.force = true;
    } else if (arg.startsWith('--') || arg === '-') {
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
        applyShortFlag(token, flags);
      }
    } else {
      flags.targets.push(arg);
    }
  }
  return flags;
}

function classify(resolved: string, ctx: Ctx, root: string, home: string): Kind | null {
  if (ctx.paths.isFsRoot(resolved)) return 'root';
  if (ctx.paths.same(resolved, home)) return 'home';
  if (ctx.paths.same(resolved, root)) return 'repo';
  if (!ctx.paths.isInside(root, resolved)) return 'outside';
  return null;
}

function checkTarget(word: string, cwd: string, ctx: Ctx, root: string, home: string): string | null {
  const expanded = ctx.paths.expand(word, ctx.home);
  if (expanded === null) return 'it uses an unexpanded variable or command substitution';
  const glob = /[*?[]/.exec(expanded);
  if (!glob) {
    const kind = classify(ctx.paths.resolve(cwd, expanded), ctx, root, home);
    return kind === null ? null : `it is ${KIND_TEXT[kind]}`;
  }
  const prefix = expanded.slice(0, glob.index);
  const cut = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  const dir = ctx.paths.resolve(cwd, cut === -1 ? '.' : prefix.slice(0, cut + 1));
  const kind = classify(dir, ctx, root, home);
  const broad = BROAD_GLOB.test(expanded.slice(cut + 1));
  if (kind === 'repo') return broad ? 'the glob matches everything in the repository root' : null;
  return kind === null ? null : `the glob is in ${KIND_TEXT[kind]}`;
}

export function evaluateDelete(simple: Simple, cwd: string, ctx: Ctx): Decision | null {
  const flags = parseDeleteArgs(simple.name, simple.argv);
  const wipes = CMD_RECURSIVE_ALONE.has(simple.name) ? flags.cmdRecursive || (flags.recursive && flags.force) : flags.recursive && flags.force;
  if (!wipes) return null;
  const root = ctx.paths.resolve(ctx.cwd, ctx.git.repoRoot(ctx.cwd) ?? ctx.cwd);
  const home = ctx.paths.resolve(ctx.cwd, ctx.home);
  for (const target of flags.targets) {
    const why = checkTarget(target, cwd, ctx, root, home);
    if (why === null) continue;
    const reason = `Recursive delete of "${target}" refused: ${why}.`;
    if (why.startsWith('it uses')) {
      return ask('recursive-delete-unresolved', `${reason} Use a literal path inside the repository, e.g. rm -rf dist.`);
    }
    return block('recursive-delete', `${reason} Delete only specific paths inside the repository (e.g. rm -rf node_modules dist), or ask the user to run it.`);
  }
  return null;
}
