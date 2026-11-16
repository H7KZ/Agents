import { runs } from '../../../scripts/test/helpers.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { tokenize, type Dialect } from '../scripts/tokenize.ts';

const words = (input: string, dialect: Dialect = 'sh'): string[][] => tokenize(input, dialect).segments;
const nested = (input: string, dialect: Dialect = 'sh'): string[] => tokenize(input, dialect).nested;

describe('tokenize: words and quoting (sh)', () => {
  it('splits on whitespace and returns nothing for empty input', () => {
    assert.deepEqual(words(''), []);
    assert.deepEqual(words('   \t '), []);
    assert.deepEqual(words('git  push\torigin\r'), [['git', 'push', 'origin']]);
  });

  it('handles single quotes literally, including empty strings and unterminated quotes', () => {
    assert.deepEqual(words("echo 'a b' ''"), [['echo', 'a b', '']]);
    assert.deepEqual(words("echo 'it\\n $x'"), [['echo', 'it\\n $x']]);
    assert.deepEqual(words("echo 'open"), [['echo', 'open']]);
  });

  it('handles double quotes with escapes', () => {
    assert.deepEqual(words('echo "a b" "q\\"x" "\\\\" "\\$HOME" "\\`t" "a\\nb"'), [['echo', 'a b', 'q"x', '\\', '$HOME', '`t', 'a\\nb']]);
    assert.deepEqual(words('echo "line\\\ncont"'), [['echo', 'linecont']]);
    assert.deepEqual(words('echo "open'), [['echo', 'open']]);
    assert.deepEqual(words('echo "trail\\'), [['echo', 'trail\\']]);
  });

  it('joins adjacent quoted and bare parts', () => {
    assert.deepEqual(words('echo a"b c"\'d e\'f'), [['echo', 'ab cd ef']]);
  });

  it('handles backslash escapes but keeps Windows paths intact', () => {
    assert.deepEqual(words('echo a\\ b \\"q\\" \\;'), [['echo', 'a b', '"q"', ';']]);
    assert.deepEqual(words('rm C:\\Users\\new\\file'), [['rm', 'C:\\Users\\new\\file']]);
    assert.deepEqual(words('rd /s /q C:\\ && echo'), [['rd', '/s', '/q', 'C:\\'], ['echo']]);
    assert.deepEqual(words('echo trailing\\'), [['echo', 'trailing\\']]);
    assert.deepEqual(words('echo one\\\ntwo three\\\r\nfour'), [['echo', 'onetwo', 'threefour']]);
  });

  it('does not treat a drive-style prefix as special when the escaped char is not whitespace', () => {
    assert.deepEqual(words('echo C:\\;x'), [['echo', 'C:;x']]);
  });

  it('keeps escaped redirect characters as arguments', () => {
    assert.deepEqual(words('echo \\> x'), [['echo', '>', 'x']]);
  });
});

describe('tokenize: operators and segments', () => {
  it('splits on ; && || | & newline and parentheses', () => {
    assert.deepEqual(words('a;b&&c||d|e&f\ng (h) i'), [['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g'], ['h'], ['i']]);
  });

  it('drops empty segments', () => {
    assert.deepEqual(words(';; && || \n\n'), []);
  });

  it('strips comments only at word start', () => {
    assert.deepEqual(words('echo a # comment\nls'), [['echo', 'a'], ['ls']]);
    assert.deepEqual(words('echo a#b # c'), [['echo', 'a#b']]);
    assert.deepEqual(words('# only comment'), []);
  });

  it('removes redirections and their targets', () => {
    assert.deepEqual(words('git push origin main 2>&1 >out.txt &>/dev/null'), [['git', 'push', 'origin', 'main']]);
    assert.deepEqual(words('echo hi > file.txt more'), [['echo', 'hi', 'more']]);
    assert.deepEqual(words('echo hi 2> err more >> log.txt x'), [['echo', 'hi', 'more', 'x']]);
    assert.deepEqual(words('cat <in.txt <&3 >&2 x'), [['cat', 'x']]);
    assert.deepEqual(words('echo <<< word x'), [['echo', 'x']]);
    assert.deepEqual(words('echo a >| f b'), [['echo', 'a', 'b']]);
  });

  it('keeps quoted redirection characters as arguments', () => {
    assert.deepEqual(words('echo ">" \'>>\' x'), [['echo', '>', '>>', 'x']]);
  });

  it('a pending redirect target does not leak across segments', () => {
    assert.deepEqual(words('echo > ; ls x'), [['echo'], ['ls', 'x']]);
  });
});

