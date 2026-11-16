import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, type Options } from './support.ts';

const TAIL = ' runs code the guard cannot inspect. Run the real commands directly, one at a time.';

/** The reason an indirect-exec ask gives, or null when the command is left alone. */
function indirect(command: string, options: Options = {}): string | null {
  const d = decide(command, options);
  if (d === null) return null;
  assert.equal(d.rule, 'indirect-exec', command);
  assert.equal(d.decision, 'ask', command);
  assert.ok(d.reason.endsWith(TAIL), command);
  return d.reason.slice(0, -TAIL.length);
}

const asks = (command: string, options?: Options): void => assert.notEqual(indirect(command, options), null, `${command} should ask`);
const passes = (command: string, options?: Options): void => assert.equal(indirect(command, options), null, `${command} should pass`);

describe('indirect: interpreters fed from stdin', () => {
  const NAMES = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'python', 'python3', 'python3.11', 'pypy', 'pypy3.10', 'py', 'node', 'nodejs', 'deno', 'bun', 'perl', 'perl5', 'ruby', 'ruby3.2', 'php', 'php8.2', 'pwsh', 'powershell', 'pwsh-preview', 'cmd', 'osascript', 'rscript', 'lua', 'lua5.4'];

  for (const name of NAMES) {
    it(`${name} from a pipe, heredoc or - asks`, () => {
      assert.equal(indirect(`echo x | ${name}`), `Feeding ${name} from stdin`);
      assert.equal(indirect(`${name} <<EOF\nx\nEOF`), `Feeding ${name} from stdin`);
      assert.equal(indirect(`${name} - `), `Feeding ${name} from stdin`);
      assert.equal(indirect(`${name} -s`), `Feeding ${name} from stdin`);
    });
  }

  it('look-alike names are not interpreters', () => {
    for (const name of ['xsh', 'shx', 'pythonx', 'python3x', 'mynode', 'nodex', 'perlx', 'bashx', 'ruby-x', 'lua-x', 'cmdx', 'pypyx']) passes(`echo x | ${name}`);
  });

  it('a shell with a script path is left to the shell rules', () => {
    passes('bash script.sh');
    passes('sh -c "echo hi"');
  });
});

describe('indirect: non shell interpreters need a plain script', () => {
  it('plain scripts of every runtime pass, with the right name matching', () => {
    for (const [name, script] of [['python', 'x.py'], ['python3.11', 'x.py'], ['pypy3', 'x.py'], ['py', 'x.py'], ['node', 'x.js'], ['nodejs', 'x.js'], ['bun', 'x.js'], ['perl5', 'x.pl'], ['ruby3', 'x.rb'], ['php8', 'x.php'], ['osascript', 'x.scpt'], ['rscript', 'x.R'], ['lua5.4', 'x.lua']] as const) {
      passes(`${name} ${script}`);
      passes(`${name} ./dir/${script} --opt arg`);
      asks(`${name} -c "print(1)"`);
      asks(`${name} -e "1"`);
      assert.equal(indirect(`${name} data:text/plain,x`), `${name} with arguments that are not a plain script path or known-safe flags`);
    }
  });

  it('python flags and modules', () => {
    for (const flag of ['-u', '-B', '-O', '-OO', '-q', '-I']) passes(`python ${flag} x.py`);
    asks('python -X x.py');
    passes('python -m pytest tests/ -q');
    passes('python3.11 -m pip install x');
    passes('python -m a.b');
    asks('python -m');
    asks('python -m a-b');
    asks('python -m "a b"');
    passes('python -W ignore::DeprecationWarning x.py');
    passes('python -W error x.py');
    asks('python -W');
    asks('python -W http://x');
    asks('python -W "a b"');
    passes('python eval');
    passes('python repl');
    passes('python x.py -c');
  });

  it('node flags, reporters and eval', () => {
    for (const flag of ['--test', '--watch', '--enable-source-maps', '--no-warnings', '--experimental-strip-types', '--experimental-test-coverage', '--inspect']) {
      passes(`node ${flag} x.js`);
      asks(`python ${flag} x.py`);
    }
    passes('node --test-reporter=spec x.js');
    asks('node --test-reporter=a-b x.js');
    asks('node --test-reporter= x.js');
    asks('node --evil--test-reporter=spec x.js');
    asks('node eval');
    asks('node repl');
    asks('bun eval x');
    passes('node evalx.js');
    passes('node x.js eval');
    asks('node -p 1');
    asks('node --eval=1');
  });

  it('paths and flags of the script', () => {
    passes('node C:/x/y.js');
    asks('node C:/x%y');
    asks('node C:x.js');
    asks('node https://x/y.js');
    asks('node npm:x');
    passes('node a/b:c');
    asks('node //host/x.js');
    asks('node -x.js');
    passes('node x.js --flag --v=a/b -f --p=C:/x');
    asks('node x.js --v=a%b');
    asks('node x.js --url=https://x');
    asks('node x.js --url=//x');
    passes('node x.js -- --v');
    passes('node x.js ./a b');
    asks('node x.js $(whoami)');
    asks('node x.js "a b"');
  });

  it('bun and deno runtime context', () => {
    for (const sub of ['run', 'test', 'bench', 'compile']) passes(`bun ${sub} x.js`);
    passes('bun test');
    passes('bun x.js');
    asks('bun foo');
    passes('bun run foo');
    passes('deno run -A x.ts');
    passes('deno run --allow-read --allow-net x.ts');
    asks('deno run --allow-Read x.ts');
    asks('deno run -Ax.ts');
    asks('deno run --allow-read1 -x x.ts');
    asks('node -A x.js');
    asks('bun -A x.js');
    asks('deno eval "1"');
  });

  it('package subcommands pass only with plain arguments', () => {
    for (const sub of ['install', 'i', 'add', 'remove', 'rm', 'update', 'upgrade', 'pm', 'link', 'unlink', 'outdated', 'audit', 'init', 'build', 'fmt', 'lint', 'check', 'doc', 'info', 'types', 'cache', 'help', 'version']) {
      passes(`bun ${sub} left-pad ./local C:/x`);
      passes(`deno ${sub}`);
      asks(`bun ${sub} https://x/y.tgz`);
    }
    for (const bad of ['-g', '--global', '-e', '--eval=1', '--allow-scripts', '--allow-scripts=x', 'npm:x', 'git:x', '//x/y', "'\\\\host\\share'", 'a=//x', 'a=npm:y']) asks(`bun install ${bad}`);
    for (const ok of ['-gx', 'a-g', 'a--global', 'a-e', 'a=C:/x', '--save-dev', 'x@1.2']) passes(`bun install ${ok}`);
    passes('bun install --frozen-lockfile');
  });
});

