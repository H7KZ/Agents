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
  expand(word: string, home: string): string | null;
}

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

  /** Resolves a leading ~ only; any variable reference ($X, ${X}, $env:X, %X%) or ~user stays unresolved (null). */
  const expand = (word: string, home: string): string | null => {
    let s = word;
    if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = home + s.slice(1);
    if (/^~./.test(s) || /[$`]/.test(s)) return null;
    if (platform === 'win32' && /%[A-Za-z_][A-Za-z0-9_]*%/.test(s)) return null;
    return s;
  };

  const relative = (root: string, target: string): string | null =>
    isInside(root, target) ? api.relative(api.resolve(root), api.resolve(target)).split(api.sep).join('/') : null;

  return { resolve, isInside, same, isFsRoot, relative, expand };
}
