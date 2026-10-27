// Saved-query watches, as worg's bell does them: a watch is a saved query the
// server re-runs whenever the org files change (and every few minutes, for
// queries that move with the clock), saying when it finds a heading it had not
// found before. Here that arrives as a VS Code notification - Open goes to the
// heading - and as a bell in the status bar (and a badge on the Agenda view)
// with the unread count.
//
// One live copy of the list, kept by the event stream (kind `querymatch`,
// folded straight in) and a quiet poll that picks up whatever the stream
// missed: every minute with the stream up, every twenty seconds without.
//
// The server holds everything (orgs/internal/app/orgs/querywatch.go): /watches
// to list, make, change and remove watches, /notifications and its read and
// clear, /watches/check to run them now. The pure part is query-watch-model.ts.
import * as vscode from 'vscode';
import { Auth } from './auth';
import { onOrgsEvent, onStreamLive, isStreamLive } from './events';
import { orgsRequest } from './orgs-request';
import { openAt, readLines } from './org-files';
import { findHeading } from './links/model';
import * as agendaView from './agenda-view';
import {
    NoticeList, WatchList, QueryWatch, WatchNotice, WatchMatch, WatchStatus, QueryMatchEvent,
    EMPTY_NOTICES, EMPTY_WATCHES, asNoticeList, asWatchList, noticeFromEvent, withNotice, markedRead,
    popupNotice, noticeCounts, noticeSummary, relativeTime, whereOf, watchOf, watchState, watchTitle,
    plainWatch, watchForQuery, bellText, badgeText, isNew,
} from './query-watch-model';

let notices: NoticeList = EMPTY_NOTICES;
let watches: WatchList = EMPTY_WATCHES;
let loaded = false;
// The notifications already told about (or there before we looked), so a
// poll that brings one the stream missed pops it once, and only that one.
const seen = new Set<string>();
let asking = false;
let poll: NodeJS.Timeout | undefined;
let bell: vscode.StatusBarItem;

const NO_ANSWER = 'The orgs server did not answer.';

function popupsOn(): boolean {
    return vscode.workspace.getConfiguration('org').get<boolean>('watchPopups', true) !== false;
}

// -- The list ------------------------------------------------------------------

function takeNotices(n: NoticeList) {
    notices = n;
    if (!loaded) {
        // Whatever is there on the first look is not news to pop up.
        n.notices.forEach(x => seen.add(x.id));
    }
    loaded = true;
    show();
}

function takeWatches(w: WatchList) {
    watches = w;
    show();
}

async function refresh() {
    if (asking || !Auth.get().isLoggedIn()) {
        return;
    }
    asking = true;
    try {
        const [n, w] = await Promise.all([
            orgsRequest<NoticeList>('GET', '/notifications'),
            orgsRequest<WatchList>('GET', '/watches'),
        ]);
        const nl = asNoticeList(n), wl = asWatchList(w);
        // A failed read keeps what is shown: stale is better than blank.
        if (wl.ok) {
            watches = wl;
        }
        if (nl.ok) {
            const fresh = loaded ? nl.notices.filter(x => !x.read && !seen.has(x.id)) : [];
            takeNotices(nl);
            fresh.reverse().forEach(popup);
        } else {
            show();
        }
    } finally {
        asking = false;
    }
}

function schedulePoll() {
    if (poll) {
        clearInterval(poll);
    }
    poll = setInterval(refresh, isStreamLive() ? 60000 : 20000);
}

function onMatch(e: QueryMatchEvent) {
    const n = noticeFromEvent(e);
    if (n && isNew(notices, n.id)) {
        takeNotices(withNotice(notices, n));
        popup(n);
    }
    // And ask again, for anything the stream missed.
    refresh();
}

// -- What shows ----------------------------------------------------------------

