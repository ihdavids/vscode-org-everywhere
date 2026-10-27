// A box to type a date in: tomorrow, fri, +2w, fri 14:00, mon +1w. What it
// resolves to shows in the prompt as it is typed, so a date is checked before
// it goes into a file. The calendar is one button (or an empty Enter) away.

import * as vscode from 'vscode';
import { parseOrgDate, describeWhen, OrgDate } from './when-model';

export type WhenAnswer =
    | { kind: 'date', date: OrgDate }
    | { kind: 'clear' }
    | { kind: 'calendar' };

export interface WhenOptions {
    title: string;
    // What the box starts with, e.g. the date already there.
    value?: string;
    // Whether an empty Enter (or "clear") clears the date rather than opening
    // the calendar.
    allowClear?: boolean;
    // Offer the calendar button, and open it on an empty Enter.
    calendar?: boolean;
}

const HINT = 'today · tomorrow · fri · +2w · 10-01 · 2026-10-01 · fri 14:00 · mon 9:30-10:45 · mon +1w';

export function askWhen(opts: WhenOptions): Promise<WhenAnswer | undefined> {
    const box = vscode.window.createInputBox();
    box.title = opts.title;
    box.placeholder = HINT;
    box.value = opts.value || '';
    box.ignoreFocusOut = true;
    const calButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('calendar'), tooltip: 'Pick from the calendar' };
    if (opts.calendar) {
        box.buttons = [calButton];
    }
    const emptyMeans = opts.calendar ? 'Enter on an empty line opens the calendar' : opts.allowClear ? 'Enter on an empty line clears the date' : HINT;
    const show = () => {
        const v = box.value.trim();
        if (v === '') {
            box.prompt = emptyMeans;
            box.validationMessage = undefined;
            return;
        }
        const d = describeWhen(v);
        if (!d.ok) {
            box.prompt = undefined;
            box.validationMessage = d.text;
        } else if (d.stamp === '' && !opts.allowClear) {
            box.prompt = undefined;
            box.validationMessage = 'Type a date';
        } else {
            box.validationMessage = undefined;
            box.prompt = '→ ' + d.text;
        }
    };
    show();
    return new Promise(resolve => {
        let answer: WhenAnswer | undefined;
        box.onDidChangeValue(show);
        box.onDidTriggerButton(b => {
            if (b === calButton) {
                answer = { kind: 'calendar' };
                box.hide();
            }
        });
        box.onDidAccept(() => {
            const v = box.value.trim();
            if (v === '' && opts.calendar) {
                answer = { kind: 'calendar' };
                box.hide();
                return;
            }
            const r = parseOrgDate(v);
            if (r.error) {
                return;
            }
            if (!r.set) {
                if (!opts.allowClear) {
                    return;
                }
                answer = { kind: 'clear' };
            } else {
                answer = { kind: 'date', date: r.date };
            }
            box.hide();
        });
        box.onDidHide(() => {
            box.dispose();
            resolve(answer);
        });
        box.show();
    });
}
