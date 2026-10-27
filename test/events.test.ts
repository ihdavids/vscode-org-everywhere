// The event stream's model, saved-query watches' and focus sessions'. None of
// these touch vscode: mocha --ui tdd out/test/events.test.js
import * as assert from 'assert';
import { SseParser, parseEvent, wantedKinds, eventsPath, wants, backoff } from '../src/events-model';
import {
    asNoticeList, asWatchList, watchOf, badgeText, noticeSummary, relativeTime, noticeFromEvent, withNotice,
    markedRead, whereOf, plainWatch, watchForQuery, watchState, bellText, noticeCounts, NoticeList, WatchMatch, NOTICE_CAP,
} from '../src/query-watch-model';
import {
    IDLE, FocusState, asFocusState, formatCountdown, formatMinutes, localEnd, remainingAt, statusText,
    transitionNotice, recentHashes, orderTasks, setPosition, startBody, todaysRecords, recordLine,
} from '../src/focus-model';

suite('Event stream', () => {
    test('reads events across pieces and skips the heartbeat', () => {
        const p = new SseParser();
        assert.deepStrictEqual(p.feed('data: {"kind":"hel'), []);
        assert.deepStrictEqual(p.feed('lo"}\n'), []);
        assert.deepStrictEqual(p.feed('\n: beat\n\ndata: {"kind":"reload"}\r'), ['{"kind":"hello"}']);
        assert.deepStrictEqual(p.feed('\n\r\n'), ['{"kind":"reload"}']);
    });

    test('joins multi-line data and ignores other fields', () => {
        const p = new SseParser();
        assert.deepStrictEqual(p.feed('event: x\ndata: a\ndata:b\nid: 3\n\n'), ['a\nb']);
        assert.deepStrictEqual(p.feed('\n\n'), []);
    });

    test('parses events with a kind only', () => {
        assert.deepStrictEqual(parseEvent('{"kind":"reload","file":"/a.org"}'), { kind: 'reload', data: { kind: 'reload', file: '/a.org' } });
        assert.strictEqual(parseEvent('not json'), null);
        assert.strictEqual(parseEvent('{"file":"x"}'), null);
        assert.strictEqual(parseEvent('[1]'), null);
    });

    test('asks for the union of kinds', () => {
        assert.strictEqual(wantedKinds([]), '');
        assert.strictEqual(wantedKinds([['reload', 'clockin'], ['querymatch', 'reload']]), 'clockin,querymatch,reload');
        assert.strictEqual(wantedKinds([['reload'], []]), '*');
        assert.strictEqual(eventsPath('*'), '/events');
        assert.strictEqual(eventsPath('a,b'), '/events?kinds=a%2Cb%2Chello');
        assert.strictEqual(eventsPath('hello,a'), '/events?kinds=hello%2Ca');
    });

    test('hands each listener its own kinds, and hello', () => {
        assert.ok(wants([], 'anything'));
        assert.ok(wants(['reload'], 'hello'));
        assert.ok(wants(['reload'], 'reload'));
        assert.ok(!wants(['reload'], 'clockin'));
    });

    test('backs off, doubling, at most a minute', () => {
        const mid = () => 0.5;
        assert.strictEqual(backoff(0, mid), 1000);
        assert.strictEqual(backoff(3, mid), 8000);
        assert.strictEqual(backoff(20, mid), 60000);
        assert.ok(backoff(0, () => 0) >= 800 && backoff(0, () => 1) <= 1200);
    });
});

