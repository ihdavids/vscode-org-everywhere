// The assistant's model, ported from worg (src/assistant.ts and
// src/viewassistant.ts; server internal/app/orgs/assistant.go and
// assistantview.go). No vscode here: tested by test/assistant.test.ts.
//
// - What it sees is the writer's choice and nothing more: the selection, the
//   subtree the cursor is in, or the whole file. Only that text goes in the
//   request; a selection rides along only when it lies inside what was chosen.
// - Replies stream back as newline-delimited JSON (NdjsonLines). A backend
//   with tools may also send edits to the open file, placed with placeEdit.

import { headingAt, subtreeEnd, olpOf, findOlp, COMMON_KEYWORDS } from './outline/model';

export type KeySource = 'worg' | 'orgs.yaml' | 'environment' | 'profile' | 'subscription' | 'token' | 'api' | 'local' | '';
// Where the server sends what the assistant sees, from the url it really uses.
export type Where = 'machine' | 'network' | 'cloud';
export type AssistantBackendStatus = {
    Name: string; Label: string; Model: string; Models: string[]; Ready: boolean; Msg?: string; Source?: KeySource; Tools?: boolean;
    Where?: Where; ModelWhere?: Record<string, Where>;
    Views?: boolean; ViewTools?: boolean;
};
export type AssistantStatus = { Ok: boolean; Off?: boolean; Default?: string; Backends?: AssistantBackendStatus[]; CanSetKeys?: boolean; Msg?: string };

export type AssistantMsg = { Role: 'user' | 'assistant'; Text: string };
export type AssistantScope = 'section' | 'file' | 'none';
export type AssistantView = {
    Kind: 'columns' | 'gantt' | 'kanban' | 'search';
    Title?: string; Query?: string; File?: string; Columns?: string[]; About?: string;
    Edit: boolean; Selected?: string[];
};
export type AssistantRequest = {
    Backend: string; Model: string; Messages: AssistantMsg[];
    File: string; Title: string; Scope: AssistantScope; Context: string; Section: string; Selection: string;
    Others: string[];
    Doc?: string; Edit?: string[];
    NumCtx?: number;
    View?: AssistantView;
};
// undo: a view turn that changed headings, for POST /assistant/undo.
export type AssistantEnd = { done: boolean; error?: string; model?: string; stop?: string; undo?: string };
// UTF-16 positions in the text as the assistant last saw it, all against the
// same text - which is what vscode's positionAt counts in too.
export type AssistantChange = { from: number; to: number; insert: string };
export type AssistantEdit = { file: string; old: string; changes: AssistantChange[] };
export type AssistantEvent =
    | { tool: string; wrote?: string; warn?: boolean }
    | { edit: AssistantEdit }
    | { query: string; why?: string; count?: number }
    | { wrote: string };

// Where each service hands out keys, for the key helper.
export const KEY_PAGES: Record<string, { url: string; where: string; looks: string }> = {
    claude: { url: 'https://console.anthropic.com/settings/keys', where: 'the Claude Console', looks: 'sk-ant-…' },
    chatgpt: { url: 'https://platform.openai.com/api-keys', where: 'the OpenAI platform', looks: 'sk-…' },
    gemini: { url: 'https://aistudio.google.com/apikey', where: 'Google AI Studio', looks: 'AIza…' },
};

// What an API key is paid with, said before anyone pastes one in.
export const KEY_BILLING: Record<string, string> = {
    claude: 'API keys use prepaid API credits from the Claude Console, separate from a Claude Pro or Max subscription.',
    chatgpt: 'API keys use OpenAI platform credits, separate from a ChatGPT Plus subscription.',
    gemini: 'Gemini keys from AI Studio have a free tier; heavier use is billed to a Google Cloud account.',
};

export const SOURCE_SAY: Record<KeySource, string> = {
    worg: 'set from a client', 'orgs.yaml': 'from orgs.yaml', environment: 'from the server’s environment', profile: 'from ant auth login',
    subscription: 'your Claude subscription', token: 'a claude setup-token', api: 'Claude Code’s API key', local: 'on the server', '': '',
};

// Backends with no key to paste, and how each is set up on the server.
export const SETUP: Record<string, string> = {
    local: 'Runs a model on the server’s own machine through llama.cpp, LM Studio or MLX. Turn it on with assistant: local: enabled: true in orgs.yaml and pick a model in worg’s Local runtimes.',
    ollama: 'Runs a model on the server’s own machine through Ollama. Turn it on with assistant: ollama: enabled: true in orgs.yaml, then add models from worg’s Local models.',
    claudecode: 'Uses the claude command on the server’s machine, signed in with a Claude subscription. Run claude login there as the user orgs runs as, and turn it on with assistant: claudecode: enabled: true in orgs.yaml.',
};

