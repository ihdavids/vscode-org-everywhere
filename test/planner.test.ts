// The day planner's arithmetic, the same cases as worg/src/planner.test.ts and
// the server's planner_test.go. Plain node: mocha --ui tdd out/test/planner.test.js
import { expect } from './jest-expect';
import {
    clockMins, clock, lengthText, snap, clampBlock, taskLength, dayLoad, overlapPairs, freeSlot, layoutLanes,
    placeLocally, unplanLocally, filterTasks, taskNote, searchFrom, PlanDay, PlanTask, PlanBlock, Span,
} from '../src/planner-model';

suite('minutes', () => {
    test('reads and writes a time of day', () => {
        expect(clockMins('09:05')).toBe(545);
        expect(clockMins('9:05')).toBe(545);
        expect(clockMins('24:00')).toBe(1440);
        expect(clockMins('24:01')).toBe(-1);
        expect(clockMins('10:75')).toBe(-1);
        expect(clockMins('')).toBe(-1);
        expect(clock(545)).toBe('09:05');
        expect(clock(-5)).toBe('00:00');
    });

    test('says a length the way the planner does', () => {
        expect(lengthText(0)).toBe('0m');
        expect(lengthText(45)).toBe('45m');
        expect(lengthText(60)).toBe('1h');
        expect(lengthText(90)).toBe('1h30');
        expect(lengthText(125)).toBe('2h05');
    });

    test('snaps to the quarter hour and keeps a block inside the day', () => {
        expect(snap(607)).toBe(600);
        expect(snap(608)).toBe(615);
        expect(clampBlock(600, 5)).toEqual({ start: 600, end: 615 });
        expect(clampBlock(-30, 60)).toEqual({ start: 0, end: 60 });
        expect(clampBlock(1420, 60)).toEqual({ start: 1379, end: 1439 });
    });

    test('sizes a dropped task by its EFFORT, else the default, on the grid', () => {
        expect(taskLength(0)).toBe(60);
        expect(taskLength(45)).toBe(45);
        expect(taskLength(50)).toBe(60);
        expect(taskLength(90)).toBe(90);
        expect(taskLength(0, 30)).toBe(30);
    });
});

// The same cases as TestPlanLoadOverlapsAndFreeSlot in planner_test.go.
suite('load, overlaps and free time', () => {
    const spans: Span[] = [
        { start: 540, end: 600 }, { start: 570, end: 630 }, { start: 720, end: 780 },
        { start: 1020, end: 1080 }, { start: 900, end: 900 },
    ];

    test('counts the window a minute at a time', () => {
        expect(dayLoad(spans, 540, 1020)).toEqual({ planned: 150, double: 30, outside: 60 });
    });

    test('pairs only what shares a minute; a moment overlaps nothing', () => {
        expect(overlapPairs(spans)).toEqual([[0, 1]]);
    });

    test('finds the first gap long enough', () => {
        const cases: [number, number, number | null][] = [
            [540, 60, 630], [540, 120, 780], [660, 30, 660], [540, 300, null], [1000, 20, 1000], [1001, 20, null],
        ];
        for (const [from, len, want] of cases) {
            expect(freeSlot(spans, 540, 1020, from, len)).toBe(want);
        }
    });

    test('looks from now on today and from the start of the day otherwise', () => {
        const day = { Date: '2026-10-12' } as PlanDay;
        expect(searchFrom(day, new Date(2026, 9, 12, 10, 7), 540)).toBe(615);
        expect(searchFrom(day, new Date(2026, 9, 12, 7, 0), 540)).toBe(540);
        expect(searchFrom(day, new Date(2026, 9, 11, 10, 7), 540)).toBe(540);
    });
});

suite('lanes', () => {
    test('puts overlapping blocks side by side and leaves the rest whole', () => {
        const l = layoutLanes([
            { start: 540, end: 600 }, { start: 570, end: 630 }, { start: 600, end: 660 },
            { start: 720, end: 780 }, { start: 900, end: 900 },
        ]);
        expect(l[0]).toEqual({ lane: 0, lanes: 2 });
        expect(l[1]).toEqual({ lane: 1, lanes: 2 });
        // 10:00 starts as the first ends, so it takes the first lane again.
        expect(l[2]).toEqual({ lane: 0, lanes: 2 });
        expect(l[3]).toEqual({ lane: 0, lanes: 1 });
        expect(l[4]).toEqual({ lane: 0, lanes: 1 });
    });
});

