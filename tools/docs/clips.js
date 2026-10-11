// The README's animations, as clips. Like scenes.js this runs inside VS Code
// (as its extension tests do), but each clip is recorded while it plays: it
// asks tools/docs/screenshots.js, listening on SHOT_PORT, to start a
// screencast, presses real keys through it (so the keybindings and pickers
// are the ones a person meets), shows each key as a caption, and stops.
// Every clip starts from the demo files as they were, so the order does not
// matter. Run by `tools/docs/build.sh --clips`, not by hand.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const port = process.env.SHOT_PORT;
const demo = process.env.DEMO_DIR;
const pause = ms => new Promise(r => setTimeout(r, ms));
const cmd = (id, ...args) => vscode.commands.executeCommand(id, ...args);

async function ask(what, params = {}) {
    const q = new URLSearchParams(params).toString();
    const res = await fetch(`http://127.0.0.1:${port}/${what}${q ? '?' + q : ''}`);
    if (!res.ok) {
        throw new Error(`${what}: ${await res.text()}`);
    }
}
const caption = text => ask('caption', { text });
const typeText = (text, delay = 55) => ask('type', { text, delay });

// Shows the key, presses it, and lets the result be seen. A key is
// 'alt+shift+Tab' or a chord 'ctrl+alt+o m'; label is what the caption says.
async function key(keys, label, after = 1100) {
    await caption(label || keys);
    await pause(350);
    for (const k of keys.split(' ')) {
        const parts = k.split('+');
        await ask('press', { key: parts.pop(), mods: parts.join(',') });
        await pause(120);
    }
    await pause(after);
}

// The demo files as the clips found them, to put back after each one.
const pristine = {};
for (const f of fs.readdirSync(demo).filter(f => f.endsWith('.org'))) {
    pristine[f] = fs.readFileSync(path.join(demo, f), 'utf8');
}
async function restore() {
    await cmd('workbench.action.closeQuickOpen');
    await cmd('workbench.action.files.revert').then(() => undefined, () => undefined);
    await cmd('workbench.action.closeAllEditors');
    for (const [f, text] of Object.entries(pristine)) {
        if (fs.readFileSync(path.join(demo, f), 'utf8') !== text) {
            fs.writeFileSync(path.join(demo, f), text);
        }
    }
    await pause(600);
}

async function open(file, re, ch = 0) {
    const doc = await vscode.workspace.openTextDocument(path.join(demo, file));
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    await cmd('editor.unfoldAll');
    const line = re ? Math.max(0, doc.getText().split('\n').findIndex(l => re.test(l))) : 0;
    const pos = new vscode.Position(line, typeof ch === 'function' ? ch(doc.lineAt(line).text) : ch);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    await cmd('workbench.action.focusActiveEditorGroup');
    await pause(400);
    return editor;
}

async function layout(sidebar) {
    await cmd('workbench.action.closePanel');
    if (sidebar) {
        await cmd(sidebar);
    } else {
        await cmd('workbench.action.closeSidebar');
    }
}

