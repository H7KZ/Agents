import type { Simple } from './command.ts';
import { ask, type Decision } from './types.ts';

const RULE = 'indirect-exec';
const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'pwsh', 'powershell', 'pwsh-preview', 'cmd',
  'python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno',
]);
const SHELL_LIKE = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish'];
const POWERSHELLS = ['pwsh', 'powershell', 'pwsh-preview'];
const EXACT_FLAGS: Record<string, string[]> = {
  python: ['-c', '-m'],
  python3: ['-c', '-m'],
  node: ['-e', '-p', '--eval', '--print'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
};
const POWERSHELL_PARAMS = ['command', 'encodedcommand', 'file'];

/** Per-interpreter test for a flag that hands the program over inline (or as a script file), so stdin is data. */
function isProgramFlag(name: string, arg: string): boolean {
  if (SHELL_LIKE.includes(name)) return /^-[A-Za-z]*c[A-Za-z]*$/.test(arg);
  if (POWERSHELLS.includes(name)) {
    const param = arg.replace(/^[-/]/, '').toLowerCase();
    return /^[-/]/.test(arg) && param !== '' && (param === 'ec' || POWERSHELL_PARAMS.some((full) => full.startsWith(param)));
  }
  if (name === 'cmd') return ['/c', '/k'].includes(arg.toLowerCase());
  return (EXACT_FLAGS[name] ?? []).includes(arg);
}
const EVALUATORS = new Set(['invoke-expression', 'iex']);
const XARGS_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-d', '-L', '-E', '-s', '-a']);
/** Flags with no value, or with an optional value that can only be attached (-i, -l, -e). */
const XARGS_PLAIN = /^-(?:[0rtpxoile]+|[ile].*)$/;
const XARGS_LONG_PLAIN = new Set([
  '--null', '--no-run-if-empty', '--verbose', '--interactive', '--exit', '--open-tty', '--show-limits', '--version', '--help',
]);
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

type XargsCommand = { kind: 'none' } | { kind: 'command'; name: string } | { kind: 'unknown' };

/** Finds the command xargs will run; anything it cannot place with certainty is "unknown". */
function xargsCommand(argv: string[]): XargsCommand {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') return argv[i + 1] === undefined ? { kind: 'none' } : { kind: 'command', name: argv[i + 1] as string };
    if (!arg.startsWith('-') || arg === '-') return { kind: 'command', name: arg };
    if (XARGS_VALUE_FLAGS.has(arg)) {
      i++;
    } else if (arg.startsWith('--')) {
      if (!arg.includes('=') && !XARGS_LONG_PLAIN.has(arg)) return { kind: 'unknown' };
    } else if (!XARGS_PLAIN.test(arg) && !/^-[InPdLEsa]./.test(arg)) {
      return { kind: 'unknown' };
    }
  }
  return { kind: 'none' };
}

/**
 * True when the interpreter surely gets its program from an argument: a program flag, or a script path that is
 * the first word. A word after other options might be an option's value, so that is not certain.
 */
function programGiven(name: string, argv: string[]): boolean {
  let sawOption = false;
  for (const arg of argv) {
    if (isProgramFlag(name, arg)) return true;
    const option = arg.startsWith('-') || arg.startsWith('+') || (name === 'cmd' && arg.startsWith('/'));
    if (!option) return !sawOption;
    sawOption = true;
  }
  return false;
}

export function evaluateIndirection(simple: Simple, flow: Flow): Decision | null {
  const { name, argv, raw } = simple;
  const dynamic = /[$`]/.test(raw) && (!flow.powershell || flow.call);
  if (dynamic) return indirect(`The command word "${raw}"`);
  if (EVALUATORS.has(name)) return indirect(name);
  if (name === 'xargs') {
    const found = xargsCommand(argv);
    if (found.kind === 'none') return null;
    if (found.kind === 'unknown') return indirect('xargs with options the guard cannot place');
    const base = (found.name.split(/[\\/]/).pop() as string).toLowerCase();
    return XARGS_SAFE.has(base) ? null : indirect(`xargs ${found.name}`);
  }
  if (!INTERPRETERS.has(name)) return null;
  const readsStdin = flow.piped || flow.input;
  const explicitStdin = argv.includes('-s') || argv.includes('-');
  if (explicitStdin || (readsStdin && !programGiven(name, argv))) return indirect(`Feeding ${name} from stdin`);
  return null;
}