describe('tokenize: substitutions', () => {
  it('extracts $() and backticks and keeps the original text in the word', () => {
    const t = tokenize('echo $(rm -rf /) `ls` x');
    assert.deepEqual(t.segments, [['echo', '$(rm -rf /)', '`ls`', 'x']]);
    assert.deepEqual(t.nested, ['rm -rf /', 'ls']);
  });

  it('extracts substitutions inside double quotes but not single quotes', () => {
    assert.deepEqual(nested('echo "a $(one) `two` b" \'$(three)\''), ['one', 'two']);
  });

  it('handles nested parentheses, quotes and escapes inside $()', () => {
    assert.deepEqual(nested('echo $(a (b) ")" \')\' \\) $(c))'), ['a (b) ")" \')\' \\) $(c)']);
    assert.deepEqual(nested('echo "$(a "x)" y)"'), ['a "x)" y']);
    assert.deepEqual(nested('echo $(a "q\\")" )'), ['a "q\\")" ']);
  });

  it('handles unterminated substitutions', () => {
    assert.deepEqual(nested('echo $(a b'), ['a b']);
    assert.deepEqual(nested('echo `a b'), ['a b']);
    assert.deepEqual(nested('echo "$(a'), ['a']);
    assert.deepEqual(nested('echo "`a'), ['a']);
  });

  it('handles escaped backticks inside backticks', () => {
    assert.deepEqual(nested('echo `a \\` b`'), ['a \\` b']);
  });

  it('does not extract an escaped dollar paren', () => {
    assert.deepEqual(nested('echo "\\$(x)"'), []);
  });

  it('extracts arithmetic expansion content too (harmless)', () => {
    assert.deepEqual(nested('echo $((1+2))'), ['(1+2)']);
  });
});

describe('tokenize: heredocs (sh)', () => {
  it('skips the body of a quoted-delimiter heredoc', () => {
    const t = tokenize("git commit -m \"$(cat <<'EOF'\nrm -rf / and $(evil)\nEOF\n)\"\nls");
    assert.deepEqual(t.nested, ['cat <<\'EOF\'\nrm -rf / and $(evil)\nEOF\n']);
    assert.deepEqual(tokenize("cat <<'EOF'\nrm -rf /\nEOF\nls").segments, [['cat'], ['ls']]);
  });

  it('scans substitutions in the body of an unquoted-delimiter heredoc', () => {
    const t = tokenize('cat <<EOF\nplain "quote" $(danger) `tick`\nEOF\nls');
    assert.deepEqual(t.segments, [['cat'], ['ls']]);
    assert.deepEqual(t.nested, ['danger', 'tick']);
  });

  it('supports <<-, double-quoted, backslash and spaced delimiters, CRLF and unterminated bodies', () => {
    assert.deepEqual(words('cat <<-EOF\n\tbody\n\tEOF\nls'), [['cat'], ['ls']]);
    assert.deepEqual(words('cat << "END"\nrm\nEND\nls'), [['cat'], ['ls']]);
    assert.deepEqual(words('cat <<\\X\nrm\nX\nls'), [['cat'], ['ls']]);
    assert.deepEqual(words('cat <<EOF\r\nrm\r\nEOF\r\nls'), [['cat'], ['ls']]);
    assert.deepEqual(words("cat <<'EOF\nnever closed\n"), [['cat']]);
    assert.deepEqual(words('cat <<EOF'), [['cat']]);
    assert.deepEqual(words('cat <<EOF;ls\nbody\nEOF\nx'), [['cat'], ['ls'], ['x']]);
  });

  it('handles several heredocs on one line', () => {
    assert.deepEqual(words("cat <<A <<'B'\none\nA\ntwo\nB\nls"), [['cat'], ['ls']]);
  });

  it('does not treat <<< as a heredoc', () => {
    assert.deepEqual(words('cat <<<x\nls'), [['cat'], ['ls']]);
  });
});

describe('tokenize: PowerShell dialect', () => {
  it('uses backtick as escape and keeps backslashes literal', () => {
    assert.deepEqual(words('Remove-Item C:\\a\\b `$x a` b', 'ps'), [['Remove-Item', 'C:\\a\\b', '$x', 'a b']]);
    assert.deepEqual(words('echo a`\nb `', 'ps'), [['echo', 'ab', '']]);
  });

  it('handles single and double quoted strings with doubled quotes', () => {
    assert.deepEqual(words("echo 'it''s' \"say \"\"hi\"\"\" \"a`\"b\" \"x`", 'ps'), [['echo', "it's", 'say "hi"', 'a"b', 'x']]);
  });

  it('extracts subexpressions but not backtick substitutions', () => {
    assert.deepEqual(nested('echo $(Get-X) "$(Get-Y)" `x', 'ps'), ['Get-X', 'Get-Y']);
  });

  it('skips backtick-escaped parens and quotes inside subexpressions', () => {
    assert.deepEqual(nested('echo $(a `) b) "$(c "q`")" d)"', 'ps'), ['a `) b', 'c "q`")" d']);
  });

  it('treats ; | && || braces and parens as separators and & as call operator', () => {
    assert.deepEqual(words('& git push; ls | % { rm x } && (a)', 'ps'), [['git', 'push'], ['ls'], ['%'], ['rm', 'x'], ['a']]);
    assert.deepEqual(words('a & b', 'ps'), [['a'], ['b']]);
    assert.deepEqual(words('a && b', 'ps'), [['a'], ['b']]);
    assert.deepEqual(words('echo ${env:X} @{a=1}', 'ps'), [['echo', '${env:X}', '@{a=1}']]);
  });

  it('does not treat << as a heredoc', () => {
    assert.deepEqual(words('echo <<EOF x', 'ps'), [['echo', 'x']]);
  });

  it('skips single-quoted here-strings and scans double-quoted ones', () => {
    assert.deepEqual(words("git commit -m @'\nrm -rf /\n'@\nls", 'ps'), [['git', 'commit', '-m', 'rm -rf /'], ['ls']]);
    const t = tokenize('git commit -m @"\nsay "hi" $(Danger)\n"@; ls', 'ps');
    assert.deepEqual(t.segments, [['git', 'commit', '-m', 'say "hi" $(Danger)'], ['ls']]);
    assert.deepEqual(t.nested, ['Danger']);
    assert.deepEqual(words("echo @'\nnever closed", 'ps'), [['echo', 'never closed']]);
    assert.deepEqual(words("echo @'\n'@", 'ps'), [['echo', '']]);
  });

  it('does not treat @ quote without newline as a here-string', () => {
    assert.deepEqual(words("echo @'x' y", 'ps'), [['echo', '@x', 'y']]);
  });
});

