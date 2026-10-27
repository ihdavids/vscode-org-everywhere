// The assistant: talk an org file over with the model the orgs server offers
// (Claude, ChatGPT, Gemini, or one on the server's own machine), as worg's
// writing assistant does. Server: internal/app/orgs/assistant.go,
// assistantview.go, assistantkeys.go, assistantdefault.go. Model in
// assistant-model.ts, the chat panel in assistant-panel.ts.
//
// - What it sees is the writer's choice: the selection, the subtree the
//   cursor is in, or the file. Nothing else is sent.
// - Keys go straight to the server (POST /assistant/key), which keeps them
//   in its keyring; the extension never stores one. Which backend to use is
//   remembered in globalState, the server's default set with
//   POST /assistant/default.

import * as vscode from 'vscode';
import { URL } from 'url';
import { TextDecoder } from 'util';
import { Request, Headers } from 'node-fetch';
import { Sets } from './sets';
import { ODb } from './db';
import { Auth, orgsAgent } from './auth';
import {
    AssistantEnd, AssistantEvent, AssistantRequest, AssistantStatus, EditorScope, KEY_BILLING, KEY_PAGES, NdjsonLines,
    SCOPE_SAY, SETUP, SOURCE_SAY, modelLabel, pickBackend, sectionAt, unavailable, whereOf, whereSay,
} from './assistant-model';
import { AssistantHost, AssistantPanel, EDIT_SCHEME, ProposalContent, Target, ViewTarget } from './assistant-panel';

const fetchModule = import('node-fetch');
async function fetch(req: any): Promise<any> {
    return (await fetchModule).default(req);
}

let context: vscode.ExtensionContext;
let cached: AssistantStatus | undefined;

const BACKEND_KEY = 'org.assistant.backend';
const MODEL_KEY = 'org.assistant.model';

async function status(refresh = false): Promise<AssistantStatus | undefined> {
    if (cached && !refresh) {
        return cached;
    }
    const s = await ODb.api<AssistantStatus>('/assistant/status').catch(() => undefined);
    // An old server answers 404 with a non-json body: doGet gives undefined.
    cached = s && typeof s === 'object' ? s : undefined;
    return cached;
}

function chosen(): { backend: string; model: string } {
    return { backend: context.globalState.get<string>(BACKEND_KEY, ''), model: context.globalState.get<string>(MODEL_KEY, '') };
}

// One turn, the answer handed to onText piece by piece as it streams in
// (newline-delimited JSON), and what a backend with tools did to onEvent.
async function chat(req: AssistantRequest, onText: (t: string) => void, onEvent: (e: AssistantEvent) => void, signal: AbortSignal): Promise<AssistantEnd> {
    if (!await Auth.get().ensureLoggedIn()) {
        return { done: false, error: 'Not logged in to the orgs server.' };
    }
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    const token = Auth.get().getToken();
    if (token) {
        headers.set('Authorization', 'Bearer ' + token);
    }
    let res: any;
    try {
        res = await fetch(new Request(new URL(Sets.orgsConnection + '/assistant/chat'),
            { method: 'POST', headers, body: JSON.stringify(req), agent: orgsAgent(), signal: signal as any }));
    } catch (e) {
        return { done: false, error: e && e.name === 'AbortError' ? '' : String((e && e.message) || e) };
    }
    if (res.status === 401) {
        return { done: false, error: 'The server wants a login again: run Org: Login and ask again.' };
    }
    if (!res.ok) {
        return { done: false, error: `The server answered ${res.status} ${res.statusText}` };
    }
    // A refusal comes back as plain json rather than a stream.
    if ((res.headers.get('Content-Type') || '').startsWith('application/json')) {
        const j = await res.json().catch(() => null);
        return { done: false, error: (j && j.Msg) || 'The server refused.' };
    }
    const lines = new NdjsonLines();
    const dec = new TextDecoder();
    let end: AssistantEnd = { done: false, error: 'The answer stopped part way.' };
    const each = (evs: any[]) => {
        for (const ev of evs) {
            if (typeof ev.t === 'string') onText(ev.t);
            else if (ev.edit || typeof ev.tool === 'string' || typeof ev.query === 'string' || typeof ev.wrote === 'string') onEvent(ev);
            else if (ev.error) end = { done: false, error: ev.error, undo: ev.undo };
            else if (ev.done) end = { done: true, model: ev.model, stop: ev.stop, undo: ev.undo };
        }
    };
    try {
        for await (const chunk of res.body) {
            each(lines.push(dec.decode(chunk as Buffer, { stream: true })));
        }
        each(lines.push(dec.decode(), true));
    } catch (e) {
        return { done: false, error: e && e.name === 'AbortError' ? '' : String((e && e.message) || e), undo: end.undo };
    }
    return end;
}

