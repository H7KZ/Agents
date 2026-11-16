import type { Simple } from './command.ts';
import { ask, type Decision } from './types.ts';

const RULE = 'indirect-exec';
/** Shells and interpreters: fed from a pipe, heredoc or process substitution they run code the guard cannot see. */
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|ash|fish|python[\d.]*|pypy[\d.]*|py|node|nodejs|deno|bun|perl[\d.]*|ruby[\d.]*|php[\d.]*|pwsh|powershell|pwsh-preview|cmd|osascript|rscript|lua[\d.]*)$/;
/** Interpreters whose inline or script arguments are not re-scanned as shell (shells, pwsh and cmd are). */
const NON_SHELL = /^(?:python[\d.]*|pypy[\d.]*|py|node|nodejs|deno|bun|perl[\d.]*|ruby[\d.]*|php[\d.]*|osascript|Rscript|lua[\d.]*)$/i;
const PYTHON = /^(?:python[\d.]*|pypy[\d.]*|py)$/i;
const JS_RUNTIME = /^(?:node|nodejs|bun|deno)$/i;
const PYTHON_FLAGS = new Set(['-u', '-B', '-O', '-OO', '-q', '-I', '-s']);
const JS_FLAGS = new Set(['--test', '--watch', '--enable-source-maps', '--no-warnings', '--experimental-strip-types', '--experimental-test-coverage', '--inspect']);
const SCHEME = /^[a-z][\w+.-]*:/i;
const WINDOWS_PATH = /^[A-Za-z]:[\\/][\w./\\@+*-]*$/;
const PLAIN_WORD = /^[\w./@:+*-]+$/;
const SCRIPT_FLAG = /^--?[\w-]+(=[\w./:@+*-]*)?$/;

/** A file path or module name: no leading dash, no URL scheme (data:, npm:, file:, http:...), no UNC or protocol-relative start. */
function isPositional(word: string): boolean {
  if (WINDOWS_PATH.test(word)) return true;
  return !word.startsWith('-') && !word.startsWith('//') && PLAIN_WORD.test(word) && !SCHEME.test(word);
}

/** bun and deno subcommands that manage packages or tooling without running a program (publish and installs are judged by the deploy rules). */
const NON_RUNNING_SUBCOMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'update', 'upgrade', 'publish', 'pm', 'link', 'unlink', 'outdated', 'audit', 'init', 'build', 'fmt', 'lint', 'check', 'doc', 'info', 'bench', 'compile', 'cache', 'help', 'version']);

/** A flag of the script itself; a value after = must be as plain as a path (no URL scheme, no // or \\ start). */
function scriptFlag(word: string): boolean {
  if (!SCRIPT_FLAG.test(word)) return false;
  const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : '';
  return !value.startsWith('//') && (!SCHEME.test(value) || /^[A-Za-z]:[\\/]/.test(value));
}

/**
 * Strict allowlist, no denylist and no per-interpreter flag grammar beyond a handful of known-safe flags: a non-shell
 * interpreter call passes only when every word is an allowed flag, a plain path or module name, or (after the script or
 * `-m module`) an argument of that script. Anything else could carry a program the guard cannot read, so it asks.
 */
function placeable(name: string, argv: string[]): boolean {
  const python = PYTHON.test(name);
  const js = JS_RUNTIME.test(name);
  const runner = /^(?:bun|deno)$/i.test(name);
  const deno = /^deno$/i.test(name);
  let script = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (script) {
      if (isPositional(word) || scriptFlag(word)) continue;
      return false;
    }
    if (runner && i === 0) {
      // run and test are runtime context, not the script: runtime flags are still checked until the real script positional.
      if (word === 'run' || word === 'test') continue;
      if (NON_RUNNING_SUBCOMMANDS.has(word)) return true;
      if (!/[./\\]/.test(word)) return false;
    }
    if (deno && /^(?:-A|--allow-[a-z-]+)$/.test(word)) continue;
    if (python && word === '-m') {
      if (!/^[\w.]+$/.test(argv[++i] ?? '')) return false;
      script = true;
    } else if (python && word === '-W') {
      if (!/^[\w:.]+$/.test(argv[++i] ?? '')) return false;
    } else if (!(python && PYTHON_FLAGS.has(word)) && !(js && (JS_FLAGS.has(word) || /^--test-reporter=\w+$/.test(word)))) {
      if (!isPositional(word) || (js && (word === 'eval' || word === 'repl'))) return false;
      script = true;
    }
  }
  return true;
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
  return NON_SHELL.test(name) && !placeable(name, argv) ? indirect(`${name} with arguments that are not a plain script path or known-safe flags`) : null;
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
