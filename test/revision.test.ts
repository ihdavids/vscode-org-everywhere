// Revision notes (src/revision-model.ts), worg's revision.test.ts cases. No
// vscode: mocha --ui tdd out/test/revision.test.js
import * as assert from 'assert';
import { parseNotes, formatNote, addNote, setNoteState, setNoteText, deleteNote, noteSpot, openCount, noteGroups, nextNote } from '../src/revision-model';

suite('Revision notes', () => {
    const doc = [
        '* The letter',
        'The letter was waiting when Mara',
        'came in from the boats.',
        '# NOTE: too slow',
        '# NOTE "the boats": which boats?',
        '# note[done]: check the tides',
        '',
        'She read it twice.',
        '#+BEGIN_SRC sh',
        '# NOTE: not a note, code',
        '#+END_SRC',
    ];

    test('notes are read with their paragraph, anchor and state', () => {
        const n = parseNotes(doc);
        assert.deepStrictEqual(n.map(x => [x.line, x.state, x.anchor, x.text]), [
            [3, 'open', '', 'too slow'],
            [4, 'open', 'the boats', 'which boats?'],
            [5, 'done', '', 'check the tides'],
        ]);
        assert.deepStrictEqual(n[0].para, [1, 2]);
        assert.deepStrictEqual(n[1].at, { line: 2, from: 13, to: 22 });
        assert.strictEqual(openCount(n), 2);
    });

    test('a drawer is not part of the paragraph', () => {
        const n = parseNotes(['** Scene', ':PROPERTIES:', ':POV: Mara', ':END:', 'She ran.', '# NOTE: why?']);
        assert.deepStrictEqual(n[0].para, [4, 4]);
    });

    test('a note under a heading is about the heading', () => {
        assert.deepStrictEqual(parseNotes(['* Scene', '# NOTE: rename'])[0].para, [0, 0]);
        assert.deepStrictEqual(parseNotes(['', '# NOTE: alone'])[0].para, [-1, -1]);
    });

    test('formatting round trips', () => {
        const s = formatNote({ state: 'done', anchor: 'say "hi"', text: 'two\nlines' });
        assert.strictEqual(s, '# NOTE[done] "say hi": two lines');
        const n = parseNotes(['x', s])[0];
        assert.deepStrictEqual([n.state, n.anchor, n.text], ['done', 'say hi', 'two lines']);
    });

    test('adding goes under the paragraph, after its notes', () => {
        assert.deepStrictEqual(noteSpot(doc, 1), { at: 6, indent: '' });
        const r = addNote(doc, 7, 'better verb', 'read');
        assert.strictEqual(r.line, 8);
        assert.strictEqual(r.lines[8], '# NOTE "read": better verb');
        assert.strictEqual(r.lines[9], '#+BEGIN_SRC sh');
        // Selections over several lines do not anchor.
        assert.strictEqual(addNote(doc, 1, 'x', 'a\nb').lines[6], '# NOTE: x');
        // Indented prose (a list item's text) keeps its indent.
        assert.strictEqual(addNote(['- item', '  more'], 1, 'y', '').lines[2], '  # NOTE: y');
    });

    test('toggling, editing and deleting are one line each', () => {
        assert.strictEqual(setNoteState(doc, 3, 'done')[3], '# NOTE[done]: too slow');
        assert.strictEqual(setNoteState(doc, 5, 'open')[5], '# NOTE: check the tides');
        assert.strictEqual(setNoteText(doc, 4, 'the fishing boats?')[4], '# NOTE "the boats": the fishing boats?');
        const del = deleteNote(doc, 3);
        assert.strictEqual(del.length, doc.length - 1);
        assert.strictEqual(del[3], '# NOTE "the boats": which boats?');
        assert.strictEqual(setNoteState(doc, 1, 'done'), null);
    });

    test('notes under one paragraph are one thread', () => {
        const g = noteGroups(parseNotes([...doc, '', '# NOTE: alone']));
        assert.deepStrictEqual(g.map(x => [x.range, x.notes.map(n => n.line)]), [[[1, 2], [3, 4, 5]], [[12, 12], [12]]]);
    });

    test('next and previous go round the end', () => {
        const n = parseNotes(doc);
        assert.strictEqual(nextNote(n, 3, 1).line, 4);
        assert.strictEqual(nextNote(n, 5, 1).line, 3);
        assert.strictEqual(nextNote(n, 3, -1).line, 5);
        assert.strictEqual(nextNote([], 0, 1), undefined);
    });
});
