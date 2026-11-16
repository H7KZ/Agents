import type { Dialect } from './tokenize.ts';

export interface Simple {
  name: string;
  argv: string[];
  /** The command word as written, before wrapper stripping and normalisation. */
  raw: string;
  env: Record<string, string>;
}

export interface Nested {
  script: string;
  dialect: Dialect;
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', 'fi', 'done', 'esac', '!', '{', '}']);
const ASSIGNMENT = /^(?:\$env:)?([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/i;
const PS_ENV_VARIABLE = /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/i;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const POWERSHELLS = new Set(['pwsh', 'powershell', 'pwsh-preview']);
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-h', '-p', '-C', '-T', '-R', '-D', '-U', '-r', '-t']);
const ENV_VALUE_FLAGS = new Set(['-u', '-C', '-S']);
const NICE_VALUE_FLAGS = new Set(['-n']);
const WRAPPERS: Record<string, Set<string>> = {
  sudo: SUDO_VALUE_FLAGS,
  doas: SUDO_VALUE_FLAGS,
  env: ENV_VALUE_FLAGS,
  command: new Set(),
  builtin: new Set(),
  exec: new Set(),
  nohup: new Set(),
  time: new Set(),
  nice: NICE_VALUE_FLAGS,
  timeout: new Set(['-s', '-k']),
};

export function commandName(word: string): string {
  const base = word.split(/[\\/]/).pop() as string;
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|com)$/, '');
}

function skipWrapper(name: string, words: string[], from: number, env: Record<string, string>): number {
  const valueFlags = WRAPPERS[name] as Set<string>;
  let i = from;
  for (;;) {
    const word = words[i];
    if (word === undefined) return i;
    if (word === '--') return i + 1;
    const assignment = name === 'env' ? ASSIGNMENT.exec(word) : null;
    if (assignment) {
      env[assignment[1] as string] = assignment[2] as string;
      i++;
    } else if (word.startsWith('-') && word.length > 1) {
      i += valueFlags.has(word) ? 2 : 1;
    } else {
      return name === 'timeout' ? i + 1 : i;
    }
  }
}

export function parseSimple(words: string[]): Simple {
  const env: Record<string, string> = {};
  let i = 0;
  for (;;) {
    const word = words[i];
    if (word === undefined) return { name: '', argv: [], env, raw: '' };
    const psAssign = PS_ENV_VARIABLE.exec(word);
    if (psAssign && words[i + 1] === '=') {
      env[psAssign[1] as string] = words[i + 2] ?? '';
      i += 3;
      continue;
    }
    const assignment = ASSIGNMENT.exec(word);
    if (assignment) {
      env[assignment[1] as string] = assignment[2] as string;
      i++;
      continue;
    }
    if (KEYWORDS.has(word)) {
      i++;
      continue;
    }
    const name = commandName(word);
    if (Object.hasOwn(WRAPPERS, name)) {
      i = skipWrapper(name, words, i + 1, env);
      continue;
    }
    return { name, argv: words.slice(i + 1), env, raw: word };
  }
}

export function assignmentsOf(simple: Simple): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of simple.argv) {
    const match = ASSIGNMENT.exec(arg);
    if (match) out[match[1] as string] = match[2] as string;
  }
  return out;
}

function powershellScript(argv: string[]): Nested | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!/^[-/]/.test(arg)) continue;
    const param = arg.slice(1).toLowerCase();
    if (param.startsWith('c') && 'command'.startsWith(param)) {
      return { script: argv.slice(i + 1).join(' '), dialect: 'ps' };
    }
    if (param === 'ec' || (param.startsWith('e') && 'encodedcommand'.startsWith(param))) {
      const encoded = argv[i + 1] ?? '';
      return { script: Buffer.from(encoded, 'base64').toString('utf16le'), dialect: 'ps' };
    }
  }
  return null;
}

export function nestedScript(simple: Simple): Nested | null {
  const { name, argv } = simple;
  if (SHELLS.has(name)) {
    const at = argv.findIndex((arg) => /^-[a-zA-Z]+$/.test(arg) && arg.includes('c'));
    const script = argv[at + 1];
    return at === -1 || script === undefined ? null : { script, dialect: 'sh' };
  }
  if (POWERSHELLS.has(name)) return powershellScript(argv);
  if (name === 'cmd') {
    const at = argv.findIndex((arg) => /^\/[ck]$/i.test(arg));
    return at === -1 ? null : { script: argv.slice(at + 1).join(' '), dialect: 'sh' };
  }
  if (name === 'eval') return { script: argv.join(' '), dialect: 'sh' };
  return null;
}

