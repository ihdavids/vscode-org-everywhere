import * as vscode from 'vscode';
/* SDOC: Developers
* A local orgs server
  =Org: Set Up a Local orgs Server= downloads the latest orgs release from
  github for this machine, checks it against the release's =checksums.txt=,
  and keeps it in the extension's global storage with an =orgs.yaml=, a
  keystore and its logs (=orgs-server-model.ts= has the parts with no vscode).

  The server it starts is detached, so it outlives the window that started it
  and every window shares it; a window that finds it not answering starts it
  again (=org.orgsServer.autoStart=). It has a login like any other: the
  password is made at random, kept in SecretStorage and handed to =Auth= as
  its credential source, so nobody is asked for it - worg's panels included,
  which are logged in (=Auth.quietLogin=) before they open.

  It serves https and nothing else (=httpsOnly=), on the loopback only
  (=localhostOnly=), with a self-signed certificate =orgs cert= makes beside
  it. The plugin trusts that one certificate for that one address
  (=trustCertificate= in auth.ts) - not every self-signed one - and renews it
  when it has under a month left. A server set up on http before this, or by
  an orgs too old to make a certificate, is moved to https once its orgs can.

  The orgs command line beside it reads that server's =orgs.yaml=, keys and
  all, and makes its own token (orgs' =localtoken.go=); VS Code's terminals
  get it first on PATH. =Org: Open worg in Browser= asks the server for a
  one-use login link (=POST /login/ticket=) and opens that.
EDOC */

import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as crypto from 'crypto';
import { spawn, execFile } from 'child_process';
import { Auth, agentFor, trustCertificate } from './auth';
import { Sets } from './sets';
import { ODb } from './db';
import {
    ORGS_REPO, ORGS_USER, assetName, binaryName, parseChecksums, isNewer, orgsYaml, configListen, isLocalUrl,
    withHttps, OrgsConfig,
} from './orgs-server-model';

const fetchModule = import('node-fetch');
async function fetch(url: string, opts: any = {}): Promise<any> {
    return (await fetchModule)['default'](url, opts);
}

const DEFAULT_PORT = 8010;
const PASSWORD_KEY = 'orgs.server.password';
const STATE_KEY = 'orgs.server';
// How long a server gets to read its org files and start listening.
const START_TIMEOUT_MS = 90_000;

interface ServerState {
    version?: string;     // the installed release tag
    lastCheck?: number;   // when github was last asked for a newer one
    skipped?: string;     // a release the user said not to offer again
}

interface Release {
    tag: string;
    page: string;
    assets: Map<string, string>; // name -> download url
}

let ctx: vscode.ExtensionContext;

const dir = () => path.join(ctx.globalStorageUri.fsPath, 'orgs');
const binPath = () => path.join(dir(), binaryName(process.platform));
export const configPath = () => path.join(dir(), 'orgs.yaml');
const pidPath = () => path.join(dir(), 'orgs.pid');
const logPath = () => path.join(dir(), 'server.log');
const lockPath = () => path.join(dir(), 'start.lock');

const state = (): ServerState => ctx.globalState.get<ServerState>(STATE_KEY) || {};
const setState = (s: Partial<ServerState>) => ctx.globalState.update(STATE_KEY, { ...state(), ...s });

export function isInstalled(): boolean {
    return !!ctx && fs.existsSync(binPath()) && fs.existsSync(configPath());
}

const crtPath = () => path.join(dir(), 'server.crt');
const keyPath = () => path.join(dir(), 'server.key');

// How the server answers: https on its tlsport (what set up writes), or http
// on its port (a set up from before, or by an orgs too old to make a
// certificate).
function listen(): { scheme: 'http' | 'https', port: number } {
    try {
        const l = configListen(fs.readFileSync(configPath(), 'utf8'));
        return { scheme: l.scheme, port: l.port || DEFAULT_PORT };
    } catch (e) {
        return { scheme: 'http', port: DEFAULT_PORT };
    }
}

