// Focus sessions run by the orgs server (/focus/*): pomodoros on a heading,
// clocked in while they run and written into its logbook when done, with the
// breaks between them. The same session worg's header chip and `orgs focus`
// show, so one started in the terminal counts down here too.
//
// How it stays current, as worg's focusApi.ts does it:
//  1. The event stream (events.ts), for the focus kinds: any of them means
//     "ask again".
//  2. A quiet poll: every 30 seconds with the stream up, every 15 without.
//  3. A one second tick, only while a phase runs, moving the countdown on
//     locally. When it passes zero the server is asked straight away rather
//     than waiting for the event.
//
// pomodoro.ts is the older timer that runs inside VS Code alone (no server
// needed). The two are separate status bar items; Start Focus offers the local
// timer when there is no server to ask.
import * as vscode from 'vscode';
import { Auth } from './auth';
import { onOrgsEvent, onStreamLive, isStreamLive } from './events';
import { orgsRequest } from './orgs-request';
import { openAt, readLines } from './org-files';
import { findHeading } from './links/model';
import { headingAt, olpOf, parseHeading, COMMON_KEYWORDS } from './outline/model';
import {
    FocusState, FocusHistory, FocusTask, IDLE, NO_ANSWER, StartOptions, asFocusState, asFocusHistory,
    localEnd, remainingAt, isRunning, statusText, statusTooltip, transitionNotice, phaseLabel,
    formatCountdown, formatMinutes, recentHashes, orderTasks, recordLine, startBody,
} from './focus-model';

const KINDS = ['focusstart', 'focusend', 'breakstart', 'breakend', 'focusstop', 'focusextend'];

let state: FocusState = IDLE;
let loaded = false;
let end = 0;
let remaining = 0;
let ticker: NodeJS.Timeout | undefined;
let poll: NodeJS.Timeout | undefined;
let asking = false;
let item: vscode.StatusBarItem;

function popupsOn(): boolean {
    return vscode.workspace.getConfiguration('org').get<boolean>('focusPopups', true) !== false;
}

// -- The store -----------------------------------------------------------------

function take(st: FocusState) {
    const prev = state;
    const first = !loaded;
    loaded = true;
    state = st;
    end = localEnd(st, Date.now());
    remaining = remainingAt(end, Date.now());
    if (!first) {
        notify(prev, st);
    }
    runTicker();
    show();
}

async function refresh() {
    if (asking || !Auth.get().isLoggedIn()) {
        return;
    }
    asking = true;
    try {
        const st = asFocusState(await orgsRequest('GET', '/focus'));
        if (st.Msg !== NO_ANSWER) {
            take(st);
        }
    } finally {
        asking = false;
    }
}

// A write's answer is the state after it, taken at once: the status bar moves
// without waiting for the event. A refusal still carries the real state.
async function write(path: string, body: any): Promise<FocusState | undefined> {
    if (!(await Auth.get().ensureLoggedIn())) {
        return undefined;
    }
    const st = asFocusState(await orgsRequest('POST', path, {}, body));
    if (st.Msg !== NO_ANSWER) {
        take(st);
    }
    if (!st.Ok) {
        vscode.window.showWarningMessage(st.Msg || 'That did not work.');
    }
    return st;
}

function schedulePoll() {
    if (poll) {
        clearInterval(poll);
    }
    poll = setInterval(refresh, isStreamLive() ? 30000 : 15000);
}

function runTicker() {
    const running = isRunning(state);
    if (running && !ticker) {
        ticker = setInterval(tick, 1000);
    } else if (!running && ticker) {
        clearInterval(ticker);
        ticker = undefined;
    }
}

function tick() {
    const left = remainingAt(end, Date.now());
    // Out of time: the server moves the phase on within a second and says so;
    // asking here as well covers an event that went missing.
    if (left <= 0 && remaining > 0) {
        setTimeout(refresh, 1200);
    }
    if (left <= 0 && Math.floor(Date.now() / 1000) % 5 === 0) {
        refresh();
    }
    remaining = left;
    show();
}

function show() {
    if (!isRunning(state)) {
        item.hide();
        return;
    }
    item.text = statusText(state, remaining);
    item.tooltip = `${statusTooltip(state)}\nClick to stop, add time or skip.`;
    item.show();
}

