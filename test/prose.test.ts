// Prose checking's models (src/prose-model.ts, src/prose-rules-model.ts),
// with worg's writing.test.ts cases. No vscode: mocha --ui tdd out/test/prose.test.js
import * as assert from 'assert';
import {
    walk, todoStates, proseSpans, paragraphs, paragraphAt, issueRange, harperIssues, mergeHarper, kept, harperText, OBJ, Issue,
} from '../src/prose-model';
import { grammarIssues, sentences, nameIndex, nameIssues, echoIssues, localIssues } from '../src/prose-rules-model';

const todo = todoStates('');
const read = (text: string) => {
    const lines = text.split('\n');
    return { lines, states: walk(lines) };
};

suite('Prose', () => {
    test('only the words, not org', () => {
        const line = 'Met <2026-10-21 Wed> at [[https://x.org][the hall]] with =code= :x: https://a.b/c';
        const got = proseSpans(line, walk([line])[0], todo).map(s => line.slice(s.from, s.to));
        assert.strictEqual(got.join('|'), 'Met | at |the hall| with | :x: ');
    });

    test('drawers, keywords, blocks, tables and comments are not prose', () => {
        const { lines, states } = read([
            '#+TITLE: Two words', '* TODO Hello there :tag:', 'SCHEDULED: <2026-10-21 Wed>', ':PROPERTIES:', ':ID: x', ':END:',
            '#+BEGIN_SRC', 'not me', '#+END_SRC', '| a | table |', '# NOTE: a comment', 'And four more words.',
        ].join('\n'));
        const got = paragraphs(lines, states, todo).map(p => p.text);
        assert.deepStrictEqual(got, ['Hello there', 'And four more words.']);
    });

    test('a paragraph joins its lines and knows where each character is', () => {
        const { lines, states } = read('- item one\nFirst line of\n*bold* end <2026-01-01> more.\n\nNext.');
        const ps = paragraphs(lines, states, todo);
        // A list item takes the lines under it; emphasis markers are no gap,
        // a timestamp is one.
        assert.deepStrictEqual(ps.map(p => p.text), ['item one\nFirst line of\nbold end ' + OBJ + ' more.', 'Next.']);
        assert.deepStrictEqual(paragraphAt(lines, 2), [0, 2]);
        const p = ps[0];
        const at = p.text.indexOf('end');
        assert.deepStrictEqual(issueRange(p, at, at + 3), { start: { line: 2, col: 7 }, end: { line: 2, col: 10 } });
        assert.strictEqual(harperText(p.text), 'item one\nFirst line of\nbold end   more.');
        // Only the paragraphs touching a range.
        assert.deepStrictEqual(paragraphs(lines, states, todo, 4, 4).map(x => x.first), [4]);
    });

    test('a file\'s own todo keywords stay out of a heading', () => {
        const text = '#+TODO: DRAFT | FINAL\n* DRAFT The opening';
        const { lines, states } = read(text);
        assert.deepStrictEqual(paragraphs(lines, states, todoStates(text)).map(p => p.text), ['The opening']);
    });
});

