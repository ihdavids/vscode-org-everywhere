// The Records panel in the Org side bar: the orgs server's record collections
// (contacts, equipment, anything a heading with a RECORD property stands for)
// and the records in each, with the birthdays and anniversaries coming up on
// top. Click a record to go to its heading; Edit Record… and New Record… open
// a form (records-form.ts). Worg's Collections and Contacts tabs are the same
// data in a browser.
//
// Collections come from /records/collections, a collection's records from
// /records?type= when it is first opened, birthdays from /records/birthdays.
// All of it is asked again when the server says files changed (`reload`).

import * as vscode from 'vscode';
import { ODb } from './db';
import { Auth } from './auth';
import { openAt } from './org-files';
import { localPath } from './worg';
import { onOrgsEvent } from './events';
import { RecordForm } from './records-form';
import {
    OrgRecord, RecordCollection, BirthdayEvent,
    collectionLabel, recordLabel, recordDescription, recordTooltip, sortRecords,
    birthdayLabel, birthdayDescription, upcoming, isoDay,
} from './records-model';

type Node = CollectionItem | RecordItem | BirthdaySection | BirthdayItem | NoteItem;

class NoteItem extends vscode.TreeItem {
    constructor(text: string, icon: string) {
        super(text, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
    }
}

class CollectionItem extends vscode.TreeItem {
    constructor(public collection: RecordCollection) {
        super(collectionLabel(collection), collection.Count ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.id = 'records-collection:' + collection.Type;
        this.description = `${collection.Count}`;
        this.tooltip = `${collection.Name || collection.Type} (RECORD: ${collection.Type})` +
            (collection.Filename ? `\n${vscode.workspace.asRelativePath(collection.Filename)}` : '');
        this.iconPath = collection.Icon ? undefined : new vscode.ThemeIcon('library');
        this.contextValue = 'recordCollection';
    }
}

class RecordItem extends vscode.TreeItem {
    constructor(public record: OrgRecord, keys: string[]) {
        super(recordLabel(record), vscode.TreeItemCollapsibleState.None);
        this.id = 'record:' + record.Hash;
        this.description = recordDescription(record, keys);
        this.tooltip = recordTooltip(record) + `\n${vscode.workspace.asRelativePath(record.Filename)}:${record.LineNum + 1}`;
        this.iconPath = new vscode.ThemeIcon(record.Type === 'contact' ? 'person' : 'symbol-field');
        this.contextValue = 'record';
        this.command = { command: 'org.records.open', title: 'Go to the record', arguments: [record.Filename, record.LineNum, record.Name] };
    }
}

class BirthdaySection extends vscode.TreeItem {
    constructor(public events: BirthdayEvent[], days: number) {
        super('Coming up', vscode.TreeItemCollapsibleState.Expanded);
        this.id = 'records-birthdays';
        this.description = `next ${days} days · ${events.length}`;
        this.iconPath = new vscode.ThemeIcon('calendar');
        this.contextValue = 'recordBirthdays';
    }
}

class BirthdayItem extends vscode.TreeItem {
    constructor(public event: BirthdayEvent, today: string) {
        super(birthdayLabel(event), vscode.TreeItemCollapsibleState.None);
        this.id = `record-birthday:${event.Hash}:${event.Field}:${event.Date}`;
        this.description = birthdayDescription(event, today);
        this.tooltip = `${event.Field.toLowerCase()}: ${event.Birthday}`;
        this.iconPath = new vscode.ThemeIcon((event.Field || '').toUpperCase() === 'ANNIVERSARY' ? 'heart' : 'gift');
        this.contextValue = 'record';
        this.command = { command: 'org.records.open', title: 'Go to the record', arguments: [event.Filename, event.LineNum, event.Name] };
    }
}

// The line the record's heading is on now, when unsaved edits or a stale
// server have moved it: the given line if it is the heading, else the nearest
// heading line naming the record.
function nearestHeading(doc: vscode.TextDocument, line: number, name: string): number {
    const at = Math.max(0, Math.min(line, doc.lineCount - 1));
    const isIt = (i: number) => {
        const t = doc.lineAt(i).text;
        return /^\*+\s/.test(t) && (!name || t.indexOf(name) >= 0);
    };
    if (isIt(at)) {
        return at;
    }
    for (let d = 1; d < doc.lineCount; d++) {
        if (at - d >= 0 && isIt(at - d)) { return at - d; }
        if (at + d < doc.lineCount && isIt(at + d)) { return at + d; }
        if (at - d < 0 && at + d >= doc.lineCount) { break; }
    }
    return at;
}

export async function openRecordAt(filename: string, line: number, name?: string) {
    const file = await localPath(filename);
    if (!file) {
        vscode.window.showWarningMessage(`Could not find ${filename} on this machine. Set org.serverPathMap if the server keeps its files elsewhere.`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await openAt(file, nearestHeading(doc, line || 0, name || ''), 0);
}

function birthdayDays(): number {
    const n = vscode.workspace.getConfiguration('org').get<number>('recordsBirthdayDays', 30);
    return typeof n === 'number' && n >= 0 ? n : 30;
}

class RecordsTree implements vscode.TreeDataProvider<Node> {
    private changed = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    view: vscode.TreeView<Node> | undefined;
    private collections: RecordCollection[] | undefined;
    private records = new Map<string, OrgRecord[]>();
    private birthdays: BirthdayEvent[] = [];
    private status = '';
    private loading: Promise<void> | undefined;
    private ticket = 0;

    getTreeItem(n: Node): vscode.TreeItem {
        return n;
    }

    async getChildren(n?: Node): Promise<Node[]> {
        if (n instanceof BirthdaySection) {
            const today = isoDay(new Date());
            return n.events.map(e => new BirthdayItem(e, today));
        }
        if (n instanceof CollectionItem) {
            const recs = await this.recordsOf(n.collection.Type);
            if (!recs) {
                return [new NoteItem('The orgs server did not answer', 'warning')];
            }
            const keys = n.collection.Fields || [];
            return sortRecords(recs).map(r => new RecordItem(r, keys));
        }
        if (n) {
            return [];
        }
        if (!this.collections) {
            await this.load();
            if (!this.collections) {
                return [];   // refreshed while asking: the tree asks again
            }
        }
        if (this.status) {
            return [new NoteItem(this.status, 'info')];
        }
        const out: Node[] = [];
        const days = birthdayDays();
        const soon = days > 0 ? upcoming(this.birthdays, isoDay(new Date()), days) : [];
        if (soon.length) {
            out.push(new BirthdaySection(soon, days));
        }
        const cs = [...(this.collections || [])].sort((a, b) => collectionLabel(a).localeCompare(collectionLabel(b)));
        cs.forEach(c => out.push(new CollectionItem(c)));
        if (!cs.length) {
            out.push(new NoteItem('No records yet: give a heading a RECORD property', 'info'));
        }
        return out;
    }

    private async recordsOf(type: string): Promise<OrgRecord[] | undefined> {
        if (!this.records.has(type)) {
            const recs = await ODb.api<OrgRecord[]>('/records', { type }).catch(() => undefined);
            if (!Array.isArray(recs)) {
                return undefined;
            }
            this.records.set(type, recs);
        }
        return this.records.get(type);
    }

    private load(): Promise<void> {
        if (!this.loading) {
            const p: Promise<void> = this.fetch().finally(() => {
                if (this.loading === p) {
                    this.loading = undefined;
                }
            });
            this.loading = p;
        }
        return this.loading;
    }

    private async fetch() {
        const ticket = ++this.ticket;
        if (!Auth.get().isLoggedIn()) {
            this.collections = [];
            this.status = 'Connect to an orgs server to see records';
            return;
        }
        const [cs, bs] = await Promise.all([
            ODb.api<RecordCollection[]>('/records/collections').catch(() => undefined),
            ODb.api<BirthdayEvent[]>('/records/birthdays').catch(() => undefined),
        ]);
        if (ticket !== this.ticket) {
            return;
        }
        this.collections = Array.isArray(cs) ? cs : [];
        this.birthdays = Array.isArray(bs) ? bs : [];
        this.status = Array.isArray(cs) ? '' : 'The orgs server did not answer';
    }

    refresh() {
        this.collections = undefined;
        this.records.clear();
        // An answer still on its way is for before the change.
        this.ticket++;
        this.loading = undefined;
        this.changed.fire(undefined);
    }

    async allCollections(): Promise<RecordCollection[]> {
        if (!this.collections) {
            await this.load();
        }
        return this.collections || [];
    }
}

export function activateRecordsView(context: vscode.ExtensionContext) {
    const tree = new RecordsTree();
    const view = vscode.window.createTreeView('orgRecords', { treeDataProvider: tree, showCollapseAll: true });
    tree.view = view;
    let pending: NodeJS.Timeout | undefined;
    const soon = () => {
        if (pending) {
            clearTimeout(pending);
        }
        pending = setTimeout(() => tree.refresh(), 800);
    };
    const pickCollection = async (): Promise<RecordCollection | undefined> => {
        const cs = await tree.allCollections();
        if (!cs.length) {
            vscode.window.showInformationMessage('The orgs server has no record collections yet.');
            return undefined;
        }
        const pick = await vscode.window.showQuickPick(cs.map(c => ({ label: collectionLabel(c), description: c.Type, c })),
            { placeHolder: 'A new record in which collection?' });
        return pick && pick.c;
    };
    context.subscriptions.push(
        view,
        onOrgsEvent(['reload'], soon),
        Auth.get().onTokenChanged(() => tree.refresh()),
        vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('org.recordsBirthdayDays') && tree.refresh()),
        vscode.commands.registerCommand('org.records.refresh', () => tree.refresh()),
        vscode.commands.registerCommand('org.records.open', (file: string, line: number, name?: string) => openRecordAt(file, line, name)),
        vscode.commands.registerCommand('org.records.edit', (item?: RecordItem | BirthdayItem) => {
            const hash = item instanceof RecordItem ? item.record.Hash : item instanceof BirthdayItem ? item.event.Hash : undefined;
            if (!hash) {
                vscode.window.showInformationMessage('Pick a record in the Records view to edit it.');
                return;
            }
            RecordForm.edit(hash, () => tree.refresh());
        }),
        vscode.commands.registerCommand('org.records.new', async (item?: CollectionItem) => {
            const c = item instanceof CollectionItem ? item.collection : await pickCollection();
            if (c) {
                RecordForm.create(c, rec => {
                    tree.refresh();
                    if (rec) {
                        openRecordAt(rec.Filename, rec.LineNum, rec.Name);
                    }
                });
            }
        }),
    );
}