async function undo(token: string) {
    const r = await ODb.apiPost<{ Ok: boolean; Msg?: string }>('/assistant/undo', { Token: token });
    if (r && r.Ok) {
        AssistantPanel.undone();
        vscode.window.showInformationMessage(`The assistant's changes were put back: ${r.Msg || 'done'}.`);
    } else {
        vscode.window.showWarningMessage(`Nothing was undone: ${(r && r.Msg) || 'no answer from the server'}.`);
    }
}

const host: AssistantHost = { status, chosen, chat, undo, showStatus: () => showStatus() };

// The server can be talked to, or say why not, offering the status.
async function usable(views = false): Promise<boolean> {
    const s = await status(true);
    const why = unavailable(s);
    if (why || !pickBackend(s, chosen().backend, chosen().model, views)) {
        const pick = await vscode.window.showWarningMessage(why || 'No ready backend can talk about views.', 'Assistant Status');
        if (pick) {
            await showStatus();
        }
        return false;
    }
    return true;
}

function orgEditor(): vscode.TextEditor | undefined {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'org') {
        vscode.window.showWarningMessage('The assistant works on an org file: open one first.');
        return undefined;
    }
    return ed;
}

// The target for a scope in the active editor; undefined (said why) when
// the scope cannot be had.
function targetFor(ed: vscode.TextEditor, scope: EditorScope): Target | undefined {
    const sel = ed.selection;
    const lines = ed.document.getText().split(/\r?\n/);
    const section = sectionAt(lines, sel.active.line);
    if (scope === 'selection' && sel.isEmpty) {
        vscode.window.showWarningMessage('Select some text first.');
        return undefined;
    }
    if (scope === 'section' && !section) {
        vscode.window.showWarningMessage('The cursor is above the first heading: there is no subtree. Pick This File instead.');
        return undefined;
    }
    return {
        kind: 'editor', uri: ed.document.uri, scope,
        section: section ? section.path : undefined,
        olp: section ? section.olp : undefined,
        range: sel.isEmpty ? undefined : new vscode.Range(sel.start, sel.end),
    };
}

async function pickScope(ed: vscode.TextEditor): Promise<EditorScope | undefined> {
    const lines = ed.document.getText().split(/\r?\n/);
    const section = sectionAt(lines, ed.selection.active.line);
    const tokens = (s: string) => `about ${Math.round(s.length / 4).toLocaleString()} tokens`;
    const items: (vscode.QuickPickItem & { scope: EditorScope })[] = [];
    if (!ed.selection.isEmpty) {
        items.push({ scope: 'selection', label: '$(selection) The selection', description: tokens(ed.document.getText(ed.selection)) });
    }
    if (section) {
        items.push({ scope: 'section', label: '$(list-tree) This heading’s subtree', description: tokens(section.text), detail: section.path });
    }
    items.push({ scope: 'file', label: '$(file) This file', description: tokens(ed.document.getText()) });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'What may the assistant see? Only that is sent.' });
    return pick ? pick.scope : undefined;
}

async function askQuestion(scope: EditorScope): Promise<string | undefined> {
    return vscode.window.showInputBox({
        prompt: `Ask the assistant about ${SCOPE_SAY[scope]}`,
        placeHolder: 'Leave empty to open the conversation and pick an action there',
        ignoreFocusOut: true,
    });
}

async function askAssistant() {
    const ed = orgEditor();
    if (!ed || !await usable()) return;
    const scope = await pickScope(ed);
    if (!scope) return;
    const target = targetFor(ed, scope);
    if (!target) return;
    const q = await askQuestion(scope);
    if (q === undefined) return;
    await AssistantPanel.start(host, target, q.trim() || undefined);
}

async function askAboutSelection() {
    const ed = orgEditor();
    if (!ed || !await usable()) return;
    const target = targetFor(ed, 'selection');
    if (!target) return;
    const q = await askQuestion('selection');
    if (q === undefined) return;
    await AssistantPanel.start(host, target, q.trim() || undefined);
}

async function summarizeSubtree() {
    const ed = orgEditor();
    if (!ed || !await usable()) return;
    const target = targetFor(ed, 'section');
    if (!target) return;
    await AssistantPanel.start(host, target,
        'Summarize this subtree in a short paragraph, then list its main points, open tasks and decisions, if it has any.');
}

