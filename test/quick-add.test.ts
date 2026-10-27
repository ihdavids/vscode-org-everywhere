// Quick add, with the cases from worg's ganttquick.test.ts and orgs'
// cols/model_test.go. No vscode: mocha --ui tdd out/test/quick-add.test.js
import * as assert from 'assert';
import { dayKey } from '../src/when-model';
import {
    parseQuickAdd, addRequest, newHeadingLines, ganttStamp, findByName, idFor, describeQuick, insertPoint, insertTask,
} from '../src/quick-add-model';

// A Thursday.
const NOW = new Date(2026, 0, 8);

suite('Quick add', () => {
    test('a line is read for its parts and the rest is the title', () => {
        const q = parseQuickAdd('NEXT Write the spec 3d @Ian_Davids #design ^fri >kick_off !a RISK=high', ['TODO', 'NEXT'], NOW);
        assert.strictEqual(q.status, 'NEXT');
        assert.strictEqual(q.headline, 'Write the spec');
        assert.strictEqual(q.effort, '3d');
        assert.strictEqual(q.person, 'Ian Davids');
        assert.deepStrictEqual(q.tags, ['design']);
        assert.strictEqual(dayKey(q.start), '2026-01-09');
        assert.strictEqual(q.after, 'kick off');
        assert.strictEqual(q.priority, 'A');
        assert.deepStrictEqual(q.props, { RISK: 'high' });
    });

    test('quoted runs, and words that only look like markers', () => {
        const q = parseQuickAdd('Fix @"Sam Smith" ^soon email', [], NOW);
        assert.strictEqual(q.person, 'Sam Smith');
        // ^soon is not a date, so it stays in the title.
        assert.strictEqual(q.headline, 'Fix ^soon email');
    });

    test('a keyword only counts first, and tags split on colons', () => {
        const q = parseQuickAdd('Ask TODO about it #a:b #a', [], NOW);
        assert.strictEqual(q.status, '');
        assert.strictEqual(q.headline, 'Ask TODO about it');
        assert.deepStrictEqual(q.tags, ['a', 'b']);
    });

    test('^ takes what orgs sched takes too, and ^^ is the deadline', () => {
        const q = parseQuickAdd('Ship ^eow ^^+2w 4h', [], NOW);
        assert.strictEqual(dayKey(q.start), '2026-01-09');
        assert.strictEqual(dayKey(q.deadline), '2026-01-22');
        assert.strictEqual(q.effort, '4h');
        assert.strictEqual(q.headline, 'Ship');
    });

    test('the request is what worg and orgs cols send', () => {
        const q = parseQuickAdd('Write spec @ian ^fri 3h !b', [], NOW);
        const a = addRequest(q, { afterId: 'design-abc123' });
        assert.deepStrictEqual(a, {
            Headline: '[#B] Write spec', Status: 'TODO', Effort: '3h', Tags: [],
            Props: { ASSIGNEE: 'ian', AFTER: 'design-abc123' }, Start: '2026-01-09', DateKind: 'SCHEDULED',
        });
        assert.strictEqual(addRequest(parseQuickAdd('x ^^fri', [], NOW)).DateKind, 'DEADLINE');
        assert.strictEqual(addRequest(parseQuickAdd('x @bo', [], NOW), { personProp: 'assigned' }).Props.ASSIGNED, 'bo');
    });

    test('the lines are the server\'s ganttNewLines', () => {
        const q = parseQuickAdd('NEXT Write spec @ian ^fri 3h #web', ['NEXT'], NOW);
        assert.deepStrictEqual(newHeadingLines(2, addRequest(q)), [
            '** NEXT Write spec  :web:',
            '   SCHEDULED: <2026-01-09 Fri>',
            '   :PROPERTIES:',
            '     :EFFORT: 3h',
            '     :ASSIGNEE: ian',
            '   :END:',
        ]);
        const both = parseQuickAdd('Ship ^mon ^^fri', [], NOW);
        assert.deepStrictEqual(newHeadingLines(1, addRequest(both), dayKey(both.deadline)), [
            '* TODO Ship',
            '  SCHEDULED: <2026-01-12 Mon> DEADLINE: <2026-01-09 Fri>',
        ]);
        assert.strictEqual(ganttStamp('2026-01-05'), '<2026-01-05 Mon>');
        assert.strictEqual(ganttStamp('soon'), 'soon');
    });

    test('a heading is found by its name, whole before part, shortest first', () => {
        const hs = [{ title: 'design review' }, { title: 'design' }, { title: 'redesign the thing' }];
        assert.strictEqual(findByName(hs, 'design').title, 'design');
        assert.strictEqual(findByName(hs, 'review').title, 'design review');
        assert.strictEqual(findByName(hs, 'nope'), null);
    });

    test('an id is the words plus a bit of the hash (ganttIdFor)', () => {
        assert.strictEqual(idFor('Design the API!', 'aB+/c9xyz'), 'design-the-api-abc9xy');
        assert.strictEqual(idFor('', ''), 'task');
        assert.strictEqual(idFor('A very long title that goes on and on', ''), 'a-very-long-title-that-g');
    });

    test('it goes in last under the heading, before the gap', () => {
        const lines = ['* Work', '** design', '** Two', '', '* Home'];
        assert.deepStrictEqual(insertPoint(lines, 0), { row: 3, level: 2 });
        assert.deepStrictEqual(insertPoint(lines, -1), { row: 5, level: 1 });
        assert.deepStrictEqual(insertPoint(lines, 4), { row: 5, level: 2 });
        // With an ID given to "design" in the same edit.
        const r = insertTask(lines, 3, ['** TODO New'], { start: 1, end: 2, lines: ['** design', '   :PROPERTIES:', '   :ID: design', '   :END:'] });
        assert.deepStrictEqual(r.start, 1);
        assert.deepStrictEqual(r.end, 3);
        assert.deepStrictEqual(r.lines, ['** design', '   :PROPERTIES:', '   :ID: design', '   :END:', '** Two', '** TODO New']);
        assert.strictEqual(r.heading, 6);
        const plain = insertTask(lines, 3, ['** TODO New']);
        assert.deepStrictEqual(plain, { start: 3, end: 3, lines: ['** TODO New'], heading: 3 });
        // An edit after the insertion point does not move the new heading.
        const after = insertTask(lines, 1, ['** TODO New'], { start: 4, end: 5, lines: ['* Home', '  :PROPERTIES:', '  :ID: home', '  :END:'] });
        assert.strictEqual(after.heading, 1);
        assert.deepStrictEqual(after.lines, ['** TODO New', '** design', '** Two', '', '* Home', '  :PROPERTIES:', '  :ID: home', '  :END:']);
    });

    test('the preview says it back', () => {
        const s = describeQuick(parseQuickAdd('Write spec @ian ^fri 3h >design', [], NOW));
        assert.strictEqual(s, 'TODO Write spec · ASSIGNEE ian · scheduled Fri 2026-01-09 · effort 3h · after design');
    });
});
