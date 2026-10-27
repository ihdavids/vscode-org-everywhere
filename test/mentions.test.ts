// The Mentions panel's model. No vscode: mocha --ui tdd out/test/mentions.test.js
import * as assert from 'assert';
import {
    Mention, LinkTarget, LinkInContext, snippet, mentionLabel, linkLabel, groupByFile, targetLabel, searchedNote,
    targetParams, linkRequest, linkedNote, changedFiles,
} from '../src/mentions-model';

function mention(file: string, line: number, before: string, text: string, after: string): Mention {
    return { Filename: file, Line: line, Col: before.length, Text: text, Term: text.toLowerCase(), Before: before, After: after,
        Hash: 'h' + line, Headline: 'Head', Olp: ['Head'], InHeadline: false };
}

const target: LinkTarget = { Kind: 'heading', Filename: '/o/a.org', Hash: 'abc', Headline: 'Apollo', Olp: ['Apollo'], Line: 3,
    Title: 'Apollo', Id: '', Terms: ['apollo', 'moon shot'], Skipped: ['“Notes” is common words'] };

suite('Mentions', () => {
    test('a sentence cut around its match, the match kept', () => {
        const [b, m, a] = snippet('word '.repeat(30), 'Apollo', ' then more words '.repeat(10), 40);
        assert.strictEqual(m, 'Apollo');
        assert.ok(b.startsWith('…'));
        assert.ok(a.endsWith('…'));
        assert.ok((b + m + a).length <= 46);
        assert.deepStrictEqual(snippet('We flew ', 'Apollo', ' home.'), ['We flew ', 'Apollo', ' home.']);
    });

    test('labels highlight the match', () => {
        const l = mentionLabel(mention('/o/b.org', 4, '  We flew ', 'Apollo', ' home.  '));
        assert.strictEqual(l.label, 'We flew Apollo home.');
        assert.deepStrictEqual(l.highlight, [8, 14]);
        const link = { Raw: 'id:1', Desc: 'the mission', Context: 'Read about the mission today', Before: '', Shown: '', After: '' } as LinkInContext;
        const ll = linkLabel(link);
        assert.strictEqual(ll.label.slice(ll.highlight![0], ll.highlight![1]), 'the mission');
        const cut = linkLabel({ ...link, Before: 'see ', Shown: '[[id:1][x]]', After: ' now' });
        assert.strictEqual(cut.label, 'see [[id:1][x]] now');
        assert.deepStrictEqual(linkLabel({ ...link, Desc: 'nowhere' }).highlight, null);
    });

    test('grouping and naming', () => {
        const ms = [mention('/o/b.org', 1, '', 'Apollo', ''), mention('/o/b.org', 9, '', 'Apollo', ''), mention('/o/c.org', 2, '', 'apollo', '')];
        assert.deepStrictEqual(groupByFile(ms).map(g => [g.file, g.mentions.length]), [['/o/b.org', 2], ['/o/c.org', 1]]);
        assert.strictEqual(targetLabel(target), 'Apollo');
        assert.strictEqual(targetLabel({ ...target, Kind: 'file', Title: '' }), 'a.org');
        assert.ok(searchedNote(target).indexOf('Looking for “apollo”, “moon shot”') === 0);
        assert.ok(searchedNote(target).indexOf('not searched') > 0);
    });

    test('requests', () => {
        assert.deepStrictEqual(targetParams('/o/a.org', 3, false), { filename: '/o/a.org', line: '3' });
        assert.deepStrictEqual(targetParams('/o/a.org', -1, true), { filename: '/o/a.org', all: 't' });
        const ms = [mention('/o/b.org', 1, 'x ', 'Apollo', '')];
        assert.deepStrictEqual(linkRequest(target, ms), { Hash: 'abc', Filename: '', Mentions: [{ Filename: '/o/b.org', Line: 1, Col: 2, Text: 'Apollo' }] });
        assert.deepStrictEqual(linkRequest({ ...target, Kind: 'file' }, ms).Filename, '/o/a.org');
    });

    test('after linking', () => {
        const res = { Ok: true, Msg: '', Linked: 2, Id: 'x', NewId: true, Results: [
            { Filename: '/o/b.org', Line: 1, Col: 0, Text: 'A', Ok: true, Msg: '', Link: '' },
            { Filename: '/o/c.org', Line: 1, Col: 0, Text: 'A', Ok: false, Msg: 'moved', Link: '' }] };
        const n = linkedNote(target, res);
        assert.strictEqual(n.ok, false);
        assert.ok(n.text.indexOf('Linked 2 mentions. Apollo was given an :ID:') === 0);
        assert.ok(n.text.indexOf('1 could not be: moved') > 0);
        assert.deepStrictEqual(changedFiles(target, res), ['/o/b.org', '/o/a.org']);
        assert.strictEqual(linkedNote(target, undefined).ok, false);
    });
});
