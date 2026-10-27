// The assistant's chat panel: one conversation at a time, about a scope of an
// org file (the selection, a subtree, the file) or about a view (a query's
// results, a file's column view). The model is in assistant-model.ts, the
// commands and the server calls in assistant.ts.
//
// - Each turn sends the chosen scope again, read as it is at that moment:
//   the subtree is found again by its outline path, the selection by its
//   range. Nothing outside it is sent.
// - Replies are drawn from escaped text (renderMarkdown), and can go into
//   the file: at the cursor, over the selection, or to the clipboard. Each is
//   one edit, so one undo takes it back.
// - A backend with tools may edit the file itself (when org.assistantAllowEdits
//   lets it): each edit is shown as a diff first (org.assistantConfirmEdits)
//   and made with one WorkspaceEdit.

import * as vscode from 'vscode';
import * as path from 'path';
import {
    AssistantEdit, AssistantEvent, AssistantMsg, AssistantRequest, AssistantStatus, AssistantView, EditorScope, QUICK_ACTIONS,
    SCOPE_SAY, actionReady, applyChanges, buildViewRequest, editorRequest, forManuscript, modelLabel, pickBackend,
    placeEdit, renderMarkdown, sectionByPath, sizeOf, stripHeadingIds, unavailable, whereOf, whereSay,
} from './assistant-model';

export type EditorTarget = {
    kind: 'editor'; uri: vscode.Uri; scope: EditorScope;
    section?: string;          // the subtree's outline path, for 'section'
    olp?: string[];            // the same as titles, to find it again by
    range?: vscode.Range;      // the selection when the conversation began
};
export type ViewTarget = { kind: 'view'; view: Omit<AssistantView, 'Edit'>; edit: boolean };
export type Target = EditorTarget | ViewTarget;

// What the panel needs from assistant.ts: the server, and the user's choice
// of backend (kept in globalState, never in settings).
export interface AssistantHost {
    status(refresh?: boolean): Promise<AssistantStatus | undefined>;
    chosen(): { backend: string; model: string };
    chat(req: AssistantRequest, onText: (t: string) => void, onEvent: (e: AssistantEvent) => void, signal: AbortSignal):
        Promise<{ done: boolean; error?: string; model?: string; undo?: string }>;
    undo(token: string): Promise<void>;
    showStatus(): Promise<void>;
}

type Note = { text: string; warn?: boolean };
type Turn = { role: 'user' | 'assistant'; text: string; shown?: string; notes: Note[]; error?: string; streaming?: boolean; edited?: boolean };

export const EDIT_SCHEME = 'org-assistant';

// The proposed text of a file, for vscode.diff to show beside the real one.
export class ProposalContent implements vscode.TextDocumentContentProvider {
    static texts = new Map<string, string>();
    private changed = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.changed.event;
    provideTextDocumentContent(uri: vscode.Uri): string {
        return ProposalContent.texts.get(uri.query) || '';
    }
}

export class AssistantPanel {
    static current: AssistantPanel | undefined;
    private panel: vscode.WebviewPanel;
    private target: Target | undefined;
    private turns: Turn[] = [];
    private busy = false;
    private abort: AbortController | undefined;
    private undoToken = '';
    private status: AssistantStatus | undefined;
    private header = '';
    private renderTimer: NodeJS.Timeout | undefined;
    private edits: Promise<void> = Promise.resolve();

    // Opens (or reuses) the panel for a new conversation, and asks the first
    // question if there is one.
    static async start(host: AssistantHost, target: Target, question?: string) {
        if (!AssistantPanel.current) {
            AssistantPanel.current = new AssistantPanel(host);
        } else {
            AssistantPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
            AssistantPanel.current.stop();
        }
        const p = AssistantPanel.current;
        p.target = target;
        p.turns = [];
        p.undoToken = '';
        p.status = await host.status(true);
        p.render();
        if (question) {
            await p.ask(question);
        }
    }

    static lastUndo(): string {
        return AssistantPanel.current ? AssistantPanel.current.undoToken : '';
    }

    static undone() {
        if (AssistantPanel.current) {
            AssistantPanel.current.undoToken = '';
            AssistantPanel.current.render();
        }
    }

    // The status changed (a key or default set): draw the header again.
    static async refresh() {
        const p = AssistantPanel.current;
        if (p) {
            p.status = await p.host.status(true);
            p.render();
        }
    }

