// Org: Read the orgs Docs - the orgs manual (docs/docs.html on main in the
// orgs repository) in a webview. Fetched each time it is opened, cheaply: the
// copy from last time is kept with its ETag, so an unchanged page is a 304,
// and the copy is what is shown when github cannot be reached.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ORGS_DOCS_URL, docsForWebview } from './orgs-server-model';

const fetchModule = import('node-fetch');
async function fetch(url: string, opts: any = {}): Promise<any> {
    return (await fetchModule)['default'](url, opts);
}

const ETAG_KEY = 'orgs.docs.etag';

let ctx: vscode.ExtensionContext;
let panel: vscode.WebviewPanel | undefined;
let page: string | undefined;

const cachePath = () => path.join(ctx.globalStorageUri.fsPath, 'orgs-docs.html');

function cached(): string | undefined {
    try {
        return fs.readFileSync(cachePath(), 'utf8');
    } catch (e) {
        return undefined;
    }
}

// The page: github's if it has a newer one, else the copy from last time.
async function load(): Promise<string> {
    const copy = cached();
    const etag = copy && ctx.globalState.get<string>(ETAG_KEY);
    try {
        const res = await fetch(ORGS_DOCS_URL, {
            headers: { 'User-Agent': 'org-everywhere', ...(etag ? { 'If-None-Match': etag } : {}) },
            timeout: 15000,
        });
        if (res.status === 304 && copy) {
            return copy;
        }
        if (!res.ok) {
            throw new Error(`github answered ${res.status}`);
        }
        const html: string = await res.text();
        fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
        fs.writeFileSync(cachePath(), html);
        await ctx.globalState.update(ETAG_KEY, res.headers.get('etag') || undefined);
        return html;
    } catch (e) {
        if (copy) {
            vscode.window.setStatusBarMessage('Could not reach github: showing the orgs docs from last time', 5000);
            return copy;
        }
        throw e;
    }
}

const isDark = () => [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(vscode.window.activeColorTheme.kind);

function render() {
    if (panel && page) {
        panel.webview.html = docsForWebview(page, isDark());
    }
}

async function show() {
    if (panel) {
        panel.reveal();
        return;
    }
    try {
        page = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Fetching the orgs docs' }, load);
    } catch (e) {
        const b = await vscode.window.showErrorMessage(`Could not fetch the orgs docs: ${e && e.message || e}`, 'Open on GitHub');
        if (b) {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/ihdavids/orgs/blob/main/docs/docs.html'));
        }
        return;
    }
    panel = vscode.window.createWebviewPanel('orgsDocs', 'orgs Docs', vscode.ViewColumn.Active, {
        enableScripts: true,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        // Everything it loads is from the web; nothing of this machine's.
        localResourceRoots: [],
    });
    panel.onDidDispose(() => panel = undefined);
    render();
}

export function activateOrgsDocs(context: vscode.ExtensionContext) {
    ctx = context;
    context.subscriptions.push(
        vscode.commands.registerCommand('org.showOrgsDocs', show),
        vscode.window.onDidChangeActiveColorTheme(render),
    );
}
