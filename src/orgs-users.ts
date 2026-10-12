import * as vscode from 'vscode';
/* SDOC: Developers
* Users and passwords
  =Org: Manage orgs Users= gives you a login of your own, for worg in a
  browser or =orgs login= somewhere else; the plugin's own (=vscode=) is not
  one anybody knows.

  Adding a user is =POST /users/add=, which takes effect at once and needs the
  plugin's login to be an administrator - the local server's is - so it works
  against any server where that is so. The password does not travel: the
  plugin makes the user a salt and sends a hash under it, as a login does.

  Changing a password and removing a user have no endpoint, on purpose (orgs'
  =orgs user= says why), so they are only offered for the local server:
  =orgs user passwd= / =rm= on its keystore, with the server stopped for the
  moment it takes, because it writes the keystore back on every login.
EDOC */

import { ODb } from './db';
import { worgBase } from './worg';
import { isManaged, orgsCli, withServerStopped } from './orgs-server';
import { ORGS_USER, clientHash, newSalt, usernameProblem } from './orgs-server-model';

interface UserRow {
    Name: string;
    Admin: boolean;
    LastLogin?: string;
}

// The local server's users, from its keystore file.
async function localUsers(): Promise<UserRow[]> {
    try {
        const rows = JSON.parse(await orgsCli(['user', 'ls', '-json']));
        return Array.isArray(rows) ? rows : [];
    } catch (e) {
        return [];
    }
}

async function askPassword(who: string): Promise<string | undefined> {
    const first = await vscode.window.showInputBox({
        title: `Password for ${who}`, password: true, ignoreFocusOut: true,
        validateInput: v => v ? undefined : 'An empty password is not one',
    });
    if (!first) {
        return undefined;
    }
    const again = await vscode.window.showInputBox({
        title: `Password for ${who}, again`, password: true, ignoreFocusOut: true,
        validateInput: v => v === first ? undefined : 'Those do not match',
    });
    return again === first ? first : undefined;
}

async function addUser(taken: string[]) {
    const name = await vscode.window.showInputBox({
        title: 'Add a user to the orgs server', prompt: 'The name to log in with', ignoreFocusOut: true,
        validateInput: v => usernameProblem(v) || (taken.includes(v) ? `There is already a user ${v}` : undefined),
    });
    if (!name) {
        return;
    }
    const password = await askPassword(name);
    if (!password) {
        return;
    }
    const role = await vscode.window.showQuickPick([
        { label: 'Ordinary user', admin: false },
        { label: 'Administrator', description: 'may add users of their own', admin: true },
    ], { title: `What is ${name}?` });
    if (!role) {
        return;
    }
    const salt = newSalt();
    const res = await ODb.apiPost<{ Ok?: boolean, Msg?: string }>('/users/add', {
        username: name, salt, password: clientHash(name, salt, password), admin: role.admin,
    }).catch(e => ({ Ok: false, Msg: e.message }));
    if (!res || !res.Ok) {
        vscode.window.showErrorMessage(`Could not add ${name}: ${res && res.Msg || 'the orgs server did not answer'}`);
        return;
    }
    const b = await vscode.window.showInformationMessage(
        `${name} can log in now - to worg in a browser, or with orgs login -user ${name}.`, 'Open worg in Browser');
    if (b) {
        vscode.env.openExternal(vscode.Uri.parse(worgBase() + '/'));
    }
}

async function keystoreEdit(what: string, args: string[]) {
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `orgs: ${what}` },
            () => withServerStopped(() => orgsCli(args)));
        vscode.window.setStatusBarMessage(`orgs: ${what} - done`, 4000);
    } catch (e) {
        vscode.window.showErrorMessage(`orgs: ${what} failed: ${e && e.message || e}`);
    }
}

async function userMenu(u: UserRow) {
    const pick = await vscode.window.showQuickPick([
        { label: '$(key) Change the password', run: 'passwd' },
        { label: '$(trash) Remove', run: 'rm' },
    ], { title: u.Name, placeHolder: 'The server restarts for a moment to take the change' });
    if (!pick) {
        return;
    }
    if (pick.run === 'passwd') {
        const password = await askPassword(u.Name);
        if (password) {
            // On orgs' command line for the moment it takes to hash it, as at set up.
            await keystoreEdit(`new password for ${u.Name}`, ['user', 'passwd', u.Name, '-password', password]);
        }
    } else {
        const sure = await vscode.window.showWarningMessage(`Remove ${u.Name}? They will not be able to log in.`,
            { modal: true }, 'Remove');
        if (sure) {
            await keystoreEdit(`removing ${u.Name}`, ['user', 'rm', u.Name, '-force']);
        }
    }
}

export async function manageUsers() {
    if (!isManaged()) {
        // Not the local server: adding is all there is, and the server decides
        // whether this login may.
        return addUser([]);
    }
    const users = await localUsers();
    const items = [
        { label: '$(person-add) Add a user…', user: undefined as UserRow | undefined },
        ...users.map(u => ({
            label: '$(person) ' + u.Name,
            description: [u.Admin ? 'admin' : '', u.Name === ORGS_USER ? 'VS Code\'s own login' : '',
                !u.LastLogin ? '' : u.LastLogin === 'never' ? 'never logged in' : 'last login ' + u.LastLogin].filter(x => x).join(' · '),
            user: u,
        })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Users of the local orgs server' });
    if (!pick) {
        return;
    }
    if (!pick.user) {
        return addUser(users.map(u => u.Name));
    }
    if (pick.user.Name === ORGS_USER) {
        vscode.window.showInformationMessage(`${ORGS_USER} is how VS Code logs in, with a password it keeps; ` +
            'it is left alone here. Add a user of your own to log in from a browser.');
        return;
    }
    return userMenu(pick.user);
}

export function activateOrgsUsers(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('org.manageOrgsUsers', manageUsers));
}
