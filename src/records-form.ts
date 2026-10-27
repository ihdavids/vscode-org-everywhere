// The form a record is edited in, or a new one written: a webview with the
// record's name, one input per field (what /records/fields says the
// collection's records use, typed by kind), rows for fields nobody has used
// yet, and the notes. Saving checks the form (records-model.ts' validateForm),
// then POSTs /record/update with only what changed - or /record for a new one
// - and waits for the editor to reload the file the server wrote.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ODb } from './db';
import { Sets } from './sets';
import { settled } from './org-files';
import {
    OrgRecord, RecordCollection, RecordFieldUse, FormField, FormValues,
    formFields, inputType, validateForm, updateRequest, newRequest, collectionLabel, recordLabel,
} from './records-model';

type Done = (saved?: OrgRecord) => void;

function nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) {
        s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
}

function esc(s: string): string {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The file the server wrote, as this machine has it - without asking anybody,
// since this is only for waiting on the reload.
function localFile(filename: string): string | undefined {
    const name = (filename || '').replace(/\\/g, '/');
    if (name && fs.existsSync(name)) {
        return name;
    }
    const map = Sets.serverPathMap || {};
    for (const from of Object.keys(map)) {
        const f = from.replace(/\\/g, '/');
        if (name.startsWith(f)) {
            const mapped = path.join(map[from], name.substring(f.length));
            if (fs.existsSync(mapped)) {
                return mapped;
            }
        }
    }
    return undefined;
}

async function fieldsOf(type: string): Promise<RecordFieldUse[]> {
    const uses = await ODb.api<RecordFieldUse[]>('/records/fields', { type }).catch(() => undefined);
    return Array.isArray(uses) ? uses : [];
}

export class RecordForm {
    private static open = new Map<string, RecordForm>();

    private panel: vscode.WebviewPanel;
    private fields: FormField[] = [];
    private saving = false;

    // Edit the record that heading is.
    public static async edit(hash: string, done: Done) {
        const key = 'edit:' + hash;
        const open = RecordForm.open.get(key);
        if (open) {
            open.panel.reveal();
            return;
        }
        const rec = await ODb.api<OrgRecord & { Ok?: boolean, Msg?: string }>('/record/' + ODb.pathHash(hash)).catch(() => undefined);
        if (!rec || !rec.Hash) {
            vscode.window.showWarningMessage('Could not read the record: ' + ((rec && rec.Msg) || 'the orgs server did not answer'));
            return;
        }
        const uses = await fieldsOf(rec.Type);
        if (!RecordForm.open.has(key)) {
            RecordForm.open.set(key, new RecordForm(key, rec.Type, rec, undefined, uses, done));
        }
    }

    // A new record in a collection.
    public static async create(c: RecordCollection, done: Done) {
        const key = 'new:' + c.Type;
        const open = RecordForm.open.get(key);
        if (open) {
            open.panel.reveal();
            return;
        }
        const uses = await fieldsOf(c.Type);
        if (!RecordForm.open.has(key)) {
            RecordForm.open.set(key, new RecordForm(key, c.Type, undefined, c, uses, done));
        }
    }

    private constructor(private key: string, private type: string, private rec: OrgRecord | undefined,
        private collection: RecordCollection | undefined, uses: RecordFieldUse[], private done: Done) {
        this.fields = formFields(uses, rec, (collection && collection.Fields) || []);
        const title = rec ? `Edit ${recordLabel(rec)}` : `New in ${collection ? collectionLabel(collection) : type}`;
        this.panel = vscode.window.createWebviewPanel('orgRecordForm', title, vscode.ViewColumn.Active, { enableScripts: true });
        this.panel.webview.html = this.html();
        this.panel.webview.onDidReceiveMessage(m => this.receive(m));
        this.panel.onDidDispose(() => RecordForm.open.delete(this.key));
    }

    private kinds(): { [key: string]: string } {
        const k: { [key: string]: string } = {};
        this.fields.forEach(f => k[f.key] = f.kind);
        return k;
    }

    private async receive(m: any) {
        if (!m || m.type === 'cancel') {
            this.panel.dispose();
            return;
        }
        if (m.type !== 'save' || this.saving) {
            return;
        }
        const v: FormValues = { name: String(m.name || ''), notes: typeof m.notes === 'string' ? m.notes : undefined,
            fields: m.fields || {}, extra: Array.isArray(m.extra) ? m.extra : [] };
        const errs = validateForm(v, this.kinds());
        if (Object.keys(errs).length) {
            this.panel.webview.postMessage({ type: 'errors', errs });
            return;
        }
        this.saving = true;
        try {
            if (this.rec) {
                const req = updateRequest(this.rec, v);
                if (!req) {
                    this.panel.dispose();
                    return;
                }
                const res = await ODb.apiPost<{ Ok: boolean, Msg?: string }>('/record/update', req).catch(e => ({ Ok: false, Msg: e.message }));
                if (!res || !res.Ok) {
                    this.panel.webview.postMessage({ type: 'errors', errs: { _: (res && res.Msg) || 'The orgs server did not answer.' } });
                    return;
                }
                const f = localFile(this.rec.Filename);
                if (f) {
                    await settled([f]);
                }
                this.panel.dispose();
                this.done(this.rec);
            } else {
                const res = await ODb.apiPost<OrgRecord & { Ok?: boolean, Msg?: string }>('/record', newRequest(this.type, v))
                    .catch(e => ({ Ok: false, Msg: e.message } as any));
                // A new record comes back without its hash; a failure is {Ok: false, Msg}.
                if (!res || res.Ok === false || !(res.Filename || res.Name)) {
                    this.panel.webview.postMessage({ type: 'errors', errs: { _: (res && res.Msg) || 'The orgs server did not answer.' } });
                    return;
                }
                const f = localFile(res.Filename);
                if (f) {
                    await settled([f]);
                }
                this.panel.dispose();
                this.done(res);
            }
        } finally {
            this.saving = false;
        }
    }

    private input(f: FormField): string {
        const id = 'f_' + f.key;
        const t = inputType(f.kind);
        const control = t === 'textarea'
            ? `<textarea id="${id}" data-key="${esc(f.key)}" rows="3">${esc(f.value)}</textarea>`
            : `<input id="${id}" data-key="${esc(f.key)}" type="${t}" value="${esc(f.value)}"${f.kind === 'date' ? ' placeholder="2026-05-15 or --05-15"' : ''}>`;
        return `<label for="${id}">${esc(f.label)} <span class="key">${esc(f.key)}</span></label>${control}<div class="err" data-for="${esc(f.key)}"></div>`;
    }

    private html(): string {
        const n = nonce();
        const rec = this.rec;
        const heading = rec ? `Edit ${esc(recordLabel(rec))}` : `New record in ${esc(this.collection ? collectionLabel(this.collection) : this.type)}`;
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px 20px; max-width: 640px; }
  label { display: block; margin-top: 10px; font-weight: 600; }
  .key { font-weight: normal; opacity: 0.6; font-family: var(--vscode-editor-font-family); font-size: 0.85em; margin-left: 4px; }
  input, textarea { width: 100%; box-sizing: border-box; margin-top: 3px; padding: 4px 6px; font-family: inherit;
                    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                    border: 1px solid var(--vscode-input-border, transparent); }
  input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .extra { display: flex; gap: 6px; }
  .extra input:first-child { flex: 0 0 35%; font-family: var(--vscode-editor-font-family); text-transform: uppercase; }
  .err { color: var(--vscode-errorForeground); font-size: 0.9em; min-height: 0; }
  .bad { border-color: var(--vscode-inputValidation-errorBorder, red) !important; }
  .buttons { margin-top: 18px; display: flex; gap: 8px; }
  button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 6px 14px; cursor: pointer; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  h2 { margin-bottom: 4px; }
  .where { opacity: 0.7; font-size: 0.9em; }
</style>
</head>
<body>
<h2>${heading}</h2>
<div class="where">${rec ? esc(vscode.workspace.asRelativePath(rec.Filename)) + ':' + (rec.LineNum + 1) : 'RECORD: ' + esc(this.type)}</div>
<div class="err" data-for="_"></div>
<label for="name">Name</label><input id="name" value="${esc(rec ? rec.Name : '')}"><div class="err" data-for="name"></div>
${this.fields.map(f => this.input(f)).join('\n')}
<label>Another field</label>
<div id="extras"></div>
<button class="secondary" id="more" type="button">Add a field</button>
<label for="notes">Notes</label><textarea id="notes" rows="6">${esc(rec ? rec.Notes || '' : '')}</textarea>
<div class="buttons"><button id="save">Save</button><button class="secondary" id="cancel">Cancel</button></div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const extras = document.getElementById('extras');
  function addExtra() {
    const i = extras.children.length;
    const row = document.createElement('div');
    row.innerHTML = '<div class="extra"><input placeholder="FIELD_NAME"><input placeholder="value"></div><div class="err" data-for="extra:' + i + '"></div>';
    extras.appendChild(row);
    return row;
  }
  addExtra();
  document.getElementById('more').addEventListener('click', () => addExtra().querySelector('input').focus());
  function collect() {
    const fields = {};
    document.querySelectorAll('[data-key]').forEach(el => { fields[el.dataset.key] = el.value; });
    const extra = Array.from(extras.querySelectorAll('.extra')).map(r => {
      const [k, v] = r.querySelectorAll('input');
      return { key: k.value, value: v.value };
    });
    return { type: 'save', name: document.getElementById('name').value, notes: document.getElementById('notes').value, fields, extra };
  }
  function save() { vscode.postMessage(collect()); }
  document.getElementById('save').addEventListener('click', save);
  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  });
  window.addEventListener('message', e => {
    const m = e.data;
    if (!m || m.type !== 'errors') return;
    document.querySelectorAll('.err').forEach(el => { el.textContent = ''; });
    document.querySelectorAll('.bad').forEach(el => el.classList.remove('bad'));
    let first = null;
    Object.keys(m.errs).forEach(k => {
      const el = document.querySelector('.err[data-for="' + CSS.escape(k) + '"]');
      if (el) el.textContent = m.errs[k];
      const input = k === 'name' ? document.getElementById('name') : k.startsWith('extra:') ? extras.children[+k.slice(6)]?.querySelector('input') : document.querySelector('[data-key="' + CSS.escape(k) + '"]');
      if (input) { input.classList.add('bad'); first = first || input; }
    });
    if (first) first.focus();
  });
  document.getElementById('name').focus();
</script>
</body>
</html>`;
    }
}
