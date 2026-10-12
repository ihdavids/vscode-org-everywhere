// Org: Set Up a Local orgs Server, for real: downloads the latest orgs
// release from github, starts it on a folder of its own, logs in, restarts and
// stops it, and opens the orgs docs. Needs the network, so it runs only with ORGS_INSTALL_TEST=1.
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Internals } from '../src/extension';
import { internals } from './internals';

const win: any = vscode.window;
const run = (id: string, ...args: any[]): Promise<any> => vscode.commands.executeCommand(id, ...args) as any;
const connection = () => vscode.workspace.getConfiguration('org').get<string>('orgsConnection');

(process.env.ORGS_INSTALL_TEST ? suite : suite.skip)('Local orgs server', function () {
    this.timeout(180_000);
    let I: Internals;
    let notes: string;
    const saved: any = {};

    // Wipe what an earlier run left in this VS Code's global storage.
    async function remove() {
        if (I.orgsServer.isInstalled()) {
            await I.orgsServer.stop();
        }
        fs.rmSync(path.dirname(I.orgsServer.configPath()), { recursive: true, force: true });
    }

    suiteSetup(async () => {
        I = await internals();
        await remove();
        notes = fs.mkdtempSync(path.join(os.tmpdir(), 'orgs-install-'));
        fs.writeFileSync(path.join(notes, 'main.org'), '* TODO Try the local server\n');
        await vscode.workspace.getConfiguration('org').update('orgsConnection', 'http://localhost:1', true);
        for (const k of ['showInformationMessage', 'showQuickPick', 'showOpenDialog', 'showErrorMessage']) {
            saved[k] = win[k];
        }
    });

    suiteTeardown(async () => {
        Object.assign(win, saved);
        await remove();
        fs.rmSync(notes, { recursive: true, force: true });
        await vscode.workspace.getConfiguration('org').update('orgsConnection', undefined, true);
    });

    test('sets up, connects and logs in', async () => {
        const errors: string[] = [];
        // Yes to the download, the notes folder, and nothing after.
        win.showInformationMessage = async (_msg: string, ...rest: any[]) =>
            rest.includes('Download and Set Up') ? 'Download and Set Up' : undefined;
        win.showQuickPick = async (items: any) => (await items).find((i: any) => /another folder/.test(i.label));
        win.showOpenDialog = async () => [vscode.Uri.file(notes)];
        win.showErrorMessage = async (msg: string) => { errors.push(msg); return undefined; };

        await run('org.setUpOrgsServer');
        assert.deepEqual(errors, []);
        assert.ok(I.orgsServer.isInstalled());
        assert.ok(I.orgsServer.isManaged(), `connection is ${connection()}`);
        assert.match(connection(), /^http:\/\/localhost:\d+$/);
        assert.equal(await I.Auth.get().probe(), 'closed', 'the server wants a login');
        assert.ok(I.Auth.get().isLoggedIn());
        const v = await I.ODb.api<any>('/version');
        assert.match(v.version, /^v\d+\.\d+\.\d+/);
    });

    test('a restart keeps the login', async () => {
        await run('org.restartOrgsServer');
        assert.ok(I.Auth.get().isLoggedIn());
        const v = await I.ODb.api<any>('/version');
        assert.ok(v && v.version, 'the token from before the restart still works');
    });

    test('opens the orgs docs', async () => {
        const errors: string[] = [];
        win.showErrorMessage = async (msg: string) => { errors.push(msg); return undefined; };
        await run('org.showOrgsDocs');
        assert.deepEqual(errors, []);
        await new Promise(r => setTimeout(r, 500));
        const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
        assert.ok(tabs.some(t => t.label === 'orgs Docs'), tabs.map(t => t.label).join(', '));
        await run('workbench.action.closeActiveEditor');
    });

    test('stops', async () => {
        assert.ok(await I.orgsServer.stop());
        assert.equal(await I.Auth.get().probe(), 'unreachable');
    });
});
