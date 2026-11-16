import { parseSimple } from './command.ts';
import { tokenize, type Dialect } from './tokenize.ts';

const READERS = new Set(['cat', 'ls', 'head', 'tail', 'grep', 'rg', 'wc', 'stat', 'type', 'get-content', 'get-childitem', 'select-string', 'gc', 'gci', 'dir', 'sls']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show']);
/** Options that write or run something even on a "read" command (git diff --output, rg --pre, ...). */
const WRITING_OPTION = /^(?:--output|-o$|--pre|--hostname-bin|--ext-diff|--textconv|-ext)/i;
const DYNAMIC = /[$`]/;

/**
 * True only when every simple command in the text is a plain reader (cat, ls, head, tail, grep, rg, wc, stat, type, Get-Content, Get-ChildItem,
 * Select-String, git status/diff/log/show) with no output redirect, substitution, variable, heredoc or option that writes. Built on the shell
 * tokens (so quoting tricks resolve to the real command word); the raw-text checks for `>`, `$` and backticks are deliberately broader than the tokens.
 * Anything doubtful is false: callers treat false as "may write".
 */
export function isReadOnly(text: string, dialect: Dialect): boolean {
  if (text.includes('>') || DYNAMIC.test(text)) return false;
  const tokens = tokenize(text, dialect);
  if (tokens.nested.length > 0 || tokens.ambiguous || tokens.inputs.some(Boolean) || tokens.calls.some(Boolean) || tokens.segments.length === 0) return false;
  return tokens.segments.every((words) => {
    const simple = parseSimple(words);
    if (simple.name === '' || Object.keys(simple.env).length > 0 || simple.argv.some((arg) => WRITING_OPTION.test(arg))) return false;
    if (simple.name === 'git') return GIT_READ.has(simple.argv[0] ?? '');
    return READERS.has(simple.name);
  });
}
