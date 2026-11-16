import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { cleanupTmp, tmpDir, writeTree } from '../../scripts/test/helpers.ts';
import { MAX_FINDINGS_PER_LENS, MAX_OUTPUT, SEVERITIES, classifyCommand, extractReport, main, mergeFindings, parseReport, realRead, summarize, type Merged } from '../../plugins/h7/scripts/review-findings.ts';

cleanupTmp();

const script = join(import.meta.dirname, '../../plugins/h7/scripts/review-findings.ts');

const finding = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Path traversal in upload',
  severity: 'high',
  file: 'src/upload.ts',
  line: 12,
  claim: 'name is joined unchecked',
  command: 'node -e "console.log(1)"',
  output: '1',
  ...over,
});

const report = (lens: string, findings: unknown[]): string => `Review done.\n\n\`\`\`json\n${JSON.stringify({ lens, findings })}\n\`\`\`\n`;

describe('extractReport', () => {
  it('takes the last fenced block that is a report and ignores others', () => {
    const body = ['```json\n{"findings":[{"title":"old"}]}\n```', '```\nnot json\n```', '```JSON\n{"findings":[{"title":"new"}]}\n```', '```json\n{"nope":1}\n```'].join('\n');
    assert.deepEqual(extractReport(body), { findings: [{ title: 'new' }] });
  });

  it('accepts unfenced JSON and CRLF fences, rejects arrays and non-reports', () => {
    assert.deepEqual(extractReport('{"findings":[]}'), { findings: [] });
    assert.deepEqual(extractReport('```json\r\n{"findings":[]}\r\n```'), { findings: [] });
    for (const body of ['', 'prose only', '[]', '{"findings":3}', '```json\n{\n```', '```json\n[{"findings":[]}]\n```']) assert.equal(extractReport(body), null, body);
  });

  it('never throws on any text', () => {
    fc.assert(fc.property(fc.string(), (body) => void extractReport(body)));
  });
});

describe('regressions from review', () => {
  it('keeps the report when a finding output contains a fenced block', () => {
    const output = 'run:\n```sh\nnpm test\n```\nfailed';
    const body = '```json\n' + JSON.stringify({ lens: 'spec', findings: [finding({ output })] }, null, 2) + '\n```\n';
    const r = parseReport(body);
    assert.equal(r.error, null);
    assert.equal(r.findings[0]?.output, output);
    const raw = '```json\n{"lens":"spec","findings":[{"title":"t","command":"c","output":"a```\\n b"}]}\n```';
    assert.equal(parseReport(raw).findings.length, 1);
  });

  it('does not merge distinct findings that share a command', () => {
    const merged = mergeFindings([parseReport(report('a', [finding({ command: 'npm test', line: 1, title: 'one' }), finding({ command: 'npm test', line: 2, title: 'two' }), finding({ command: 'npm test', file: 'other.ts', line: 1, title: 'three' })]))]);
    assert.equal(merged.length, 3);
  });

  it('records every absorbed duplicate in a merged trace', () => {
    const merged = mergeFindings([parseReport(report('a', [finding({ severity: 'high' })])), parseReport(report('b', [finding({ severity: 'low', title: 'Other words' })])), parseReport(report('c', [finding({ severity: 'medium', title: 'x' })]))]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]?.merged, [
      { lens: 'c', title: 'x', severity: 'medium' },
      { lens: 'b', title: 'Other words', severity: 'low' },
    ]);
    assert.deepEqual(mergeFindings([parseReport(report('a', [finding()]))])[0]?.merged, []);
  });

  it('caps findings per lens and truncates oversized output with a marker', () => {
    const many = Array.from({ length: MAX_FINDINGS_PER_LENS + 3 }, (_, i) => finding({ command: `c${i}`, title: `t${i}` }));
    const r = parseReport(report('a', many));
    assert.equal(r.findings.length, MAX_FINDINGS_PER_LENS);
    assert.deepEqual(r.dropped.map((d) => d.reason), Array(3).fill(`over the cap of ${MAX_FINDINGS_PER_LENS} findings per lens`));
    const big = parseReport(report('a', [finding({ output: 'x'.repeat(MAX_OUTPUT + 50) })])).findings[0]?.output as string;
    assert.ok(big.startsWith('x'.repeat(MAX_OUTPUT)));
    assert.ok(big.endsWith('[truncated 50 chars]'));
    assert.equal(parseReport(report('a', [finding({ output: 'x'.repeat(MAX_OUTPUT) })])).findings[0]?.output, 'x'.repeat(MAX_OUTPUT));
  });
});