describe('tokenize: properties', () => {
  const safeWord = fc.stringMatching(/^[A-Za-z0-9_./=-]{1,12}$/);

  it('never throws and returns non-empty segments of strings for arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), fc.constantFrom<Dialect>('sh', 'ps'), (input, dialect) => {
        const t = tokenize(input, dialect);
        assert.ok(t.segments.every((s) => s.length > 0 && s.every((w) => typeof w === 'string')));
        assert.ok(t.nested.every((n) => typeof n === 'string'));
      }),
      { numRuns: runs(400) },
    );
  });

  it('never throws on shell-metacharacter soup', () => {
    const soup = fc.stringMatching(/^[a-z "'`$()\\;&|<>\n#@{}:=-]{0,80}$/);
    fc.assert(
      fc.property(soup, fc.constantFrom<Dialect>('sh', 'ps'), (input, dialect) => {
        tokenize(input, dialect);
      }),
      { numRuns: runs(600) },
    );
  });

  it('is deterministic', () => {
    fc.assert(fc.property(fc.string({ maxLength: 60 }), (input) => assert.deepEqual(tokenize(input), tokenize(input))));
  });

  it('round-trips plain words joined by spaces', () => {
    fc.assert(
      fc.property(fc.array(safeWord, { minLength: 1, maxLength: 6 }), (list) => {
        assert.deepEqual(words(list.join(' ')), [list]);
      }),
    );
  });

  it('round-trips arbitrary strings through single quotes in sh', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }).filter((s) => !s.includes("'") && !s.includes('\0')), (value) => {
        assert.deepEqual(words(`echo '${value}'`), [['echo', value]]);
      }),
    );
  });

  it('round-trips arbitrary strings through single quotes in PowerShell (quote doubling)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (value) => {
        assert.deepEqual(words(`echo '${value.replaceAll("'", "''")}'`, 'ps'), [['echo', value]]);
      }),
    );
  });

  it('operators in quotes never create segments', () => {
    fc.assert(
      fc.property(fc.constantFrom(';', '&&', '||', '|', '&', '\n', '$(x)'), safeWord, (op, w) => {
        const t = tokenize(`echo "${w}${op === '$(x)' ? '' : op}${w}" 'a${op}b'`);
        assert.equal(t.segments.length, 1);
      }),
    );
  });

  it('every extracted nested script appears verbatim in the input', () => {
    fc.assert(
      fc.property(safeWord, safeWord, (a, b) => {
        const input = `echo $(${a} ${b}) "$(${b})"`;
        assert.deepEqual(nested(input), [`${a} ${b}`, b]);
      }),
    );
  });
});

describe('tokenize: structure metadata', () => {
  it('records the separator before each segment', () => {
    const t = tokenize('a && b || c; d | e\nf & g');
    assert.deepEqual(t.ops, ['', '&&', '||', ';', '|', '\n', '&']);
    assert.deepEqual(tokenize('a\n\n\nb').ops, ['', '\n\n\n']);
  });

  it('tracks subshell depth and never goes negative', () => {
    const t = tokenize('(cd x; (ls)); rm');
    assert.deepEqual(t.segments, [['cd', 'x'], ['ls'], ['rm']]);
    assert.deepEqual(t.depths, [1, 2, 0]);
    assert.deepEqual(tokenize(') a').depths, [0]);
    assert.deepEqual(tokenize('echo $(cd x) y').depths, [0]);
  });

  it('flags segments that read stdin from heredocs, here-strings or files', () => {
    assert.deepEqual(tokenize('bash <<X\nls\nX\nbash <<< "ls"\nsh < f\necho hi > out\nsh <&3\ncat').inputs, [true, true, true, false, false, false]);
    assert.deepEqual(tokenize('a | sh').inputs, [false, false]);
  });
});