suite('Query watches', () => {
    const m = (headline: string, extra: Partial<WatchMatch> = {}): WatchMatch =>
        ({ key: headline, headline, file: '/org/todo.org', line: 3, ...extra });

    test('makes lists of what failed requests answer', () => {
        assert.strictEqual(asNoticeList(undefined).ok, false);
        assert.strictEqual(asNoticeList([]).ok, false);
        assert.strictEqual(asNoticeList({ msg: 'no' }).msg, 'no');
        assert.strictEqual(asWatchList({ ok: true, watches: [], desktop: true }).desktop, true);
    });

    test('finds the watch on a saved query', () => {
        const ws: any[] = [{ name: 'other', storedQuery: 'q1' }, { name: 'q2' }];
        assert.strictEqual(watchOf(ws, 'q1').name, 'other');
        assert.strictEqual(watchOf(ws, 'q2').name, 'q2');
        assert.strictEqual(watchOf(ws, 'q3'), undefined);
    });

    test('words a notification', () => {
        assert.strictEqual(badgeText(0), '');
        assert.strictEqual(badgeText(12), '9+');
        assert.strictEqual(bellText(0), '$(bell)');
        assert.strictEqual(bellText(3), '$(bell-dot) 3');
        const n = { gained: [m('a'), m('b'), m('c'), m('d')], left: [m('x')] };
        assert.strictEqual(noticeSummary(n), '4 new: a, b, c, and 1 more; 1 gone: x');
        assert.strictEqual(noticeCounts({ ...n, id: '1', watch: 'w', label: 'w', at: '', count: 7, read: false }), '4 new · 1 gone · 7 matching now');
        assert.strictEqual(whereOf(m('h', { path: ['Work', 'Proj', 'h'] })), 'todo.org › Work › Proj');
    });

    test('reads times relatively', () => {
        const now = new Date(2026, 9, 24, 15, 0, 0).getTime();
        assert.strictEqual(relativeTime(new Date(now - 30000).toISOString(), now), 'just now');
        assert.strictEqual(relativeTime(new Date(now - 12 * 60000).toISOString(), now), '12 min ago');
        assert.strictEqual(relativeTime(new Date(now - 3 * 3600000).toISOString(), now), '3 h ago');
        assert.strictEqual(relativeTime(new Date(2026, 9, 23, 14, 5).toISOString(), now), 'yesterday 14:05');
        assert.strictEqual(relativeTime('nonsense', now), 'nonsense');
    });

    test('folds an event into the list once', () => {
        const ev: any = { kind: 'querymatch', watch: 'w', notice: 'n1', headings: [m('a')], count: 2, at: 'x' };
        const n = noticeFromEvent(ev);
        assert.strictEqual(n.label, 'w');
        const empty: NoticeList = { ok: true, unread: 0, total: 0, notices: [] };
        const one = withNotice(empty, n);
        assert.strictEqual(one.unread, 1);
        assert.strictEqual(withNotice(one, n), one);
        assert.strictEqual(noticeFromEvent({ ...ev, notice: '' }), null);
        let big = empty;
        for (let i = 0; i < NOTICE_CAP + 5; i++) {
            big = withNotice(big, { ...n, id: 'n' + i });
        }
        assert.strictEqual(big.notices.length, NOTICE_CAP);
        assert.strictEqual(big.notices[0].id, 'n' + (NOTICE_CAP + 4));
    });

    test('marks read locally', () => {
        const list: NoticeList = { ok: true, unread: 2, total: 2, notices: [
            { id: 'a', watch: 'w', label: 'w', at: '', count: 1, read: false },
            { id: 'b', watch: 'w', label: 'w', at: '', count: 1, read: false },
        ] };
        assert.strictEqual(markedRead(list, ['a']).unread, 1);
        assert.strictEqual(markedRead(list, 'all').unread, 0);
    });

    test('sends back only what a watch saves', () => {
        assert.deepStrictEqual(plainWatch({ name: 'q', storedQuery: 'q', left: false, desktop: true, resolved: 'x', count: 3 } as any),
            { name: 'q', storedQuery: 'q', desktop: true });
        assert.deepStrictEqual(watchForQuery('q'), { name: 'q', storedQuery: 'q', left: false, desktop: false });
        assert.strictEqual(watchState({ name: 'q', resolved: '', count: 4 }), '4 matching');
        assert.strictEqual(watchState({ name: 'q', resolved: '', count: -1 }), 'not checked yet');
        assert.strictEqual(watchState({ name: 'q', resolved: '', count: 1, error: 'gone' }), 'gone');
    });
});