// A conversation about a view: the results of a query, or this file's
// column view. The server looks the headings up itself.
async function askAboutView() {
    if (!await usable(true)) return;
    const ed = vscode.window.activeTextEditor;
    const items: (vscode.QuickPickItem & { which: 'search' | 'columns' })[] = [
        { which: 'search', label: '$(search) The results of a query', description: 'e.g. IsTodo() && !IsArchived()' },
    ];
    if (ed && ed.document.languageId === 'org') {
        items.push({ which: 'columns', label: '$(table) The column view of this file' });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'What should the assistant look at?' });
    if (!pick) return;
    let view: ViewTarget;
    if (pick.which === 'search') {
        const q = await vscode.window.showInputBox({ prompt: 'A query in the orgs query language', ignoreFocusOut: true });
        if (!q || !q.trim()) return;
        view = { kind: 'view', view: { Kind: 'search', Query: q.trim(), Title: q.trim() }, edit: false };
    } else {
        view = { kind: 'view', view: { Kind: 'columns', File: ed.document.uri.fsPath, Title: ed.document.uri.fsPath }, edit: false };
    }
    const s = await status();
    const b = pickBackend(s, chosen().backend, chosen().model, true);
    if (b && b.backend.ViewTools) {
        const allow = await vscode.window.showQuickPick([
            { label: 'Read only', edit: false },
            { label: 'May change headings', detail: 'Keywords, properties, tags, dates; every turn can be undone with Org: Assistant Undo', edit: true },
        ], { placeHolder: `May ${b.backend.Label} change the headings it looks at?` });
        if (!allow) return;
        view.edit = allow.edit;
    }
    const q = await vscode.window.showInputBox({ prompt: 'Ask the assistant', placeHolder: 'Summarize these, which should I do next…', ignoreFocusOut: true });
    if (q === undefined) return;
    await AssistantPanel.start(host, view, q.trim() || undefined);
}

async function assistantUndo() {
    const token = AssistantPanel.lastUndo();
    if (!token) {
        vscode.window.showInformationMessage('The assistant has changed nothing on the server to undo. Edits it made in the editor undo with Ctrl+Z / Cmd+Z, like any other.');
        return;
    }
    await undo(token);
}

// Which backend and model the assistant uses, where each sends the text,
// and the server's keys and default.
async function showStatus() {
    const s = await status(true);
    if (!s || !s.Ok || s.Off) {
        vscode.window.showWarningMessage(unavailable(s));
        return;
    }
    const now = pickBackend(s, chosen().backend, chosen().model);
    type Item = vscode.QuickPickItem & { run?: () => Promise<void> };
    const items: Item[] = [];
    items.push({ label: 'Backends', kind: vscode.QuickPickItemKind.Separator });
    for (const b of s.Backends || []) {
        const w = whereOf(b, b.Model);
        items.push({
            label: `${now && now.backend.Name === b.Name ? '$(check)' : b.Ready ? '$(circle-outline)' : '$(warning)'} ${b.Label}`,
            description: b.Ready ? `${modelLabel(b.Name, now && now.backend.Name === b.Name ? now.model : b.Model)} · ${whereSay(w, b.Name).short}${b.Name === s.Default ? ' · server default' : ''}` : 'not ready',
            detail: b.Ready ? `Key ${SOURCE_SAY[b.Source || ''] || 'set'}${b.Tools ? ' · has tools' : ''}${b.Views ? ' · works in views' : ''}` : (b.Msg || SETUP[b.Name] || ''),
            run: () => backendMenu(s, b.Name),
        });
    }
    items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(refresh) Ask the server again', run: () => showStatus() });
    if (s.CanSetKeys) {
        items.push({ label: '$(key) Give the server an API key…', run: () => setKey(s) });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: now ? `The assistant uses ${now.backend.Label} (${modelLabel(now.backend.Name, now.model)}). Pick one to change it.` : 'No backend is ready yet.' });
    if (pick && pick.run) {
        await pick.run();
    }
}

