// The extension's own singletons. It runs from its esbuild bundle (dist/),
// which has its own copy of every module: importing ../src/auth here would
// give the tests a second Auth that the running extension never sees. So they
// come from the extension's exports (activate() returns them).
import * as vscode from 'vscode';
import type { Internals } from '../src/extension';

export const EXTENSION_ID = 'iorg.vscode-org-everywhere';

export async function internals(): Promise<Internals> {
    return await vscode.extensions.getExtension<Internals>(EXTENSION_ID).activate();
}