// The bell, and the badge on the Agenda view. Nothing at all when nothing is
// watched and nothing has been found, like worg's: the status bar shows a
// feature at work, it does not advertise one.
function show() {
    const unread = notices.unread;
    if (!loaded || (watches.watches.length === 0 && notices.total === 0)) {
        bell.hide();
    } else {
        const watching = watches.watches.filter(w => !w.paused).length;
        bell.text = bellText(unread);
        bell.tooltip = (unread > 0
            ? `${unread} unread notification${unread === 1 ? '' : 's'} from watched queries`
            : 'Notifications from watched queries') + ` · ${watching} watch${watching === 1 ? '' : 'es'}`;
        bell.show();
    }
    const view = agendaView.agendaTreeView;
    if (view) {
        view.badge = unread > 0
            ? { value: unread, tooltip: `${badgeText(unread)} unread notification${unread === 1 ? '' : 's'} from watched queries` }
            : undefined;
    }
}

async function popup(n: WatchNotice) {
    if (seen.has(n.id)) {
        return;
    }
    seen.add(n.id);
    if (!popupsOn()) {
        return;
    }
    const { title, body } = popupNotice(n);
    const pick = await vscode.window.showInformationMessage(`${title}: ${body}`, 'Open', 'Mark read');
    if (pick === 'Open') {
        await openNotice(n);
    } else if (pick === 'Mark read') {
        await markRead([n.id]);
    }
}

// -- Acting on it --------------------------------------------------------------

async function markRead(ids: string[] | 'all') {
    takeNotices(markedRead(notices, ids));
    const body = ids === 'all' ? { all: true } : { ids };
    const res = asNoticeList(await orgsRequest('POST', '/notifications/read', {}, body));
    if (res.ok) {
        takeNotices(res);
    }
}

// Goes to a heading a watch found. The line is where it was when found; if
// the file has moved on since, the heading is looked for by name.
async function openMatch(m: WatchMatch) {
    const lines = readLines(m.file);
    if (!lines.length) {
        vscode.window.showWarningMessage(`${m.headline}: ${m.file} is not on this machine.`);
        return;
    }
    let line = m.line;
    if (!(lines[line] && /^\*+\s/.test(lines[line]) && lines[line].indexOf(m.headline) >= 0)) {
        const found = findHeading(lines, m.headline);
        if (found >= 0) {
            line = found;
        }
    }
    await openAt(m.file, Math.max(0, line));
}

async function openNotice(n: WatchNotice) {
    if (!n.read) {
        markRead([n.id]);
    }
    const gained = n.gained || [];
    if (gained.length === 1) {
        return openMatch(gained[0]);
    }
    const items = gained.map(m => ({ label: (m.status ? m.status + ' ' : '') + m.headline, description: whereOf(m), m }))
        .concat((n.left || []).map(m => ({ label: '$(circle-slash) ' + m.headline, description: 'no longer matches · ' + whereOf(m), m: undefined })));
    if (!items.length) {
        vscode.window.showInformationMessage(`${n.label}: ${noticeCounts(n)}`);
        return;
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `${n.label} · ${noticeCounts(n)}` });
    if (pick && pick.m) {
        await openMatch(pick.m);
    }
}

// -- Commands ------------------------------------------------------------------

async function loggedIn(): Promise<boolean> {
    return Auth.get().ensureLoggedIn();
}

interface QueryPick extends vscode.QuickPickItem { name: string; w?: WatchStatus; }
interface OptionPick extends vscode.QuickPickItem { id: 'left' | 'desktop' | 'paused'; }

