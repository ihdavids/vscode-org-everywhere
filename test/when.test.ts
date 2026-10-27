// Typed dates: worg's parseWhen and orgs' internal/orgdate, with the cases
// from ganttquick.test.ts and orgdate_test.go. No vscode:
// mocha --ui tdd out/test/when.test.js
import * as assert from 'assert';
import { parseWhen, parseOrgDate, orgDateString, dayKey, describeWhen } from '../src/when-model';

suite('parseWhen (worg)', () => {
    // A Thursday.
    const NOW = new Date(2026, 0, 8);
    const key = (s: string) => { const d = parseWhen(s, NOW); return d ? dayKey(d) : null; };

    test('dates the way they are typed', () => {
        assert.strictEqual(key('today'), '2026-01-08');
        assert.strictEqual(key('tom'), '2026-01-09');
        assert.strictEqual(key('fri'), '2026-01-09');
        // The weekday today is today.
        assert.strictEqual(key('thursday'), '2026-01-08');
        assert.strictEqual(key('mon'), '2026-01-12');
        assert.strictEqual(key('+2w'), '2026-01-22');
        assert.strictEqual(key('2026-03-01'), '2026-03-01');
        // A month and day already past is next year's.
        assert.strictEqual(key('01-02'), '2027-01-02');
        assert.strictEqual(key('soon'), null);
    });

    test('offsets in months and backwards', () => {
        assert.strictEqual(key('+1m'), '2026-02-08');
        assert.strictEqual(key('-2d'), '2026-01-06');
        assert.strictEqual(key('+3'), '2026-01-11');
    });
});

suite('parseOrgDate (orgs internal/orgdate)', () => {
    // Sunday the 27th of September 2026, 11:30 - local wall clock, as org reads it.
    const now = new Date(2026, 8, 27, 11, 30);
    const cases: [string, string][] = [
        ['today', '<2026-09-27 Sun>'],
        ['tomorrow', '<2026-09-28 Mon>'],
        ['yesterday', '<2026-09-26 Sat>'],
        ['+3d', '<2026-09-30 Wed>'],
        ['-1w', '<2026-09-20 Sun>'],
        ['+2w', '<2026-10-11 Sun>'],
        ['+1m', '<2026-10-27 Tue>'],
        ['+1y', '<2027-09-27 Mon>'],
        ['2026-10-01', '<2026-10-01 Thu>'],
        // The coming weekday, today counting as one - which is org's reading.
        ['sun', '<2026-09-27 Sun>'],
        ['mon', '<2026-09-28 Mon>'],
        ['fri', '<2026-10-02 Fri>'],
        ['eow', '<2026-10-02 Fri>'],
        ['eom', '<2026-09-30 Wed>'],
        ['eoy', '<2026-12-31 Thu>'],
        // A time, either way round, and a range.
        ['tomorrow 14:00', '<2026-09-28 Mon 14:00>'],
        ['14:00 tomorrow', '<2026-09-28 Mon 14:00>'],
        ['fri 2pm', '<2026-10-02 Fri 14:00>'],
        ['mon 09:30-10:45', '<2026-09-28 Mon 09:30-10:45>'],
        // A time with no day is today.
        ['16:00', '<2026-09-27 Sun 16:00>'],
        // A repeater needs a day in front of it.
        ['mon +1w', '<2026-09-28 Mon +1w>'],
        ['tomorrow .+2d', '<2026-09-28 Mon .+2d>'],
        ['fri 14:00 ++1m', '<2026-10-02 Fri 14:00 ++1m>'],
        // A day and month with no year is the coming one.
        ['12-25', '<2026-12-25 Fri>'],
        ['01-05', '<2027-01-05 Tue>'],
        // A bare day of the month.
        ['30', '<2026-09-30 Wed>'],
        ['15', '<2026-10-15 Thu>'],
        // Already written: passed through untouched.
        ['<2026-10-01 Thu 09:00>', '<2026-10-01 Thu 09:00>'],
        ['[2026-10-01 Thu]', '[2026-10-01 Thu]'],
    ];
    for (const [input, want] of cases) {
        test(`"${input}"`, () => {
            const r = parseOrgDate(input, now);
            assert.ok(!r.error, r.error);
            assert.ok(r.set && r.date);
            assert.strictEqual(orgDateString(r.date), want);
        });
    }

    test('clearing', () => {
        for (const s of ['', 'clear', 'none']) {
            const r = parseOrgDate(s, now);
            assert.strictEqual(r.set, false);
            assert.ok(!r.error);
        }
    });

    // An ambiguous date is refused rather than guessed at.
    test('ambiguous or unreadable dates are refused', () => {
        for (const s of ['1/10', '3/4', 'not-a-date', '+2q']) {
            assert.ok(parseOrgDate(s, now).error, s);
        }
        assert.match(parseOrgDate('1/10', now).error, /month first/);
    });

    test('the prompt line says what it resolves to', () => {
        assert.strictEqual(describeWhen('tomorrow', now).text, '<2026-09-28 Mon>  (tomorrow)');
        assert.strictEqual(describeWhen('', now).text, 'clears the date');
        assert.strictEqual(describeWhen('3/4', now).ok, false);
    });
});
