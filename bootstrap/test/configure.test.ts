import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { askYesNo, configure, main, marketplaceEntry, mergeSettings, parseOptions, shellRun, type CommandResult, type Deps, type Options } from '../configure.ts';
import { cleanupTmp, runNode, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

const repoRoot = join(import.meta.dirname, '..', '..');
const OK: CommandResult = { status: 0, stdout: 'ok', stderr: '' };
const opts = (over: Partial<Options> = {}): Options => ({ dryRun: false, yes: false, help: false, local: null, ...over });

interface Harness {
  deps: Deps;
  home: string;
  logs: string[];
  commands: string[];
}

function harness(over: { files?: Record<string, string>; fail?: string[]; answer?: boolean; nodeVersion?: string; home?: string } = {}): Harness {
  const home = over.home ?? tmpDir();
  writeTree(home, over.files ?? {});
  const logs: string[] = [];
  const commands: string[] = [];
  const deps: Deps = {
    home,
    nodeVersion: over.nodeVersion ?? '24.0.0',
    run: (command, args) => {
      const line = [command, ...args].join(' ');
      commands.push(line);
      return over.fail?.includes(line) ? { status: 1, stdout: '', stderr: 'boom' } : OK;
    },
    log: (line) => logs.push(line),
    confirm: async () => over.answer ?? false,
  };
  return { deps, home, logs, commands };
}

const settingsPath = (home: string) => join(home, '.claude', 'settings.json');
const installing = (h: Harness) => h.commands.filter((c) => c.startsWith('claude plugin'));

describe('parseOptions', () => {
  it('parses flags', () => {
    assert.deepEqual(parseOptions([]), opts());
    assert.deepEqual(parseOptions(['--dry-run', '--yes', '--local', 'x', '--help']), opts({ dryRun: true, yes: true, help: true, local: 'x' }));
    assert.equal(parseOptions(['-y']).yes, true);
    assert.equal(parseOptions(['-h']).help, true);
  });

  it('rejects unknown arguments and a missing --local value', () => {
    assert.throws(() => parseOptions(['--nope']), /unknown argument: --nope/);
    assert.throws(() => parseOptions(['--local']), /needs a path/);
    assert.throws(() => parseOptions(['--local', '--yes']), /needs a path/);
  });
});

describe('mergeSettings', () => {
  const entry = marketplaceEntry(null);

  it('creates a new file with two-space indent and a trailing newline', () => {
    const result = mergeSettings(null, entry);
    assert.equal(result.changed, true);
    assert.equal(result.text, `${JSON.stringify({ extraKnownMarketplaces: { h7kz: entry } }, null, 2)}\n`);
    assert.equal(mergeSettings('  \n', entry).changed, true);
  });

  it('preserves other keys, order, indentation, line endings and trailing newline state', () => {
    const original = '{\n\t"model": "x",\n\t"enabledPlugins": {"a": true},\n\t"extraKnownMarketplaces": {\n\t\t"gitkraken": {"p": 1}\n\t}\n}';
    const merged = mergeSettings(original, entry);
    const parsed = JSON.parse(merged.text);
    assert.deepEqual(Object.keys(parsed), ['model', 'enabledPlugins', 'extraKnownMarketplaces']);
    assert.deepEqual(parsed.extraKnownMarketplaces, { gitkraken: { p: 1 }, h7kz: entry });
    assert.ok(merged.text.startsWith('{\n\t"model"'));
    assert.ok(!merged.text.endsWith('\n'));
    const crlf = mergeSettings('{\r\n    "a": 1\r\n}\r\n', entry);
    assert.ok(crlf.text.includes('\r\n    "a": 1'));
    assert.ok(crlf.text.endsWith('}\r\n'));
    assert.ok(!/[^\r]\n/.test(crlf.text));
  });

  it('detects no change and updates a stale entry', () => {
    const current = mergeSettings(null, entry).text;
    assert.deepEqual(mergeSettings(current, entry), { text: current, changed: false });
    const stale = JSON.stringify({ extraKnownMarketplaces: { h7kz: { source: { source: 'github', repo: 'old/old' }, autoUpdate: false } } });
    const fixed = mergeSettings(stale, entry);
    assert.equal(fixed.changed, true);
    assert.deepEqual(JSON.parse(fixed.text).extraKnownMarketplaces.h7kz, entry);
  });

  it('replaces a non-object extraKnownMarketplaces', () => {
    for (const bad of ['[]', 'null', '"x"']) {
      const merged = mergeSettings(`{"extraKnownMarketplaces": ${bad}}`, entry);
      assert.deepEqual(JSON.parse(merged.text).extraKnownMarketplaces, { h7kz: entry });
    }
  });

  it('refuses invalid JSON and non-objects', () => {
    assert.throws(() => mergeSettings('{', entry), /not valid JSON/);
    assert.throws(() => mergeSettings('[]', entry), /not a JSON object/);
    assert.throws(() => mergeSettings('null', entry), /not a JSON object/);
    assert.throws(() => mergeSettings('3', entry), /not a JSON object/);
  });

  it('property: other keys always survive and the result is idempotent', () => {
    const key = fc.stringMatching(/^[a-z]{1,8}$/).filter((k) => k !== 'extraKnownMarketplaces');
    fc.assert(
      fc.property(fc.dictionary(key, fc.oneof(fc.string({ maxLength: 8 }), fc.integer(), fc.boolean())), fc.constantFrom(0, 1, 2, 4, '\t'), (rest, indent) => {
        const original = JSON.stringify(rest, null, indent);
        const merged = mergeSettings(original, entry);
        const parsed = JSON.parse(merged.text);
        for (const [k, v] of Object.entries(rest)) assert.deepEqual(parsed[k], v);
        assert.equal(mergeSettings(merged.text, entry).changed, false);
      }),
    );
  });
});

describe('marketplaceEntry and shellRun', () => {
  it('builds github and directory entries with autoUpdate', () => {
    assert.deepEqual(marketplaceEntry(null), { source: { source: 'github', repo: 'H7KZ/Agents' }, autoUpdate: true });
    assert.deepEqual(marketplaceEntry('/x/y'), { source: { source: 'directory', path: '/x/y' }, autoUpdate: true });
  });

  it('runs commands, quotes awkward arguments and refuses shell metacharacters', () => {
    const ok = shellRun('node', ['--version']);
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /^v\d/);
    const spaced = shellRun('node', ['-p', '"a"'.slice(0, 0) + '1+1']);
    assert.equal(spaced.stdout.trim(), '2');
    assert.equal(shellRun('node', [join(tmpDir(), 'dir with space', 'x.js')]).status === 0, false);
    for (const bad of ['a"b', 'a$b', 'a`b', 'a%b%', 'a\nb', 'a\rb']) assert.throws(() => shellRun('node', [bad]), /metacharacters/);
    assert.notEqual(shellRun('definitely-not-a-command-h7', []).status, 0);
    const nulls = (() => ({ status: null, stdout: null, stderr: null })) as unknown as typeof spawnSync;
    assert.deepEqual(shellRun('x', [], nulls), { status: null, stdout: '', stderr: '' });
  });
});