// Watch a saved query, or change how one is watched: what it finds now counts
// as known, and only what it finds from here on is news.
export async function watchSavedQuery(name?: string): Promise<void> {
    if (!(await loggedIn())) {
        return;
    }
    const [queries, wl] = await Promise.all([
        orgsRequest<{ name: string, query: string }[]>('GET', '/ext/queries'),
        orgsRequest<WatchList>('GET', '/watches'),
    ]);
    if (!Array.isArray(queries)) {
        vscode.window.showErrorMessage(NO_ANSWER);
        return;
    }
    const list = asWatchList(wl);
    if (list.ok) {
        takeWatches(list);
    }
    if (!name) {
        if (!queries.length) {
            vscode.window.showInformationMessage('There are no saved queries yet. Save one in worg\'s Saved Queries, or with `orgs q save`.');
            return;
        }
        const pick = await vscode.window.showQuickPick<QueryPick>(queries.map(q => {
            const w = watchOf(list.watches, q.name);
            return { label: (w ? '$(bell-dot) ' : '$(bell) ') + q.name, description: w ? watchState(w) : '', detail: q.query, name: q.name, w };
        }), { placeHolder: 'Watch which saved query?', matchOnDetail: true });
        if (!pick) {
            return;
        }
        name = pick.name;
    }
    const w = watchOf(list.watches, name);
    const options: OptionPick[] = [
        { id: 'left', label: 'Also when a heading leaves', detail: 'Say when something stops matching, too.', picked: !!(w && w.left) },
        {
            id: 'desktop', label: 'Desktop popup', picked: !!(w && w.desktop),
            detail: list.desktop ? 'On the server\'s desktop, through the notify plugin.'
                : 'Needs the notify plugin in server.plugins; saved, but nothing pops up until then.',
        },
    ];
    if (w) {
        options.push({ id: 'paused', label: 'Paused', detail: 'Keep the watch but stop checking. Resuming starts afresh.', picked: !!w.paused });
    }
    const how = await vscode.window.showQuickPick(options, {
        canPickMany: true,
        placeHolder: w ? `Watching “${name}” - change how` : `Watch “${name}”: what it finds now counts as known. Anything more?`,
    });
    if (!how) {
        return;
    }
    const label = await vscode.window.showInputBox({
        prompt: 'What its notifications are called (optional)', value: (w && w.label) || '', placeHolder: name,
    });
    if (label === undefined) {
        return;
    }
    const on = (id: string) => how.some(o => o.id === id);
    const watch: QueryWatch = { ...(w ? plainWatch(w) : watchForQuery(name)), left: on('left'), desktop: on('desktop'), paused: on('paused') };
    if (label.trim()) {
        watch.label = label.trim();
    } else {
        delete watch.label;
    }
    const res = asWatchList(await orgsRequest('POST', '/watches', {}, plainWatch(watch)));
    if (!res.ok) {
        vscode.window.showErrorMessage(`Could not watch “${name}”: ${res.msg || NO_ANSWER}`);
        return;
    }
    takeWatches(res);
    vscode.window.setStatusBarMessage(w ? `$(bell) “${name}”: changed` : `$(bell) Watching “${name}”: anything it finds from here on shows up under the bell`, 5000);
}

export async function unwatchSavedQuery(): Promise<void> {
    if (!(await loggedIn())) {
        return;
    }
    const list = asWatchList(await orgsRequest('GET', '/watches'));
    if (!list.ok) {
        vscode.window.showErrorMessage(list.msg || NO_ANSWER);
        return;
    }
    takeWatches(list);
    if (!list.watches.length) {
        vscode.window.showInformationMessage('Nothing is being watched.');
        return;
    }
    const pick = await vscode.window.showQuickPick(list.watches.map(w => ({
        label: (w.error ? '$(warning) ' : w.paused ? '$(debug-pause) ' : '$(bell-dot) ') + watchTitle(w),
        description: watchState(w), detail: w.storedQuery ? `saved query ${w.storedQuery}` : w.resolved || w.query, w,
    })), { placeHolder: 'Stop watching which?' });
    if (!pick) {
        return;
    }
    const res = asWatchList(await orgsRequest('DELETE', '/watches', { name: pick.w.name }));
    if (!res.ok) {
        vscode.window.showErrorMessage(`Could not stop watching ${pick.w.name}: ${res.msg || NO_ANSWER}`);
        return;
    }
    takeWatches(res);
    vscode.window.setStatusBarMessage(`$(bell-slash) Stopped watching ${watchTitle(pick.w)}`, 3000);
}

interface NoticePick extends vscode.QuickPickItem { n?: WatchNotice; act?: () => Promise<void>; }

const markReadButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('check'), tooltip: 'Mark read' };

