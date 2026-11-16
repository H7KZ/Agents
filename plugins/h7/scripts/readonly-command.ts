import { tokenize, type Dialect } from './tokenize.ts';

const SH_READERS = new Set(['cat', 'ls', 'head', 'tail', 'grep', 'rg', 'wc', 'stat']);
const PS_READERS = new Set([...SH_READERS, 'type', 'get-content', 'get-childitem', 'select-string', 'gc', 'gci', 'dir', 'sls']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show']);
/** Options that write or run something even on a "read" command (git diff --output, rg --pre, ...). */
const WRITING_OPTION = /^(?:--output|-o$|--pre|--hostname-bin|--ext-diff|--textconv|-ext)/i;
const DYNAMIC = /[$`]/;

/** The command word as written must be exactly a bare reader name (optional .exe; PowerShell names are case-insensitive): no path, wrapper, other extension. */
function readerName(word: string, dialect: Dialect): string {
  const bare = dialect === 'ps' ? word.toLowerCase() : word;
  return bare.replace(/\.exe$/, '');
}

/**
 * True only when every simple command in the text STARTS with a plain reader (cat, ls, head, tail, grep, rg, wc, stat, type, Get-Content,
 * Get-ChildItem, Select-String, git status/diff/log/show) written as a bare name: no wrapper before it (env, sudo, timeout, nohup, exec, ...), no
 * path or script extension, no assignment. No output redirect, substitution, variable, heredoc or writing option. The raw-text checks for `>`,
 * `$` and backticks are deliberately broader than the tokens. Anything doubtful is false: callers treat false as "may write".
 */
export function isReadOnly(text: string, dialect: Dialect): boolean {
  if (text.includes('>') || DYNAMIC.test(text)) return false;
  const tokens = tokenize(text, dialect);
  if (tokens.nested.length > 0 || tokens.ambiguous || tokens.inputs.some(Boolean) || tokens.calls.some(Boolean) || tokens.segments.length === 0) return false;
  const readers = dialect === 'ps' ? PS_READERS : SH_READERS;
  return tokens.segments.every(([first = '', ...args]) => {
    if (args.some((arg) => WRITING_OPTION.test(arg))) return false;
    const name = readerName(first, dialect);
    return name === 'git' ? GIT_READ.has(args[0] ?? '') : readers.has(name);
  });
}
