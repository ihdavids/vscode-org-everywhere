// A CodeLens over each heading whose dependencies or schedule need a look:
// "blocked by Deploy · overdue 2d · on critical path". Clicking it goes to
// what holds the heading up (a pick when there are several). The problems
// come from orgs' /insights/deps, the schedule from /gantt/tasks laid out as
// worg's gantt chart lays it out (src/dep-lens-model.ts).
//
// Asked for once and kept: the dependency report once for every file, the
// plan once per file, both forgotten when the server says a file was re-read
// or an org file is saved.

import * as vscode from 'vscode';
import * as path from 'path';
import { ODb } from './db';
import { Auth } from './auth';
import { openAt, readLines } from './org-files';
import { onOrgsEvent } from './events';
import { DepReport, DepHeading, GanttData, PlannedTask, schedule, fileQuery, lensesFor, lensTitle, placeOf } from './dep-lens-model';

function enabled(): boolean {
    return vscode.workspace.getConfiguration('org').get<boolean>('dependencyLens', true) !== false;
}

class DependencyLens implements vscode.CodeLensProvider {
    private changed = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.changed.event;
    private deps: Promise<DepReport | undefined> | undefined;
    private plans = new Map<string, Promise<PlannedTask[]>>();

    forget() {
        this.deps = undefined;
        this.plans.clear();
        this.changed.fire();
    }

    private report(): Promise<DepReport | undefined> {
        if (!this.deps) {
            // min=2: a heading behind even one open blocker is worth saying so.
            this.deps = ODb.api<DepReport>('/insights/deps', { min: '2' })
                .then(r => r && r.Ok ? r : undefined, () => undefined);
        }
        return this.deps;
    }

    private plan(file: string): Promise<PlannedTask[]> {
        let p = this.plans.get(file);
        if (!p) {
            p = ODb.api<GanttData>('/gantt/tasks', { query: fileQuery(file) })
                .then(r => r && r.Ok && r.Tasks ? schedule(r.Tasks, new Date()) : [], () => []);
            this.plans.set(file, p);
        }
        return p;
    }

    async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        if (!enabled() || doc.uri.scheme !== 'file' || !Auth.get().isLoggedIn()) {
            return [];
        }
        const [report, tasks] = await Promise.all([this.report(), this.plan(doc.fileName)]);
        const lines = doc.getText().split(/\r?\n/);
        return lensesFor(doc.fileName, lines, report, tasks, new Date()).map(l => {
            const range = new vscode.Range(l.line, 0, l.line, 0);
            return new vscode.CodeLens(range, {
                title: lensTitle(l),
                tooltip: l.tooltip || undefined,
                command: l.targets.length ? 'org.dependencyLens.go' : 'org.dependencyLens.explain',
                arguments: l.targets.length ? [l.targets] : [l.parts.join(' · '), l.tooltip],
            });
        });
    }
}

// Go to a heading the server named, finding it again if lines have moved.
async function goTo(h: DepHeading) {
    const line = placeOf(readLines(h.Filename), h.LineNum, h.Headline);
    await openAt(h.Filename, line < 0 ? h.LineNum : line);
}

async function go(targets: DepHeading[]) {
    if (!targets || !targets.length) {
        return;
    }
    if (targets.length === 1) {
        return goTo(targets[0]);
    }
    const pick = await vscode.window.showQuickPick(targets.map(t => ({
        label: `${t.Status ? t.Status + ' ' : ''}${t.Headline}`,
        description: `${path.basename(t.Filename)}:${t.LineNum + 1}`,
        target: t,
    })), { placeHolder: 'Go to what holds this heading up' });
    if (pick) {
        await goTo(pick.target);
    }
}

export function activateDependencyLens(ctx: vscode.ExtensionContext) {
    const lens = new DependencyLens();
    let pending: NodeJS.Timeout | undefined;
    const forgetSoon = () => {
        if (pending) {
            clearTimeout(pending);
        }
        pending = setTimeout(() => lens.forget(), 1000);
    };
    ctx.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ language: 'org', scheme: 'file' }, lens),
        vscode.commands.registerCommand('org.dependencyLens.go', go),
        vscode.commands.registerCommand('org.dependencyLens.explain', (text: string, tip: string) =>
            vscode.window.showInformationMessage(tip ? `${text}: ${tip}` : text)),
        vscode.commands.registerCommand('org.refreshDependencyLens', () => lens.forget()),
        vscode.workspace.onDidSaveTextDocument(d => d.languageId === 'org' && forgetSoon()),
        onOrgsEvent(['reload'], forgetSoon),
        Auth.get().onTokenChanged(() => lens.forget()),
        vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('org.dependencyLens') && lens.forget()),
    );
}