suite('Prose rules', () => {
    const rules = (t: string) => grammarIssues(t).map(i => `${i.rule}:${t.slice(i.from, i.to)}>${i.fixes[0] ?? ''}`);
    const has = (got: string[], want: string[]) => want.forEach(w => assert.ok(got.includes(w), `${w} in ${got.join(', ')}`));

    test('sentences skip abbreviations', () => {
        const t = 'Mr. Smith left. He said, e.g. this! Then "quiet." End';
        assert.deepStrictEqual(sentences(t).map(([a, b]) => t.slice(a, b)), ['Mr. Smith left.', 'He said, e.g. this!', 'Then "quiet."', 'End']);
    });

    test('repeats, articles, i, capitals', () => {
        has(rules('I saw the the cat. it was a apple and an car.'), ['repeat:the the>the', 'capital:i>I', 'article:a>an', 'article:an>a']);
        assert.deepStrictEqual(rules('An hour, a user, a European, an FBI agent, a UFO.'), []);
        assert.deepStrictEqual(rules('so i think i.e. this'), ['pronoun:i>I']);
    });

    test('usage and wordiness', () => {
        has(rules('We could of gone in order to win.'), ['usage:could of>could have', 'wordy:in order to>to']);
    });

    test('spacing and passive voice', () => {
        has(rules('Words ,here and,there. The ball was thrown.'), ['space-before: ,>,', 'space-after:,>, ', 'passive:was thrown>']);
        assert.deepStrictEqual(rules('term :: what it means'), []);
        assert.deepStrictEqual(rules('I was tired.'), []);
        assert.deepStrictEqual(rules('She had been gone for years.'), []);
    });

    test('rules can be switched off by kind', () => {
        assert.deepStrictEqual(grammarIssues('It was very done in order to', { grammar: true, style: false }), []);
    });

    test('a name one slip from a common one', () => {
        const { lines, states } = read('Then Mara ran. And Mara hid. So Mara won. Later Marra came. Then Bob left.');
        const names = nameIndex(lines, states, todo);
        assert.strictEqual(names.get('Mara'), 3);
        const t = lines[0];
        assert.deepStrictEqual(nameIssues(t, names).map(i => [t.slice(i.from, i.to), i.fixes[0]]), [['Marra', 'Mara']]);
        assert.ok(localIssues(t, names).some(i => i.rule === 'name'));
    });

    test('the same word again too soon', () => {
        const t = 'The light turned. She watched the light fade. Far away, much later, another light.';
        assert.deepStrictEqual(echoIssues(t, 6).map(i => i.msg), ['"light" again, 5 words after the last']);
        assert.deepStrictEqual(echoIssues('Then Mara ran and Mara hid.'), []);
    });
});

suite('Harper', () => {
    test('lints become issues, Harper first where both mark the same words', () => {
        const h = harperIssues([
            { rule: 'SpellCheck', kind: 'Spelling', start: 4, end: 8, msg: 'Did you mean `word`?', fixes: ['word', 'word', 'ward'] },
            { rule: 'RepeatedWords', kind: 'Repetition', start: 10, end: 17, msg: 'Repeated', fixes: ['the'] },
            { rule: 'Empty', kind: 'Grammar', start: 3, end: 3, msg: 'nothing', fixes: [] },
        ]);
        assert.deepStrictEqual(h.map(i => [i.rule, i.kind, i.msg, i.fixes]), [
            ['harper:SpellCheck', 'spell', 'Did you mean “word”?', ['word', 'ward']],
            ['harper:RepeatedWords', 'style', 'Repeated', ['the']],
        ]);
        const local: Issue[] = [
            { from: 10, to: 17, kind: 'grammar', msg: 'twice', fixes: [], rule: 'repeat' },
            { from: 20, to: 22, kind: 'style', msg: 'filler', fixes: [''], rule: 'filler' },
        ];
        assert.deepStrictEqual(mergeHarper(local, h, () => false).map(i => i.rule), ['harper:SpellCheck', 'harper:RepeatedWords', 'filler']);
        // A name the file uses often is not misspelt.
        assert.deepStrictEqual(mergeHarper(local, h, () => true).map(i => i.rule), ['harper:RepeatedWords', 'filler']);
    });

    test('ignored words and rules', () => {
        const i: Issue = { from: 0, to: 4, kind: 'spell', msg: '', fixes: [], rule: 'harper:SpellCheck' };
        assert.strictEqual(kept(i, 'Mara', ['mara'], []), false);
        assert.strictEqual(kept(i, 'Mara', [], ['SpellCheck']), false);
        assert.strictEqual(kept(i, 'Mara', [], []), true);
        assert.strictEqual(kept({ ...i, kind: 'style', rule: 'passive' }, 'was', ['was'], []), true);
    });
});
