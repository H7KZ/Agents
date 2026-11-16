import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { cleanupTmp, tmpDir, writeTree } from '../../scripts/test/helpers.ts';
import { SEVERITIES, extractReport, main, mergeFindings, parseReport, realRead, summarize, type Merged } from '../../plugins/h7/scripts/review-findings.ts';

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

  it('property: ids are F1..Fn, commands are unique and severities sorted', () => {
    const item = fc.record({ title: fc.string({ minLength: 1 }), command: fc.constantFrom('a', 'b', 'c', 'd'), output: fc.constant('o'), severity: fc.constantFrom(...SEVERITIES), file: fc.constantFrom('x', 'y'), line: fc.integer({ min: 1, max: 3 }) });
    fc.assert(
      fc.property(fc.array(fc.array(item, { maxLength: 5 }), { maxLength: 4 }), (lists) => {
        const merged = mergeFindings(lists.map((items, i) => parse(`l${i}`, items)));
        assert.deepEqual(merged.map((m) => m.id), merged.map((_, i) => `F${i + 1}`));
        assert.equal(new Set(merged.map((m) => m.command)).size, merged.length);
        const order = merged.map((m) => SEVERITIES.indexOf(m.severity));
        assert.deepEqual(order, [...order].sort((a, b) => a - b));
      }),
    );
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

  it('prints usage on bad arguments', () => {
    for (const argv of [[], ['merge'], ['keep'], ['nope', 'x']]) {
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
