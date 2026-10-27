// The Mentions panel in the Org side bar: for the heading at the cursor (or
// the file, above the first heading), the links into it and the places it is
// named without a link (orgs' /links/heading and /mentions). Click one to go
// there; the link button on a mention makes it a link (/mentions/link).
//
// It follows the cursor. Going to look at an entry pins the panel, as worg's
// does: opening a mention moves the cursor into some other heading, and a
// panel that then switched to that heading's mentions would lose the list
// being worked through. Follow Cursor lets go again.
//
// Show Backlinks (src/links/providers.ts) finds links by reading the files
// itself; this panel asks the server, which also finds the unlinked mentions
// and knows the line each link is written on.

import * as vscode from 'vscode';
import * as path from 'path';
import { ODb } from './db';
import { Auth } from './auth';
import { openAt, settled, readLines } from './org-files';
import { headingAt } from './outline/model';
import { onOrgsEvent } from './events';
import {
    LinksAround, MentionsResult, Mention, LinkInContext, LinkTarget, MentionLinkResult, Marked,
    mentionLabel, linkLabel, groupByFile, targetLabel, searchedNote, targetParams, linkRequest, linkedNote, changedFiles,
} from './mentions-model';

type Node = Section | FileGroup | MentionItem | LinkItem | NoteItem;

function label(m: Marked): vscode.TreeItemLabel {
    return { label: m.label, highlights: m.highlight ? [m.highlight] : undefined };
}

