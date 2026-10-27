// Keeping what the extension shows in step with the server, from its event
// stream (events.ts): when an org file is re-read - saved here, in worg, in
// Emacs, or rewritten by the server itself - the agenda and clock views load
// again (while they show), and an open, unmodified editor of that file is made
// to read the disk now rather than whenever VS Code next looks. When a clock
// starts or stops anywhere, the status bar's clock is asked again.
//
// The views keep their own timers; this only makes them prompt.
import * as vscode from 'vscode';
import * as fs from 'fs';
import { onOrgsEvent, OrgsEvent } from './events';
import { settled } from './org-files';
import { refreshClock } from './time';
import * as agendaView from './agenda-view';
import * as clockView from './clock-view';

// A save can be a burst of reloads (one per file the server re-reads): wait
// for it to finish before redrawing.
const SETTLE_MS = 400;

let timer: NodeJS.Timeout | undefined;
let files = new Set<string>();
let views = false;
let clock = false;

function schedule() {
    if (timer) {
        clearTimeout(timer);
    }
    timer = setTimeout(flush, SETTLE_MS);
}

async function flush() {
    timer = undefined;
    const reloaded = Array.from(files);
    const doViews = views;
    const doClock = clock;
    files = new Set();
    views = clock = false;

    if (doViews) {
        const at = agendaView.agendaTree, av = agendaView.agendaTreeView;
        if (at && av && av.visible) {
            at.load();
        }
        const ct = clockView.clockTree, cv = clockView.clockTreeView;
        if (ct && cv && cv.visible) {
            ct.load();
        }
    }
    if (doClock) {
        refreshClock();
    }
    if (reloaded.length) {
        await reloadEditors(reloaded);
    }
}

// VS Code reloads an unmodified document whose file changed in its own time,
// usually within moments. Give it those moments; then, if the copy in the
// active editor still disagrees with the disk, revert it - which for an
// unmodified copy is just reading the disk. Only the active editor's, because
// the revert command acts on the active editor whatever it is handed, and
// never a modified copy: that would throw away the typing.
async function reloadEditors(reloaded: string[]) {
    const open = vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file' && reloaded.indexOf(d.uri.fsPath) >= 0);
    if (!open.length) {
        return;
    }
    await settled(reloaded);
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    for (const d of open) {
        if (d.isClosed || d.isDirty || !fs.existsSync(d.uri.fsPath)) {
            continue;
        }
        let disk: string;
        try {
            disk = fs.readFileSync(d.uri.fsPath, 'utf8');
        } catch (e) {
            continue;
        }
        const active = vscode.window.activeTextEditor;
        if (norm(d.getText()) !== norm(disk) && !d.isDirty && active && active.document === d) {
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
    }
}

function onEvent(ev: OrgsEvent) {
    switch (ev.kind) {
        case 'reload':
            if (ev.data && ev.data.file) {
                files.add(ev.data.file);
            }
            views = true;
            // A clock line written by hand moves the clock too.
            clock = true;
            break;
        case 'clockin':
        case 'clockout':
            views = true;
            clock = true;
            break;
        case 'hello':
            // (Back) up: catch up on whatever happened while it was down.
            views = true;
            clock = true;
            break;
        default:
            return;
    }
    schedule();
}

export function activateLiveRefresh(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
        onOrgsEvent(['reload', 'clockin', 'clockout'], onEvent),
        { dispose: () => timer && clearTimeout(timer) },
    );
}