describe('parseReport', () => {
  it('keeps proven findings with normalized fields', () => {
    const r = parseReport(report('security', [finding({ severity: 'HIGH', title: '  T  ', line: 3 })]));
    assert.equal(r.error, null);
    assert.deepEqual(r.findings, [{ lens: 'security', title: 'T', severity: 'high', file: 'src/upload.ts', line: 3, claim: 'name is joined unchecked', command: 'node -e "console.log(1)"', output: '1' }]);
    assert.deepEqual(r.dropped, []);
  });

  it('drops a finding with no command, no output or no title, and says why', () => {
    const r = parseReport(
      report('spec', [finding({ command: '  ' }), finding({ command: undefined, title: 'b' }), finding({ output: '' , title: 'c' }), finding({ output: 5, title: 'd' }), finding({ title: '' }), 'junk', null, finding({ title: 'ok' })]),
    );
    assert.deepEqual(r.findings.map((f) => f.title), ['ok']);
    assert.deepEqual(r.dropped, [
      { lens: 'spec', title: 'Path traversal in upload', reason: 'no reproducing command' },
      { lens: 'spec', title: 'b', reason: 'no reproducing command' },
      { lens: 'spec', title: 'c', reason: 'no command output' },
      { lens: 'spec', title: 'd', reason: 'no command output' },
      { lens: 'spec', title: '(untitled)', reason: 'no title' },
      { lens: 'spec', title: '(untitled)', reason: 'no reproducing command' },
      { lens: 'spec', title: '(untitled)', reason: 'no reproducing command' },
    ]);
  });

  it('defaults severity to low and drops invalid lines', () => {
    for (const severity of [undefined, 'urgent', 3]) assert.equal(parseReport(report('x', [finding({ severity })])).findings[0]?.severity, 'low');
    for (const line of [0, -1, 1.5, '3', null, undefined]) assert.equal(parseReport(report('x', [finding({ line })])).findings[0]?.line, null, String(line));
  });

  it('uses the hint when the report names no lens, and reports unparsable text as an error', () => {
    assert.equal(parseReport(report('', [finding()]), 'perf').lens, 'perf');
    assert.equal(parseReport(report('', [finding()])).lens, 'unknown');
    const bad = parseReport('I found nothing.', 'perf');
    assert.deepEqual([bad.lens, bad.findings, bad.error], ['perf', [], 'no JSON report with a findings array']);
  });

  it('property: every kept finding has a command and output, every input is kept or dropped', () => {
    const item = fc.record({ title: fc.string(), command: fc.string(), output: fc.string(), severity: fc.string() });
    fc.assert(
      fc.property(fc.array(item, { maxLength: 8 }), (items) => {
        const r = parseReport(JSON.stringify({ findings: items }));
        assert.equal(r.findings.length + r.dropped.length, items.length);
        for (const f of r.findings) assert.ok(f.command !== '' && f.output !== '' && SEVERITIES.includes(f.severity));
      }),
    );
  });
});