class NoteItem extends vscode.TreeItem {
    constructor(text: string, icon: string, command?: vscode.Command) {
        super(text, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.command = command;
    }
}

class Section extends vscode.TreeItem {
    constructor(public kind: 'links' | 'mentions', title: string, count: number, public kids: Node[]) {
        super(`${title} (${count})`, count ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(kind === 'links' ? 'references' : 'search');
        this.contextValue = kind === 'mentions' && count ? 'mentionsSection' : 'mentionsHeader';
    }
}

class FileGroup extends vscode.TreeItem {
    constructor(public file: string, public mentions: Mention[]) {
        super(path.basename(file), vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${mentions.length}`;
        this.tooltip = file;
        this.resourceUri = vscode.Uri.file(file);
        this.iconPath = vscode.ThemeIcon.File;
        this.contextValue = 'mentionsFile';
    }
}

// Where a match is in its line, in characters; the server's Col is bytes.
function chOf(file: string, line: number, text: string): number {
    const l = readLines(file)[line] || '';
    const i = l.toLowerCase().indexOf(text.toLowerCase());
    return i < 0 ? 0 : i;
}

class MentionItem extends vscode.TreeItem {
    constructor(public mention: Mention) {
        super(label(mentionLabel(mention)), vscode.TreeItemCollapsibleState.None);
        const where = (mention.Olp && mention.Olp.length ? mention.Olp.join(' › ') : mention.Headline) || path.basename(mention.Filename);
        this.description = `${where} · ${mention.Line + 1}`;
        this.tooltip = new vscode.MarkdownString(`**${mention.Headline || path.basename(mention.Filename)}** - ${vscode.workspace.asRelativePath(mention.Filename)}:${mention.Line + 1}\n\n` +
            `${mention.Before}**${mention.Text}**${mention.After}`);
        this.iconPath = new vscode.ThemeIcon(mention.InHeadline ? 'symbol-class' : 'quote');
        this.contextValue = 'mention';
        this.command = { command: 'org.mentions.open', title: 'Go to the mention', arguments: [mention.Filename, mention.Line, mention.Text] };
    }
}

class LinkItem extends vscode.TreeItem {
    constructor(public link: LinkInContext) {
        super(label(linkLabel(link)), vscode.TreeItemCollapsibleState.None);
        const from = link.From;
        this.description = `${from.Headline || path.basename(from.Filename)} · ${path.basename(from.Filename)}:${from.Line + 1}`;
        this.tooltip = `${vscode.workspace.asRelativePath(from.Filename)}:${from.Line + 1}\n${link.Context || link.Raw}`;
        this.iconPath = new vscode.ThemeIcon(link.Broken ? 'debug-disconnect' : 'arrow-small-left');
        this.contextValue = 'mentionLink';
        if (from.Filename) {
            this.command = { command: 'org.mentions.open', title: 'Go to the link', arguments: [from.Filename, from.Line, link.Shown || link.Desc || ''] };
        }
    }
}

class MentionsTree implements vscode.TreeDataProvider<Node> {
    private changed = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    view: vscode.TreeView<Node> | undefined;
    pinned = false;
    all = false;              // search names made of common words too
    private place: { file: string; line: number } | undefined;
    private asked = '';       // the place the answer below is for
    private target: LinkTarget | undefined;
    private links: LinksAround | undefined;
    private mentions: MentionsResult | undefined;
    private status = '';
    private ticket = 0;

    getTreeItem(n: Node): vscode.TreeItem {
        return n;
    }

    getChildren(n?: Node): Node[] {
        if (n instanceof Section) {
            return n.kids;
        }
        if (n instanceof FileGroup) {
            return n.mentions.map(m => new MentionItem(m));
        }
        if (n) {
            return [];
        }
        if (this.status) {
            return [new NoteItem(this.status, 'info')];
        }
        const out: Node[] = [];
        const ins = (this.links && this.links.Ok && this.links.In) || [];
        out.push(new Section('links', 'Links here', ins.length, ins.map(l => new LinkItem(l))));
        const ms = (this.mentions && this.mentions.Ok && this.mentions.Mentions) || [];
        const kids: Node[] = groupByFile(ms).map(g => new FileGroup(g.file, g.mentions));
        if (this.mentions && this.mentions.Truncated) {
            kids.push(new NoteItem(`${this.mentions.Total - ms.length} more not shown`, 'ellipsis'));
        }
        const t = this.target;
        if (t && (t.Skipped || []).length && !this.all) {
            kids.push(new NoteItem(`Not searched: ${(t.Skipped || []).join('; ')} - search anyway`, 'search-fuzzy',
                { command: 'org.mentions.searchAll', title: 'Search common words too' }));
        }
        const sec = new Section('mentions', 'Unlinked mentions', ms.length, kids);
        if (!ms.length && kids.length) {
            sec.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        }
        out.push(sec);
        return out;
    }

    // The place the cursor is: its file and the heading it is under.
    follow() {
        const ed = vscode.window.activeTextEditor;
        if (this.pinned || !ed || ed.document.languageId !== 'org' || ed.document.uri.scheme !== 'file') {
            return;
        }
        const lines = ed.document.getText().split(/\r?\n/);
        const place = { file: ed.document.fileName, line: headingAt(lines, ed.selection.active.line) };
        if (!this.place || this.place.file !== place.file || this.place.line !== place.line) {
            // Asking for common words too is for one target, not a mode.
            this.all = false;
        }
        this.place = place;
        this.load(false);
    }

    async load(force: boolean) {
        if (!this.view || !this.view.visible || !this.place) {
            return;
        }
        const key = `${this.place.file}:${this.place.line}:${this.all}`;
        if (!force && key === this.asked) {
            return;
        }
        this.asked = key;
        if (!Auth.get().isLoggedIn()) {
            this.status = 'Connect to an orgs server to see mentions';
            this.target = undefined;
            this.show();
            return;
        }
        const ticket = ++this.ticket;
        const p = targetParams(this.place.file, this.place.line, this.all);
        const [links, mentions] = await Promise.all([
            ODb.api<LinksAround>('/links/heading', p).catch(() => undefined),
            ODb.api<MentionsResult>('/mentions', p).catch(() => undefined),
        ]);
        if (ticket !== this.ticket) {
            return;   // the cursor has moved on since
        }
        this.links = links && links.Target ? links : undefined;
        this.mentions = mentions && mentions.Target ? mentions : undefined;
        this.target = (this.links && this.links.Ok && this.links.Target) || (this.mentions && this.mentions.Ok && this.mentions.Target) || undefined;
        const fail = (links && !links.Ok && links.Msg) || (mentions && !mentions.Ok && mentions.Msg) || '';
        this.status = !links && !mentions ? 'The orgs server did not answer' : fail;
        this.show();
    }

    private show() {
        if (this.view) {
            const t = this.target;
            this.view.description = (this.pinned ? 'pinned · ' : '') + (t ? targetLabel(t) : '');
            this.view.message = t ? searchedNote(t) || undefined : undefined;
        }
        this.changed.fire(undefined);
    }

    setPinned(on: boolean) {
        this.pinned = on;
        vscode.commands.executeCommand('setContext', 'org.mentionsPinned', on);
        this.show();
        if (!on) {
            this.follow();
        }
    }

    async link(ms: Mention[]) {
        const t = this.target;
        if (!t || !ms.length) {
            return;
        }
        const res = await ODb.apiPost<MentionLinkResult>('/mentions/link', linkRequest(t, ms)).catch(() => undefined);
        const note = linkedNote(t, res);
        if (res && res.Linked > 0) {
            await settled(changedFiles(t, res));
        }
        if (note.ok) {
            vscode.window.showInformationMessage(note.text);
        } else {
            vscode.window.showWarningMessage(note.text);
        }
        this.load(true);
    }

    allMentions(): Mention[] {
        return (this.mentions && this.mentions.Ok && this.mentions.Mentions) || [];
    }
}

export function activateMentionsView(ctx: vscode.ExtensionContext) {
    const tree = new MentionsTree();
    const view = vscode.window.createTreeView('orgMentions', { treeDataProvider: tree, showCollapseAll: true });
    tree.view = view;
    let pending: NodeJS.Timeout | undefined;
    const soon = (ms: number, fn: () => void) => {
        if (pending) {
            clearTimeout(pending);
        }
        pending = setTimeout(fn, ms);
    };
    vscode.commands.executeCommand('setContext', 'org.mentionsPinned', false);
    ctx.subscriptions.push(
        view,
        vscode.window.onDidChangeTextEditorSelection(() => soon(400, () => tree.follow())),
        vscode.window.onDidChangeActiveTextEditor(() => soon(400, () => tree.follow())),
        view.onDidChangeVisibility(() => view.visible && (tree.follow(), tree.load(false))),
        vscode.workspace.onDidSaveTextDocument(d => d.languageId === 'org' && soon(800, () => tree.load(true))),
        onOrgsEvent(['reload'], () => soon(800, () => tree.load(true))),
        Auth.get().onTokenChanged(() => tree.load(true)),
        vscode.commands.registerCommand('org.mentions.open', async (file: string, line: number, text: string) => {
            if (!tree.pinned) {
                tree.setPinned(true);
            }
            await openAt(file, line, text ? chOf(file, line, text) : 0, true);
        }),
        vscode.commands.registerCommand('org.mentions.link', (item: MentionItem) => item && item.mention && tree.link([item.mention])),
        vscode.commands.registerCommand('org.mentions.linkAll', (item?: Section | FileGroup) => {
            const ms = item instanceof FileGroup ? item.mentions : tree.allMentions();
            return tree.link(ms);
        }),
        vscode.commands.registerCommand('org.mentions.refresh', () => {
            tree.follow();
            return tree.load(true);
        }),
        vscode.commands.registerCommand('org.mentions.pin', () => tree.setPinned(true)),
        vscode.commands.registerCommand('org.mentions.follow', () => tree.setPinned(false)),
        vscode.commands.registerCommand('org.mentions.searchAll', () => {
            tree.all = true;
            return tree.load(true);
        }),
    );
    tree.follow();
}