// When the session moves on by itself: the pomodoro is done, the break over.
async function notify(prev: FocusState, next: FocusState) {
    const n = transitionNotice(prev, next);
    if (!n || !popupsOn()) {
        return;
    }
    const text = n.body ? `${n.title}: ${n.body}` : n.title;
    if (n.title === 'Break over') {
        const pick = await vscode.window.showInformationMessage(text, 'Start another');
        if (pick === 'Start another') {
            await startFocus({ hash: next.Hash });
        }
    } else if (next.Phase === 'break') {
        const pick = await vscode.window.showInformationMessage(text, 'Skip the break');
        if (pick === 'Skip the break') {
            await skipFocus();
        }
    } else {
        vscode.window.showInformationMessage(text);
    }
}

// -- Commands ------------------------------------------------------------------

export async function startFocus(o: StartOptions = {}): Promise<FocusState | undefined> {
    return write('/focus/start', startBody(o));
}

export const stopFocus = () => write('/focus/stop', {});
export const skipFocus = () => write('/focus/skip', {});
export const extendFocus = (minutes = 5) => write('/focus/extend', { Minutes: minutes });

// The heading under the cursor of an org file, as a target the server keeps
// hold of (file+olp, the way it clocks in).
async function headingAtCursor(): Promise<{ target: StartOptions['target'], title: string } | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'org' || editor.document.uri.scheme !== 'file') {
        return undefined;
    }
    const lines = editor.document.getText().split(/\r?\n/);
    const h = headingAt(lines, editor.selection.active.line);
    if (h < 0) {
        return undefined;
    }
    // The server reads the file: what is typed has to be on disk first.
    if (editor.document.isDirty) {
        await editor.document.save();
    }
    return {
        target: { Filename: editor.document.fileName, Id: olpOf(lines, h).join('::'), Type: 'file+olp' },
        title: parseHeading(lines[h], h, COMMON_KEYWORDS).title,
    };
}

interface TaskPick extends vscode.QuickPickItem { hash?: string; last?: boolean; }

// The open TODOs, the recently focused first, as worg's Focus tab offers them.
async function pickTask(): Promise<StartOptions | undefined> {
    const [rows, hist] = await Promise.all([
        orgsRequest<any[]>('GET', '/search', { query: '!IsProject() && !IsArchived() && IsTodo()' }),
        orgsRequest<FocusHistory>('GET', '/focus/history', { days: '14' }),
    ]);
    const tasks: FocusTask[] = (Array.isArray(rows) ? rows : []).filter(r => r && r.Hash).map(r => ({
        Hash: r.Hash, Headline: r.Headline, Filename: r.Filename, Status: r.Status, Priority: r.Priority,
    }));
    const recent = recentHashes(asFocusHistory(hist).Records);
    const items: TaskPick[] = orderTasks(tasks, recent).map(t => ({
        label: `${t.Status ? t.Status + ' ' : ''}${t.Priority ? `[#${t.Priority}] ` : ''}${t.Headline}`,
        description: vscode.workspace.asRelativePath(t.Filename),
        detail: recent.indexOf(t.Hash) >= 0 ? '$(history) recently focused' : undefined,
        hash: t.Hash,
    }));
    if (state.Hash || recent.length) {
        items.unshift({ label: '$(debug-restart) The last task again', last: true });
    }
    if (!items.length) {
        vscode.window.showInformationMessage('No open TODOs to focus on. Put the cursor on a heading and start there.');
        return undefined;
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Focus on which task?', matchOnDescription: true });
    if (!pick) {
        return undefined;
    }
    return pick.last ? {} : { hash: pick.hash };
}

export async function startFocusCommand(): Promise<void> {
    // No server to run it: the timer that runs here alone will do.
    if (!(await Auth.get().quietLogin()) && Auth.get().accessState() === 'unreachable') {
        const use = await vscode.window.showWarningMessage('The orgs server is not answering, and focus sessions run there. Use the local timer instead?', 'Local timer');
        if (use === 'Local timer') {
            await vscode.commands.executeCommand('org.startTimer');
        }
        return;
    }
    if (!(await Auth.get().ensureLoggedIn())) {
        return;
    }
    const here = await headingAtCursor();
    let opts: StartOptions | undefined;
    if (here) {
        opts = { target: here.target };
    } else {
        opts = await pickTask();
    }
    if (!opts) {
        return;
    }
    if (isRunning(state)) {
        const go = await vscode.window.showWarningMessage(
            `${phaseLabel(state)} is running${state.Title ? ' on ' + state.Title : ''}. Start a new one?`, 'Start');
        if (go !== 'Start') {
            return;
        }
    }
    const st = await startFocus(opts);
    if (st && st.Ok && isRunning(st)) {
        vscode.window.setStatusBarMessage(`🍅 ${formatMinutes(Math.round(st.Total / 60))} on ${st.Title || 'the task'}`, 3000);
    }
}

async function extendCommand(minutes?: number) {
    if (typeof minutes !== 'number') {
        const pick = await vscode.window.showQuickPick(['5', '10', '15', '25'].map(m => ({ label: `$(add) ${m} minutes`, m: +m })),
            { placeHolder: `${phaseLabel(state)}: ${formatCountdown(remaining)} left. How much more?` });
        if (!pick) {
            return;
        }
        minutes = pick.m;
    }
    await extendFocus(minutes);
}

async function openTask(file: string | undefined, title: string | undefined) {
    if (!file) {
        return;
    }
    const lines = readLines(file);
    if (!lines.length) {
        vscode.window.showWarningMessage(`${file} is not on this machine.`);
        return;
    }
    await openAt(file, Math.max(0, title ? findHeading(lines, title) : 0));
}

// The status bar's click: what worg's chip panel offers.
async function focusMenu() {
    await refresh();
    if (!isRunning(state)) {
        return startFocusCommand();
    }
    const work = state.Phase === 'work';
    const items: { label: string, act: () => Promise<unknown> }[] = [
        { label: work ? '$(debug-stop) Stop' : '$(debug-stop) End break', act: () => stopFocus() },
        { label: '$(add) 5 more minutes', act: () => extendFocus(5) },
        { label: work ? '$(check) Done - take the break' : '$(debug-step-over) Skip - start the next one', act: () => skipFocus() },
    ];
    if (state.File) {
        items.push({ label: '$(go-to-file) Open the task', act: () => openTask(state.File, state.Title) });
    }
    items.push({ label: '$(history) Focus history', act: () => focusHistory() });
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `${phaseLabel(state)} · ${formatCountdown(remaining)} left${state.Title ? ' · ' + state.Title : ''} · ${state.Today} today`,
    });
    if (pick) {
        await pick.act();
    }
}

