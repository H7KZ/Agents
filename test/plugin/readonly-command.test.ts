import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { isReadOnly } from '../../plugins/h7/scripts/readonly-command.ts';
import { runs } from '../../scripts/test/helpers.ts';

const NAME = ['.h7', 'workspace.json'].join('-');

describe('isReadOnly', () => {
  it('accepts plain readers, pipes between them and read-only git', () => {
    for (const text of [`cat ${NAME}`, 'ls -la x', 'head -n 5 a | grep x | wc -l', `rg scratch ${NAME}`, 'tail -f a', 'stat a; cat b && ls', 'git status', 'git diff --stat HEAD', 'git log --oneline', 'git show HEAD:a', "grep 'a b' f", 'c""at f']) {
      assert.equal(isReadOnly(text, 'sh'), true, text);
    }
    for (const text of ['Get-Content a', 'Get-ChildItem . | Select-String x', 'type a', 'gc a | sls b']) assert.equal(isReadOnly(text, 'ps'), true, text);
  });

  it('refuses writers, redirects, substitutions, variables, heredocs and writing options', () => {
    for (const text of ['echo x', 'rm a', 'cp a b', 'tee a', 'sed -i s/a/b/ f', 'node -e 1', 'cat a > b', 'cat a >> b', 'cat a 2>b', 'cat $(echo a)', 'cat `x`', 'cat $F', 'cat <<EOF\nx\nEOF', 'git diff --output=x', 'git diff -o x', 'git commit', 'git -c core.pager=x log', 'git', 'git --exec-path=x log', 'rg --pre sh x', 'cat a | tee b', 'cat a; rm b', 'FOO=1 cat a', '', '   ', '(cat a', 'case x in a) cat;; esac', 'sudo rm a']) {
      assert.equal(isReadOnly(text, 'sh'), false, text);
    }
    for (const text of ['Set-Content a x', '"x" | Out-File a', 'Get-Content a > b', '& Get-Content a', 'Remove-Item a']) assert.equal(isReadOnly(text, 'ps'), false, text);
  });

  it('property: a command with a redirect or a non-reader word is never read-only', () => {
    const word = fc.constantFrom('a', 'b.txt', '-n', NAME);
    fc.assert(
      fc.property(fc.array(word, { maxLength: 4 }), fc.constantFrom('>', '>>', '2>', '| tee', '; rm', '&& mv'), (args, bad) => {
        assert.equal(isReadOnly(`cat ${args.join(' ')} ${bad} out`, 'sh'), false);
      }),
      { numRuns: runs(80) },
    );
  });
});
