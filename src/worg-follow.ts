// Docked worg follows the editor: as the cursor in an org file moves into
// another heading, every open worg panel is told (`worg:reveal`, see the
// protocol at the top of worg.ts) and the view it is showing scrolls to that
// heading - the Org view's source, the column view, the gantt chart. A view
// with no notion of a heading ignores it.
//
// Debounced, so walking down a file with the arrow keys sends one reveal when
// the cursor stops rather than one per heading passed. org.worgFollowCursor
// turns it off.
import * as vscode from 'vscode';
import { Sets } from './sets';
import { WorgPanel } from './worg';
import { WorgReveal, revealAt, serverPath, sameReveal } from './worg-follow-model';

const DELAY = 300;

function enabled(): boolean {
    return vscode.workspace.getConfiguration('org').get<boolean>('worgFollowCursor', true) !== false;
}

export function activateWorgFollow(context: vscode.ExtensionContext) {
    let last: WorgReveal | undefined;
    let timer: NodeJS.Timeout | undefined;

    const send = () => {
        timer = undefined;
        const ed = vscode.window.activeTextEditor;
        if (!enabled() || !WorgPanel.anyOpen() || !ed || ed.document.languageId !== 'org' || ed.document.uri.scheme !== 'file') {
            return;
        }
        const lines = ed.document.getText().split(/\r?\n/);
        const r = revealAt(lines, ed.selection.active.line, serverPath(ed.document.fileName, Sets.serverPathMap || {}));
        if (!r || sameReveal(r, last)) {
            return;
        }
        last = r;
        WorgPanel.broadcast(r);
    };
    const soon = () => {
        if (!enabled() || !WorgPanel.anyOpen()) {
            // A panel opened later starts from nothing having been said.
            last = undefined;
            return;
        }
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(send, DELAY);
    };

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
            if (e.textEditor === vscode.window.activeTextEditor) {
                soon();
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(() => soon()),
        // An edit above the cursor moves the heading's line: say it again
        // once the typing stops.
        vscode.workspace.onDidSaveTextDocument(d => {
            if (d.languageId === 'org') {
                last = undefined;
                soon();
            }
        }),
        { dispose: () => timer && clearTimeout(timer) },
    );
}
