// The kanban board, native: the boards saved on the orgs server (the same ones
// worg's Kanban tab shows) drawn as columns of cards in a webview. Dragging a
// card to another column changes its keyword, property or tag through the
// server, and dragging within a column writes its manual order, just as worg
// does. Double-click a card to open its heading. The board model is
// kanban-model.ts; this is the plumbing between it, the server and the page.

import * as vscode from 'vscode';
import { ODb } from './db';
import { openAt, settled } from './org-files';
import { onOrgsEvent } from './events';
import { kanbanHtml } from './kanban-webview';
import {
    Card, KanbanBoard, KanbanColumn, TodoStateList, newBoard, normalizeBoard, boardColumns, bucketCards,
    boardQueryProblem, searchExpr, columnOf, columnTitle, planOrder, movedCard, dropRefused, formatOrder, UNSET,
    swatch, autoSwatch, cardSwatch, headerColorOf, labelsOf, labelColorOf, assigneeOf, isSetDate, dateLabel,
    isOverdue, haystack, checklistOf, PRIORITY_COLOR, uniqueName,
} from './kanban-model';

type Stored = { name: string; query: string };

// The board shown when the server has none saved: every open todo, by keyword.
// Not saved until somebody makes a board of their own.
function fallbackBoard(): KanbanBoard {
    return { ...newBoard('Todos'), query: 'IsTodo()' };
}

const LAST_BOARD = 'org.kanban.lastBoard';
// Bodies are read one request per card; past this many a board is drawn
// without its checklist counts rather than asking for hundreds.
const MAX_BODIES = 300;

class KanbanPanel {
    static current: KanbanPanel | undefined;
    private panel: vscode.WebviewPanel;
    private subs: vscode.Disposable[] = [];
    private boards: KanbanBoard[] = [];
    private saved = false;          // whether `boards` came from the server
    private stored: Stored[] = [];
    private states: TodoStateList = { active: [], done: [] };
    private active = '';
    private cards: Card[] = [];
    private checks = new Map<string, [number, number]>();
    private message = '';
    private loading = false;
    private busy = false;
    private seq = 0;

    static show(ctx: vscode.ExtensionContext) {
        if (KanbanPanel.current) {
            KanbanPanel.current.panel.reveal();
            KanbanPanel.current.reload();
            return;
        }
        KanbanPanel.current = new KanbanPanel(ctx);
    }

