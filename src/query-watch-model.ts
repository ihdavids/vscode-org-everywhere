// Saved-query watches: the shapes the server sends, and the small decisions the
// bell and the notification list make about them. Ported from worg's
// querywatch.ts so both read the same; pure, for test/query-watch.test.ts.
//
// The server decides what is new (orgs/internal/app/orgs/querywatch.go: the
// baseline rule, heading identity across edits); nothing here second-guesses
// it. What lives here is presentation, and folding a `querymatch` event into
// the list already held, so the bell moves the moment the event arrives.

export type WatchMatch = {
    key: string;
    headline: string;
    status?: string;
    file: string;
    line: number;
    hash?: string;
    path?: string[];
};

export type WatchNotice = {
    id: string;
    watch: string;
    label: string;
    at: string;
    gained?: WatchMatch[];
    left?: WatchMatch[];
    count: number;
    read: boolean;
};

export type QueryWatch = {
    name: string;
    label?: string;
    storedQuery?: string;
    query?: string;
    left?: boolean;
    desktop?: boolean;
    paused?: boolean;
};

export type WatchStatus = QueryWatch & {
    resolved: string;
    count: number;
    checked?: string;
    error?: string;
};

export type WatchList = { ok: boolean; msg?: string; watches: WatchStatus[]; desktop: boolean };
export type NoticeList = { ok: boolean; msg?: string; unread: number; total: number; notices: WatchNotice[] };

// The `querymatch` event, as /events sends it.
export type QueryMatchEvent = {
    kind: 'querymatch';
    watch: string;
    label?: string;
    count?: number;
    notice?: string;
    headings?: WatchMatch[];
    left?: WatchMatch[];
    msg?: string;
    at: string;
};

export const EMPTY_NOTICES: NoticeList = { ok: true, unread: 0, total: 0, notices: [] };
export const EMPTY_WATCHES: WatchList = { ok: true, watches: [], desktop: false };

// How many notifications the server keeps; the list here keeps the same.
export const NOTICE_CAP = 50;

const NO_ANSWER = 'The server did not answer.';

// What a request that failed, or an older server, hands back, made into a list.
export function asNoticeList(x: any): NoticeList {
    if (!x || Array.isArray(x) || !Array.isArray(x.notices)) {
        return { ...EMPTY_NOTICES, ok: false, msg: (x && (x.msg || x.Msg)) || NO_ANSWER };
    }
    return x as NoticeList;
}

export function asWatchList(x: any): WatchList {
    if (!x || Array.isArray(x) || !Array.isArray(x.watches)) {
        return { ...EMPTY_WATCHES, ok: false, msg: (x && (x.msg || x.Msg)) || NO_ANSWER };
    }
    return x as WatchList;
}

export function watchTitle(w: QueryWatch): string {
    return w.label || w.name;
}

// The watch on a saved query, if there is one. A watch made in the terminal on
// the same query under another name counts.
export function watchOf(watches: WatchStatus[], storedQuery: string): WatchStatus | undefined {
    return watches.find(w => w.storedQuery === storedQuery)
        || watches.find(w => !w.storedQuery && w.name === storedQuery);
}

export function badgeText(unread: number): string {
    if (!unread || unread < 0) {
        return '';
    }
    return unread > 9 ? '9+' : String(unread);
}

function names(ms: WatchMatch[], max: number): string {
    const shown = ms.slice(0, max).map(m => m.headline);
    if (ms.length > max) {
        shown.push(`and ${ms.length - max} more`);
    }
    return shown.join(', ');
}

// One line saying what happened, matching the server's noticeSummary: "2 new:
// Call Sam, Fix the roof".
export function noticeSummary(n: Pick<WatchNotice, 'gained' | 'left'>): string {
    const parts: string[] = [];
    const g = n.gained || [];
    const l = n.left || [];
    if (g.length) {
        parts.push(`${g.length} new: ${names(g, 3)}`);
    }
    if (l.length) {
        parts.push(`${l.length} gone: ${names(l, 3)}`);
    }
    return parts.join('; ');
}