describe('mergeFindings', () => {
  const parse = (lens: string, items: unknown[]) => parseReport(report(lens, items));

  it('dedupes by command across lenses, keeps the strongest severity and unions lenses', () => {
    const merged = mergeFindings([parse('security', [finding({ severity: 'medium', title: 'one' })]), parse('adversarial', [finding({ severity: 'blocker', title: 'other words', command: 'node  -e  "console.log(1)"' })])]);
    assert.equal(merged.length, 1);
    assert.deepEqual([merged[0]?.severity, merged[0]?.title, merged[0]?.lenses], ['blocker', 'other words', ['adversarial', 'security']]);
  });

  it('dedupes by place and title when commands differ, ignoring case and punctuation', () => {
    const merged = mergeFindings([parse('a', [finding({ command: 'c1' })]), parse('b', [finding({ command: 'c2', title: 'path TRAVERSAL, in upload!' })])]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]?.lenses, ['a', 'b']);
  });

  it('keeps distinct findings and does not repeat a lens', () => {
    const merged = mergeFindings([parse('a', [finding({ command: 'c1' }), finding({ command: 'c1', title: 'again' }), finding({ command: 'c2', line: 99 })])]);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0]?.lenses, ['a']);
  });

  it('ranks by severity, then agreeing lenses, then file, line and title; ids follow the order', () => {
    const merged = mergeFindings([
      parse('a', [
        finding({ severity: 'low', command: 'l', title: 'z' }),
        finding({ severity: 'high', command: 'h2', file: 'b.ts', line: 1, title: 'y' }),
        finding({ severity: 'high', command: 'h1', file: 'a.ts', line: 9, title: 'y' }),
        finding({ severity: 'high', command: 'h0', file: 'a.ts', line: 2, title: 'y' }),
        finding({ severity: 'high', command: 'h3', file: 'a.ts', line: null, title: 'x' }),
        finding({ severity: 'high', command: 'h4', file: 'a.ts', line: null, title: 'w' }),
        finding({ severity: 'blocker', command: 'b' }),
      ]),
      parse('b', [finding({ severity: 'high', command: 'h2', file: 'b.ts', line: 1, title: 'y' })]),
    ]);
    assert.deepEqual(merged.map((m) => `${m.id}:${m.command}`), ['F1:b', 'F2:h2', 'F3:h4', 'F4:h3', 'F5:h0', 'F6:h1', 'F7:l']);
  });

  it('is empty for no reports and for reports without findings', () => {
    assert.deepEqual(mergeFindings([]), []);
    assert.deepEqual(mergeFindings([parse('a', [])]), []);
  });

  it('property: ids are F1..Fn, place and command pairs are unique and severities sorted', () => {
    const item = fc.record({ title: fc.string({ minLength: 1 }), command: fc.constantFrom('a', 'b', 'c', 'd'), output: fc.constant('o'), severity: fc.constantFrom(...SEVERITIES), file: fc.constantFrom('x', 'y'), line: fc.integer({ min: 1, max: 3 }) });
    fc.assert(
      fc.property(fc.array(fc.array(item, { maxLength: 5 }), { maxLength: 4 }), (lists) => {
        const merged = mergeFindings(lists.map((items, i) => parse(`l${i}`, items)));
        assert.deepEqual(merged.map((m) => m.id), merged.map((_, i) => `F${i + 1}`));
        assert.equal(new Set(merged.map((m) => `${m.file}:${m.line}:${m.command}`)).size, merged.length);
        const order = merged.map((m) => SEVERITIES.indexOf(m.severity));
        assert.deepEqual(order, [...order].sort((a, b) => a - b));
      }),
    );
  });
});