    private constructor(private host: AssistantHost) {
        this.panel = vscode.window.createWebviewPanel('orgAssistant', 'Assistant', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
        this.panel.webview.html = this.html();
        this.panel.onDidDispose(() => {
            this.stop();
            AssistantPanel.current = undefined;
        });
        this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    }

    private stop() {
        if (this.abort) {
            this.abort.abort();
            this.abort = undefined;
        }
    }

    private async onMessage(m: any) {
        const turn = typeof m.i === 'number' ? this.turns[m.i] : undefined;
        switch (m.type) {
            case 'ready': this.render(); break;
            case 'send': await this.ask(String(m.text || '')); break;
            case 'action': {
                const a = QUICK_ACTIONS.find(x => x.id === m.id);
                if (a) await this.ask(a.prompt + (m.text ? '\n\n' + String(m.text).trim() : ''), a.label);
                break;
            }
            case 'stop': this.stop(); break;
            case 'new': this.stop(); this.turns = []; this.undoToken = ''; this.render(); break;
            case 'status': await this.host.showStatus(); break;
            case 'undo': if (this.undoToken) await this.host.undo(this.undoToken); break;
            case 'insert': if (turn) await this.put(forManuscript(turn.text), false); break;
            case 'replace': if (turn) await this.put(forManuscript(turn.text), true); break;
            case 'copy':
                if (turn) {
                    await vscode.env.clipboard.writeText(forManuscript(turn.text));
                    vscode.window.setStatusBarMessage('Copied the answer', 2000);
                }
                break;
        }
    }

    private editorTarget(): EditorTarget | undefined {
        return this.target && this.target.kind === 'editor' ? this.target : undefined;
    }

    // The editor showing the conversation's file, opened if it is not.
    private async editor(): Promise<vscode.TextEditor | undefined> {
        const t = this.editorTarget();
        if (!t) {
            return vscode.window.visibleTextEditors.find(e => e.document.languageId === 'org');
        }
        const shown = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === t.uri.toString());
        if (shown) {
            return shown;
        }
        const doc = await vscode.workspace.openTextDocument(t.uri);
        return vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    }

    // An answer into the file: at the cursor, or over the selection (the
    // editor's own, else the one the conversation was about if it still
    // reads the same).
    private async put(text: string, replace: boolean) {
        const ed = await this.editor();
        if (!ed) {
            vscode.window.showWarningMessage('Open the org file to put the answer in.');
            return;
        }
        let range: vscode.Range = new vscode.Range(ed.selection.active, ed.selection.active);
        if (replace) {
            const t = this.editorTarget();
            if (!ed.selection.isEmpty) {
                range = ed.selection;
            } else if (t && t.range && !t.range.isEmpty) {
                range = t.range;
            } else {
                vscode.window.showWarningMessage('Select the text to replace first.');
                return;
            }
        }
        const ok = await ed.edit(b => b.replace(range, text));
        if (ok) {
            const t = this.editorTarget();
            // The selection the conversation is about is now the new text.
            if (t && replace && t.range && range.isEqual(t.range)) {
                const end = ed.document.positionAt(ed.document.offsetAt(range.start) + text.length);
                t.range = new vscode.Range(range.start, end);
            }
        }
    }

    // The request for this turn, from the scope as it reads now.
    private async request(messages: AssistantMsg[]): Promise<AssistantRequest> {
        const pick = pickBackend(this.status, this.host.chosen().backend, this.host.chosen().model, this.target.kind === 'view');
        if (!pick) {
            throw new Error(unavailable(this.status) || 'No backend can talk about this view: pick one that offers views in Org: Assistant Status.');
        }
        const conf = vscode.workspace.getConfiguration('org');
        const numCtx = conf.get<number>('assistantContextLength', 0);
        const ctx = (pick.backend.Name === 'ollama' || pick.backend.Name === 'local') && numCtx > 0 ? numCtx : 0;
        if (this.target.kind === 'view') {
            return buildViewRequest({ backend: pick.backend.Name, model: pick.model, messages, view: this.target.view,
                edit: this.target.edit && !!pick.backend.ViewTools, numCtx: ctx });
        }
        const t = this.target;
        const doc = await vscode.workspace.openTextDocument(t.uri);
        const lines = doc.getText().split(/\r?\n/);
        const section = t.olp ? sectionByPath(lines, t.olp) : null;
        if (t.scope === 'section' && !section) {
            throw new Error(`The heading “${t.section}” is not in the file any more: start a new conversation.`);
        }
        const selText = t.range ? doc.getText(t.range) : '';
        const req = editorRequest({
            backend: pick.backend.Name, model: pick.model, messages, file: doc.uri.fsPath, title: titleOf(lines, doc.uri.fsPath),
            scope: t.scope, lines, section,
            selection: selText ? { text: selText, startLine: t.range.start.line, endLine: t.range.end.line } : null,
            tools: !!pick.backend.Tools, allowEdit: conf.get<boolean>('assistantAllowEdits', false),
        });
        if (ctx) req.NumCtx = ctx;
        return req;
    }

