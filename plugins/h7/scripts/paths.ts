import path from 'node:path';

export type Platform = 'win32' | 'posix';
export type Realpath = (p: string) => string;

export interface Paths {
  resolve(base: string, target: string): string;
  isInside(root: string, target: string): boolean;
  same(a: string, b: string): boolean;
  isFsRoot(target: string): boolean;
  /** Forward-slash path of target relative to root; empty for root itself, null when outside. */
  relative(root: string, target: string): string | null;
  /** vars maps names to literal values, or to null when the command itself reassigns them (then they stay unresolved). */
  expand(word: string, home: string, vars?: Record<string, string | null>): string | null;
}

const NAMED_VARIABLE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}|\$(?:env:)?([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g;
const HOME_VARIABLE = /\$\{(?:env:)?(?:HOME|USERPROFILE)\}|\$(?:env:)?(?:HOME|USERPROFILE)(?![A-Za-z0-9_])|%(?:USERPROFILE|HOME)%/gi;

export function makePaths(platform: Platform, realpath: Realpath): Paths {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const fold = (p: string): string => (platform === 'win32' ? p.toLowerCase() : p);

  const normalize = (p: string): string => {
    const msys = /^\/([a-zA-Z])(?:\/|$)/.exec(p);
    if (platform === 'win32' && msys) return `${msys[1]}:${p.slice(2) || '/'}`;
    return p;
  };

  const canonical = (p: string): string => {
    const rest: string[] = [];
    let current = p;
    for (;;) {
      try {
        const real = realpath(current);
        return rest.length === 0 ? real : api.join(real, ...rest.reverse());
      } catch {
        const parent = api.dirname(current);
        if (parent === current) return p;
        rest.push(api.basename(current));
        current = parent;
      }
    }
  };

  const resolve = (base: string, target: string): string => canonical(api.resolve(normalize(base), normalize(target)));

  const same = (a: string, b: string): boolean => fold(api.resolve(a)) === fold(api.resolve(b));

  const isInside = (root: string, target: string): boolean => {
    const rel = api.relative(fold(api.resolve(root)), fold(api.resolve(target)));
    if (rel === '') return true;
    return rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
  };

  const isFsRoot = (target: string): boolean => {
    const resolved = api.resolve(target);
    return api.parse(resolved).root === resolved;
  };

  const lookup = (name: string, vars: Record<string, string | null>): string | null | undefined => {
    const key = Object.keys(vars).find((k) => fold(k) === fold(name));
    return key === undefined ? undefined : vars[key];
  };

  const expand = (word: string, home: string, vars: Record<string, string | null> = {}): string | null => {
    let s = word;
    const homeKnown = lookup('HOME', vars) !== null && lookup('USERPROFILE', vars) !== null;
    if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
      if (!homeKnown) return null;
      s = home + s.slice(1);
    }
    s = s.replace(HOME_VARIABLE, (match) => (homeKnown ? home : match));
    s = s.replace(NAMED_VARIABLE, (match, braced, bare, percent) => lookup(braced ?? bare ?? percent, vars) ?? match);
    if (/^~./.test(s) || /[$`]/.test(s)) return null;
    if (platform === 'win32' && /%[A-Za-z_][A-Za-z0-9_]*%/.test(s)) return null;
    return s;
  };

  const relative = (root: string, target: string): string | null =>
    isInside(root, target) ? api.relative(api.resolve(root), api.resolve(target)).split(api.sep).join('/') : null;

  return { resolve, isInside, same, isFsRoot, relative, expand };
}
