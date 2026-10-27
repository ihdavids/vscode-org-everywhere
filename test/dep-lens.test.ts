// The dependency lens model. No vscode: mocha --ui tdd out/test/dep-lens.test.js
import * as assert from 'assert';
import {
    GanttServerTask, DepReport, DepHeading, schedule, criticalPath, healthOf, lensesFor, lensTitle, placeOf, fileQuery, pathRegex,
    addWorkingTime,
} from '../src/dep-lens-model';

function task(hash: string, line: number, extra: Partial<GanttServerTask> = {}): GanttServerTask {
    return { Hash: hash, Headline: hash.toUpperCase(), Filename: '/o/plan.org', LineNum: line, Section: 'main', Props: {}, Start: '', End: '',
        EffortDays: 1, After: '', Percent: 0, Order: 0, HasOrder: false, Done: false, Milestone: false, Mark: false, Implied: false, ...extra };
}

function dh(hash: string, line: number, extra: Partial<DepHeading> = {}): DepHeading {
    return { Hash: hash, Headline: hash.toUpperCase(), Filename: '/o/plan.org', LineNum: line, Status: 'TODO', Done: false, ...extra };
}

const lines = ['#+TITLE: plan', '* TODO A', '* TODO B', '* WAITING C', '* TODO D'];

suite('Dependency lens', () => {
    test('queries keep to one file without backslashes', () => {
        assert.strictEqual(pathRegex('/a/b.c (1).org'), '^/a/b[.]c [(]1[)][.]org$');
        assert.ok(new RegExp(pathRegex('/a/b.c (1).org')).test('/a/b.c (1).org'));
        assert.ok(!new RegExp(pathRegex('/a/b.org')).test('/a/bxorg'));
        assert.strictEqual(fileQuery('/a/b.org'), 'HasAStatus() && !IsArchived() && InFile("^/a/b[.]org$")');
    });

    test('working time skips weekends', () => {
        // Friday 2026-10-23, two days of work: ends Tuesday morning.
        const end = addWorkingTime(new Date(2026, 9, 23), 2 * 86400000);
        assert.strictEqual(end.getDay(), 2);
    });

    test('a plan laid out, its critical path and health', () => {
        const now = new Date(2026, 9, 21, 12);   // a Wednesday
        const plan = schedule([
            task('a', 1, { Start: '2026-10-19', EffortDays: 2 }),
            task('b', 2, { After: 'a', EffortDays: 1 }),
            task('c', 3, { Start: '2026-10-19', EffortDays: 1 }),
            task('d', 4, { After: 'b', EffortDays: 1, Props: { PERCENTDONE: '0' } }),
        ], now);
        const by = new Map(plan.map(t => [t.hash, t]));
        assert.strictEqual(by.get('b')!.start.getDate(), 21);
        assert.strictEqual(by.get('d')!.start.getDate(), 22);
        const crit = criticalPath(plan);
        assert.ok(crit.has('a') && crit.has('b') && crit.has('d'));
        assert.ok(!crit.has('c'));
        assert.deepStrictEqual(healthOf(by.get('c')!, now), { kind: 'overdue', note: 'overdue 2d' });
        assert.strictEqual(healthOf(by.get('b')!, now), null);
        const late = schedule([task('x', 1, { Start: '2026-10-19', EffortDays: 5, Percent: 10 })], now)[0];
        assert.strictEqual(healthOf(late, now)!.kind, 'slipping');
        assert.strictEqual(healthOf({ ...late, done: true }, now), null);
    });

    test('a heading found again when its line moved', () => {
        assert.strictEqual(placeOf(lines, 2, 'B'), 2);
        assert.strictEqual(placeOf(['x', ...lines], 2, 'B'), 3);
        assert.strictEqual(placeOf(lines, 2, 'Nope'), -1);
    });

    test('lenses from problems and the plan', () => {
        const report: DepReport = { Ok: true, Query: '', Checked: 4, Problems: [
            { Kind: 'blocked-chain', Severity: 'warn', Title: '2 headings held up behind C', Suggestion: 'Chase it.',
                Chain: [dh('c', 3, { Status: 'WAITING' }), dh('b', 2), dh('d', 4)], Length: 3, Held: 2 },
            { Kind: 'waiting-on-done', Severity: 'warn', Title: 'C waits on done A', Suggestion: 'Make it TODO.',
                Chain: [dh('a', 1, { Done: true, Status: 'DONE' }), dh('c', 3, { Status: 'WAITING' })] },
            { Kind: 'dangling', Severity: 'info', Title: 'x', Suggestion: '', Chain: [dh('z', 9, { Filename: '/o/other.org' })], Missing: 'nope' },
        ] };
        const now = new Date(2026, 9, 21, 12);
        const plan = schedule([task('a', 1, { Start: '2026-10-19', EffortDays: 1 }), task('b', 2, { After: 'a' }), task('d', 4, { After: 'b' })], now);
        const ls = lensesFor('/o/plan.org', lines, report, plan, now);
        const at = (n: number) => ls.find(l => l.line === n)!;
        assert.deepStrictEqual(at(3).parts, ['holding up 2', 'WAITING on done A']);
        assert.deepStrictEqual(at(3).targets.map(t => t.Hash), ['a']);
        assert.strictEqual(at(4).parts[0], 'blocked by C');
        assert.deepStrictEqual(at(4).targets.map(t => t.Hash), ['c', 'b']);
        assert.ok(at(4).parts.indexOf('on critical path') > 0);
        assert.strictEqual(at(4).severity, 'warn');
        assert.ok(lensTitle(at(4)).startsWith('$(warning) blocked by C · '));
        assert.ok(at(3).tooltip.indexOf('Chase it.') > 0);
        assert.ok(!ls.some(l => l.line === 9));
    });
});
