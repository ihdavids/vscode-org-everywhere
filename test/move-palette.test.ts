// The fuzzy matcher, the move dialog's model and Org: Menu's ordering, with
// the cases from worg's fuzzy.test.ts, move.test.ts and palette.test.ts.
// No vscode: mocha --ui tdd out/test/move-palette.test.js
import * as assert from 'assert';
import { fuzzyScore, fuzzyScoreAll, fuzzyTerms } from '../src/fuzzy-model';
import {
    targetKey, targetLabel, targetDetail, targetName, targetHay, recentKey,
    filterTargets, toApiTarget, opTitle, opVerb, needsTarget, summarise, failures,
    RefileTarget, MoveResponse, noteRecent, landing,
} from '../src/move-model';
import { rankEntries, noteUse, recentCount, PaletteEntry } from '../src/palette-model';

suite('Fuzzy', () => {
    test('a subsequence, in order, and nothing else', () => {
        assert.notStrictEqual(fuzzyScore('cde', 'code'), null);
        assert.notStrictEqual(fuzzyScore('cod', 'code'), null);
        assert.strictEqual(fuzzyScore('cdx', 'code'), null);
        assert.strictEqual(fuzzyScore('edoc', 'code'), null);
        assert.strictEqual(fuzzyScore('CODE', 'code'), fuzzyScore('code', 'CODE'));
        assert.strictEqual(fuzzyScore('', 'whatever'), 0);
    });

    test('the front, then word starts, then runs; shorter wins', () => {
        assert.ok(fuzzyScore('ga', 'gantt chart') > fuzzyScore('ga', 'the organ'));
        assert.ok(fuzzyScore('mm', 'mind map') > fuzzyScore('mm', 'maximum'));
        assert.ok(fuzzyScore('code', 'code') > fuzzyScore('code', 'code' + ' extra'.repeat(8)));
    });

    test('every term, any order; the name loosely, the rest on whole words', () => {
        assert.notStrictEqual(fuzzyScoreAll(['go', 'code'], 'Go to Code', 'Go to Code'), null);
        assert.notStrictEqual(fuzzyScoreAll(['code', 'go'], 'Go to Code', 'Go to Code'), null);
        assert.strictEqual(fuzzyScoreAll(['code', 'zz'], 'Go to Code', 'Go to Code'), null);
        assert.notStrictEqual(fuzzyScoreAll(['clrp'], 'Clock Report', 'Clock Report — time spent'), null);
        assert.strictEqual(fuzzyScoreAll(['tmsp'], 'Clock Report', 'Clock Report — time spent'), null);
        assert.notStrictEqual(fuzzyScoreAll(['spent'], 'Clock Report', 'Clock Report — time spent'), null);
        assert.ok(fuzzyScoreAll(['tables'], 'Tables', 'Tables — spreadsheets') > fuzzyScoreAll(['tables'], 'Files', 'Files — tables and text'));
        assert.deepStrictEqual(fuzzyTerms('  Go   Code '), ['go', 'code']);
        assert.deepStrictEqual(fuzzyTerms('   '), []);
    });
});

function t(p: Partial<RefileTarget>): RefileTarget {
    return { Hash: 'h', Filename: '/org/work.org', Olp: null, Level: 0, Todo: '', Tags: null, ...p };
}