// Splits a stream of newline-delimited JSON into objects as the pieces come
// in, keeping a line cut in two until the rest arrives.
export class NdjsonLines {
    private rest = '';
    push(chunk: string, end = false): any[] {
        this.rest += chunk;
        const parts = this.rest.split('\n');
        this.rest = end ? '' : parts.pop() || '';
        const out: any[] = [];
        for (const line of parts) {
            const t = line.trim();
            if (!t) continue;
            try { out.push(JSON.parse(t)); } catch { /* a torn or foreign line */ }
        }
        return out;
    }
}

export type QuickAction = { id: string; label: string; needs: 'selection' | 'text' | 'none'; prompt: string; insert: boolean };

// `insert`: the answer is text for the document (offered to replace the
// selection or go in at the cursor) rather than a reply to read.
export const QUICK_ACTIONS: QuickAction[] = [
    { id: 'continue', label: 'Continue', needs: 'text', insert: true,
        prompt: 'Continue the text from where my cursor is, a paragraph or two, in the same voice. Give only the new text.' },
    { id: 'rephrase', label: 'Rephrase', needs: 'selection', insert: true,
        prompt: 'Rewrite the selected passage so it reads better, keeping its meaning, voice and length. Give only the rewritten passage.' },
    { id: 'tighten', label: 'Tighten', needs: 'selection', insert: true,
        prompt: 'Tighten the selected passage: cut what is not pulling its weight, keep the voice. Give only the tightened passage.' },
    { id: 'critique', label: 'Critique', needs: 'text', insert: false,
        prompt: 'Give me an honest editor’s critique of this: what works, what does not, and the two or three changes that would help most. Be brief and specific, quoting the words you mean.' },
    { id: 'summarize', label: 'Summarize', needs: 'text', insert: false,
        prompt: 'Summarize this in a short paragraph, then list its main points, open tasks and decisions, if it has any.' },
    { id: 'questions', label: 'Questions', needs: 'text', insert: false,
        prompt: 'What questions would a reader be left asking here? A short list.' },
];

export function actionReady(a: QuickAction, hasSelection: boolean): boolean {
    return a.needs !== 'selection' || hasSelection;
}

// The subtree the cursor is in: its outline path (as the server names
// sections, "Part one/The letter"), its text and its lines [start, end).
// null above the first heading.
export type Section = { path: string; olp: string[]; text: string; start: number; end: number };

export function sectionAt(lines: string[], line: number, keywords: string[] = COMMON_KEYWORDS): Section | null {
    const h = headingAt(lines, line);
    if (h < 0) return null;
    const end = subtreeEnd(lines, h);
    const olp = olpOf(lines, h, keywords);
    return { path: olp.join('/'), olp, text: lines.slice(h, end).join('\n'), start: h, end };
}

// The same section found again by its outline path (the titles, or them
// joined by /), for a follow-up after the file has changed; null when gone.
export function sectionByPath(lines: string[], path: string | string[], keywords: string[] = COMMON_KEYWORDS): Section | null {
    const h = findOlp(lines, Array.isArray(path) ? path : path.split('/'), keywords);
    return h < 0 ? null : sectionAt(lines, h, keywords);
}

