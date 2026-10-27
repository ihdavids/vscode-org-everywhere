// The day planner, native: the day's hours with what is on them, and beside
// them the open tasks that are not (GET /plan/day). Dragging a task onto an
// hour writes SCHEDULED: <2026-10-12 Mon 10:00-11:00> on it (POST
// /plan/block); dragging a block moves it, its bottom edge resizes it, and
// dragging it back onto the list takes it off the day (POST /plan/unblock).
//
// As in worg's DayPlanner, every change is drawn at once (planner-model.ts's
// placeLocally/unplanLocally) and written behind it, one write at a time in
// the order they were made. A refused write puts the day back as it was and
// says why; after the last write the day is read again, because the server
// is the truth.

import * as vscode from 'vscode';
import { ODb } from './db';
import { openAt, settled } from './org-files';
import { onOrgsEvent } from './events';
import { plannerHtml } from './planner-webview';
import {
    PlanDay, PlanWrite, clock, clockMins, freeSlot, filterTasks, layoutLanes, lengthText, placeLocally, searchFrom,
    spanOf, taskLength, taskNote, unplanLocally, ymd,
} from './planner-model';

function config() {
    const c = vscode.workspace.getConfiguration('org');
    const start = clockMins(c.get<string>('planner.dayStart', '09:00'));
    const end = clockMins(c.get<string>('planner.dayEnd', '17:00'));
    const ok = start >= 0 && end > start;
    return { start: ok ? start : 540, end: ok ? end : 1020, query: c.get<string>('planner.query', '') };
}

function addDays(d: Date, n: number): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

class PlannerPanel {
    static current: PlannerPanel | undefined;
    private panel: vscode.WebviewPanel;
    private subs: vscode.Disposable[] = [];
    private date = new Date();
    private day: PlanDay | null = null;
    private error = '';
    private notice = '';
    private loading = false;
    private filter = '';
    private pending = 0;
    private queue: Promise<void> = Promise.resolve();
    private seq = 0;
    private dragging = false;

    static show(ctx: vscode.ExtensionContext) {
        if (PlannerPanel.current) {
            PlannerPanel.current.panel.reveal();
            PlannerPanel.current.refresh();
            return;
        }
        PlannerPanel.current = new PlannerPanel(ctx);
    }

