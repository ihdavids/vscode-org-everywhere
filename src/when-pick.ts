// Picking a date from a short list, or typing one: the agenda's Reschedule….
// The usual days are listed; anything typed (fri, +2w, mon 14:00) becomes the
// first entry, already resolved, so Enter takes it.

import * as vscode from 'vscode';
import { describeWhen, parseOrgDate, orgDateString, startOfDay } from './when-model';
import { stamp } from './dates';

interface DayPick extends vscode.QuickPickItem { value?: string; }

// The timestamp to write, '' to take the date off, or undefined when the
// pick was dismissed.
export function pickWhen(placeHolder: string, now: Date = new Date()): Promise<string | undefined> {
    const today = startOfDay(now);
    const plus = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
    const fixed: DayPick[] = [
        ['Today', plus(0)], ['Tomorrow', plus(1)],
        ['Next Monday', plus((8 - today.getDay()) % 7 || 7)], ['In a week', plus(7)],
    ].map(([label, d]: [string, Date]) => ({ label: '$(calendar) ' + label, description: stamp(d, true, false), value: stamp(d, true, false) }));
    const qp = vscode.window.createQuickPick<DayPick>();
    qp.placeholder = placeHolder + ' (or type one: fri, +2w, 10-01, mon 14:00, clear)';
    qp.matchOnDescription = true;
    qp.items = fixed;
    qp.onDidChangeValue(v => {
        const t = v.trim();
        if (!t) {
            qp.items = fixed;
            return;
        }
        const d = describeWhen(t, now);
        const r = parseOrgDate(t, now);
        // The typed one first, always shown whatever the filter makes of it.
        const typed: DayPick = d.ok
            ? { label: '$(edit) ' + t, description: d.text, alwaysShow: true, value: r.set && r.date ? orgDateString(r.date) : '' }
            : { label: '$(warning) ' + t, description: d.text, alwaysShow: true };
        qp.items = [typed, ...fixed];
    });
    return new Promise(resolve => {
        let out: string | undefined;
        qp.onDidAccept(() => {
            const p = qp.selectedItems[0] || qp.activeItems[0];
            if (!p || p.value === undefined) {
                return;
            }
            out = p.value;
            qp.hide();
        });
        qp.onDidHide(() => {
            qp.dispose();
            resolve(out);
        });
        qp.show();
    });
}
