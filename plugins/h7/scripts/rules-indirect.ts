import type { Simple } from './command.ts';
import { ask, type Decision } from './types.ts';

const RULE = 'indirect-exec';
const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'pwsh', 'powershell', 'pwsh-preview', 'cmd',
  'python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno',
]);
const EVALUATORS = new Set(['invoke-expression', 'iex']);
const XARGS_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-d', '-L', '-E', '-s', '-a', '-l']);
const XARGS_SAFE = new Set([
  'echo', 'cat', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'ls', 'head', 'tail', 'sort', 'uniq', 'printf', 'basename', 'dirname',
  'file', 'stat', 'du', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'realpath', 'readlink',
]);

export interface Flow {
  /** Stdin comes from a pipe. */
  piped: boolean;
  /** Stdin comes from a heredoc, here-string or file redirect. */
  input: boolean;
  /** PowerShell call operator (&) started the command. */
  call: boolean;
  powershell: boolean;
}

function indirect(what: string): Decision {
  return ask(RULE, `${what} runs code the guard cannot inspect. Run the real commands directly, one at a time.`);
}

function xargsCommand(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') return argv[i + 1] ?? null;
    if (!arg.startsWith('-')) return arg;
    if (XARGS_VALUE_FLAGS.has(arg)) i++;
  }
  return null;
}

export function evaluateIndirection(simple: Simple, flow: Flow): Decision | null {
  const { name, argv, raw } = simple;
  const dynamic = /[$`]/.test(raw) && argv[0] !== '=' && (!flow.powershell || flow.call);
  if (dynamic) return indirect(`The command word "${raw}"`);
  if (EVALUATORS.has(name)) return indirect(name);
  if (name === 'xargs') {
    const command = xargsCommand(argv);
    const base = command === null ? 'echo' : (command.split(/[\\/]/).pop() as string).toLowerCase();
    return XARGS_SAFE.has(base) ? null : indirect(`xargs ${command ?? ''}`.trim());
  }
  if (!INTERPRETERS.has(name)) return null;
  const readsStdin = flow.piped || flow.input;
  const hasProgram = argv.some((arg) => !arg.startsWith('-'));
  const explicitStdin = argv.includes('-s') || argv.includes('-');
  if (explicitStdin || (readsStdin && !hasProgram)) return indirect(`Feeding ${name} from stdin`);
  return null;
}