// A time the way a list of notifications reads: "just now", "12 min ago",
// "3 h ago", "yesterday 14:05", then the date.
export function relativeTime(at: string, now: number = Date.now()): string {
    const t = Date.parse(at);
    if (isNaN(t)) {
        return at || '';
    }
    const secs = Math.max(0, (now - t) / 1000);
    if (secs < 60) {
        return 'just now';
    }
    if (secs < 3600) {
        return `${Math.floor(secs / 60)} min ago`;
    }
    const d = new Date(t);
    const today = new Date(now);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (secs < 12 * 3600 && d.getDate() === today.getDate()) {
        return `${Math.floor(secs / 3600)} h ago`;
    }
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    if (t >= startOfToday) {
        return `today ${hm}`;
    }
    if (t >= startOfToday - 86400000) {
        return `yesterday ${hm}`;
    }
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${ymd} ${hm}`;
}

// The notification an event describes. The event carries everything the list
// entry does, so it can be shown before asking the server again.
export function noticeFromEvent(e: QueryMatchEvent): WatchNotice | null {
    if (!e || e.kind !== 'querymatch' || !e.notice) {
        return null;
    }
    return {
        id: e.notice,
        watch: e.watch,
        label: e.label || e.watch,
        at: e.at,
        gained: e.headings || [],
        left: e.left || [],
        count: e.count || 0,
        read: false,
    };
}

// Whether a notification is news: not one already in the list (the event and
// a poll can both bring the same one).
export function isNew(list: NoticeList, id: string): boolean {
    return !list.notices.some(x => x.id === id);
}

// Fold a new notification into the list: newest first, never twice, capped as
// the server caps it.
export function withNotice(list: NoticeList, n: WatchNotice): NoticeList {
    if (!isNew(list, n.id)) {
        return list;
    }
    const notices = [n, ...list.notices].slice(0, NOTICE_CAP);
    return {
        ...list,
        notices,
        total: Math.min(NOTICE_CAP, list.total + 1),
        unread: notices.filter(x => !x.read).length,
    };
}

// Mark read locally, so the badge clears on the click rather than on the
// server's answer.
export function markedRead(list: NoticeList, ids: string[] | 'all'): NoticeList {
    const want = ids === 'all' ? null : new Set(ids);
    const notices = list.notices.map(n => (want === null || want.has(n.id) ? { ...n, read: true } : n));
    return { ...list, notices, unread: notices.filter(n => !n.read).length };
}

// What a pop-up notification says.
export function popupNotice(n: WatchNotice): { title: string; body: string } {
    return { title: n.label, body: noticeSummary(n) || `${n.count} matching now` };
}

// The counts line under a notification: "2 new · 1 gone · 5 matching now".
export function noticeCounts(n: WatchNotice): string {
    const bits: string[] = [];
    const g = (n.gained || []).length, l = (n.left || []).length;
    if (g) {
        bits.push(`${g} new`);
    }
    if (l) {
        bits.push(`${l} gone`);
    }
    bits.push(`${n.count} matching now`);
    return bits.join(' · ');
}

// Where a heading lives, for the line under it.
export function whereOf(m: WatchMatch): string {
    const base = m.file.split(/[\\/]/).pop() || m.file;
    const parents = (m.path || []).slice(0, -1);
    return parents.length ? `${base} › ${parents.join(' › ')}` : base;
}

// What is saved of a watch, without what the server reports about it, for
// sending back.
export function plainWatch(w: QueryWatch): QueryWatch {
    const out: QueryWatch = { name: w.name };
    if (w.label) {
        out.label = w.label;
    }
    if (w.storedQuery) {
        out.storedQuery = w.storedQuery;
    }
    if (w.query) {
        out.query = w.query;
    }
    if (w.left) {
        out.left = true;
    }
    if (w.desktop) {
        out.desktop = true;
    }
    if (w.paused) {
        out.paused = true;
    }
    return out;
}

// A new watch on a saved query, with the defaults worg's bell uses.
export function watchForQuery(name: string, opts: Partial<QueryWatch> = {}): QueryWatch {
    return { name, storedQuery: name, left: false, desktop: false, ...opts };
}

// How a watch reads in a list: "5 matching · checked 3 min ago", or why not.
export function watchState(w: WatchStatus, now: number = Date.now()): string {
    if (w.error) {
        return w.error;
    }
    if (w.paused) {
        return 'paused';
    }
    const count = w.count >= 0 ? `${w.count} matching` : 'not checked yet';
    return w.checked ? `${count} · checked ${relativeTime(w.checked, now)}` : count;
}

// The status bar bell: "$(bell-dot) 3" with unread, a plain bell without.
export function bellText(unread: number): string {
    return unread > 0 ? `$(bell-dot) ${badgeText(unread)}` : '$(bell)';
}