/** What a `wsl.exe` call runs inside Linux: its argv as a shell script the guard can scan like any other, or why that cannot be told. */
export type Wsl = { script: string; cwd: boolean; ask?: undefined } | { ask: string; script?: string; cwd?: boolean };

const WSL_VALUE = new Set(['-d', '--distribution', '-u', '--user', '--shell-type', '--cd']);
const WSL_PLAIN = new Set(['--system', '-l', '--list', '-v', '--verbose', '--status', '--version', '--help', '--online', '-o', '--running', '-q', '--quiet', '--all']);
const WSL_ASK = 'wsl with this command line runs code the guard cannot read. Use wsl [-d <distro>] --exec <program> <args> (for example --exec bash -lc "<commands>").';
const shellQuote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * `wsl.exe [-d d] [-u u] [--cd dir] --exec|-e|-- <program> <args>` runs program with exactly those arguments, so it is scanned like the same command
 * run directly (`--exec bash -lc 'x'` is `bash -c 'x'`). Only --exec and -e are exact argv. `--` and a bare command go through wsl's default Linux
 * shell, which re-parses the line: those ask, and the words joined by spaces (unquoted) are scanned as well so a block still wins. An option the guard does
 * not know, or --exec with nothing after it, asks. `--cd` makes relative paths unresolved. Management calls such as `wsl -l` pass.
 */
export function wslCall(simple: Simple): Wsl | null {
  if (simple.name !== 'wsl') return null;
  const { argv } = simple;
  let cwd = false;
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--exec' || arg === '-e') {
      const command = argv.slice(i + 1);
      return command.length === 0 ? { ask: WSL_ASK } : { script: command.map(shellQuote).join(' '), cwd };
    }
    if (arg === '--' || !arg.startsWith('-')) {
      const line = argv.slice(arg === '--' ? i + 1 : i).join(' ');
      return { ask: WSL_ASK, script: line, cwd };
    }
    if (WSL_VALUE.has(arg)) {
      if (argv[i + 1] === undefined) return { ask: WSL_ASK };
      if (arg === '--cd') cwd = true;
      i++;
    } else if (!WSL_PLAIN.has(arg)) {
      return { ask: WSL_ASK };
    }
  }
  return null;
}

export interface ParseSpec {
  valueShort?: string;
  attachedShort?: string;
  valueLong?: string[];
  /** Canonical long options; unique GNU-style abbreviations (4+ characters, e.g. --no-ver) map onto them. */
  vocab?: string[];
}

export interface ParsedArgs {
  flags: string[];
  options: Map<string, string>;
  positionals: string[];
  rest: string[];
}

export function canonicalLong(name: string, vocab: string[]): string {
  if (name.length < 4 || vocab.includes(name)) return name;
  // "--no-" and "--no" are not abbreviations of anything; "--no-v" is.
  const stem = name.startsWith('--no') ? 6 : 4;
  return name.length < stem ? name : (vocab.find((candidate) => candidate.startsWith(name)) ?? name);
}

export function parseArgs(args: string[], spec: ParseSpec = {}): ParsedArgs {
  const flags: string[] = [];
  const options = new Map<string, string>();
  const positionals: string[] = [];
  const rest: string[] = [];
  const valueShort = spec.valueShort ?? '';
  const attachedShort = spec.attachedShort ?? '';
  const valueLong = new Set(spec.valueLong ?? []);
  let afterDashes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (afterDashes) {
      rest.push(arg);
    } else if (arg === '--') {
      afterDashes = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = canonicalLong(eq === -1 ? arg : arg.slice(0, eq), spec.vocab ?? []);
      flags.push(name);
      if (eq !== -1) {
        options.set(name, arg.slice(eq + 1));
      } else if (valueLong.has(name)) {
        options.set(name, args[i + 1] ?? '');
        i++;
      }
    } else if (arg.length > 1 && arg.startsWith('-')) {
      for (let k = 1; k < arg.length; k++) {
        const ch = arg[k] as string;
        flags.push(`-${ch}`);
        if (valueShort.includes(ch)) {
          if (k === arg.length - 1) {
            options.set(`-${ch}`, args[i + 1] ?? '');
            i++;
          } else {
            options.set(`-${ch}`, arg.slice(k + 1));
          }
          break;
        }
        if (attachedShort.includes(ch)) {
          options.set(`-${ch}`, arg.slice(k + 1));
          break;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, options, positionals, rest };
}