    private constructor(private ctx: vscode.ExtensionContext) {
        this.active = ctx.globalState.get<string>(LAST_BOARD, '');
        this.panel = vscode.window.createWebviewPanel('orgKanban', 'Kanban', vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
        const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        this.panel.webview.html = kanbanHtml(this.panel.webview.cspSource, nonce);
        let pending: NodeJS.Timeout | undefined;
        this.subs.push(
            this.panel.webview.onDidReceiveMessage(m => this.onMessage(m)),
            // Somebody else changed a file: read the board back, unless a move
            // of ours is still being written (it refreshes when it is done).
            onOrgsEvent(['reload'], () => {
                if (pending) {
                    clearTimeout(pending);
                }
                pending = setTimeout(() => { if (!this.busy) { this.refresh(); } }, 400);
            }),
        );
        this.panel.onDidDispose(() => {
            this.subs.forEach(s => s.dispose());
            KanbanPanel.current = undefined;
        });
    }

    private get board(): KanbanBoard | null {
        return this.boards.find(b => b.name === this.active) || this.boards[0] || null;
    }

    private async onMessage(m: any) {
        switch (m.command) {
            case 'ready': return this.reload();
            case 'refresh': return this.refresh();
            case 'pick':
                this.active = m.name;
                this.ctx.globalState.update(LAST_BOARD, m.name);
                this.cards = [];
                return this.refresh();
            case 'open': {
                const c = this.cards.find(x => x.Hash === m.hash);
                if (c) {
                    await openAt(c.Filename, c.LineNum);
                }
                return;
            }
            case 'move': return this.move(m.hash, m.from, m.to, m.index);
            case 'fold': return this.fold(m.value);
            case 'newBoard': return this.newBoard();
        }
    }

    // The boards, saved queries and keywords, then the cards.
    async reload() {
        this.loading = true;
        this.post();
        const [raw, stored, states] = await Promise.all([
            ODb.api<any[]>('/ext/kanban/boards').catch((): any[] => []),
            ODb.api<Stored[]>('/ext/queries').catch((): Stored[] => []),
            ODb.api<{ Active: string[]; Done: string[] }>('/status').catch((): any => null),
        ]);
        const list = Array.isArray(raw) ? raw.map(normalizeBoard) : [];
        this.saved = list.length > 0;
        this.boards = this.saved ? list : [fallbackBoard()];
        this.stored = Array.isArray(stored) ? stored : [];
        if (states && !Array.isArray(states)) {
            this.states = { active: states.Active || [], done: states.Done || [] };
        }
        if (!this.boards.some(b => b.name === this.active)) {
            this.active = this.boards[0].name;
        }
        await this.refresh();
    }

    // Run the board's query again. Answers the cards, or null when it could not.
    async refresh(): Promise<Card[] | null> {
        const board = this.board;
        const seq = ++this.seq;
        if (!board) {
            this.cards = [];
            this.post();
            return null;
        }
        const problem = boardQueryProblem(board, this.stored);
        if (problem !== '') {
            this.cards = [];
            this.message = problem;
            this.loading = false;
            this.post();
            return null;
        }
        this.loading = true;
        this.post();
        const res = await ODb.api<any>('/search', { query: searchExpr(board, this.stored) });
        if (seq !== this.seq) {
            return null;
        }
        this.loading = false;
        if (!Array.isArray(res)) {
            this.cards = [];
            this.message = 'Could not run that board’s query (is the orgs server running?).';
            this.post();
            return null;
        }
        this.cards = res as Card[];
        if (this.message.startsWith('Could not run')) {
            this.message = '';
        }
        // A hash does not change when the text under it does, so the checklist
        // counts are read again with the cards.
        this.checks.clear();
        this.post();
        this.readBodies(seq);
        return this.cards;
    }

    // Each card's checklist count, a few requests at a time, posted as they come.
    private async readBodies(seq: number) {
        const todo = this.cards.slice(0, MAX_BODIES).map(c => c.Hash);
        let i = 0;
        const worker = async () => {
            while (i < todo.length && seq === this.seq) {
                const hash = todo[i++];
                const r = await ODb.api<any>('/body/' + ODb.pathHash(hash)).catch((): any => null);
                if (seq !== this.seq) {
                    return;
                }
                const list = checklistOf((r && r.Text) || '');
                if (list.total > 0) {
                    this.checks.set(hash, [list.done, list.total]);
                    this.panel.webview.postMessage({ command: 'check', hash, done: list.done, total: list.total });
                }
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
    }

    private columns(board: KanbanBoard): KanbanColumn[] {
        return boardColumns(board, this.states, this.cards);
    }

    // Move a card, the way worg's Kanban.moveCard does: drawn at once, written
    // behind it, and the board read back either way.
    private async move(hash: string, from: string, to: string, index: number) {
        const board = this.board;
        const card = this.cards.find(c => c.Hash === hash);
        if (!board || !card || this.busy) {
            return;
        }
        if (dropRefused(board, to)) {
            this.message = 'A heading cannot have its todo keyword taken away from here.';
            this.post();
            return;
        }
        const cols = this.columns(board);
        const target = bucketCards(this.cards, board, cols).get(to) || [];
        const writes = planOrder(target, index, card, board);
        if (from === to && !writes) {
            return;
        }
        const key = board.orderKey || 'KANBAN';
        this.busy = true;
        this.message = '';
        this.cards = this.cards.map(c => {
            let out = c.Hash === hash ? movedCard(c, board, from, to) : c;
            const w = writes && writes.find(x => x.card.Hash === c.Hash);
            if (w) {
                out = { ...out, Props: { ...(out.Props || {}), [key]: formatOrder(w.value) } };
            }
            return out;
        });
        this.post();

        let failed = '';
        try {
            if (from !== to) {
                if (board.groupBy === 'property') {
                    const res: any = await ODb.apiPost('/property', { Hash: hash, Name: board.groupKey, Value: to });
                    if (!res || res.Ok === false) {
                        failed = `Could not set ${board.groupKey}.`;
                    }
                } else if (board.groupBy === 'status') {
                    const res: any = await ODb.apiPost('/status/change', { Hash: hash, Value: to });
                    if (!res || res.Ok === false) {
                        failed = `${to} is not a todo keyword that file allows.`;
                    }
                } else {
                    // A tag column: toggling the old tag off and the new one on.
                    if (from !== UNSET) {
                        await ODb.apiPost('/tags', { Hash: hash, Value: from });
                    }
                    if (to !== UNSET) {
                        await ODb.apiPost('/tags', { Hash: hash, Value: to });
                    }
                }
            }
            if (!failed && writes) {
                for (const w of writes) {
                    await ODb.apiPost('/property', { Hash: w.card.Hash, Name: key, Value: formatOrder(w.value) });
                }
            }
        } catch (e) {
            failed = 'The server did not take that move.';
        }
        await settled([card.Filename]);
        this.busy = false;
        this.message = failed;
        // The hash of a heading whose keyword changed is not the hash it had,
        // so the board reads itself back whatever happened.
        const after = await this.refresh();
        // A move can be right and still take the card off a board whose query
        // it no longer matches (DONE on an IsTodo() board). Say so.
        if (!failed && after && from !== to &&
            !after.some(c => c.Headline === card.Headline && c.Filename === card.Filename)) {
            this.message = `“${card.Headline}” is now ${to === UNSET ? 'unset' : to} and no longer matches ` +
                `this board’s query, so it has left the board. It is still in ${card.Filename.split('/').pop()}.`;
            this.post();
        }
    }

    // Fold or unfold a column, kept on the board as worg keeps it.
    private async fold(value: string) {
        const board = this.board;
        if (!board) {
            return;
        }
        const folded = new Set(board.folded || []);
        if (folded.has(value)) {
            folded.delete(value);
        } else {
            folded.add(value);
        }
        board.folded = Array.from(folded);
        this.post();
        if (this.saved) {
            await ODb.apiPost('/ext/kanban/boards', this.boards);
        }
    }

    // A new board: a name and a query (or a saved query), grouped by keyword.
    // The rest of a board's settings are worg's settings dialog for now.
    private async newBoard() {
        const name = await vscode.window.showInputBox({
            prompt: 'Name of the new board',
            value: uniqueName('Board', this.saved ? this.boards.map(b => b.name) : []),
        });
        if (!name) {
            return;
        }
        const picks: (vscode.QuickPickItem & { q?: Stored })[] = [
            { label: '$(edit) Write a query…' },
            ...this.stored.map(q => ({ label: q.name, description: q.query, q })),
        ];
        const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Where do its cards come from?' });
        if (!pick) {
            return;
        }
        const board = newBoard(name);
        if (pick.q) {
            board.storedQuery = pick.q.name;
        } else {
            const q = await vscode.window.showInputBox({ prompt: 'Query expression', value: 'IsTodo()' });
            if (!q || q.trim() === '') {
                return;
            }
            board.query = q;
        }
        const res: any = await ODb.apiPost('/ext/kanban/board', board);
        if (!res || res.Ok === false) {
            vscode.window.showErrorMessage('Could not save the board: ' + ((res && res.Msg) || 'no answer from the server'));
            return;
        }
        this.active = name;
        this.ctx.globalState.update(LAST_BOARD, name);
        await this.reload();
    }

    // Everything the page draws, worked out here so the page only lays it out.
    private post() {
        const board = this.board;
        const dark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
            vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
        const cols = board ? this.columns(board) : [];
        const buckets = board ? bucketCards(this.cards, board, cols) : new Map<string, Card[]>();
        const have = new Set(cols.map(c => c.value));
        const homeless = board ? this.cards.filter(c => !have.has(columnOf(c, board, cols))).length : 0;
        const face = (c: Card) => {
            const sw = cardSwatch(c, board);
            const check = this.checks.get(c.Hash);
            return {
                hash: c.Hash,
                headline: c.Headline || '(no headline)',
                status: board.groupBy !== 'status' ? c.Status : '',
                priority: (c.Priority || '').toUpperCase(),
                priorityColor: PRIORITY_COLOR[(c.Priority || '').toUpperCase()] || '#6b7280',
                header: headerColorOf(c, board, dark),
                stripe: sw ? sw.hex : '',
                labels: labelsOf(c, board).map(v => ({ v, color: labelColorOf(v, board) })),
                tags: (c.Tags || []).map(t => ({ t, color: autoSwatch(t).hex })),
                badges: (board.badges || []).map(n => ({ n, v: (c.Props || {})[n] || '' })).filter(b => b.v !== ''),
                assignee: assigneeOf(c),
                deadline: isSetDate(c.Deadline) ? dateLabel(c.Deadline.Start) : '',
                deadlineFull: isSetDate(c.Deadline) ? c.Deadline.Start.slice(0, 10) : '',
                overdue: isSetDate(c.Deadline) && isOverdue(c.Deadline.Start),
                scheduled: isSetDate(c.Date) ? dateLabel(c.Date.Start) : '',
                scheduledFull: isSetDate(c.Date) ? c.Date.Start.slice(0, 10) : '',
                file: (c.Filename || '').split('/').pop(),
                path: c.Filename,
                check: check || null,
                hay: haystack(c),
            };
        };
        this.panel.title = board ? `Kanban: ${board.name}` : 'Kanban';
        this.panel.webview.postMessage({
            command: 'board',
            boards: this.boards.map(b => b.name),
            saved: this.saved,
            active: board ? board.name : '',
            groupBy: board ? board.groupBy : 'status',
            manual: board ? board.sort === 'manual' : false,
            loading: this.loading,
            busy: this.busy,
            message: this.message,
            total: this.cards.length,
            homeless,
            columns: board ? cols.map(col => ({
                value: col.value,
                title: columnTitle(col),
                color: col.color ? (col.color.charAt(0) === '#' ? col.color : swatch(col.color).hex) : autoSwatch(col.value).hex,
                limit: col.limit,
                collapsed: col.collapsed,
                refused: dropRefused(board, col.value),
                cards: (buckets.get(col.value) || []).map(face),
            })) : [],
        });
    }
}

export function activateKanban(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('org.showKanbanNative', () => KanbanPanel.show(context)),
    );
}
