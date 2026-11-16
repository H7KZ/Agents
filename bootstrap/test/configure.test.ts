import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { askYesNo, configure, main, marketplaceEntry, mergeSettings, parseOptions, quote, shellRun, writeFileAtomic, type AtomicOps, type CommandResult, type Deps, type Options } from '../configure.ts';
import { SLOW, cleanupTmp, runNode, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

const repoRoot = join(import.meta.dirname, '..', '..');
const OK: CommandResult = { status: 0, stdout: 'ok', stderr: '' };
const opts = (over: Partial<Options> = {}): Options => ({ dryRun: false, yes: false, help: false, local: null, dev: null, ...over });

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
    assert.equal(parseOptions(['--dev', 'r']).dev, 'r');
  });

  it('rejects unknown arguments, a missing path and --local with --dev', () => {
    assert.throws(() => parseOptions(['--nope']), /unknown argument: --nope/);
    assert.throws(() => parseOptions(['--local']), /--local needs a path/);
    assert.throws(() => parseOptions(['--local', '--yes']), /needs a path/);
    assert.throws(() => parseOptions(['--dev']), /--dev needs a path/);
    assert.throws(() => parseOptions(['--dev', '--yes']), /needs a path/);
    assert.throws(() => parseOptions(['--local', 'a', '--dev', 'b']), /cannot be combined/);
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

  it('runs commands, quotes awkward arguments and refuses shell metacharacters', SLOW, () => {
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
      'claude plugin marketplace add anthropics/claude-plugins-official',
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
      '.claude/plugins/known_marketplaces.json': JSON.stringify({ h7kz: { source: { source: 'github', repo: 'H7KZ/Agents' } }, 'claude-plugins-official': {} }),
      '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'h7@h7kz': [], 'mattpocock-skills@claude-plugins-official': [] } }),
      '.h7/.keep': '',
    };
    const h = harness({ files });
    const before = readFileSync(settingsPath(h.home), 'utf8');
    assert.equal(await configure(opts(), h.deps), 0);
    assert.deepEqual(installing(h), []);
    assert.equal(readFileSync(settingsPath(h.home), 'utf8'), before);
    assert.equal(readFileSync(`${settingsPath(h.home)}.h7bak`, 'utf8'), before);
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

  it('configure.ts --help works as a subprocess', SLOW, () => {
    const result = runNode(join(import.meta.dirname, '..', 'configure.ts'), ['--help'], { env: { H7_HOME: tmpDir() } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
  });

  it('configure.ts exits 2 on bad arguments as a subprocess and uses the real home when H7_HOME is unset', SLOW, () => {
    const script = join(import.meta.dirname, '..', 'configure.ts');
    assert.equal(runNode(script, ['--bogus'], { env: { H7_HOME: tmpDir() } }).status, 2);
    const home = tmpDir();
    const result = runNode(script, ['--dry-run', '--local', tmpDir()], { env: { H7_HOME: undefined, HOME: home, USERPROFILE: home } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /no \.claude-plugin\/marketplace\.json/);
    assert.equal(readdirSync(home).length, 0);
  });

  it('the installer wrappers forward arguments to configure.ts', SLOW, () => {
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

describe('configure: official marketplace', () => {
  it('adds claude-plugins-official before installing mattpocock-skills when it is unknown', async () => {
    const h = harness();
    assert.equal(await configure(opts(), h.deps), 0);
    const cmds = installing(h);
    const add = cmds.indexOf('claude plugin marketplace add anthropics/claude-plugins-official');
    assert.ok(add >= 0 && add < cmds.indexOf('claude plugin install mattpocock-skills@claude-plugins-official'));
  });

  it('does not add it again when it is already known', async () => {
    const h = harness({ files: { '.claude/plugins/known_marketplaces.json': JSON.stringify({ 'claude-plugins-official': {} }) } });
    assert.equal(await configure(opts(), h.deps), 0);
    assert.ok(!installing(h).some((c) => c.includes('anthropics/claude-plugins-official')));
  });

  it('stops with the command output when adding it fails, before installing', async () => {
    const h = harness({ fail: ['claude plugin marketplace add anthropics/claude-plugins-official'] });
    assert.equal(await configure(opts(), h.deps), 1);
    assert.match(h.logs.at(-1) as string, /failed \(exit 1\): boom/);
    assert.ok(!installing(h).some((c) => c.includes('install mattpocock')));
  });
});

describe('configure: settings.json handling', () => {
  const original = '{\n  "model": "x"\n}\n';

  it('backs up the ORIGINAL settings before claude rewrites them, and merges afterwards with autoUpdate', async () => {
    const h = harness({ files: { '.claude/settings.json': original } });
    const file = settingsPath(h.home);
    const inner = h.deps.run;
    h.deps.run = (command, args) => {
      const line = [command, ...args].join(' ');
      if (line.startsWith('claude plugin marketplace add')) {
        const now = JSON.parse(readFileSync(file, 'utf8'));
        now.extraKnownMarketplaces = { ...now.extraKnownMarketplaces, h7kz: { source: { source: 'github', repo: 'H7KZ/Agents' } }, 'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } } };
        writeFileSync(file, JSON.stringify(now, null, 2));
      }
      return inner(command, args);
    };
    assert.equal(await configure(opts(), h.deps), 0);
    assert.equal(readFileSync(`${file}.h7bak`, 'utf8'), original);
    const merged = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(merged.extraKnownMarketplaces.h7kz.autoUpdate, true);
    assert.equal(merged.extraKnownMarketplaces['claude-plugins-official'].source.repo, 'anthropics/claude-plugins-official');
    assert.equal(merged.model, 'x');
  });

  it('takes the backup before the first claude plugin command and never overwrites an existing backup', async () => {
    const backupSeenByPluginCommands = async (files: Record<string, string>) => {
      const h = harness({ files });
      const backup = `${settingsPath(h.home)}.h7bak`;
      const seen: string[] = [];
      const inner = h.deps.run;
      h.deps.run = (command, args) => {
        if (args[0] === 'plugin') seen.push(existsSync(backup) ? readFileSync(backup, 'utf8') : 'none');
        return inner(command, args);
      };
      assert.equal(await configure(opts(), h.deps), 0);
      return seen;
    };
    const kept = await backupSeenByPluginCommands({ '.claude/settings.json': original, '.claude/settings.json.h7bak': 'older' });
    assert.ok(kept.length > 0 && kept.every((b) => b === 'older'));
    const fresh = await backupSeenByPluginCommands({ '.claude/settings.json': original });
    assert.ok(fresh.length > 0 && fresh.every((b) => b === original));
  });

  it('dry run does not write the backup but says it would', async () => {
    const h = harness({ files: { '.claude/settings.json': original } });
    assert.equal(await configure(opts({ dryRun: true }), h.deps), 0);
    assert.equal(existsSync(`${settingsPath(h.home)}.h7bak`), false);
    assert.ok(h.logs.some((l) => l.startsWith('[dry-run] back up ')));
  });

  it('mergeSettings handles a UTF-8 BOM: parses through it and writes it back', () => {
    const entry = marketplaceEntry(null);
    const merged = mergeSettings('\uFEFF{\n  "a": 1\n}\n', entry);
    assert.equal(merged.changed, true);
    assert.ok(merged.text.startsWith('\uFEFF{'));
    assert.equal(merged.text.indexOf('\uFEFF', 1), -1);
    assert.deepEqual(JSON.parse(merged.text.slice(1)), { a: 1, extraKnownMarketplaces: { h7kz: entry } });
    assert.deepEqual(mergeSettings(merged.text, entry), { text: merged.text, changed: false });
    assert.ok(!mergeSettings('{}', entry).text.startsWith('\uFEFF'));
    assert.ok(mergeSettings('\uFEFF', entry).text.startsWith('\uFEFF{'));
    assert.throws(() => mergeSettings('\uFEFF{', entry), /not valid JSON/);
  });

  it('a BOM settings.json survives a full run', async () => {
    const h = harness({ files: { '.claude/settings.json': '\uFEFF{"model":"x"}' } });
    assert.equal(await configure(opts(), h.deps), 0);
    const text = readFileSync(settingsPath(h.home), 'utf8');
    assert.ok(text.startsWith('\uFEFF{'));
    assert.equal(JSON.parse(text.slice(1)).model, 'x');
  });

  it('writeFileAtomic writes through a temp file and leaves none behind', () => {
    const dir = tmpDir();
    const file = join(dir, 'a.json');
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two');
    assert.equal(readFileSync(file, 'utf8'), 'two');
    assert.deepEqual(readdirSync(dir), ['a.json']);
  });

  it('writeFileAtomic keeps the original and removes the temp file when the rename fails', () => {
    const dir = tmpDir();
    const file = join(dir, 'a.json');
    writeFileSync(file, 'original');
    const removed: string[] = [];
    const ops = {
      write: writeFileSync,
      rename: () => {
        throw new Error('rename failed');
      },
      remove: (p: string) => removed.push(p),
    } as unknown as AtomicOps;
    assert.throws(() => writeFileAtomic(file, 'new', ops), /rename failed/);
    assert.equal(readFileSync(file, 'utf8'), 'original');
    assert.deepEqual(removed, [`${file}.h7tmp`]);
    const failing = {
      ...ops,
      write: () => {
        throw new Error('disk full');
      },
      remove: () => {
        throw new Error('no such file');
      },
    } as unknown as AtomicOps;
    assert.throws(() => writeFileAtomic(file, 'new', failing), /disk full/);
  });
});

describe('configure: marketplace source mismatch', () => {
  const known = (entry: object) => ({ '.claude/plugins/known_marketplaces.json': JSON.stringify({ h7kz: entry, 'claude-plugins-official': {} }) });
  const warned = (h: Harness) => h.logs.filter((l) => /^warning: marketplace h7kz/.test(l));

  it('warns and explains how to switch when --local meets a github marketplace, and does not add', async () => {
    const h = harness({ files: known({ source: { source: 'github', repo: 'H7KZ/Agents' } }) });
    assert.equal(await configure(opts({ local: repoRoot }), h.deps), 0);
    assert.equal(warned(h).length, 1);
    assert.match(warned(h)[0] as string, /claude plugin marketplace remove h7kz/);
    assert.ok(!installing(h).some((c) => c.includes('marketplace add')));
  });

  it('warns when a github install meets a directory marketplace or another repo', async () => {
    for (const entry of [{ source: { source: 'directory', path: repoRoot } }, { source: { source: 'github', repo: 'other/Agents' } }, {}]) {
      const h = harness({ files: known(entry) });
      assert.equal(await configure(opts(), h.deps), 0);
      assert.equal(warned(h).length, 1, JSON.stringify(entry));
    }
  });

  it('is silent when the directory source is the same, and warns for another directory', async () => {
    const same = harness({ files: known({ source: { source: 'directory', path: repoRoot } }) });
    await configure(opts({ local: repoRoot }), same.deps);
    assert.equal(warned(same).length, 0);
    assert.ok(same.logs.some((l) => /already added/.test(l)));
    const other = harness({ files: known({ source: { source: 'directory', path: tmpDir() } }) });
    await configure(opts({ local: repoRoot }), other.deps);
    assert.equal(warned(other).length, 1);
  });
});

describe('configure: --dev (live edits)', () => {
  function devHarness(over: Parameters<typeof harness>[0] = {}): Harness & { repo: string; link: string; target: string } {
    const repo = tmpDir();
    writeTree(repo, { 'plugins/h7/.claude-plugin/plugin.json': '{"name":"h7"}', 'plugins/h7/skills/doctor/SKILL.md': 'x' });
    const h = harness(over);
    return { ...h, repo, link: join(h.home, '.claude', 'skills', 'h7'), target: join(repo, 'plugins', 'h7') };
  }

  it('links plugins/h7 into ~/.claude/skills/h7 so edits are live, adds no marketplace and writes no h7kz settings', async () => {
    const h = devHarness({ files: { '.claude/settings.json': '{"model":"x"}' } });
    assert.equal(await configure(opts({ dev: h.repo }), h.deps), 0);
    assert.ok(lstatSync(h.link).isSymbolicLink());
    assert.equal(realpathSync(h.link), realpathSync(h.target));
    writeFileSync(join(h.target, 'skills', 'doctor', 'SKILL.md'), 'edited');
    assert.equal(readFileSync(join(h.link, 'skills', 'doctor', 'SKILL.md'), 'utf8'), 'edited');
    assert.ok(!h.commands.some((c) => c.includes('marketplace add H7KZ') || c.includes('install h7@h7kz')));
    assert.equal(readFileSync(settingsPath(h.home), 'utf8'), '{"model":"x"}');
    assert.ok(h.logs.some((l) => /dev mode: no marketplace/.test(l)));
  });

  it('still installs mattpocock-skills (with its marketplace) in dev mode', async () => {
    const h = devHarness();
    await configure(opts({ dev: h.repo }), h.deps);
    assert.deepEqual(installing(h), ['claude plugin marketplace add anthropics/claude-plugins-official', 'claude plugin install mattpocock-skills@claude-plugins-official']);
  });

  it('uninstalls h7@h7kz first so h7 never loads twice', async () => {
    const h = devHarness({ files: { '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'h7@h7kz': [] } }) } });
    assert.equal(await configure(opts({ dev: h.repo }), h.deps), 0);
    assert.ok(installing(h).includes('claude plugin uninstall h7@h7kz'));
    assert.ok(lstatSync(h.link).isSymbolicLink());
  });

  it('is idempotent when already linked to the same plugin directory', async () => {
    const h = devHarness();
    await configure(opts({ dev: h.repo }), h.deps);
    h.logs.length = 0;
    assert.equal(await configure(opts({ dev: h.repo }), h.deps), 0);
    assert.ok(h.logs.some((l) => /already links to/.test(l)));
  });

  it('refuses to replace a link to somewhere else, a broken link or a real directory', async () => {
    const elsewhere = devHarness();
    const other = tmpDir();
    writeTree(other, { '.claude-plugin/plugin.json': '{"name":"h7"}' });
    mkdirSync(join(elsewhere.home, '.claude', 'skills'), { recursive: true });
    symlinkSync(other, elsewhere.link, 'junction');
    assert.equal(await configure(opts({ dev: elsewhere.repo }), elsewhere.deps), 1);
    assert.match(elsewhere.logs.at(-1) as string, /already exists \(ok, points to .*\); remove it/);
    assert.equal(realpathSync(elsewhere.link), realpathSync(other));

    const broken = devHarness();
    mkdirSync(join(broken.home, '.claude', 'skills'), { recursive: true });
    const gone = tmpDir();
    symlinkSync(gone, broken.link, 'junction');
    rmSync(gone, { recursive: true });
    assert.equal(await configure(opts({ dev: broken.repo }), broken.deps), 1);
    assert.match(broken.logs.at(-1) as string, /already exists \(broken\); remove it/);

    const real = devHarness({ files: { '.claude/skills/h7/keep.txt': 'mine' } });
    assert.equal(await configure(opts({ dev: real.repo }), real.deps), 1);
    assert.match(real.logs.at(-1) as string, /\(not-a-link\)/);
    assert.equal(readFileSync(join(real.link, 'keep.txt'), 'utf8'), 'mine');
  });

  it('dry run changes nothing and prints the link it would make', async () => {
    const h = devHarness({ files: { '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'h7@h7kz': [] } }) } });
    assert.equal(await configure(opts({ dev: h.repo, dryRun: true }), h.deps), 0);
    assert.equal(lstatSync(h.link, { throwIfNoEntry: false }), undefined);
    assert.ok(h.logs.some((l) => l.startsWith('[dry-run] link ') && l.includes('->')));
    assert.deepEqual(installing(h), []);
  });

  it('fails clearly when the path has no plugins/h7', async () => {
    const h = harness();
    assert.equal(await configure(opts({ dev: tmpDir() }), h.deps), 1);
    assert.match(h.logs.at(-1) as string, /--dev: no plugins\/h7\/\.claude-plugin\/plugin\.json/);
    assert.deepEqual(h.commands, []);
  });

  it('a normal run on a machine with a dev link warns that h7 would load twice', async () => {
    const h = devHarness();
    await configure(opts({ dev: h.repo }), h.deps);
    h.logs.length = 0;
    assert.equal(await configure(opts(), h.deps), 0);
    assert.ok(h.logs.some((l) => /^warning: .*h7 would load twice/.test(l)));
    const clean = harness();
    await configure(opts(), clean.deps);
    assert.ok(!clean.logs.some((l) => /load twice/.test(l)));
  });
});

describe('configure: dry-run output quoting', () => {
  it('quotes commands and paths that contain spaces', async () => {
    const repo = join(tmpDir(), 'dir with space', 'My Repo');
    writeTree(repo, { '.claude-plugin/marketplace.json': '{}' });
    const h = harness({ home: join(tmpDir(), 'home dir'), files: { '.claude/settings.json': '{}' } });
    assert.equal(await configure(opts({ dryRun: true, local: repo }), h.deps), 0);
    assert.ok(h.logs.some((l) => l === `[dry-run] run: claude plugin marketplace add "${repo}"`), h.logs.join('\n'));
    assert.ok(h.logs.some((l) => l.startsWith('[dry-run] merge ') && l.includes(`into "${join(h.home, '.claude', 'settings.json')}"`)));
    assert.ok(h.logs.some((l) => l.startsWith('[dry-run] create "') && l.includes('home dir')));
    assert.ok(h.logs.some((l) => l.startsWith('[dry-run] back up "')));
  });

  it('quote leaves plain arguments alone', () => {
    assert.equal(quote('H7KZ/Agents'), 'H7KZ/Agents');
    assert.equal(quote('C:\\a\\b'), 'C:\\a\\b');
    assert.equal(quote('a b'), '"a b"');
  });
});

describe('configure: skill lock follow-up', () => {
  function stale(): Harness {
    const home = tmpDir();
    writeTree(home, {
      '.agents/.skill-lock.json': JSON.stringify({ skills: { tdd: { source: 'mattpocock/skills' }, mine: { source: 'me/skills' } } }, null, 2),
    });
    mkdirSync(join(home, '.agents', 'skills', 'tdd'), { recursive: true });
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(home, '.agents', 'skills', 'tdd'), join(home, '.claude', 'skills', 'tdd'), 'junction');
    return harness({ home });
  }
  const lock = (h: Harness) => join(h.home, '.agents', '.skill-lock.json');

  it('notes that the lock remains and npx skills update can re-add the links', async () => {
    const h = stale();
    await configure(opts(), h.deps);
    assert.ok(h.logs.some((l) => /skill-lock\.json still lists 1 mattpocock\/skills entries.*npx skills update/.test(l)));
  });

  it('removes the mattpocock entries (keeping a backup) only after a second confirmation', async () => {
    const h = stale();
    const before = readFileSync(lock(h), 'utf8');
    const asked: string[] = [];
    h.deps.confirm = async (q) => {
      asked.push(q);
      return true;
    };
    assert.equal(await configure(opts(), h.deps), 0);
    assert.equal(asked.length, 2);
    assert.match(asked[1] as string, /skill-lock\.json/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(lock(h), 'utf8')).skills), ['mine']);
    assert.equal(readFileSync(`${lock(h)}.h7bak`, 'utf8'), before);
    assert.ok(h.logs.some((l) => /removed 1 mattpocock\/skills entries/.test(l)));
  });

  it('keeps the lock when the second question is declined', async () => {
    const h = stale();
    const before = readFileSync(lock(h), 'utf8');
    let n = 0;
    h.deps.confirm = async () => ++n === 1;
    assert.equal(await configure(opts(), h.deps), 0);
    assert.equal(readFileSync(lock(h), 'utf8'), before);
    assert.equal(existsSync(`${lock(h)}.h7bak`), false);
  });

  it('--yes removes the entries without asking, and dry run never touches the lock', async () => {
    const yes = stale();
    yes.deps.confirm = async () => assert.fail('must not ask');
    await configure(opts({ yes: true }), yes.deps);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(lock(yes), 'utf8')).skills), ['mine']);
    const dry = stale();
    const before = readFileSync(lock(dry), 'utf8');
    await configure(opts({ yes: true, dryRun: true }), dry.deps);
    assert.equal(readFileSync(lock(dry), 'utf8'), before);
  });

  it('does not ask about the lock when it lists no mattpocock entries', async () => {
    const h = harness({ files: { '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'mattpocock-skills@local-desktop-app-uploads': [] } }) } });
    let n = 0;
    h.deps.confirm = async () => {
      n++;
      return true;
    };
    await configure(opts(), h.deps);
    assert.equal(n, 1);
    assert.ok(!h.logs.some((l) => /skill-lock/.test(l)));
  });
});
