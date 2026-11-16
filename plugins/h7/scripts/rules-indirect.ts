import type { Simple } from './command.ts';
import { ask, type Decision } from './types.ts';

const RULE = 'indirect-exec';
/** Shells and interpreters: fed from a pipe, heredoc or process substitution they run code the guard cannot see. */
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|ash|fish|python[\d.]*|pypy[\d.]*|py|node|nodejs|deno|bun|perl[\d.]*|ruby[\d.]*|php[\d.]*|pwsh|powershell|pwsh-preview|cmd|osascript)$/;
/**
 * Short-option grammar of interpreters whose inline program (-c, -e, ...) is not re-scanned as shell. Shells, pwsh and cmd are
 * re-scanned instead. `program` letters start an inline program, `value` letters take an argument (attached or next word),
 * `bool` letters take none and `stop` letters end option parsing (python -m runs a module with its own arguments).
 * A letter in none of these sets is an option the guard cannot place.
 */
interface InlineSpec {
  program: string;
  long: string[];
  bool: string;
  value: string;
  stop: string;
}

const DIGITS = '0123456789';
const INLINE_SPECS: [RegExp, InlineSpec][] = [
  [/^(?:python[\d.]*|pypy[\d.]*|py)$/, { program: 'c', long: [], bool: 'BbdEhiIOPqRsSuvVx', value: 'WXQ', stop: 'm' }],
  [/^(?:node|nodejs)$/, { program: 'ep', long: ['--eval', '--print'], bool: 'vhci', value: 'rC', stop: '' }],
  [/^perl[\d.]*$/, { program: 'eE', long: [], bool: `acnpsStTuUwWXhvl${DIGITS}`, value: 'IMmiFCVdDxA', stop: '' }],
  [/^ruby[\d.]*$/, { program: 'e', long: [], bool: `acdhlnpsSvwWyU${DIGITS}`, value: 'CEFiIKrxT', stop: '' }],
  [/^osascript$/, { program: 'e', long: [], bool: 'hi', value: 'ls', stop: '' }],
  [/^php[\d.]*$/, { program: 'r', long: ['--run'], bool: 'aeHhilmnqsvwY', value: 'cdfBREFSTtz', stop: '' }],
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

type InlineScan = { kind: 'none' } | { kind: 'inline'; text: string } | { kind: 'unknown' };

/**
 * Finds the inline program of an interpreter call by its option grammar: combined short flags ending in the program letter
 * (python -Bc, perl -we), attached text (-c'...', -e...), and long forms (--eval=X). Options after the script belong to the
 * script. `unknown` means an option the guard cannot place, so the call cannot be classified.
 */
function scanInline(spec: InlineSpec, argv: string[]): InlineScan {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') return { kind: 'none' };
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (spec.long.includes(eq === -1 ? arg : arg.slice(0, eq))) return { kind: 'inline', text: eq === -1 ? (argv[i + 1] ?? '') : arg.slice(eq + 1) };
      if (eq === -1 && argv[i + 1]?.startsWith('-') === false) i++;
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') return { kind: 'none' };
    for (let k = 1; k < arg.length; k++) {
      const letter = arg[k] as string;
      if (spec.program.includes(letter)) {
        const rest = arg.slice(k + 1);
        const letters = spec.program + spec.bool;
        if (rest === '') return { kind: 'inline', text: argv[i + 1] ?? '' };
        return { kind: 'inline', text: [...rest].every((c) => letters.includes(c)) ? `${rest} ${argv[i + 1] ?? ''}` : rest };
      }
      if (spec.stop.includes(letter)) return { kind: 'none' };
      if (spec.value.includes(letter)) {
        if (k === arg.length - 1) i++;
        break;
      }
      if (!spec.bool.includes(letter)) return { kind: 'unknown' };
    }
  }
  return { kind: 'none' };
}

function interpreter(name: string, argv: string[], flow: Flow): Decision | null {
  if (flow.piped || flow.input || argv.includes('-s') || argv.includes('-')) return indirect(`Feeding ${name} from stdin`);
  const spec = INLINE_SPECS.find(([pattern]) => pattern.test(name))?.[1];
  if (spec === undefined) return null;
  const scan = scanInline(spec, argv);
  if (scan.kind === 'unknown') return indirect(`${name} with options the guard cannot place`);
  return scan.kind === 'inline' && DANGEROUS.test(scan.text) ? indirect(`${name} with an inline program that deletes, executes or pushes`) : null;
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