export async function showNotifications(): Promise<void> {
    if (!(await loggedIn())) {
        return;
    }
    await refresh();
    const qp = vscode.window.createQuickPick<NoticePick>();
    const watching = watches.watches.filter(w => !w.paused).length;
    qp.title = `Notifications · ${watching} watch${watching === 1 ? '' : 'es'}`;
    qp.placeholder = notices.unread ? `${notices.unread} unread` : 'Nothing unread';
    qp.matchOnDetail = true;
    const items = (): NoticePick[] => {
        const out: NoticePick[] = notices.notices.map(n => ({
            label: `${n.read ? '$(circle-outline)' : '$(circle-filled)'} ${n.label}`,
            description: relativeTime(n.at),
            detail: [noticeCounts(n), noticeSummary(n)].filter(s => s).join(' — '),
            buttons: n.read ? [] : [markReadButton],
            n,
        }));
        if (!out.length) {
            out.push({ label: '$(info) Nothing new yet', detail: 'When a watched query finds a heading it did not find before, it shows up here.' });
        }
        out.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        if (notices.unread) {
            out.push({ label: '$(check-all) Mark all read', act: () => markRead('all') });
        }
        out.push({ label: '$(refresh) Check the watches now', act: checkWatches });
        out.push({ label: '$(bell) Watch a saved query…', act: () => watchSavedQuery() });
        if (watches.watches.length) {
            out.push({ label: '$(bell-slash) Stop watching…', act: unwatchSavedQuery });
        }
        if (notices.total) {
            out.push({ label: '$(clear-all) Clear all notifications', act: clearNotifications });
        }
        return out;
    };
    qp.items = items();
    qp.onDidTriggerItemButton(async e => {
        if (e.item.n) {
            await markRead([e.item.n.id]);
            qp.items = items();
        }
    });
    qp.onDidAccept(async () => {
        const sel = qp.selectedItems[0];
        qp.hide();
        if (sel && sel.n) {
            await openNotice(sel.n);
        } else if (sel && sel.act) {
            await sel.act();
        }
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
}

export async function clearNotifications(): Promise<void> {
    if (!(await loggedIn())) {
        return;
    }
    const res = asNoticeList(await orgsRequest('POST', '/notifications/clear', {}, { all: true }));
    if (!res.ok) {
        vscode.window.showErrorMessage(res.msg || NO_ANSWER);
        return;
    }
    takeNotices(res);
    vscode.window.setStatusBarMessage('$(clear-all) Notifications cleared', 3000);
}

export async function checkWatches(): Promise<void> {
    if (!(await loggedIn())) {
        return;
    }
    const res = asNoticeList(await orgsRequest('POST', '/watches/check', {}, {}));
    if (!res.ok) {
        vscode.window.showErrorMessage(res.msg || NO_ANSWER);
        return;
    }
    const made = res.notices.length;
    vscode.window.setStatusBarMessage(`$(bell) ${made ? `${made} new notification${made === 1 ? '' : 's'}` : 'Nothing new'}`, 4000);
    await refresh();
}

export function activateQueryWatch(ctx: vscode.ExtensionContext) {
    bell = vscode.window.createStatusBarItem('org.notifications', vscode.StatusBarAlignment.Right, 99);
    bell.name = 'Org Notifications';
    bell.command = 'org.showNotifications';
    ctx.subscriptions.push(bell,
        onOrgsEvent(['querymatch'], e => {
            if (e.kind === 'querymatch') {
                onMatch(e.data as QueryMatchEvent);
            } else {
                // `hello`: (back) up - catch up on what happened meanwhile.
                refresh();
            }
        }),
        onStreamLive(() => schedulePoll()),
        Auth.get().onTokenChanged(() => {
            // Somebody else's list is not ours: start afresh.
            loaded = false;
            notices = EMPTY_NOTICES;
            watches = EMPTY_WATCHES;
            seen.clear();
            show();
            refresh();
        }),
        { dispose: () => poll && clearInterval(poll) },
        vscode.commands.registerCommand('org.watchSavedQuery', (name?: string) => watchSavedQuery(typeof name === 'string' ? name : undefined)),
        vscode.commands.registerCommand('org.unwatchSavedQuery', unwatchSavedQuery),
        vscode.commands.registerCommand('org.showNotifications', showNotifications),
        vscode.commands.registerCommand('org.clearNotifications', clearNotifications),
        vscode.commands.registerCommand('org.checkWatches', checkWatches),
    );
    schedulePoll();
    refresh();
    // The Agenda view may be made after this runs: give it its badge then.
    setTimeout(show, 3000);
}
