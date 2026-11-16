import type { Simple } from './command.ts';
import { ask, type Decision } from './types.ts';

const RULE = 'indirect-exec';
/** Shells and interpreters: fed from a pipe, heredoc or process substitution they run code the guard cannot see. */
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|ash|fish|python[\d.]*|pypy[\d.]*|py|node|nodejs|deno|bun|perl[\d.]*|ruby[\d.]*|php[\d.]*|pwsh|powershell|pwsh-preview|cmd|osascript|rscript|lua[\d.]*)$/;
/** Interpreters whose inline or script arguments are not re-scanned as shell (shells, pwsh and cmd are). */
const NON_SHELL = /^(?:python[\d.]*|pypy[\d.]*|py|node|nodejs|deno|bun|perl[\d.]*|ruby[\d.]*|php[\d.]*|osascript|Rscript|lua[\d.]*)$/i;
/**
 * Fail closed, no flag parsing and no denylist: an argument word that looks like code (shell or program punctuation, whitespace
 * inside one word, a data: or http(s): URL) means the interpreter may run a program the guard cannot read. Plain flags, paths and
 * module names (`-m pytest`, `--test`, `script.ts arg`) pass. Per-interpreter option grammars and token denylists were bypassed.
 */
const CODE_LIKE = /[(){};`$=><|&'"\s]|^(?:data|https?):/i;
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

function interpreter(name: string, argv: string[], flow: Flow): Decision | null {
  if (flow.piped || flow.input || argv.includes('-s') || argv.includes('-')) return indirect(`Feeding ${name} from stdin`);
  return NON_SHELL.test(name) && argv.some((word) => CODE_LIKE.test(word)) ? indirect(`${name} with an argument that looks like code`) : null;
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