suite('Focus sessions', () => {
    const st = (o: Partial<FocusState>): FocusState => ({ ...IDLE, ...o });

    test('reads the server, or says it did not answer', () => {
        assert.strictEqual(asFocusState(undefined).Ok, false);
        assert.strictEqual(asFocusState([]).Ok, false);
        assert.strictEqual(asFocusState({ Phase: 'work', Ok: true }).Phase, 'work');
    });

    test('counts down like worg', () => {
        assert.strictEqual(formatCountdown(0.2), '0:01');
        assert.strictEqual(formatCountdown(0), '0:00');
        assert.strictEqual(formatCountdown(751), '12:31');
        assert.strictEqual(formatCountdown(3723), '1:02:03');
        assert.strictEqual(formatMinutes(25), '25 min');
        assert.strictEqual(formatMinutes(100), '1h 40m');
        const end = localEnd(st({ Remaining: 60 }), 1000);
        assert.strictEqual(remainingAt(end, 31000), 30);
        assert.strictEqual(remainingAt(end, 99000), 0);
    });

    test('words the status bar as worg\'s chip', () => {
        assert.strictEqual(statusText(st({ Phase: 'work', Title: 'Write the report' }), 751), '🍅 12:31 Write the report');
        assert.strictEqual(statusText(st({ Phase: 'break' }), 299), '☕ 4:59 break');
        assert.strictEqual(statusText(st({ Phase: 'break', LongBreak: true }), 60), '☕ 1:00 long break');
        assert.strictEqual(statusText(st({}), 10), '');
        assert.ok(statusText(st({ Phase: 'work', Title: 'x'.repeat(80) }), 1).endsWith('…'));
    });

    test('says when the session moves on by itself', () => {
        const work = st({ Phase: 'work', Title: 'T', Started: '1' });
        const brk = st({ Phase: 'break', Title: 'T', Started: '2', Total: 300 });
        assert.deepStrictEqual(transitionNotice(work, brk), { title: 'Pomodoro done', body: 'T · break, 5 min' });
        assert.deepStrictEqual(transitionNotice(brk, st({ Title: 'T' })), { title: 'Break over', body: 'Another on T?' });
        assert.strictEqual(transitionNotice(work, st({})), null);
        assert.strictEqual(transitionNotice(work, work), null);
    });

    test('puts recent tasks first', () => {
        const recs: any[] = [{ Hash: 'b' }, { Hash: 'c' }, { Hash: 'b' }, { Hash: '' }];
        assert.deepStrictEqual(recentHashes(recs), ['b', 'c']);
        const t = (h: string) => ({ Hash: h, Headline: h, Filename: 'f' });
        assert.deepStrictEqual(orderTasks([t('a'), t('c'), t('b'), t('d')], ['b', 'c']).map(x => x.Hash), ['b', 'c', 'a', 'd']);
    });

    test('knows where in the set it is', () => {
        assert.deepStrictEqual(setPosition(st({ Phase: 'work', Streak: 1 })), { n: 2, of: 4 });
        assert.deepStrictEqual(setPosition(st({ Phase: 'break', Streak: 0, LongBreak: true })), { n: 4, of: 4 });
    });

    test('sends only what was said', () => {
        assert.deepStrictEqual(startBody({}), {});
        assert.deepStrictEqual(startBody({ hash: 'h', work: 50, autoNext: false }), { Hash: 'h', Work: 50, AutoNext: false });
        const target = { Filename: '/a.org', Id: 'A::B', Type: 'file+olp' };
        assert.deepStrictEqual(startBody({ target }), { Target: target });
    });

    test('lists history', () => {
        const now = new Date(2026, 9, 24, 15, 0);
        const r: any = { Hash: 'h', Title: 'T', File: 'f', Start: new Date(2026, 9, 24, 14, 5).toISOString(), End: new Date(2026, 9, 24, 14, 30).toISOString(), Minutes: 25, Completed: true };
        const old = { ...r, End: new Date(2026, 9, 23, 14, 30).toISOString() };
        assert.deepStrictEqual(todaysRecords([r, old], now), [r]);
        assert.deepStrictEqual(recordLine(r), { label: '🍅 T', description: '14:05–14:30 · 25 min' });
        assert.ok(recordLine({ ...r, Completed: false }).description.endsWith('stopped'));
    });
});