    async ask(text: string, label?: string) {
        if (this.busy || !text.trim() || !this.target) {
            return;
        }
        const history: AssistantMsg[] = this.turns.filter(t => !t.error && t.text).map(t => ({ Role: t.role, Text: t.text }));
        let req: AssistantRequest;
        try {
            req = await this.request([...history, { Role: 'user', Text: text }]);
        } catch (e) {
            this.turns.push({ role: 'user', text, shown: label, notes: [] }, { role: 'assistant', text: '', notes: [], error: e.message });
            this.render();
            return;
        }
        this.turns.push({ role: 'user', text, shown: label, notes: [] });
        const answer: Turn = { role: 'assistant', text: '', notes: [], streaming: true };
        this.turns.push(answer);
        this.busy = true;
        this.render(req);
        const ac = new AbortController();
        this.abort = ac;
        const end = await this.host.chat(req, piece => {
            answer.text += piece;
            this.renderSoon();
        }, e => this.onEvent(answer, e), ac.signal);
        if (this.abort === ac) {
            this.abort = undefined;
        }
        this.busy = false;
        answer.streaming = false;
        if (!end.done) {
            answer.error = end.error === '' ? 'Stopped.' : end.error;
        }
        if (end.undo) {
            this.undoToken = end.undo;
        }
        // Edits are still being shown or made: let them finish first.
        await this.edits;
        this.render();
    }

    private onEvent(answer: Turn, e: AssistantEvent) {
        if ('edit' in e) {
            this.edits = this.edits.then(() => this.applyEdit(answer, e.edit));
        } else if ('tool' in e) {
            answer.notes.push({ text: e.tool, warn: e.warn });
        } else if ('query' in e) {
            answer.notes.push({ text: `Suggested query: ${e.query}${e.why ? ' - ' + e.why : ''}${e.count !== undefined ? ` (${e.count} found)` : ''}` });
        } else if ('wrote' in e) {
            answer.notes.push({ text: `Changed ${path.basename(e.wrote)}` });
        }
        this.renderSoon();
    }

    // An edit a backend with tools made to the open file: placed in the text
    // as it is now, shown as a diff if asked, and made as one edit.
    private async applyEdit(answer: Turn, e: AssistantEdit) {
        const t = this.editorTarget();
        const what = e.old.length > 40 ? e.old.slice(0, 40).trim() + '…' : e.old;
        if (!t) {
            return;
        }
        const doc = await vscode.workspace.openTextDocument(t.uri);
        const placed = placeEdit(doc.getText(), e);
        if (!placed) {
            answer.notes.push({ text: `Could not make an edit: “${what}” is not in the text any more`, warn: true });
            this.renderSoon();
            return;
        }
        if (vscode.workspace.getConfiguration('org').get<boolean>('assistantConfirmEdits', true)) {
            const key = String(Date.now()) + Math.random().toString(36).slice(2);
            ProposalContent.texts.set(key, applyChanges(doc.getText(), placed));
            const right = vscode.Uri.from({ scheme: EDIT_SCHEME, path: doc.uri.path, query: key });
            await vscode.commands.executeCommand('vscode.diff', doc.uri, right, `${path.basename(doc.uri.fsPath)} ↔ the assistant's edit`, { preview: true, preserveFocus: true });
            const pick = await vscode.window.showInformationMessage(`Make the assistant's edit to ${path.basename(doc.uri.fsPath)}?`, 'Apply', 'Discard');
            ProposalContent.texts.delete(key);
            if (pick !== 'Apply') {
                answer.notes.push({ text: `Edit discarded (“${what}”)`, warn: true });
                this.renderSoon();
                return;
            }
        }
        // Placed again: the writer may have typed while the diff was up.
        const now = placeEdit(doc.getText(), e);
        const we = new vscode.WorkspaceEdit();
        for (const c of now || []) {
            we.replace(doc.uri, new vscode.Range(doc.positionAt(c.from), doc.positionAt(c.to)), c.insert);
        }
        const ok = !!now && await vscode.workspace.applyEdit(we);
        answer.notes.push(ok ? { text: `Edited ${path.basename(doc.uri.fsPath)}${now.length > 1 ? ` (${now.length} places)` : ''}` }
            : { text: `Could not make an edit: “${what}” has changed`, warn: true });
        if (ok) answer.edited = true;
        this.renderSoon();
    }