// An answer meant for the document, without what models wrap such answers
// in anyway: a code fence, or quotation marks round the whole of it.
export function forManuscript(text: string): string {
    let t = text.trim();
    const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
    if (fence) t = fence[1];
    const q = /^["“]([\s\S]*)["”]$/.exec(t);
    if (q && !/["“”]/.test(q[1])) t = q[1];
    return t;
}

// An edit the assistant made to the open file, applied to the text as it is
// now: where it said, if the text there is still what it replaced; else
// wherever that text is now, if only once (the writer typed meanwhile), or
// everywhere for a replace-all. null when it cannot be placed.
export function placeEdit(doc: string, e: { old: string; changes: AssistantChange[] }): AssistantChange[] | null {
    if (!e.changes.length || !e.old) return null;
    if (e.changes.every(c => doc.slice(c.from, c.to) === e.old)) return e.changes;
    const at: number[] = [];
    for (let i = doc.indexOf(e.old); i >= 0; i = doc.indexOf(e.old, i + e.old.length)) at.push(i);
    const insert = e.changes[0].insert;
    if (e.changes.length > 1 ? at.length === 0 : at.length !== 1) return null;
    return at.map(i => ({ from: i, to: i + e.old.length, insert }));
}

// The text with placed changes made, for showing a diff before applying.
export function applyChanges(doc: string, changes: AssistantChange[]): string {
    let out = doc;
    for (const c of changes.slice().sort((a, b) => b.from - a.from)) {
        out = out.slice(0, c.from) + c.insert + out.slice(c.to);
    }
    return out;
}

export function buildRequest(o: {
    backend: string; model: string; messages: AssistantMsg[]; file: string; title: string;
    scope: AssistantScope; doc: string; section: { path: string; text: string } | null; selection: string; others: string[];
    tools?: boolean; edit?: string[];
}): AssistantRequest {
    const scope: AssistantScope = o.scope === 'section' && !o.section ? 'file' : o.scope;
    const others = o.others.filter(f => f !== o.file);
    const tools = o.tools ? {
        Doc: o.doc,
        Edit: (o.edit || []).filter(f => f === o.file || others.includes(f)),
    } : {};
    return {
        Backend: o.backend, Model: o.model, Messages: o.messages,
        File: o.file, Title: o.title, Scope: scope,
        Context: scope === 'file' ? o.doc : scope === 'section' && o.section ? o.section.text : '',
        Section: scope === 'section' && o.section ? o.section.path : '',
        Selection: o.selection,
        Others: others,
        ...tools,
    };
}

// What the writer picks in VS Code: the selection, this heading's subtree,
// or this file.
export type EditorScope = 'selection' | 'section' | 'file';

export const SCOPE_SAY: Record<EditorScope, string> = {
    selection: 'the selection', section: 'this heading’s subtree', file: 'this file',
};

// A request from the editor's state, sending only the chosen scope. The
// selection goes along only when it lies inside what was chosen (all of the
// file, or within the subtree). A backend with tools gets the editor's text
// only when it may edit the file - it needs it to place its edits.
// Throws when the scope cannot be had: no selection, or no heading.
export function editorRequest(o: {
    backend: string; model: string; messages: AssistantMsg[]; file: string; title: string;
    scope: EditorScope; lines: string[];
    selection: { text: string; startLine: number; endLine: number } | null;
    section: Section | null;
    tools?: boolean; allowEdit?: boolean;
}): AssistantRequest {
    const sel = o.selection && o.selection.text.trim() ? o.selection : null;
    if (o.scope === 'selection' && !sel) throw new Error('Select some text first.');
    if (o.scope === 'section' && !o.section) throw new Error('The cursor is above the first heading: there is no subtree to send.');
    const inSection = !!(sel && o.section && sel.startLine >= o.section.start && sel.endLine < o.section.end);
    const selection = !sel ? '' : o.scope === 'section' && !inSection ? '' : sel.text;
    const doc = o.lines.join('\n');
    const editing = !!(o.tools && o.allowEdit);
    const req = buildRequest({
        backend: o.backend, model: o.model, messages: o.messages, file: o.file, title: o.title,
        scope: o.scope === 'selection' ? 'none' : o.scope, doc, section: o.section, selection, others: [],
        tools: editing, edit: editing ? [o.file] : [],
    });
    return req;
}

// A conversation about one of the views (the column view of a file, or the
// results of a query) rather than a file.
export function buildViewRequest(o: {
    backend: string; model: string; messages: AssistantMsg[]; view: Omit<AssistantView, 'Edit'>; edit: boolean; numCtx?: number;
}): AssistantRequest {
    const v: AssistantView = { ...o.view, Edit: o.edit };
    if (v.Kind === 'columns') delete v.Query; else delete v.File;
    if (!v.Selected || v.Selected.length === 0) delete v.Selected;
    const req: AssistantRequest = {
        Backend: o.backend, Model: o.model, Messages: o.messages,
        File: '', Title: '', Scope: 'none', Context: '', Section: '', Selection: '', Others: [],
        View: v,
    };
    if (o.numCtx && o.numCtx > 0) req.NumCtx = o.numCtx;
    return req;
}

// A rough count of what a request sends (a token is about 4 characters).
export function sizeOf(req: AssistantRequest): number {
    const chars = req.Context.length + req.Selection.length + req.Messages.reduce((s, m) => s + m.Text.length, 0);
    return Math.round(chars / 4);
}

// The backend and model to talk to: the preferred one if it is ready, else
// the server's default, else the first ready one. Undefined when none is.
export function pickBackend(s: AssistantStatus | undefined, backend = '', model = '', views = false): { backend: AssistantBackendStatus; model: string } | undefined {
    if (!s || !s.Ok || s.Off) return undefined;
    const ready = (s.Backends || []).filter(b => b.Ready && (!views || b.Views));
    const chosen = ready.find(b => b.Name === backend) || ready.find(b => b.Name === s.Default) || ready[0];
    if (!chosen) return undefined;
    return { backend: chosen, model: chosen.Models.includes(model) ? model : chosen.Model };
}

// Why the assistant cannot be used, in words for the user; '' when it can.
export function unavailable(s: AssistantStatus | undefined): string {
    if (!s) return 'The orgs server did not answer. The assistant runs on the server: check the connection (org.orgsConnection).';
    if (!s.Ok) return s.Msg || 'This orgs server has no assistant (it may be too old).';
    if (s.Off) return 'The assistant is turned off on this server (assistant: backend: off in orgs.yaml).';
    if (!(s.Backends || []).some(b => b.Ready)) return 'No assistant backend is ready on the server: it needs a key for Claude, ChatGPT or Gemini, or a local model.';
    return '';
}

// Where a backend (and for local, a model) sends the text; unknown is cloud,
// the cautious reading.
export function whereOf(b: AssistantBackendStatus | undefined, model?: string): Where {
    if (!b) return 'cloud';
    if (model && b.ModelWhere && b.ModelWhere[model]) return b.ModelWhere[model];
    return b.Where || 'cloud';
}

const SERVICE: Record<string, string> = { claude: 'Anthropic', claudecode: 'Anthropic', chatgpt: 'OpenAI', gemini: 'Google' };

export function whereSay(w: Where, backend?: string): { short: string; long: string } {
    switch (w) {
        case 'machine': return { short: 'On the server’s machine', long: 'Stays on the server’s machine: nothing you write is sent anywhere else.' };
        case 'network': return { short: 'On your network', long: 'Sent to another machine on your network, not to the internet.' };
    }
    const who = backend && SERVICE[backend];
    return { short: who ? `Sent to ${who}` : 'Cloud', long: `What it sees is sent over the internet to ${who ? who + '’s' : 'the service’s'} servers.` };
}

// A local model's name: "Qwen3-8B-Q4_K_M · llama.cpp".
export const RUNTIME_LABEL: Record<string, string> = { llamacpp: 'llama.cpp', lmstudio: 'LM Studio', mlx: 'MLX' };
export function modelLabel(backend: string, model: string): string {
    if (backend !== 'local') return model;
    const i = model.indexOf(':');
    if (i < 0) return model;
    const rt = model.slice(0, i);
    return `${model.slice(i + 1)} · ${RUNTIME_LABEL[rt] || rt}`;
}

// Small models in the views echo the heading ids they were given (h12).
export function stripHeadingIds(text: string): string {
    return text.replace(/(^|[\s(\[*-])h\d{1,4}\b:?\s?/gm, '$1');
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Inline markup on already escaped text: `code`, **bold**, *bold* (org),
// /italic/ (org), _italic_, and links to http(s) only.
function inline(s: string): string {
    const codes: string[] = [];
    let t = s.replace(/`([^`\n]+)`|=([^=\n]+)=|~([^~\n]+)~/g, (_m, a, b, c) => { codes.push(a ?? b ?? c); return `\u0000${codes.length - 1}\u0000`; });
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => `<a href="${url}">${label}</a>`);
    t = t.replace(/\[\[(https?:\/\/[^\]\s]+)\](?:\[([^\]\n]+)\])?\]/g, (_m, url, label) => `<a href="${url}">${label || url}</a>`);
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?]|$)/g, '$1<strong>$2</strong>');
    t = t.replace(/(^|[\s(])\/([^/\s][^/\n]*?)\/(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    return t.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[+i]}</code>`);
}

// A reply as HTML for the chat panel. Everything is escaped first, so the
// model's text can never become markup of its own; only a few constructs
// (Markdown and the org equivalents the server asks for) are drawn.
export function renderMarkdown(text: string): string {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [];
    let list: 'ul' | 'ol' | '' = '';
    let para: string[] = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(l => inline(esc(l))).join('<br>')}</p>`); para = []; } };
    const closeList = () => { if (list) { out.push(`</${list}>`); list = ''; } };
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const fence = /^\s*(```|#\+begin_(?:src|example|quote))\s*([\w-]*)/i.exec(l);
        if (fence) {
            flushPara(); closeList();
            const endRe = fence[1] === '```' ? /^\s*```\s*$/ : /^\s*#\+end_\w+/i;
            const body: string[] = [];
            for (i++; i < lines.length && !endRe.test(lines[i]); i++) body.push(lines[i]);
            out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
            continue;
        }
        // Markdown headings, and org ones (which the server asks for).
        const h = /^(#{1,6}|\*{1,6})\s+(.*)$/.exec(l);
        if (h) { flushPara(); closeList(); const n = Math.min(6, h[1].length + 2); out.push(`<h${n}>${inline(esc(h[2]))}</h${n}>`); continue; }
        const ul = /^\s*[-+•]\s+(.*)$/.exec(l) || /^\s+\*\s+(.*)$/.exec(l);
        const ol = /^\s*\d+[.)]\s+(.*)$/.exec(l);
        if (ul || ol) {
            flushPara();
            const kind = ul ? 'ul' : 'ol';
            if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
            out.push(`<li>${inline(esc((ul || ol)[1]))}</li>`);
            continue;
        }
        if (!l.trim()) { flushPara(); closeList(); continue; }
        closeList();
        para.push(l);
    }
    flushPara(); closeList();
    return out.join('\n');
}