const CLIPS = [
    ['outline', async () => {
        await layout(null);
        await open('plan.org', /^\* Website relaunch/);
        await ask('rec/start', { name: 'outline' });
        await pause(800);
        await key('shift+Tab', 'Shift+Tab  overview');
        await key('shift+Tab', 'Shift+Tab  contents');
        await key('shift+Tab', 'Shift+Tab  everything');
        await key('shift+Tab', 'Shift+Tab  overview');
        await key('Tab', 'Tab  open one heading');
        await key('ArrowDown', '↓');
        await key('ArrowDown', '↓');
        await key('alt+ArrowDown', 'Alt+↓  move the subtree down');
        await key('alt+ArrowUp', 'Alt+↑  and back up');
        await key('alt+shift+ArrowRight', 'Alt+Shift+→  demote');
        await key('alt+shift+ArrowLeft', 'Alt+Shift+←  promote');
        await caption('');
        await pause(600);
        await ask('rec/stop');
    }],
    ['todo', async () => {
        await layout(null);
        await open('plan.org', /^\*\* TODO \[#B\] Move the blog archive/, 3);
        await cmd('org.globalCycle');
        await cmd('org.globalCycle');
        await ask('rec/start', { name: 'todo' });
        await pause(800);
        await key('alt+ArrowRight', 'Alt+→  next keyword', 1300);
        await key('alt+ArrowRight', 'Alt+→  WAITING', 1300);
        await key('alt+ArrowRight', 'Alt+→  DONE, and the [2/5] cookie counts it', 2200);
        await key('alt+ArrowLeft', 'Alt+←  back again', 1300);
        await caption('');
        await pause(500);
        await ask('rec/stop');
    }],
    ['checkboxes', async () => {
        await layout(null);
        const e = await open('plan.org', /^\* Ideas/, l => l.length);
        await e.edit(b => b.insert(e.selection.active, ' [/]'));
        const line = e.selection.active.line;
        await e.edit(b => {
            for (let i = 1; i <= 3; i++) {
                const t = e.document.lineAt(line + i).text;
                b.replace(new vscode.Range(line + i, 0, line + i, t.length), t.replace('- ', '- [ ] '));
            }
        });
        await e.document.save();
        await cmd('org.recalcCheckboxSummary').then(() => undefined, () => undefined);
        e.selection = new vscode.Selection(line + 1, 8, line + 1, 8);
        // No key of its own: on the command palette, or bind one.
        const toggle = async (label, after = 1300) => {
            await caption(label);
            await pause(350);
            await cmd('org.toggleCheckbox');
            await pause(after);
        };
        await ask('rec/start', { name: 'checkboxes' });
        await pause(800);
        await toggle('Org: Toggle Checkbox  tick it, and [0/3] counts it');
        await key('ArrowDown', '↓', 400);
        await toggle('Org: Toggle Checkbox');
        await key('ArrowDown', '↓', 400);
        await toggle('Org: Toggle Checkbox  all done: [3/3]', 1600);
        await toggle('Org: Toggle Checkbox  and untick');
        await caption('');
        await pause(500);
        await ask('rec/stop');
    }],
    ['table', async () => {
        await layout(null);
        const e = await open('budget.org', /^\| Domain/, l => l.length);
        await e.edit(b => b.insert(e.selection.active, '\n'));
        await ask('rec/start', { name: 'table' });
        await pause(800);
        await caption('A new row, typed roughly');
        await typeText('|Email|6|12', 90);
        await pause(500);
        await key('Tab', 'Tab  aligns the table and moves to the next cell', 1500);
        await caption('Org: Recalculate Table  Cost = Monthly × Months');
        await pause(400);
        await cmd('org.execTable');
        await pause(2500);
        await caption('');
        await pause(600);
        await ask('rec/stop');
    }],
    ['dates', async () => {
        await layout(null);
        const e = await open('plan.org', /^ +- an RSS feed/, l => l.length);
        await e.edit(b => b.insert(e.selection.active, ' by '));
        await ask('rec/start', { name: 'dates' });
        await pause(800);
        await key('ctrl+alt+o Period', 'Ctrl+Alt+O .  insert a timestamp', 1500);
        await key('Enter', 'Enter  today', 1000);
        await key('ArrowLeft', '←', 150);
        await key('ArrowLeft', '←', 150);
        await key('ArrowLeft', '←', 500);
        await key('alt+ArrowRight', 'Alt+→  a day later', 800);
        await key('alt+ArrowRight', 'Alt+→', 800);
        await key('alt+ArrowRight', 'Alt+→', 800);
        await key('alt+ArrowLeft', 'Alt+←  a day earlier', 1300);
        await caption('');
        await pause(500);
        await ask('rec/stop');
    }],
    ['agenda-clock', async () => {
        await layout('workbench.view.extension.org');
        await cmd('org.agenda.refresh');
        await cmd('orgClock.focus');
        await cmd('org.clock.refresh');
        await open('plan.org', /^\*\* TODO \[#B\] Move the blog archive/, 6);
        await pause(1500);
        await ask('rec/start', { name: 'agenda-clock' });
        await pause(1000);
        await key('ctrl+alt+o ctrl+i', 'Ctrl+Alt+O Ctrl+I  clock in', 2500);
        await caption('The running clock, in the status bar');
        await pause(2500);
        await key('ctrl+alt+o ctrl+o', 'Ctrl+Alt+O Ctrl+O  clock out', 2500);
        await caption('');
        await pause(500);
        await ask('rec/stop');
    }],
    ['capture', async () => {
        await layout(null);
        await open('plan.org', /^\* Inbox/);
        await ask('rec/start', { name: 'capture' });
        await pause(800);
        await key('ctrl+alt+o q', 'Ctrl+Alt+O Q  quick capture, from anywhere', 1300);
        await key('Enter', 'Enter  the orgs server\'s Inbox template', 900);
        await typeText('Ask Sam about the RSS feed');
        await pause(500);
        await key('Enter', 'Enter  filed under Inbox by the orgs server', 2500);
        await caption('');
        await pause(500);
        await ask('rec/stop');
    }],
    ['refile', async () => {
        await layout(null);
        await open('plan.org', /^\*\* WAITING Sign-off from legal/, 3);
        await ask('rec/start', { name: 'refile' });
        await pause(800);
        await key('ctrl+alt+o w', 'Ctrl+Alt+O W  refile the subtree', 1500);
        await typeText('Inbox', 110);
        await pause(900);
        await key('Enter', 'Enter  it moves under Inbox', 2500);
        await caption('');
        await pause(500);
        await ask('rec/stop');
    }],
    ['links', async () => {
        await layout(null);
        await open('plan.org', /^\*\* TODO Weekly review/, l => l.length);
        await ask('rec/start', { name: 'links' });
        await pause(800);
        await key('Enter', 'Enter', 300);
        await typeText('   Check ');
        await key('ctrl+alt+o k', 'Ctrl+Alt+O K  insert a link: files, headings, ids', 1300);
        await typeText('Hosting', 110);
        await pause(1000);
        await key('Enter', 'Enter', 1000);
        await key('Enter', 'Enter  keep the heading as its text', 1500);
        await key('ArrowLeft', '←', 200);
        await key('ArrowLeft', '←', 300);
        await key('F12', 'F12  follow it', 2200);
        await caption('');
        await pause(500);
        await ask('rec/stop');
    }],
    ['run-code', async () => {
        await layout(null);
        await open('notes.org', /^print/);
        await ask('rec/start', { name: 'run-code' });
        await pause(800);
        await key('ctrl+alt+o r', 'Ctrl+Alt+O R  run the block on the orgs server', 2800);
        await caption('');
        await pause(500);
        await ask('rec/stop');
    }],
];

exports.run = async function () {
    await vscode.extensions.getExtension('iorg.vscode-org-everywhere').activate();
    await pause(2500);   // the agenda and the connection settle
    const only = (process.env.SCENES || '').split(',').filter(s => s);
    for (const [name, clip] of CLIPS) {
        if (only.length && only.indexOf(name) < 0) {
            continue;
        }
        try {
            await restore();
            await clip();
        } catch (e) {
            console.error(`clip ${name} failed: ${e.message}`);
            await ask('rec/stop').catch(() => undefined);
            await caption('').catch(() => undefined);
        }
    }
    await restore();
};