suite('Move', () => {
    test('a target is its path, a file target its file', () => {
        assert.strictEqual(targetLabel(t({ Olp: ['Work', 'Q3', 'Notes'] })), 'Work › Q3 › Notes');
        assert.strictEqual(targetName(t({ Olp: ['Work', 'Q3', 'Notes'] })), 'Notes');
        const f = t({ Hash: '', Olp: [] });
        assert.strictEqual(targetLabel(f), 'work.org');
        assert.strictEqual(targetDetail(f), 'the end of the file');
        assert.strictEqual(targetKey(f), 'file:/org/work.org');
        assert.deepStrictEqual(toApiTarget(t({ Hash: 'abc' })), { Type: 'hash', Filename: '/org/work.org', Id: 'abc' });
        assert.deepStrictEqual(toApiTarget(t({ Hash: '' })), { Type: 'file', Filename: '/org/work.org', Id: '' });
        const hay = targetHay(t({ Olp: ['Work', 'Notes'], Todo: 'PROJECT', Tags: ['urgent'] }));
        assert.ok(hay.includes('PROJECT') && hay.includes('urgent') && hay.includes('work.org'));
    });

    const targets = [
        t({ Hash: 'a', Olp: ['Work'] }),
        t({ Hash: 'b', Olp: ['Work', 'Q3', 'Notes'] }),
        t({ Hash: 'c', Olp: ['Personal', 'Reading'] }),
        t({ Hash: 'd', Olp: ['Archive'], Filename: '/org/old.org' }),
    ];

    test('filtering, as worg filters', () => {
        assert.deepStrictEqual(filterTargets(targets, '').map(x => x.Hash), ['a', 'b', 'c', 'd']);
        assert.strictEqual(filterTargets(targets, 'work')[0].Hash, 'a');
        assert.deepStrictEqual(filterTargets(targets, 'reading').map(x => x.Hash), ['c']);
        assert.deepStrictEqual(filterTargets(targets, 'zzzzz'), []);
        const many = Array.from({ length: 500 }, (_, i) => t({ Hash: 'h' + i, Olp: ['N' + i] }));
        assert.strictEqual(filterTargets(many, '', 50).length, 50);
    });

    test('recent targets lead an empty query, by file and path not hash', () => {
        const recents = [recentKey(t({ Olp: ['Archive'], Filename: '/org/old.org' })), recentKey(t({ Hash: 'other', Olp: ['Personal', 'Reading'] }))];
        assert.deepStrictEqual(filterTargets(targets, '', 200, recents).map(x => x.Hash), ['d', 'c', 'a', 'b']);
        // With a query, a recent one only breaks ties.
        assert.strictEqual(filterTargets(targets, 'work', 200, [recentKey(targets[1])])[0].Hash, 'a');
        assert.deepStrictEqual(noteRecent('x', ['a', 'x', 'b']), ['x', 'a', 'b']);
    });

    test('what the dialog says', () => {
        assert.strictEqual(opTitle('refile', 1), 'Refile heading');
        assert.strictEqual(opTitle('copy', 3), 'Copy 3 headings');
        assert.strictEqual(opVerb('archive'), 'Archive');
        assert.strictEqual(needsTarget('archive'), false);
        assert.strictEqual(needsTarget('refile'), true);
        assert.strictEqual(needsTarget('copy'), true);
    });

    const res = (p: Partial<MoveResponse>): MoveResponse => ({ Ok: true, Msg: '', Results: [], Done: 0, Failed: 0, Skipped: 0, ...p });

    test('summarise says both halves', () => {
        assert.deepStrictEqual(summarise(res({ Done: 3 }), 'refile'), { tone: 'success', text: 'Refiled 3' });
        const s = summarise(res({ Done: 2, Skipped: 1 }), 'refile');
        assert.strictEqual(s.tone, 'success');
        assert.ok(s.text.includes('went with a parent'));
        const h = summarise(res({ Done: 2, Failed: 1 }), 'copy');
        assert.strictEqual(h.tone, 'warning');
        assert.ok(h.text.includes('Copied 2') && h.text.includes('1 could not be'));
        assert.strictEqual(summarise(res({ Failed: 3 }), 'archive').tone, 'danger');
        assert.strictEqual(summarise(res({ Msg: 'nothing to move' }), 'refile').tone, 'warning');
        const r = res({
            Ok: false, Done: 1, Failed: 1, Skipped: 1, Results: [
                { Headline: 'A', Filename: 'f', Ok: true, Msg: '', Skipped: false },
                { Headline: 'B', Filename: 'f', Ok: true, Msg: 'goes with "A"', Skipped: true },
                { Headline: 'C', Filename: 'f', Ok: false, Msg: 'gone', Skipped: false },
            ],
        });
        assert.deepStrictEqual(failures(r).map(x => x.Headline), ['C']);
    });

    test('where it lands', () => {
        const lines = ['* Work', '** One', 'text', '*** Deep', '** Two', '* Home'];
        assert.strictEqual(landing(lines, 0, ['New']), '"New" lands at ** after "Two" (2 there now)');
        assert.strictEqual(landing(lines, 5, ['A', 'B']), '2 headings land as its first child (**)');
        assert.strictEqual(landing(lines, -1, ['New']), '"New" lands at * after "Home" (2 there now)');
    });
});

suite('Menu ordering', () => {
    const e = (id: string, name: string, hint?: string): PaletteEntry => ({ id, name, hint });
    const cmds = [
        e('go:Agenda', 'Agenda', 'the calendar, today and the days around it'),
        e('go:Tables', 'Tables', 'the spreadsheet view of org tables'),
        e('go:Code', 'Code', 'source blocks, run and edit them'),
        e('file:notes.org', 'notes.org', 'open the file'),
    ];

    test('the given order when nothing is typed, recents lifted newest first', () => {
        assert.deepStrictEqual(rankEntries(cmds, '').map(c => c.id), cmds.map(c => c.id));
        const got = rankEntries(cmds, '', ['go:Code', 'go:Tables']);
        assert.deepStrictEqual(got.map(c => c.id), ['go:Code', 'go:Tables', 'go:Agenda', 'file:notes.org']);
        assert.strictEqual(recentCount(got, ['go:Code', 'go:Tables']), 2);
    });

    test('a word from the hint finds it; no match is nothing', () => {
        assert.strictEqual(rankEntries(cmds, 'spreadsheet')[0].id, 'go:Tables');
        assert.strictEqual(rankEntries(cmds, 'calendar')[0].id, 'go:Agenda');
        assert.deepStrictEqual(rankEntries(cmds, 'xyzzy'), []);
    });

    test('recency never lifts a worse match over a better one', () => {
        assert.strictEqual(rankEntries(cmds, 'tables', ['go:Code', 'go:Agenda'])[0].id, 'go:Tables');
    });

    test('noteUse keeps the newest first and each id once', () => {
        let r = noteUse('a', []);
        r = noteUse('b', r);
        r = noteUse('a', r);
        assert.deepStrictEqual(r, ['a', 'b']);
        assert.strictEqual(noteUse('z', Array.from({ length: 30 }, (_, i) => 'x' + i)).length, 24);
    });
});