const port = () => listen().port;
const isHttps = () => listen().scheme === 'https';
const serverUrl = () => `${listen().scheme}://localhost:${port()}`;

// Whether org.orgsConnection is the server this plugin runs: this machine at
// its port and scheme, however the address is spelled (127.0.0.1, a trailing
// slash), since only then is its password the one to log in with.
export function isManaged(): boolean {
    const l = listen();
    return isInstalled() && isLocalUrl(Sets.orgsConnection, l.port, l.scheme);
}

// Tells Auth to trust the server's own certificate, and only for it.
function trustOwnCertificate() {
    let pem: string | undefined;
    try {
        pem = isInstalled() && isHttps() ? fs.readFileSync(crtPath(), 'utf8') : undefined;
    } catch (e) {
        pem = undefined;
    }
    trustCertificate(pem ? port() : undefined, pem);
}

// Whether an orgs server answers on our port: /status is 200, or 401 when it
// wants a login. Anything else listening there is not one.
async function isUp(): Promise<boolean> {
    try {
        const res = await fetch(serverUrl() + '/status', { timeout: 2000, agent: agentFor(serverUrl()) });
        return res.ok || res.status === 401 || res.status === 403;
    } catch (e) {
        return false;
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- releases

async function latestRelease(): Promise<Release> {
    const res = await fetch(`https://api.github.com/repos/${ORGS_REPO}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'org-everywhere' },
        timeout: 15000,
    });
    if (!res.ok) {
        throw new Error(`github answered ${res.status} for the latest orgs release`);
    }
    const data = await res.json();
    return {
        tag: data.tag_name,
        page: data.html_url,
        assets: new Map((data.assets || []).map((a: any) => [a.name, a.browser_download_url])),
    };
}

// Streams url to dest, and hands back the sha256 of what it wrote.
async function download(url: string, dest: string, progress?: (got: number, total: number) => void): Promise<string> {
    const res = await fetch(url, { headers: { 'User-Agent': 'org-everywhere' } });
    if (!res.ok) {
        throw new Error(`${url}: ${res.status} ${res.statusText}`);
    }
    const total = +res.headers.get('content-length') || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(dest);
    let got = 0;
    await new Promise<void>((resolve, reject) => {
        res.body.on('data', (chunk: Buffer) => {
            hash.update(chunk);
            got += chunk.length;
            progress?.(got, total);
        });
        res.body.on('error', reject);
        out.on('error', reject);
        out.on('finish', () => resolve());
        res.body.pipe(out);
    });
    return hash.digest('hex');
}

function run(cmd: string, args: string[], opts: any = {}): Promise<string> {
    return new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) =>
        err ? reject(new Error(`${path.basename(cmd)} ${args[0] || ''}: ${String(stderr || err.message).trim()}`)) : resolve(String(stdout))));
}

// tar reads both archive kinds: GNU tar the .tar.gz on linux, bsdtar both on
// macOS and on windows 10 and later, where PowerShell is the fallback.
async function extract(archive: string, into: string) {
    try {
        await run('tar', ['-xf', archive, '-C', into]);
    } catch (e) {
        if (process.platform !== 'win32') {
            throw e;
        }
        await run('powershell.exe', ['-NoProfile', '-Command',
            `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${into.replace(/'/g, "''")}' -Force`]);
    }
}

// Downloads, verifies and unpacks the release's binary into a staging folder,
// leaving anything running untouched. Hands back the unpacked binary.
async function fetchBinary(release: Release, report: (msg: string, increment?: number) => void): Promise<string> {
    const name = assetName(release.tag, process.platform, process.arch);
    if (!name || !release.assets.has(name)) {
        throw new Error(`orgs ${release.tag} has no build for ${process.platform}/${process.arch}`);
    }
    const sumsUrl = release.assets.get('checksums.txt');
    if (!sumsUrl) {
        throw new Error(`orgs ${release.tag} has no checksums.txt to check the download against`);
    }
    const staging = path.join(dir(), 'download');
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    const sumsFile = path.join(staging, 'checksums.txt');
    await download(sumsUrl, sumsFile);
    const want = parseChecksums(fs.readFileSync(sumsFile, 'utf8')).get(name);
    if (!want) {
        throw new Error(`checksums.txt does not list ${name}`);
    }
    const archive = path.join(staging, name);
    let shown = 0;
    const got = await download(release.assets.get(name), archive, (n, total) => {
        if (total) {
            const pct = Math.floor(n / total * 80);
            if (pct > shown) {
                report(`Downloading orgs ${release.tag} (${Math.round(total / 1e6)} MB)`, pct - shown);
                shown = pct;
            }
        }
    });
    if (got !== want) {
        throw new Error(`the download of ${name} does not match its checksum - not installing it`);
    }
    report('Unpacking');
    const unpacked = path.join(staging, 'x');
    fs.mkdirSync(unpacked);
    await extract(archive, unpacked);
    const bin = path.join(unpacked, binaryName(process.platform));
    if (!fs.existsSync(bin)) {
        throw new Error(`${name} has no ${binaryName(process.platform)} in it`);
    }
    fs.chmodSync(bin, 0o755);
    return bin;
}

function placeBinary(staged: string, tag: string) {
    fs.renameSync(staged, binPath());
    fs.rmSync(path.join(dir(), 'download'), { recursive: true, force: true });
    return setState({ version: tag });
}

// ---------------------------------------------------------------- config

function freePort(preferred: number): Promise<number> {
    const tryPort = (p: number) => new Promise<number>((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(p, () => {
            const got = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(got));
        });
    });
    return tryPort(preferred).catch(() => tryPort(0));
}

const random = (bytes: number) => crypto.randomBytes(bytes).toString('base64');

// A self-signed certificate for this machine, from orgs itself (orgs cert),
// at crtPath/keyPath. force replaces one already there. False when this orgs
// is too old to make one.
async function makeCertificate(force = false): Promise<boolean> {
    try {
        await orgsCli(['cert', '-crt', crtPath(), '-key', keyPath(), ...(force ? ['-force'] : [])]);
        return fs.existsSync(crtPath()) && fs.existsSync(keyPath());
    } catch (e) {
        return false;
    }
}

async function configure(orgDir: string) {
    const keystore = path.join(dir(), 'keystore.yaml');
    const config: OrgsConfig = {
        port: await freePort(DEFAULT_PORT),
        orgDirs: [orgDir],
        keystore,
        salt: random(24),
        jws: random(32),
        jwe: random(32),
        dayPagePath: path.join(orgDir, 'daypages'),
    };
    // https only, unless this orgs cannot make the certificate for it: then
    // http until an update that can (upgradeToHttps).
    fs.writeFileSync(configPath(), orgsYaml(config), { mode: 0o600 });
    if (await makeCertificate(true)) {
        fs.writeFileSync(configPath(), orgsYaml({ ...config, tls: { crt: crtPath(), key: keyPath() } }), { mode: 0o600 });
    }
    trustOwnCertificate();
    // A fresh keystore each time: its salt is the one just written.
    fs.rmSync(keystore, { force: true });
    const password = random(24);
    // -password because there is no terminal to be asked on. It is on this
    // process's command line for the moment orgs takes to hash it.
    await run(binPath(), ['-config', configPath(), 'user', 'add', ORGS_USER, '-admin', '-password', password], { cwd: dir() });
    await ctx.secrets.store(PASSWORD_KEY, password);
}

// ---------------------------------------------------------------- running

function readPid(): number | undefined {
    try {
        const pid = parseInt(fs.readFileSync(pidPath(), 'utf8'), 10);
        return pid > 0 ? pid : undefined;
    } catch (e) {
        return undefined;
    }
}

// Whether pid is still an orgs - a pid file can outlive its process, and the
// number be handed to something else.
async function isOrgs(pid: number): Promise<boolean> {
    try {
        const out = process.platform === 'win32'
            ? await run('tasklist', ['/FI', `PID eq ${pid}`, '/NH'])
            : await run('ps', ['-p', String(pid), '-o', 'comm=']);
        return /\borgs(\.exe)?\b/i.test(out);
    } catch (e) {
        return false;
    }
}

function lastLines(file: string, n: number): string {
    try {
        return fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-n).join('\n');
    } catch (e) {
        return '';
    }
}

// Starts the server unless one already answers, and waits until it does.
export async function start(): Promise<void> {
    if (await isUp()) {
        return;
    }
    // Two windows opening at once would each start one; the second could not
    // have the port. The one that holds the lock starts it, the other waits.
    let lock: number | undefined;
    try {
        lock = fs.openSync(lockPath(), 'wx');
    } catch (e) {
        const age = Date.now() - fs.statSync(lockPath()).mtimeMs;
        if (age > START_TIMEOUT_MS) {
            fs.rmSync(lockPath(), { force: true });
            return start();
        }
        for (const end = Date.now() + START_TIMEOUT_MS; Date.now() < end; await sleep(500)) {
            if (await isUp()) {
                return;
            }
        }
        throw new Error('orgs did not start (another window was starting it)');
    }
    try {
        const out = fs.openSync(logPath(), 'w');
        // -port as well as server.port: orgs serve's own -port default of 8010
        // wins over the config's otherwise.
        // -tlsport likewise, for the https only server.
        const child = spawn(binPath(), ['-config', configPath(), 'serve', '-port', String(port()),
            ...(isHttps() ? ['-tlsport', String(port())] : [])], {
            cwd: dir(), detached: true, stdio: ['ignore', out, out], windowsHide: true,
        });
        fs.closeSync(out);
        let exited: number | null | undefined;
        let failed: Error | undefined;
        child.once('exit', code => exited = code);
        child.once('error', err => failed = err);
        child.unref();
        for (const end = Date.now() + START_TIMEOUT_MS; ; await sleep(500)) {
            if (failed) {
                throw failed;
            }
            if (exited !== undefined) {
                throw new Error(`orgs stopped as it started (exit ${exited}):\n${lastLines(logPath(), 5)}`);
            }
            if (await isUp()) {
                break;
            }
            if (Date.now() > end) {
                throw new Error(`orgs did not answer on ${serverUrl()} within ${START_TIMEOUT_MS / 1000}s - see Org: Show orgs Server Log`);
            }
        }
        fs.writeFileSync(pidPath(), String(child.pid));
    } finally {
        fs.closeSync(lock);
        fs.rmSync(lockPath(), { force: true });
    }
    Auth.get().probe();
}

export async function stop(): Promise<boolean> {
    const pid = readPid();
    if (pid && await isOrgs(pid)) {
        try {
            process.kill(pid);
        } catch (e) {
            // Gone already.
        }
        for (const end = Date.now() + 10_000; Date.now() < end && await isUp(); await sleep(250)) {
            // Waiting for the port to close.
        }
    }
    fs.rmSync(pidPath(), { force: true });
    Auth.get().probe();
    return !await isUp();
}

// The local server's own orgs run as a command line on its config - for
// `orgs user`, which edits the keystore file rather than asking the server.
export function orgsCli(args: string[]): Promise<string> {
    return run(binPath(), ['-config', configPath(), ...args], { cwd: dir() });
}

// Runs fn with the local server stopped, and starts it again after if it was
// running. For edits to its keystore: the server reads it only when it starts,
// and writes it back on each login, which would put back what fn took out.
export async function withServerStopped<T>(fn: () => Promise<T>): Promise<T> {
    const wasUp = await isUp();
    if (wasUp && !await stop()) {
        throw new Error('the running orgs would not stop');
    }
    try {
        return await fn();
    } finally {
        if (wasUp) {
            await start();
            // Logged in again only if the plugin talks to it: connect would
            // otherwise point it away from a server the user chose.
            if (isManaged()) {
                await connect();
            }
        }
    }
}

// A server set up on http (before https, or by an orgs that could not make a
// certificate) moves to https only once its orgs can: a certificate, the
// config's server: settings for it, a restart, and the plugin pointed at the
// new address if it was pointed at the old one. Quiet when it cannot yet.
async function upgradeToHttps(): Promise<void> {
    if (!isInstalled() || isHttps()) {
        return;
    }
    const wasManaged = isManaged();
    // Not forced: another window moving it at the same moment makes the same
    // pair, rather than each one trusting a certificate the other replaced.
    if (!await makeCertificate()) {
        return;
    }
    try {
        await withServerStopped(async () => {
            const yaml = fs.readFileSync(configPath(), 'utf8');
            fs.writeFileSync(configPath(), withHttps(yaml, port(), { crt: crtPath(), key: keyPath() }), { mode: 0o600 });
            trustOwnCertificate();
            if (wasManaged) {
                await Sets.setProp('orgsConnection', serverUrl());
            }
        });
    } catch (e) {
        return report(e, 'Moving the local orgs server to https failed');
    }
    vscode.window.showInformationMessage(`The local orgs server now answers on ${serverUrl()} only, with a certificate of its own.`);
}

// A certificate with under a month left is replaced, and the server restarted
// to serve the new one.
async function renewCertificate(): Promise<void> {
    if (!isInstalled() || !isHttps()) {
        return;
    }
    try {
        const left = new Date(new crypto.X509Certificate(fs.readFileSync(crtPath())).validTo).getTime() - Date.now();
        if (left > 30 * 24 * 60 * 60 * 1000) {
            return;
        }
    } catch (e) {
        // Missing or unreadable: make one.
    }
    if (await makeCertificate(true)) {
        await withServerStopped(async () => trustOwnCertificate());
    }
}

// Points the plugin at the server and logs in.
async function connect() {
    if (!isManaged()) {
        await Sets.setProp('orgsConnection', serverUrl());
    }
    if (await Auth.get().probe() !== 'unreachable' && !Auth.get().isLoggedIn()) {
        await Auth.get().ensureLoggedIn();
    }
}

function report(e: any, what: string) {
    vscode.window.showErrorMessage(`${what}: ${e && e.message || e}`, 'Show Log').then(b => b && showLog());
}

// ---------------------------------------------------------------- commands

async function pickOrgDir(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length) {
        const pick = await vscode.window.showQuickPick(
            [...folders.map(f => ({ label: '$(folder) ' + f.name, description: f.uri.fsPath, dir: f.uri.fsPath })),
                { label: '$(folder-opened) Choose another folder…', description: '', dir: '' }],
            { placeHolder: 'Which folder of org files should orgs read?' });
        if (!pick) {
            return undefined;
        }
        if (pick.dir) {
            return pick.dir;
        }
    }
    const chosen = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Read these org files', title: 'The folder of org files orgs should read',
    });
    return chosen && chosen[0].fsPath;
}

async function setUp() {
    if (isInstalled()) {
        return serverMenu();
    }
    let release: Release;
    try {
        release = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Looking up orgs' }, latestRelease);
    } catch (e) {
        return report(e, 'Could not find an orgs release');
    }
    if (!assetName(release.tag, process.platform, process.arch)) {
        vscode.window.showErrorMessage(`orgs has no build for ${process.platform}/${process.arch}. Build it from github.com/${ORGS_REPO} and set Org: Orgs Connection.`);
        return;
    }
    const go = await vscode.window.showInformationMessage(
        `Download orgs ${release.tag} from github.com/${ORGS_REPO} and run it on this machine?`,
        { modal: true, detail: 'It reads the org files in a folder you choose and serves the agenda, clocking, refile, export and the rest. It runs in the background, only you can log in to it, and it does not run code blocks unless you turn that on in its config.' },
        'Download and Set Up');
    if (!go) {
        return;
    }
    const orgDir = await pickOrgDir();
    if (!orgDir) {
        return;
    }
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'orgs' }, async progress => {
            const say = (message: string, increment?: number) => progress.report({ message, increment });
            fs.mkdirSync(dir(), { recursive: true });
            await placeBinary(await fetchBinary(release, say), release.tag);
            say('Writing its config', 5);
            await configure(orgDir);
            say(`Starting - reading ${orgDir}`, 5);
            await start();
            say('Connecting', 5);
            await connect();
            updateTerminalPath();
        });
    } catch (e) {
        // A half set-up server is not one: the next try starts over.
        fs.rmSync(configPath(), { force: true });
        return report(e, 'Setting up orgs failed');
    }
    const next = await vscode.window.showInformationMessage(
        `orgs ${release.tag} is running at ${serverUrl()}, reading ${orgDir}.` +
        (isHttps() ? '' : ' This release cannot make a certificate, so it is on http until an update that can.'),
        'Show Agenda', 'Edit Its Config');
    if (next === 'Show Agenda') {
        vscode.commands.executeCommand('org.showAgenda');
    } else if (next === 'Edit Its Config') {
        openConfig();
    }
}

async function update(release?: Release) {
    if (!isInstalled()) {
        return setUp();
    }
    try {
        release = release || await latestRelease();
    } catch (e) {
        return report(e, 'Could not look for an orgs update');
    }
    const have = state().version;
    if (!isNewer(release.tag, have)) {
        vscode.window.showInformationMessage(`orgs ${have} is the latest release.`);
        return;
    }
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'orgs' }, async progress => {
            const say = (message: string, increment?: number) => progress.report({ message, increment });
            const staged = await fetchBinary(release, say);
            say('Restarting');
            const wasUp = await isUp();
            if (wasUp && !await stop()) {
                throw new Error('the running orgs would not stop');
            }
            await placeBinary(staged, release.tag);
            if (wasUp) {
                await start();
                await connect();
            }
            // A release that can make a certificate takes the server to https.
            await upgradeToHttps();
        });
    } catch (e) {
        return report(e, 'Updating orgs failed');
    }
    vscode.window.showInformationMessage(`orgs is now ${release.tag}.`, 'Release Notes')
        .then(b => b && vscode.env.openExternal(vscode.Uri.parse(release.page)));
}

async function checkForUpdate() {
    const s = state();
    if (!Sets.orgsServerCheckForUpdates || Date.now() - (s.lastCheck || 0) < 24 * 60 * 60 * 1000) {
        return;
    }
    await setState({ lastCheck: Date.now() });
    let release: Release;
    try {
        release = await latestRelease();
    } catch (e) {
        return; // Offline, or github is busy: tomorrow.
    }
    if (!isNewer(release.tag, s.version) || release.tag === s.skipped) {
        return;
    }
    const b = await vscode.window.showInformationMessage(
        `orgs ${release.tag} is out (you have ${s.version}).`, 'Update', 'Release Notes', 'Skip This Version');
    if (b === 'Update') {
        update(release);
    } else if (b === 'Release Notes') {
        vscode.env.openExternal(vscode.Uri.parse(release.page));
    } else if (b === 'Skip This Version') {
        setState({ skipped: release.tag });
    }
}

async function startCommand() {
    if (!isInstalled()) {
        return setUp();
    }
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Starting orgs' }, start);
        await connect();
    } catch (e) {
        report(e, 'orgs did not start');
    }
}

async function stopCommand() {
    if (await stop()) {
        vscode.window.setStatusBarMessage('orgs stopped', 3000);
    } else {
        vscode.window.showWarningMessage(`Something still answers on ${serverUrl()}, and it is not an orgs this plugin started.`);
    }
}

async function restart() {
    await stop();
    return startCommand();
}

function openConfig() {
    if (!isInstalled()) {
        return setUp();
    }
    return vscode.window.showTextDocument(vscode.Uri.file(configPath()));
}

function showLog() {
    if (fs.existsSync(logPath())) {
        vscode.window.showTextDocument(vscode.Uri.file(logPath()), { preview: true });
    } else {
        vscode.window.showInformationMessage('orgs has not been started from here yet, so there is no log.');
    }
}

async function copyPassword() {
    const password = await ctx.secrets.get(PASSWORD_KEY);
    if (!password) {
        vscode.window.showWarningMessage('There is no password kept for the local orgs server. Org: Set Up a Local orgs Server makes one when it sets it up.');
        return;
    }
    await vscode.env.clipboard.writeText(password);
    vscode.window.setStatusBarMessage(`Copied the password for ${ORGS_USER}`, 3000);
}

// VS Code's terminals get this server's own orgs first on PATH: it reads the
// orgs.yaml beside it, which is this server's, keys and all, so `orgs agenda`
// there makes its own token and nobody is asked for a password (orgs'
// localtoken.go). Terminals already open keep the PATH they had.
function updateTerminalPath() {
    const env = ctx.environmentVariableCollection;
    env.delete('PATH');
    if (isInstalled() && Sets.orgsServerAddToTerminalPath) {
        env.prepend('PATH', dir() + path.delimiter);
    }
}

async function useFromTerminal() {
    const bin = binPath();
    const quoted = /\s/.test(bin) ? `"${bin}"` : bin;
    const b = await vscode.window.showInformationMessage(
        'In VS Code\'s terminals `orgs` is this server\'s own and needs no login. Anywhere else, run it by its path ' +
        '(it reads the orgs.yaml beside it, so it needs no login either), or alias it: ' +
        `alias orgs='${quoted}'`,
        { modal: true, detail: bin }, 'Copy Its Path', 'Open a Terminal');
    if (b === 'Copy Its Path') {
        await vscode.env.clipboard.writeText(quoted);
        vscode.window.setStatusBarMessage('Copied the path of orgs', 3000);
    } else if (b === 'Open a Terminal') {
        vscode.window.createTerminal({ name: 'orgs' }).show();
    }
}

// Browsers warn about a self-signed certificate until it is trusted. This
// adds the server's own to the user's trust store - the login keychain, or
// the current user's root store on windows; each asks the user first. Done
// again after a renewal (every couple of years).
async function trustInBrowsers() {
    const crt = crtPath();
    try {
        if (process.platform === 'darwin') {
            await run('security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl',
                '-k', path.join(process.env.HOME || '', 'Library/Keychains/login.keychain-db'), crt]);
        } else if (process.platform === 'win32') {
            await run('certutil', ['-user', '-addstore', 'Root', crt]);
        } else {
            const b = await vscode.window.showInformationMessage(
                'On linux each browser keeps its own list: import this certificate as an authority in its settings ' +
                '(Chrome: Privacy and security > Security > Manage certificates; Firefox: Settings > Certificates).',
                { modal: true, detail: crt }, 'Copy Its Path');
            if (b) {
                await vscode.env.clipboard.writeText(crt);
            }
            return;
        }
    } catch (e) {
        return report(e, 'Could not add the certificate');
    }
    vscode.window.showInformationMessage(`Browsers on this machine now trust ${serverUrl()} (Firefox keeps its own list, and may still ask).`);
}

async function serverMenu() {
    const up = await isUp();
    const items = [
        up ? { label: '$(debug-restart) Restart', run: restart } : { label: '$(play) Start', run: startCommand },
        up ? { label: '$(debug-stop) Stop', run: stopCommand } : undefined,
        { label: '$(cloud-download) Check for an update', description: state().version, run: () => update() },
        { label: '$(gear) Edit its config', description: 'orgs.yaml', run: openConfig },
        { label: '$(output) Show its log', run: showLog },
        { label: '$(book) Read the orgs docs', run: () => vscode.commands.executeCommand('org.showOrgsDocs') },
        up ? { label: '$(link-external) Open worg in the browser', description: 'logged in for you', run: () => vscode.commands.executeCommand('org.openWorgInBrowser') } : undefined,
        isHttps() ? { label: '$(shield) Trust its certificate in browsers', description: 'so they stop warning about it', run: trustInBrowsers } : undefined,
        { label: '$(terminal) Use it from a terminal', description: 'the orgs command line, no login', run: useFromTerminal },
        { label: '$(person-add) Users and passwords', description: 'add a login of your own for worg or the command line', run: () => vscode.commands.executeCommand('org.manageOrgsUsers') },
        { label: '$(key) Copy its password', description: `to log in by hand - user ${ORGS_USER}`, run: copyPassword },
        isManaged() ? undefined : { label: '$(plug) Connect to it', description: serverUrl(), run: connect },
    ].filter(x => x);
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Local orgs server ${state().version || ''} at ${serverUrl()}: ${up ? 'running' : 'stopped'}`,
    });
    return pick && pick.run();
}

// The config was saved: orgs takes most of it without a restart.
async function configSaved(doc: vscode.TextDocument) {
    if (!isInstalled() || path.resolve(doc.uri.fsPath) !== path.resolve(configPath()) || !await isUp()) {
        return;
    }
    if (!isManaged()) {
        return;
    }
    try {
        const res = await ODb.apiPost<{ needsRestart?: string[], msg?: string }>('/reloadconfig', {});
        const needs = (res && res.needsRestart) || [];
        if (needs.length) {
            const b = await vscode.window.showInformationMessage(`orgs needs a restart for: ${needs.join(', ')}.`, 'Restart');
            if (b) {
                restart();
            }
        } else {
            vscode.window.setStatusBarMessage('orgs reloaded its config', 3000);
        }
    } catch (e) {
        report(e, 'orgs could not reload its config');
    }
}

export function activateOrgsServer(context: vscode.ExtensionContext) {
    ctx = context;
    Auth.get().setCredentialSource(async () => {
        if (!isManaged()) {
            return undefined;
        }
        const password = await ctx.secrets.get(PASSWORD_KEY);
        return password ? { username: ORGS_USER, password } : undefined;
    });
    context.subscriptions.push(
        vscode.commands.registerCommand('org.setUpOrgsServer', setUp),
        vscode.commands.registerCommand('org.startOrgsServer', startCommand),
        vscode.commands.registerCommand('org.stopOrgsServer', stopCommand),
        vscode.commands.registerCommand('org.restartOrgsServer', restart),
        vscode.commands.registerCommand('org.updateOrgsServer', () => update()),
        vscode.commands.registerCommand('org.openOrgsServerConfig', openConfig),
        vscode.commands.registerCommand('org.showOrgsServerLog', showLog),
        vscode.workspace.onDidSaveTextDocument(configSaved),
        vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('org.orgsServer.addToTerminalPath') && updateTerminalPath()),
    );
    updateTerminalPath();
    if (!isInstalled()) {
        return;
    }
    trustOwnCertificate();
    // Another window may make or renew it: trust what is on disk.
    fs.watchFile(crtPath(), { interval: 5000 }, () => trustOwnCertificate());
    context.subscriptions.push({ dispose: () => fs.unwatchFile(crtPath()) });
    (async () => {
        try {
            await upgradeToHttps();
            await renewCertificate();
        } catch (e) {
            report(e, 'The local orgs server\'s certificate');
        }
        if (isManaged() && Sets.orgsServerAutoStart && !await isUp()) {
            try {
                await start();
            } catch (e) {
                report(e, 'The local orgs server did not start');
                return;
            }
        }
        if (isManaged() && !Auth.get().isLoggedIn() && await Auth.get().probe() === 'closed') {
            await Auth.get().ensureLoggedIn();
        }
        await checkForUpdate();
    })();
}