describe('classifyCommand', () => {
  const status = (command: string, tests: string[] = []): string => classifyCommand(command, tests).status;

  it('auto-runs only single read-only git, grep and rg commands over repo paths', () => {
    for (const command of [
      'git diff main..HEAD -- src/a.ts',
      'git show HEAD:src/a.ts',
      'git log --oneline -n 5 --format=%H',
      'git grep -n -e "needle here" -- src',
      'git grep -niw needle src',
      'git blame -w src/a.ts',
      'git log -U3 --unified=5 --max-count=2 --pretty=%H:%s',
      'git ls-files src',
      'git cat-file -p HEAD',
      'git rev-parse HEAD~1',
      'git status',
      'git diff --no-ext-diff --no-textconv',
      "grep -rn 'needle' src test",
      'rg -n needle src/a.ts',
      '  git   diff  ',
    ]) {
      assert.equal(status(command), 'auto', command);
    }
  });

  it('needs approval for shell metacharacters of every kind', () => {
    for (const command of ['git diff; rm -rf x', 'git diff && git log', 'git log | sh', 'git log > out.txt', 'git log < in', 'git log `id`', 'git log $(id)', 'git log $HOME', 'git log\nrm x', 'git log\rx', 'git log a\\b', 'git log (x)', 'git log {a,b}']) {
      assert.equal(status(command), 'needs-approval', JSON.stringify(command));
    }
  });

  it('needs approval for interpreters, other programs and unknown git subcommands', () => {
    for (const command of ['node -e "1"', 'python -c 1', 'npm test', 'sh run.sh', './git diff', '/usr/bin/git diff', 'FOO=1 git diff', 'git', 'git push', 'git checkout main', 'git config user.name x', 'git -c core.pager=x log', 'git --no-pager log', '', '   ', "git 'log"]) {
      assert.equal(status(command), 'needs-approval', JSON.stringify(command));
    }
  });

  it('needs approval for options that execute programs or write files', () => {
    for (const command of ['git diff --ext-diff', 'git diff --textconv', 'git diff --output=x.patch', 'git diff --output x', 'git log --exec=x', 'git grep -O less x', 'git grep --open-files-in-pager=x y', 'git log -c', 'git log --config=x', 'git log --upload-pack=x', 'rg --pre cat x', 'rg --pre=cat x', 'rg -z x', 'rg -nz x', 'rg --search-zip x', 'rg --hostname-bin=x y']) {
      assert.equal(status(command), 'needs-approval', command);
    }
  });

  it('needs approval for paths that can leave the repo, including option values', () => {
    for (const command of ['git show /etc/passwd', 'git show C:/x', 'git diff ../other', 'git diff a/../../b', 'git diff ..', 'grep -r x ~/.ssh', 'grep x /etc/hosts', 'rg x ../x', 'git blame --contents=/etc/passwd a.ts', 'git diff --src-prefix=../x']) {
      assert.equal(status(command), 'needs-approval', command);
    }
    assert.equal(status('git diff --relative=src'), 'needs-approval');
    assert.equal(status('git diff main...HEAD'), 'auto');
  });

  it('needs approval for every bypass of a denylist: abbreviations, bundles, attached values, globs', () => {
    for (const command of [
      'git diff --out=x.patch',
      'git diff --ext',
      'git diff --ext-d',
      'git log --exe=x',
      'git grep -aO less x',
      'git grep -O/etc/x y',
      'git grep -Oless y',
      'git log -ac',
      'git log -n5c',
      'git diff -U3x',
      'git diff --unified=3a',
      'git diff --unified=',
      'git log --format=%H;x',
      'git log --pretty=',
      'git show *',
      'git show a?',
      'git show [a]',
      'git ls-files *.ts',
      'grep -rO x src',
      'grep -rne x src',
      'grep -f /etc/passwd src',
      'grep --file=x src',
      'grep --color=always x',
      'rg -r x src',
      'rg -j2 x',
      'rg --follow x',
      'rg -uuu x',
      'git grep -e',
      'git grep -e "*.x" src',
      'git grep -e -x src',
      'git grep -e [a] src',
      'git status --ignored',
      'git ls-files -z',
      'git cat-file --batch',
      'git rev-parse --git-dir',
      'git diff -- ../x',
      'git diff -- *',
      'git diff -- -x',
      'git diff -- -- x',
    ]) {
      assert.equal(status(command), 'needs-approval', command);
    }
  });

  it('property: a glob, home, absolute, parent or dash-led argument is never auto', () => {
    const hostile = fc.oneof(
      fc.string().map((x) => x + '*'),
      fc.string().map((x) => '?' + x),
      fc.string().map((x) => '[' + x),
      fc.string().map((x) => '/' + x),
      fc.string().map((x) => '~' + x),
      fc.string().map((x) => '../' + x),
      fc.string().map((x) => 'a/../' + x),
      fc.string().map((x) => '-O' + x),
      fc.string().map((x) => '--' + x + '=/etc'),
    );
    fc.assert(fc.property(fc.constantFrom('git diff', 'git log', 'git show', 'git grep -e a', 'grep -r a', 'rg a'), hostile, (base, arg) => assert.equal(classifyCommand(base + ' ' + arg).status, 'needs-approval')));
  });

  it('regression: the property generator produced options that really are allowlisted', () => {
    // Found by fast-check on a rare run: a dash-led string can be a legitimate option (-w, --, --no-color), so it is not hostile.
    for (const command of ['grep -r a -w', 'git grep -e a -i', 'git diff --', 'git diff --no-color', 'rg a -n']) assert.equal(classifyCommand(command).status, 'auto', command);
    for (const command of ['git diff -O', 'git diff --x=/etc', 'rg a -O ', 'grep -r a --=/etc']) assert.equal(classifyCommand(command).status, 'needs-approval', command);
  });

  it('auto-runs the exact recorded test command, whatever its shape, and nothing similar', () => {
    assert.equal(status('npm  test', ['npm test']), 'auto');
    assert.equal(status('node --test a.test.ts && echo x', ['node --test a.test.ts && echo x']), 'auto');
    assert.equal(status('npm test -- --bail', ['npm test']), 'needs-approval');
    assert.equal(status('npm run test', ['npm test']), 'needs-approval');
    assert.equal(status('', ['']), 'needs-approval');
  });

  it('always explains itself and never throws', () => {
    fc.assert(fc.property(fc.string(), (command) => assert.notEqual(classifyCommand(command).reason, '')));
  });

  it('property: nothing with a shell metacharacter, or a git write option, is ever auto', () => {
    const meta = fc.constantFrom(';', '&', '|', '>', '<', '`', '$', '\n');
    fc.assert(fc.property(fc.constantFrom('git diff', 'git log', 'grep -r x', 'rg x'), meta, (base, bit) => assert.equal(classifyCommand(base + ' ' + bit + ' a').status, 'needs-approval')));
    const option = fc.constantFrom('--output=x', '--ext-diff', '--textconv', '-c', '--exec=x');
    fc.assert(fc.property(fc.constantFrom('git diff', 'git log', 'git show'), option, (base, bit) => assert.equal(classifyCommand(base + ' ' + bit + ' a').status, 'needs-approval')));
  });
});