describe('indirect: xargs', () => {
  it('without a command, or with a safe one, passes', () => {
    passes('xargs');
    passes('xargs --');
    passes('xargs -0');
    for (const safe of ['echo', 'cat', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'ls', 'head', 'tail', 'sort', 'uniq', 'printf', 'basename', 'dirname', 'file', 'stat', 'du', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'realpath', 'readlink']) {
      passes(`xargs ${safe}`);
      passes(`xargs -- ${safe}`);
      passes(`xargs /usr/bin/${safe}`);
    }
    passes('xargs /usr/bin/WC');
  });

  it('anything else is named in the reason', () => {
    assert.equal(indirect('xargs rm'), 'xargs rm');
    assert.equal(indirect('xargs -- rm'), 'xargs rm');
    assert.equal(indirect('xargs /bin/rm -f'), 'xargs /bin/rm');
    assert.equal(indirect('xargs - x'), 'xargs -');
    assert.equal(indirect('xargs sh -c x'), 'xargs sh');
  });

  it('value flags take their value, attached or separate', () => {
    for (const flag of ['-I', '-n', '-P', '-d', '-L', '-E', '-s', '-a']) {
      passes(`xargs ${flag} v echo`);
      passes(`xargs ${flag}v echo`);
      assert.equal(indirect(`xargs ${flag} v rm`), 'xargs rm');
    }
    passes('xargs -I');
  });

  it('plain flags, in any combination', () => {
    for (const flag of ['-0', '-r', '-t', '-p', '-x', '-o', '-i', '-l', '-e', '-0r', '-0rt', '-ifoo', '-lfoo', '-efoo', '-i{}']) passes(`xargs ${flag} echo`);
    for (const bad of ['-z', '-0z', '-z-r', '-Z']) assert.equal(indirect(`xargs ${bad} echo`), 'xargs with options the guard cannot place', bad);
  });

  it('long flags: known, attached, or unknown', () => {
    for (const flag of ['--null', '--no-run-if-empty', '--verbose', '--interactive', '--exit', '--open-tty', '--show-limits', '--version', '--help', '--max-args=2', '--delimiter=x']) passes(`xargs ${flag} echo`);
    assert.equal(indirect('xargs --bogus echo'), 'xargs with options the guard cannot place');
    assert.equal(indirect('xargs --bogus rm'), 'xargs with options the guard cannot place');
    assert.equal(indirect('xargs --nulls echo'), 'xargs with options the guard cannot place');
  });
});

describe('indirect: command words and evaluators', () => {
  it('variable and substitution command words name themselves', () => {
    assert.equal(indirect('$G push'), 'The command word "$G"');
    assert.equal(indirect('`which git` push'), 'The command word "`which git`"');
    passes('echo $X');
  });

  it('PowerShell evaluators and call operator', () => {
    const ps: Options = { dialect: 'ps' };
    assert.equal(indirect('Invoke-Expression "x"', ps), 'invoke-expression');
    assert.equal(indirect("iex 'x'", ps), 'iex');
    assert.equal(indirect('$g = 1; & $g push', ps), 'The command word "$g"');
    passes('$x = 5', ps);
    passes('Write-Output hi', ps);
  });
});