    private renderSoon() {
        if (!this.renderTimer) {
            this.renderTimer = setTimeout(() => { this.renderTimer = undefined; this.render(); }, 60);
        }
    }

    // What the conversation sees and where it goes, for the header.
    private describe(req?: AssistantRequest): string {
        const pick = pickBackend(this.status, this.host.chosen().backend, this.host.chosen().model, this.target && this.target.kind === 'view');
        const off = unavailable(this.status);
        if (!pick) {
            return `<div class="warn">${esc(off || 'No backend that can talk about views is ready.')}</div>`;
        }
        const w = whereOf(pick.backend, pick.model);
        let sees = '';
        if (this.target && this.target.kind === 'editor') {
            const t = this.target;
            sees = `Sees ${SCOPE_SAY[t.scope]}${t.scope === 'section' && t.section ? ` (${esc(t.section)})` : ''} of ${esc(path.basename(t.uri.fsPath))}`;
            if (pick.backend.Tools) {
                sees += vscode.workspace.getConfiguration('org').get<boolean>('assistantAllowEdits', false)
                    ? ' - it has tools, and may read and edit this file itself' : ' - it has tools, and may read this file itself';
            }
        } else if (this.target && this.target.kind === 'view') {
            const t = this.target;
            const v = t.view;
            sees = `Sees ${v.Kind === 'columns' ? 'the column view of ' + esc(path.basename(v.File || '')) : 'the results of ' + esc(v.Query || '')}` +
                (t.edit && pick.backend.ViewTools ? ' - and may change headings' : '');
        }
        if (req) {
            sees += `, about ${sizeOf(req).toLocaleString()} tokens`;
        }
        return `<div><b>${esc(pick.backend.Label)}</b> · ${esc(modelLabel(pick.backend.Name, pick.model))} · <span title="${esc(whereSay(w, pick.backend.Name).long)}">${esc(whereSay(w, pick.backend.Name).short)}</span></div>` +
            `<div class="dim">${sees}</div>`;
    }

    private render(req?: AssistantRequest) {
        if (req || !this.header) {
            this.header = this.describe(req);
        } else if (!this.busy) {
            this.header = this.describe();
        }
        const t = this.editorTarget();
        const view = this.target && this.target.kind === 'view';
        const hasSel = !!(t && t.range && !t.range.isEmpty);
        this.panel.webview.postMessage({
            type: 'render',
            header: this.header,
            busy: this.busy,
            undo: !!this.undoToken,
            ready: !!pickBackend(this.status, this.host.chosen().backend, this.host.chosen().model, view),
            actions: view ? [] : QUICK_ACTIONS.map(a => ({ id: a.id, label: a.label, ok: actionReady(a, hasSel), title: a.prompt })),
            canPut: !view,
            turns: this.turns.map(x => ({
                role: x.role,
                html: x.role === 'user' ? esc(x.shown || x.text) : renderMarkdown(view ? stripHeadingIds(x.text) : x.text),
                notes: x.notes,
                error: x.error || '',
                streaming: !!x.streaming,
                edited: !!x.edited,
            })),
        });
    }

    private html(): string {
        const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); margin: 0; display: flex; flex-direction: column; height: 100vh; }
header { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
header .row { display: flex; gap: 6px; align-items: flex-start; }
header .what { flex: 1; min-width: 0; }
.dim { opacity: .75; font-size: .92em; margin-top: 2px; }
.warn { color: var(--vscode-editorWarning-foreground); }
#turns { flex: 1; overflow-y: auto; padding: 8px 10px; }
.turn { margin: 0 0 10px; }
.bubble { padding: 6px 10px; border-radius: 6px; line-height: 1.5; word-wrap: break-word; }
.user .bubble { background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.15)); white-space: pre-wrap; }
.assistant .bubble { border: 1px solid var(--vscode-panel-border); }
.bubble p { margin: .3em 0; } .bubble pre { background: var(--vscode-textCodeBlock-background); padding: 6px; overflow-x: auto; }
.bubble code { font-family: var(--vscode-editor-font-family); }
.note { font-size: .88em; opacity: .8; margin: 2px 0; } .note.warn { opacity: 1; }
.err { color: var(--vscode-errorForeground); font-size: .92em; margin-top: 3px; }
.tools { display: flex; gap: 4px; margin-top: 3px; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 8px; border-radius: 3px; cursor: pointer; font: inherit; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:disabled { opacity: .5; cursor: default; }
button:hover:not(:disabled) { filter: brightness(1.15); }
#actions { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 10px 0; }
footer { padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border); display: flex; gap: 6px; align-items: flex-end; }
textarea { flex: 1; resize: vertical; min-height: 2.6em; max-height: 40vh; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; }
.dots::after { content: '…'; animation: blink 1.2s infinite; } @keyframes blink { 50% { opacity: .2; } }
@media (prefers-reduced-motion: reduce) { .dots::after { animation: none; } }
</style></head><body>
<header><div class="row"><div class="what" id="header"></div>
<button id="undo" title="Put back what the assistant changed in this turn" hidden>Undo changes</button>
<button id="status" title="Backend, model and keys">Backend…</button>
<button id="new" title="Start a new conversation">New</button></div></header>
<main id="turns"></main>
<div id="actions"></div>
<footer><textarea id="input" rows="2" placeholder="Ask a follow-up… (Enter to send, Shift+Enter for a new line)"></textarea>
<button id="send" class="primary">Send</button></footer>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
let state = { busy: false };
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
function button(label, title, onclick, disabled) { const b = el('button'); b.textContent = label; b.title = title; b.disabled = !!disabled; b.onclick = onclick; return b; }
window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type !== 'render') return;
    state = m;
    $('header').innerHTML = m.header;
    $('undo').hidden = !m.undo;
    const list = $('turns');
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = '';
    if (!m.turns.length) list.appendChild(el('div', 'dim', m.ready ? 'Ask a question below, or pick an action.' : ''));
    m.turns.forEach((t, i) => {
        const d = el('div', 'turn ' + t.role);
        t.notes.forEach(n => { const p = el('div', 'note' + (n.warn ? ' warn' : '')); p.textContent = (n.warn ? '⚠ ' : '✓ ') + n.text; d.appendChild(p); });
        const b = el('div', 'bubble', t.html);
        if (t.streaming && !t.html) b.appendChild(el('span', 'dots', 'Thinking'));
        d.appendChild(b);
        if (t.error) { const e = el('div', 'err'); e.textContent = t.error; d.appendChild(e); }
        if (t.role === 'assistant' && !t.streaming && t.html) {
            const tools = el('div', 'tools');
            if (m.canPut && !t.edited) {
                tools.appendChild(button('Insert', 'Put this in at the cursor', () => vscode.postMessage({ type: 'insert', i })));
                tools.appendChild(button('Replace', 'Put this in place of the selection', () => vscode.postMessage({ type: 'replace', i })));
            }
            tools.appendChild(button('Copy', 'Copy to the clipboard', () => vscode.postMessage({ type: 'copy', i })));
            d.appendChild(tools);
        }
        list.appendChild(d);
    });
    if (atEnd || m.busy) list.scrollTop = list.scrollHeight;
    const acts = $('actions');
    acts.innerHTML = '';
    (m.actions || []).forEach(a => acts.appendChild(button(a.label, a.ok ? a.title : 'Start the conversation with a selection for this one',
        () => { vscode.postMessage({ type: 'action', id: a.id, text: $('input').value }); $('input').value = ''; }, !a.ok || m.busy || !m.ready)));
    $('send').textContent = m.busy ? 'Stop' : 'Send';
    $('send').disabled = !m.busy && !m.ready;
});
function send() {
    if (state.busy) { vscode.postMessage({ type: 'stop' }); return; }
    const text = $('input').value;
    if (!text.trim()) return;
    vscode.postMessage({ type: 'send', text });
    $('input').value = '';
}
$('send').onclick = send;
$('input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('new').onclick = () => vscode.postMessage({ type: 'new' });
$('status').onclick = () => vscode.postMessage({ type: 'status' });
$('undo').onclick = () => vscode.postMessage({ type: 'undo' });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
    }
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The file's #+TITLE, else its name.
function titleOf(lines: string[], file: string): string {
    for (const l of lines.slice(0, 50)) {
        const m = /^#\+title:\s*(.*)$/i.exec(l);
        if (m && m[1].trim()) return m[1].trim();
    }
    return path.basename(file, '.org');
}