describe('askYesNo', () => {
  it('accepts y and yes, rejects everything else including empty', async () => {
    for (const [answer, expected] of [['y', true], ['YES', true], [' yes ', true], ['n', false], ['', false], ['yep', false]] as const) {
      const input = new PassThrough();
      const output = new PassThrough();
      const pending = askYesNo('ok?', input, output);
      input.write(`${answer}\n`);
      assert.equal(await pending, expected, answer);
    }
  });

  it('returns false when input closes without an answer', async () => {
    const input = new PassThrough();
    const pending = askYesNo('ok?', input, new PassThrough());
    input.end();
    assert.equal(await pending, false);
  });
});

describe('configure: full run', () => {
  it('prints help without touching anything', async () => {
    const h = harness();
    assert.equal(await configure(opts({ help: true }), h.deps), 0);
    assert.match(h.logs[0] as string, /^Usage:/);
    assert.deepEqual(h.commands, []);
  });

  it('performs every step on a fresh machine', async () => {
    const h = harness({ files: { '.claude/settings.json': '{\n  "model": "x"\n}\n' } });
    assert.equal(await configure(opts(), h.deps), 0);
    assert.deepEqual(installing(h), [
      'claude plugin marketplace add H7KZ/Agents',
      'claude plugin install h7@h7kz',
      'claude plugin install mattpocock-skills@claude-plugins-official',
    ]);
    assert.deepEqual(h.commands.slice(0, 2), ['git --version', 'claude --version']);
    const settings = JSON.parse(readFileSync(settingsPath(h.home), 'utf8'));
    assert.equal(settings.model, 'x');
    assert.equal(settings.extraKnownMarketplaces.h7kz.autoUpdate, true);
    assert.equal(readFileSync(`${settingsPath(h.home)}.h7bak`, 'utf8'), '{\n  "model": "x"\n}\n');
    assert.ok(existsSync(join(h.home, '.h7')));
    assert.match(h.logs.at(-1) as string, /done/);
  });

  it('creates settings.json from nothing without a backup', async () => {
    const h = harness();
    assert.equal(await configure(opts(), h.deps), 0);
    assert.equal(existsSync(`${settingsPath(h.home)}.h7bak`), false);
    assert.equal(JSON.parse(readFileSync(settingsPath(h.home), 'utf8')).extraKnownMarketplaces.h7kz.source.repo, 'H7KZ/Agents');
  });

  it('is idempotent: a second run on a configured machine runs nothing and changes nothing', async () => {
    const files = {
      '.claude/settings.json': JSON.stringify({ extraKnownMarketplaces: { h7kz: marketplaceEntry(null) } }),
      '.claude/plugins/known_marketplaces.json': JSON.stringify({ h7kz: {} }),
      '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'h7@h7kz': [], 'mattpocock-skills@claude-plugins-official': [] } }),
      '.h7/.keep': '',
    };
    const h = harness({ files });
    const before = readFileSync(settingsPath(h.home), 'utf8');
    assert.equal(await configure(opts(), h.deps), 0);
    assert.deepEqual(installing(h), []);
    assert.equal(readFileSync(settingsPath(h.home), 'utf8'), before);
    assert.equal(existsSync(`${settingsPath(h.home)}.h7bak`), false);
    assert.ok(h.logs.some((l) => /already added/.test(l)));
    assert.ok(h.logs.some((l) => /already has h7kz/.test(l)));
    assert.ok(h.logs.some((l) => /no stale duplicates/.test(l)));
  });

  it('dry run prints the plan and changes nothing', async () => {
    const h = harness({ files: { '.claude/settings.json': '{}' } });
    assert.equal(await configure(opts({ dryRun: true }), h.deps), 0);
    assert.deepEqual(installing(h), []);
    assert.equal(readFileSync(settingsPath(h.home), 'utf8'), '{}');
    assert.equal(existsSync(join(h.home, '.h7')), false);
    assert.ok(h.logs.some((l) => l === '[dry-run] run: claude plugin marketplace add H7KZ/Agents'));
    assert.ok(h.logs.some((l) => l.startsWith('[dry-run] merge extraKnownMarketplaces.h7kz')));
    assert.ok(h.logs.some((l) => l.startsWith('[dry-run] create ')));
    assert.match(h.logs.at(-1) as string, /dry run complete/);
  });

  it('--local adds the marketplace from a local clone and records a directory source', async () => {
    const h = harness();
    assert.equal(await configure(opts({ local: repoRoot }), h.deps), 0);
    assert.ok(installing(h)[0]?.startsWith('claude plugin marketplace add '));
    assert.ok(installing(h)[0]?.includes(repoRoot.replaceAll('\\', '/')) || installing(h)[0]?.includes(repoRoot));
    const entry = JSON.parse(readFileSync(settingsPath(h.home), 'utf8')).extraKnownMarketplaces.h7kz;
    assert.equal(entry.source.source, 'directory');
    assert.equal(entry.autoUpdate, true);
  });

  it('--local fails for a directory that is not a marketplace', async () => {
    const h = harness();
    assert.equal(await configure(opts({ local: tmpDir() }), h.deps), 1);
    assert.match(h.logs.at(-1) as string, /no \.claude-plugin\/marketplace\.json/);
    assert.deepEqual(h.commands, []);
  });
});