export async function focusHistory(): Promise<void> {
    if (!(await Auth.get().ensureLoggedIn())) {
        return;
    }
    const span = await vscode.window.showQuickPick([
        { label: 'Today', days: 1 }, { label: 'The last 7 days', days: 7 }, { label: 'The last 30 days', days: 30 },
    ], { placeHolder: 'Focus history for…' });
    if (!span) {
        return;
    }
    const h = asFocusHistory(await orgsRequest('GET', '/focus/history', { days: String(span.days) }));
    if (!h.Ok && !h.Records.length) {
        vscode.window.showErrorMessage(NO_ANSWER);
        return;
    }
    if (!h.Records.length) {
        vscode.window.showInformationMessage('No focus sessions yet in that time.');
        return;
    }
    // Newest first, under the day each was on.
    const records = h.Records.slice().sort((a, b) => b.End.localeCompare(a.End));
    const items: (vscode.QuickPickItem & { r?: typeof records[0] })[] = [];
    let day = '';
    for (const r of records) {
        const d = new Date(r.End).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
        if (d !== day) {
            items.push({ label: d, kind: vscode.QuickPickItemKind.Separator });
            day = d;
        }
        items.push({ ...recordLine(r), r });
    }
    const total = records.reduce((t, r) => t + (r.Minutes || 0), 0);
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `${h.Today} today (${formatMinutes(Math.round(h.TodayMinutes))}) · ${records.length} in all, ${formatMinutes(Math.round(total))}`,
        matchOnDescription: true,
    });
    if (pick && pick.r) {
        await openTask(pick.r.File, pick.r.Title);
    }
}

export function activateFocus(ctx: vscode.ExtensionContext) {
    item = vscode.window.createStatusBarItem('org.focus', vscode.StatusBarAlignment.Right, 102);
    item.name = 'Org Focus';
    item.command = 'org.focusMenu';
    ctx.subscriptions.push(item,
        // Every kind means the state moved (and `hello`, that it may have
        // while the stream was down): ask what it is now.
        onOrgsEvent(KINDS, () => refresh()),
        onStreamLive(() => schedulePoll()),
        Auth.get().onTokenChanged(() => refresh()),
        { dispose: () => { if (poll) { clearInterval(poll); } if (ticker) { clearInterval(ticker); } } },
        vscode.commands.registerCommand('org.focusStart', startFocusCommand),
        vscode.commands.registerCommand('org.focusStop', () => stopFocus()),
        vscode.commands.registerCommand('org.focusSkip', () => skipFocus()),
        vscode.commands.registerCommand('org.focusExtend', extendCommand),
        vscode.commands.registerCommand('org.focusHistory', focusHistory),
        vscode.commands.registerCommand('org.focusMenu', focusMenu),
    );
    schedulePoll();
    refresh();
}