function task(h: string, title: string, extra: Partial<PlanTask> = {}): PlanTask {
    return {
        Hash: h, Headline: title, Filename: '/notes/work.org', LineNum: 1, Status: 'TODO', Priority: '', Tags: [],
        Effort: '', EffortMins: 0, Scheduled: '', Deadline: '', Late: -1, DueIn: 0, Repeater: '', ...extra,
    };
}

function block(h: string, title: string, start: string, end: string, extra: Partial<PlanBlock> = {}): PlanBlock {
    return {
        Hash: h, Headline: title, Filename: '/notes/work.org', LineNum: 1, Status: 'TODO', Priority: '', Tags: [],
        Kind: 'scheduled', Start: start, End: end, Mins: clockMins(end) - clockMins(start), Implied: false,
        Movable: true, Repeat: false, Repeater: '', Done: false, Stamp: '', EffortMins: 0, DueIn: -1, Late: 0, ...extra,
    };
}

function day(): PlanDay {
    return {
        Ok: true, Msg: '', Date: '2026-10-12', Today: '2026-10-10', DayStart: '09:00', DayEnd: '17:00', Query: 'IsTask()',
        Blocks: [block('s', 'Standup', '09:00', '09:15', { Kind: 'timestamp', Movable: false })],
        AllDay: [],
        Tasks: [task('r', 'Write report', { EffortMins: 90 }), task('b', 'Fix the bike', { Filename: '/notes/home.org' })],
        Load: { WindowMins: 480, PlannedMins: 15, FreeMins: 465, DoubleMins: 0, OutsideMins: 0, BacklogMins: 90, BacklogNoEst: 1 },
        Overlaps: [], DefaultMins: 60,
    };
}

suite('optimistic edits', () => {
    test('moves a task from the list onto the grid and counts it', () => {
        const d = placeLocally(day(), 'r', 540, 630);
        expect(d.Tasks.map(t => t.Hash)).toEqual(['b']);
        expect(d.Blocks.map(b => `${b.Hash} ${b.Start}-${b.End}`)).toEqual(['s 09:00-09:15', 'r 09:00-10:30']);
        expect(d.Load.PlannedMins).toBe(90);
        expect(d.Load.DoubleMins).toBe(15);
        expect(d.Load.BacklogMins).toBe(0);
        expect(d.Overlaps).toEqual([[0, 1]]);
    });

    test('moves a block and leaves a fixed one alone', () => {
        let d = placeLocally(day(), 'r', 540, 630);
        d = placeLocally(d, 'r', 600, 690);
        expect(d.Blocks.map(b => `${b.Hash} ${b.Start}-${b.End}`)).toEqual(['s 09:00-09:15', 'r 10:00-11:30']);
        expect(d.Overlaps).toEqual([]);
        expect(placeLocally(d, 's', 700, 760)).toBe(d);
    });

    test('takes a block back to the list; a repeating one keeps its day', () => {
        let d = placeLocally(day(), 'b', 600, 660);
        d = unplanLocally(d, 'b');
        expect(d.Tasks[0].Hash).toBe('b');
        expect(d.Tasks[0].Late).toBe(-1);
        const r = unplanLocally({ ...day(), Blocks: [block('w', 'Weekly review', '15:00', '16:00', { Repeater: '+1w' })] }, 'w');
        expect(r.Tasks[0].Late).toBe(0);
        expect(r.Tasks[0].Scheduled).toBe('2026-10-12');
    });
});

suite('the list', () => {
    test('filters loosely on the headline and by whole word on the rest', () => {
        const d = day();
        expect(filterTasks(d.Tasks, '').length).toBe(2);
        expect(filterTasks(d.Tasks, 'wrep').map(t => t.Hash)).toEqual(['r']);
        expect(filterTasks(d.Tasks, 'home.org').map(t => t.Hash)).toEqual(['b']);
        expect(filterTasks(d.Tasks, 'zzz')).toEqual([]);
    });

    test('says how late or how due', () => {
        expect(taskNote(task('a', 'a', { Late: 3 }))).toBe('3d late');
        expect(taskNote(task('a', 'a', { Late: 0 }))).toBe('today');
        expect(taskNote(task('a', 'a', { Deadline: '2026-10-14', DueIn: 2 }))).toBe('due in 2d');
        expect(taskNote(task('a', 'a', { Deadline: '2026-10-10', DueIn: -2 }))).toBe('due 2d ago');
        expect(taskNote(task('a', 'a'))).toBe('');
    });
});