describe('configure: failures', () => {
  it('rejects old node, missing git or claude, before changing anything', async () => {
    const cases: [{ nodeVersion?: string; fail?: string[] }, RegExp][] = [
      [{ nodeVersion: '20.1.0' }, /Node 22\.18/],
      [{ fail: ['git --version'] }, /git is not installed/],
      [{ fail: ['claude --version'] }, /claude is not installed/],
    ];
    for (const [over, pattern] of cases) {
      const h = harness(over);
      assert.equal(await configure(opts(), h.deps), 1);
      assert.match(h.logs.at(-1) as string, pattern);
      assert.equal(existsSync(settingsPath(h.home)), false);
    }
  });

  it('refuses invalid settings.json before running any claude command', async () => {
    const h = harness({ files: { '.claude/settings.json': '{ nope' } });
    assert.equal(await configure(opts(), h.deps), 1);
    assert.match(h.logs.at(-1) as string, /not valid JSON/);
    assert.deepEqual(installing(h), []);
    assert.equal(readFileSync(settingsPath(h.home), 'utf8'), '{ nope');
  });

  it('stops with the command output when a claude command fails, and skips cleanup', async () => {
    const h = harness({ fail: ['claude plugin install mattpocock-skills@claude-plugins-official'], files: { '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'mattpocock-skills@local-desktop-app-uploads': [] } }) } });
    assert.equal(await configure(opts({ yes: true }), h.deps), 1);
    assert.match(h.logs.at(-1) as string, /failed \(exit 1\): boom/);
    assert.ok(!h.commands.some((c) => c.includes('uninstall')));
  });

  it('falls back to stdout when a failing command wrote nothing to stderr', async () => {
    const h = harness();
    h.deps.run = (command, args) => ({ status: [command, ...args].join(' ').includes('install') ? 1 : 0, stdout: 'only stdout', stderr: '' });
    assert.equal(await configure(opts(), h.deps), 1);
    assert.match(h.logs.at(-1) as string, /only stdout/);
  });

  it('rethrows unexpected errors', async () => {
    const h = harness();
    h.deps.run = () => {
      throw new TypeError('unexpected');
    };
    await assert.rejects(configure(opts(), h.deps), /unexpected/);
  });
});

describe('configure: stale duplicate cleanup', () => {
  function stale(): Harness {
    const home = tmpDir();
    writeTree(home, {
      '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'mattpocock-skills@local-desktop-app-uploads': [] } }),
      '.agents/.skill-lock.json': JSON.stringify({ skills: { tdd: { source: 'mattpocock/skills' }, mine: { source: 'me/skills' } } }),
    });
    for (const name of ['tdd', 'mine']) mkdirSync(join(home, '.agents', 'skills', name), { recursive: true });
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    for (const name of ['tdd', 'mine']) symlinkSync(join(home, '.agents', 'skills', name), join(home, '.claude', 'skills', name), 'junction');
    return { ...harness({ home }), home };
  }

  const links = (home: string) => readdirSync(join(home, '.claude', 'skills')).sort();

  it('lists duplicates and removes them only after confirmation', async () => {
    const h = stale();
    h.deps.confirm = async (q) => {
      h.logs.push(`ASKED ${q}`);
      return true;
    };
    assert.equal(await configure(opts(), h.deps), 0);
    const askedAt = h.logs.findIndex((l) => l.startsWith('ASKED'));
    const listedAt = h.logs.findIndex((l) => l.includes('stale duplicates of mattpocock/skills'));
    assert.ok(listedAt >= 0 && askedAt > listedAt);
    assert.ok(h.commands.includes('claude plugin uninstall mattpocock-skills@local-desktop-app-uploads'));
    assert.deepEqual(links(h.home), ['mine']);
    assert.ok(existsSync(join(h.home, '.agents', 'skills', 'tdd')));
  });

  it('leaves everything when the user declines', async () => {
    const h = stale();
    assert.equal(await configure(opts(), h.deps), 0);
    assert.deepEqual(links(h.home), ['mine', 'tdd']);
    assert.ok(!h.commands.some((c) => c.includes('uninstall')));
    assert.ok(h.logs.some((l) => /left stale duplicates in place/.test(l)));
  });

  it('--yes skips the question', async () => {
    const h = stale();
    h.deps.confirm = async () => assert.fail('must not ask');
    assert.equal(await configure(opts({ yes: true }), h.deps), 0);
    assert.deepEqual(links(h.home), ['mine']);
  });

  it('dry run lists but removes nothing and does not ask', async () => {
    const h = stale();
    h.deps.confirm = async () => assert.fail('must not ask');
    assert.equal(await configure(opts({ dryRun: true, yes: true }), h.deps), 0);
    assert.deepEqual(links(h.home), ['mine', 'tdd']);
    assert.ok(h.logs.some((l) => /would ask before removing/.test(l)));
    assert.ok(h.logs.some((l) => /symlink .*tdd/.test(l)));
  });

  it('handles only symlinks present, only the plugin, or nothing', async () => {
    const onlyPlugin = harness({ files: { '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'mattpocock-skills@local-desktop-app-uploads': [] } }) }, answer: true });
    assert.equal(await configure(opts(), onlyPlugin.deps), 0);
    assert.ok(onlyPlugin.commands.some((c) => c.includes('uninstall mattpocock-skills@local-desktop-app-uploads')));
    assert.ok(!onlyPlugin.logs.some((l) => l.includes('symlink')));
  });
});

describe('main and CLI', () => {
  it('returns 2 with usage for bad arguments', async () => {
    const h = harness();
    assert.equal(await main(['--wat'], h.deps), 2);
    assert.match(h.logs[0] as string, /unknown argument/);
    assert.match(h.logs[1] as string, /^Usage:/);
  });

  it('delegates valid arguments to configure', async () => {
    const h = harness();
    assert.equal(await main(['--help'], h.deps), 0);
  });

  it('configure.ts --help works as a subprocess', () => {
    const result = runNode(join(import.meta.dirname, '..', 'configure.ts'), ['--help'], { env: { H7_HOME: tmpDir() } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
  });

  it('configure.ts exits 2 on bad arguments as a subprocess and uses the real home when H7_HOME is unset', () => {
    const script = join(import.meta.dirname, '..', 'configure.ts');
    assert.equal(runNode(script, ['--bogus'], { env: { H7_HOME: tmpDir() } }).status, 2);
    const home = tmpDir();
    const result = runNode(script, ['--dry-run', '--local', tmpDir()], { env: { H7_HOME: undefined, HOME: home, USERPROFILE: home } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /no \.claude-plugin\/marketplace\.json/);
    assert.equal(readdirSync(home).length, 0);
  });

  it('the installer wrappers forward arguments to configure.ts', () => {
    const dir = join(import.meta.dirname, '..');
    const bash = process.platform === 'win32' ? 'bash' : 'sh';
    const viaSh = spawnWrapper(bash, [join(dir, 'install.sh'), '--help']);
    assert.equal(viaSh.status, 0);
    assert.match(viaSh.stdout, /Usage:/);
    const ps = spawnWrapper(process.platform === 'win32' ? 'powershell' : 'pwsh', ['-NoProfile', '-File', join(dir, 'install.ps1'), '--help']);
    if (ps.status === null) return;
    assert.equal(ps.status, 0);
    assert.match(ps.stdout, /Usage:/);
  });
});

function spawnWrapper(command: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: result.stdout };
}