describe('summarize and main', () => {
  const files: Record<string, string> = {
    '/r/security.md': report('', [finding(), finding({ command: '', title: 'unproven' })]),
    '/r/spec.md': report('spec', [finding({ command: 'other', title: 'Spec gap', severity: 'blocker' })]),
    '\\r\\perf.md': 'no report here',
  };
  const read = (file: string): string | null => files[file] ?? null;

  it('merges reports, collects drops, and flags unreadable or unparsable reviewers', () => {
    const s = summarize(['/r/security.md', '/r/spec.md', '\\r\\perf.md', '/r/gone.md'], read);
    assert.deepEqual(s.findings.map((f) => [f.id, f.lenses]), [['F1', ['spec']], ['F2', ['security']]]);
    assert.deepEqual(s.dropped, [{ lens: 'security', title: 'unproven', reason: 'no reproducing command' }]);
    assert.deepEqual(s.errors, [
      { file: '\\r\\perf.md', error: 'no JSON report with a findings array' },
      { file: '/r/gone.md', error: 'cannot read file' },
    ]);
  });

  const run = (argv: string[], r = read) => {
    const out: string[] = [];
    const err: string[] = [];
    return { code: main(argv, (t) => out.push(t), (t) => err.push(t), r), out, err };
  };

  it('merge prints the summary as JSON', () => {
    const r = run(['merge', '/r/spec.md']);
    assert.equal(r.code, 0);
    assert.equal((JSON.parse(r.out[0] as string) as { findings: Merged[] }).findings[0]?.title, 'Spec gap');
  });

  it('keep splits findings into kept and rejected ids', () => {
    const merged = JSON.stringify(summarize(['/r/security.md', '/r/spec.md'], read));
    const r = run(['keep', 'm.json', 'F2'], (f) => (f === 'm.json' ? merged : null));
    assert.equal(r.code, 0);
    const result = JSON.parse(r.out[0] as string) as { kept: Merged[]; rejected: string[] };
    assert.deepEqual([result.kept.map((f) => f.id), result.rejected], [['F2'], ['F1']]);
    assert.deepEqual(JSON.parse(run(['keep', 'm.json'], () => merged).out[0] as string).kept, []);
  });

  it('keep fails on unknown ids, missing files and non-merge files', () => {
    const merged = JSON.stringify(summarize(['/r/spec.md'], read));
    assert.match(run(['keep', 'm.json', 'F9', 'F1'], () => merged).err[0] as string, /unknown finding ids: F9$/);
    assert.equal(run(['keep', 'm.json', 'F9'], () => merged).code, 2);
    for (const body of [null, '{', '{"findings":3}', '[]']) {
      const r = run(['keep', 'm.json'], () => body);
      assert.equal(r.code, 2);
      assert.match(r.err[0] as string, /missing or not a merge result/);
    }
  });

  it('classify says which finding commands may be rerun unasked', () => {
    const merged = JSON.stringify(summarize(['/r/security.md', '/r/spec.md'], read));
    const r = run(['classify', 'm.json', '--test', 'other'], () => merged);
    assert.equal(r.code, 0);
    const result = JSON.parse(r.out[0] as string) as { results: Array<{ id: string; status: string }>; needsApproval: string[] };
    assert.deepEqual(result.results.map((x) => [x.id, x.status]), [['F1', 'auto'], ['F2', 'needs-approval']]);
    assert.deepEqual(result.needsApproval, ['F2']);
    assert.deepEqual(JSON.parse(run(['classify', 'm.json'], () => merged).out[0] as string).needsApproval, ['F1', 'F2']);
  });

  it('classify rejects bad options and unreadable findings', () => {
    const merged = JSON.stringify(summarize(['/r/spec.md'], read));
    for (const argv of [['classify', 'm.json', '--test'], ['classify', 'm.json', '--tests', 'x'], ['classify', 'm.json', 'x']]) {
      const r = run(argv, () => merged);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err[0] as string, /usage: review-findings\.ts/);
    }
    assert.equal(run(['classify', 'm.json'], () => null).code, 2);
  });

  it('prints usage on bad arguments', () => {
    for (const argv of [[], ['merge'], ['keep'], ['classify'], ['nope', 'x']]) {
      const r = run(argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err[0] as string, /usage: review-findings\.ts/);
    }
  });
});

describe('review-findings.ts as a script', () => {
  it('reads reviewer files from disk and fails closed on bad arguments', () => {
    const dir = tmpDir();
    writeTree(dir, { 'security.md': report('security', [finding()]) });
    const ok = spawnSync(process.execPath, [script, 'merge', join(dir, 'security.md'), join(dir, 'missing.md')], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const summary = JSON.parse(ok.stdout) as { findings: Merged[]; errors: unknown[] };
    assert.equal(summary.findings.length, 1);
    assert.equal(summary.errors.length, 1);
    const bad = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /usage/);
    assert.equal(realRead(join(dir, 'missing.md')), null);
  });
});