    private constructor(ctx: vscode.ExtensionContext) {
        this.panel = vscode.window.createWebviewPanel('orgPlanner', 'Day Planner', vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
        const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        this.panel.webview.html = plannerHtml(nonce);
        let soon: NodeJS.Timeout | undefined;
        const quiet = () => this.pending === 0 && !this.dragging;
        this.subs.push(
            this.panel.webview.onDidReceiveMessage(m => this.onMessage(m)),
            onOrgsEvent(['reload'], () => {
                if (soon) {
                    clearTimeout(soon);
                }
                soon = setTimeout(() => { if (quiet()) { this.refresh(); } }, 400);
            }),
            vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('org.planner')) { this.refresh(); } }),
        );
        // The "now" line moves, and a day left open goes stale without events.
        const tick = setInterval(() => { if (quiet()) { this.refresh(); } }, 60000);
        this.subs.push(new vscode.Disposable(() => clearInterval(tick)));
        this.panel.onDidDispose(() => {
            this.subs.forEach(s => s.dispose());
            PlannerPanel.current = undefined;
        });
    }

    private async onMessage(m: any) {
        switch (m.command) {
            case 'ready': return this.refresh();
            case 'refresh': return this.refresh();
            case 'day':
                this.date = m.delta === 0 ? new Date() : addDays(this.date, m.delta);
                this.day = null;
                return this.refresh();
            case 'place': return this.place(m.hash, m.start, m.end);
            case 'unplan': return this.unplan(m.hash);
            case 'next': return this.placeNext(m.hash);
            case 'open': return this.open(m.hash);
            case 'filter':
                this.filter = m.text || '';
                return this.post();
            case 'dragging':
                this.dragging = !!m.on;
                return;
            case 'dismiss':
                this.error = '';
                this.notice = '';
                return this.post();
            case 'window': {
                // The working day, kept in the settings so the agenda's other
                // users of it agree.
                const c = vscode.workspace.getConfiguration('org');
                await c.update('planner.dayStart', clock(m.start), vscode.ConfigurationTarget.Global);
                await c.update('planner.dayEnd', clock(m.end), vscode.ConfigurationTarget.Global);
                return;
            }
        }
    }

    async refresh() {
        const seq = ++this.seq;
        const cfg = config();
        this.loading = true;
        this.post();
        const params: { [k: string]: string } = { date: ymd(this.date), dayStart: clock(cfg.start), dayEnd: clock(cfg.end) };
        if (cfg.query) {
            params.query = cfg.query;
        }
        const res = await ODb.api<PlanDay>('/plan/day', params).catch((): PlanDay => undefined);
        if (seq !== this.seq) {
            return;
        }
        this.loading = false;
        if (!res || Array.isArray(res) || typeof res !== 'object') {
            this.error = 'The orgs server did not answer.';
        } else if (!res.Ok) {
            this.error = res.Msg || 'The planner could not read the day.';
        } else if (this.pending === 0) {
            // A write started while this was in flight makes it stale.
            this.day = res;
            if (this.error.startsWith('The orgs server') || this.error.startsWith('The planner')) {
                this.error = '';
            }
        }
        this.post();
    }

    // Draw the change now, send it behind, put it back if it is refused.
    private write(change: (d: PlanDay) => PlanDay, send: () => Promise<PlanWrite>, what: string, file: string) {
        const before = this.day;
        if (!before) {
            return;
        }
        this.day = change(before);
        this.notice = '';
        this.pending++;
        this.seq++; // a read already on its way would undo this
        this.post();
        this.queue = this.queue.then(async () => {
            try {
                const res = await send();
                if (!res || Array.isArray(res) || typeof res !== 'object') {
                    throw new Error('the server did not answer');
                }
                if (!res.Ok) {
                    throw new Error(res.Msg || 'the write was refused');
                }
                await settled([file]);
            } catch (e) {
                this.day = before;
                this.error = `Could not ${what}: ${e?.message || e}`;
                this.post();
            } finally {
                this.pending--;
                if (this.pending === 0) {
                    this.refresh();
                }
            }
        });
    }

    private place(hash: string, start: number, end: number) {
        const d = this.day;
        if (!d) {
            return;
        }
        const b = d.Blocks.find(x => x.Hash === hash && x.Movable);
        if (b && clockMins(b.Start) === start && clockMins(b.End) === end && !b.Implied) {
            return;
        }
        const t = d.Tasks.find(x => x.Hash === hash);
        const title = b?.Headline ?? t?.Headline ?? 'it';
        const file = b?.Filename ?? t?.Filename ?? '';
        this.write(x => placeLocally(x, hash, start, end),
            () => ODb.apiPost<PlanWrite>('/plan/block', { Hash: hash, Date: d.Date, Start: clock(start), End: clock(end) }),
            `place ${title}`, file);
    }

    private unplan(hash: string) {
        const d = this.day;
        const b = d?.Blocks.find(x => x.Hash === hash && x.Movable);
        if (!d || !b) {
            return;
        }
        this.write(x => unplanLocally(x, hash), () => ODb.apiPost<PlanWrite>('/plan/unblock', { Hash: hash, KeepDate: false }),
            `take ${b.Headline} off the day`, b.Filename);
        if (b.Repeater) {
            this.notice = `${b.Headline} repeats (${b.Repeater}): it keeps its date, only the time came off.`;
            this.post();
        }
    }

    // The first free gap long enough, from now on today: where the server
    // would have put it. With no hash, the first task on the (filtered) list.
    private placeNext(hash?: string) {
        const d = this.day;
        if (!d) {
            return;
        }
        const t = hash ? d.Tasks.find(x => x.Hash === hash) : filterTasks(d.Tasks, this.filter)[0];
        if (!t) {
            this.error = 'There is no task to place.';
            return this.post();
        }
        const cfg = config();
        const len = taskLength(t.EffortMins, d.DefaultMins || 60);
        const spans = d.Blocks.filter(b => b.Hash !== t.Hash).map(spanOf);
        const at = freeSlot(spans, cfg.start, cfg.end, searchFrom(d, new Date(), cfg.start), len);
        if (at === null) {
            this.error = `No free ${lengthText(len)} left in the working day for ${t.Headline}.`;
            return this.post();
        }
        this.place(t.Hash, at, at + len);
    }

    private async open(hash: string) {
        const d = this.day;
        if (!d) {
            return;
        }
        const x = d.Blocks.find(b => b.Hash === hash) || d.AllDay.find(b => b.Hash === hash) || d.Tasks.find(t => t.Hash === hash);
        if (x) {
            await openAt(x.Filename, x.LineNum);
        }
    }

    private post() {
        const cfg = config();
        const d = this.day;
        const now = new Date();
        const spans = d ? d.Blocks.map(spanOf) : [];
        const lanes = layoutLanes(spans);
        const clash = spans.map((a, i) => spans.some((b, j) =>
            i !== j && a.end > a.start && b.end > b.start && a.start < b.end && b.start < a.end));
        const date = d ? d.Date : ymd(this.date);
        const title = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10))
            .toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        this.panel.title = `Day Planner: ${date}`;
        this.panel.webview.postMessage({
            command: 'day',
            date,
            title,
            isToday: date === ymd(now),
            nowMin: now.getHours() * 60 + now.getMinutes(),
            start: cfg.start,
            end: cfg.end,
            loading: this.loading,
            error: this.error,
            notice: this.notice,
            defaultMins: d ? d.DefaultMins || 60 : 60,
            load: d ? d.Load : null,
            loadText: d ? {
                planned: lengthText(d.Load.PlannedMins),
                window: lengthText(d.Load.WindowMins),
                free: lengthText(d.Load.FreeMins),
                double: d.Load.DoubleMins > 0 ? lengthText(d.Load.DoubleMins) : '',
                outside: d.Load.OutsideMins > 0 ? lengthText(d.Load.OutsideMins) : '',
                backlog: d.Load.BacklogMins > 0 ? lengthText(d.Load.BacklogMins) : '',
                noEst: d.Load.BacklogNoEst,
            } : null,
            blocks: d ? d.Blocks.map((b, i) => ({
                hash: b.Hash, headline: b.Headline, status: b.Status, kind: b.Kind, start: spans[i].start, end: spans[i].end,
                startText: b.Start, endText: b.End, mins: b.Mins, lengthText: lengthText(b.Mins), movable: b.Movable,
                implied: b.Implied, repeater: b.Repeater, done: b.Done, pending: !!b.Pending,
                lane: lanes[i].lane, lanes: lanes[i].lanes, clash: clash[i],
            })) : [],
            allDay: d ? d.AllDay.map(b => ({
                hash: b.Hash, headline: b.Headline, kind: b.Kind, done: b.Done,
                note: b.Kind === 'deadline' ? (b.Late > 0 ? ` · ${b.Late}d overdue` : b.DueIn > 0 ? ` · due in ${b.DueIn}d` : ' · due') : '',
            })) : [],
            tasks: d ? filterTasks(d.Tasks, this.filter).map(t => ({
                hash: t.Hash, headline: t.Headline, status: t.Status, priority: t.Priority, tags: t.Tags || [],
                file: (t.Filename || '').split('/').pop(), effort: t.EffortMins > 0 ? lengthText(t.EffortMins) : '',
                len: taskLength(t.EffortMins, d.DefaultMins || 60),
                lenText: lengthText(taskLength(t.EffortMins, d.DefaultMins || 60)), note: taskNote(t), late: t.Late > 0,
            })) : [],
            taskCount: d ? d.Tasks.length : 0,
        });
    }
}

export function activatePlanner(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('org.showDayPlanner', () => PlannerPanel.show(context)),
    );
}
