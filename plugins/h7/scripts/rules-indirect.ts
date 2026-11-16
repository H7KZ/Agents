import type { Simple } from './command.ts';
import { ask, type Decision } from './types.ts';

const RULE = 'indirect-exec';
/** Shells and interpreters: fed from a pipe, heredoc or process substitution they run code the guard cannot see. */
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|ash|fish|python[\d.]*|node|deno|bun|perl|ruby|php|pwsh|powershell|pwsh-preview|cmd|osascript)$/;
/** Inline-program flags of interpreters whose -c/-e text is not re-scanned as shell. Shells, pwsh and cmd are re-scanned instead. */
const INLINE_FLAGS: [RegExp, string[]][] = [
  [/^python[\d.]*$/, ['-c']],
  [/^node$/, ['-e', '-p', '--eval', '--print']],
  [/^perl$/, ['-e', '-E']],
  [/^(?:ruby|osascript)$/, ['-e']],
  [/^php$/, ['-r']],
];
const DANGEROUS = /\b(?:rm\w*|unlink\w*|shutil|child_process|exec\w*|subprocess|Remove-Item)\b|os\.system|git\s+push/i;
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
  /** Stdin comes from a heredoc, here-string, file redirect or process substitution. */
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

/** The literal program text passed with an inline flag, if the interpreter has one. */
function inlineProgram(name: string, argv: string[]): string | null {
  const flags = INLINE_FLAGS.find(([pattern]) => pattern.test(name))?.[1] ?? [];
  const at = argv.findIndex((arg) => flags.includes(arg));
  return at === -1 ? null : (argv[at + 1] ?? '');
}

function interpreter(name: string, argv: string[], flow: Flow): Decision | null {
  if (flow.piped || flow.input || argv.includes('-s') || argv.includes('-')) return indirect(`Feeding ${name} from stdin`);
  const program = inlineProgram(name, argv);
  return program !== null && DANGEROUS.test(program) ? indirect(`${name} with an inline program that deletes, executes or pushes`) : null;
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
  return INTERPRETER.test(name) ? interpreter(name, argv, flow) : null;
}