async function backendMenu(s: AssistantStatus, name: string) {
    const b = (s.Backends || []).find(x => x.Name === name);
    if (!b) return;
    type Item = vscode.QuickPickItem & { run: () => Promise<void> };
    const items: Item[] = [];
    if (b.Ready) {
        for (const m of b.Models) {
            items.push({
                label: `Use ${b.Label}: ${modelLabel(b.Name, m)}`, description: whereSay(whereOf(b, m), b.Name).short,
                run: async () => {
                    await context.globalState.update(BACKEND_KEY, b.Name);
                    await context.globalState.update(MODEL_KEY, m);
                    await AssistantPanel.refresh();
                    vscode.window.setStatusBarMessage(`The assistant now uses ${b.Label} (${modelLabel(b.Name, m)})`, 3000);
                },
            });
        }
        if (s.CanSetKeys) {
            for (const m of b.Models) {
                items.push({
                    label: `Make ${modelLabel(b.Name, m)} the server's default`, description: 'for every client',
                    run: async () => {
                        const r = await ODb.apiPost<{ Ok: boolean; Msg?: string }>('/assistant/default', { Backend: b.Name, Model: m });
                        report(r, `${b.Label} is the server's default now.`);
                        await AssistantPanel.refresh();
                    },
                });
            }
        }
    } else {
        items.push({ label: `$(info) ${b.Msg || 'Not ready'}`, detail: SETUP[b.Name], run: async () => { /* only says */ } });
    }
    if (KEY_PAGES[b.Name]) {
        items.push({ label: `$(link-external) Get a key from ${KEY_PAGES[b.Name].where}`, detail: KEY_BILLING[b.Name],
            run: async () => { vscode.env.openExternal(vscode.Uri.parse(KEY_PAGES[b.Name].url)); } });
        if (s.CanSetKeys) {
            items.push({ label: `$(key) Give the server a key for ${b.Label}…`, run: () => setKey(s, b.Name) });
            if (b.Ready && b.Source === 'worg') {
                items.push({ label: `$(trash) Remove the key given for ${b.Label}`, run: async () => {
                    const r = await ODb.apiPost<{ Ok: boolean; Msg?: string }>('/assistant/key', { Backend: b.Name, Key: '', Remove: true });
                    report(r, 'Removed.');
                    cached = undefined;
                    await AssistantPanel.refresh();
                } });
            }
        }
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `${b.Label}: ${whereSay(whereOf(b, b.Model), b.Name).long}` });
    if (pick) {
        await pick.run();
    }
}

// The key goes to the server, which tries it and keeps it in its keyring;
// it is never written anywhere here.
async function setKey(s: AssistantStatus, name?: string) {
    if (!s.CanSetKeys) {
        vscode.window.showWarningMessage('Only an administrator of this orgs server can give it keys.');
        return;
    }
    if (!name) {
        const pick = await vscode.window.showQuickPick((s.Backends || []).filter(b => KEY_PAGES[b.Name]).map(b => ({ label: b.Label, name: b.Name, description: b.Ready ? 'has a key' : '' })),
            { placeHolder: 'A key for which service?' });
        if (!pick) return;
        name = pick.name;
    }
    const page = KEY_PAGES[name];
    const key = await vscode.window.showInputBox({
        prompt: `An API key from ${page ? page.where : 'the service'}. ${KEY_BILLING[name] || ''}`,
        placeHolder: page ? page.looks : '',
        password: true, ignoreFocusOut: true,
    });
    if (!key || !key.trim()) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Trying the key…' },
        () => ODb.apiPost<{ Ok: boolean; Msg?: string }>('/assistant/key', { Backend: name, Key: key.trim(), Remove: false }));
    report(r, 'The key works and the server has kept it.');
    cached = undefined;
    if (r && r.Ok) {
        await context.globalState.update(BACKEND_KEY, name);
        await context.globalState.update(MODEL_KEY, '');
    }
    await AssistantPanel.refresh();
}

function report(r: { Ok: boolean; Msg?: string } | undefined, ok: string) {
    if (r && r.Ok) {
        vscode.window.showInformationMessage(r.Msg || ok);
    } else {
        vscode.window.showErrorMessage((r && r.Msg) || 'No answer from the server.');
    }
}

export function activateAssistant(ctx: vscode.ExtensionContext) {
    context = ctx;
    ctx.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(EDIT_SCHEME, new ProposalContent()),
        vscode.commands.registerCommand('org.askAssistant', askAssistant),
        vscode.commands.registerCommand('org.askAssistantSelection', askAboutSelection),
        vscode.commands.registerCommand('org.summarizeSubtree', summarizeSubtree),
        vscode.commands.registerCommand('org.askAssistantView', askAboutView),
        vscode.commands.registerCommand('org.assistantUndo', assistantUndo),
        vscode.commands.registerCommand('org.assistantStatus', showStatus),
    );
}
