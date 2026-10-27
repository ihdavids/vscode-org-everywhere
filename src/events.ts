// The orgs server's event stream (GET /events, server-sent events), shared by
// everything in the extension that wants to know when something changed: the
// agenda and clock views, saved-query watches, the focus timer.
//
// One connection for the whole extension, asking for the union of the kinds
// its listeners want (each listener is handed only its own, and `hello`). It
// is opened when the first listener comes, opened again when the kinds wanted
// change, the login changes or org.orgsConnection does, and closed when the
// last listener goes. A dropped stream is tried again, waiting longer each
// time (events-model.ts' backoff), and a stream that has said nothing for a
// minute - the server beats every twenty seconds - is taken as dropped: a
// laptop that slept leaves a socket that looks open and never speaks again.
//
// Unlike worg's EventSource this can send the bearer token, so the stream is
// the logged-in user's: querymatch events only go to the watch's owner.
// org.liveEvents false turns it off; everything then falls back on its polls.
import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { Sets } from './sets';
import { Auth, orgsAgent } from './auth';
import { SseParser, parseEvent, wantedKinds, eventsPath, wants, backoff } from './events-model';

export interface OrgsEvent {
    kind: string;
    data: any;
}

type Listener = { kinds: string[]; fn: (ev: OrgsEvent) => void };

const listeners = new Set<Listener>();
let conn: Connection | undefined;
let reconcileTimer: NodeJS.Timeout | undefined;
let watching: vscode.Disposable[] = [];

// Up or down, so a poller can poll faster while the stream is down.
let live = false;
const liveChanged = new vscode.EventEmitter<boolean>();
export const onStreamLive = liveChanged.event;
export function isStreamLive(): boolean {
    return live;
}

function setLive(on: boolean) {
    if (on !== live) {
        live = on;
        liveChanged.fire(on);
    }
}

// Listen for events of these kinds ([] for all). The stream is opened while
// anyone listens and closed when the last listener is disposed.
export function onOrgsEvent(kinds: string[], listener: (ev: OrgsEvent) => void): vscode.Disposable {
    const l: Listener = { kinds: kinds.map(k => k.trim()).filter(k => k), fn: listener };
    listeners.add(l);
    reconcile();
    return new vscode.Disposable(() => {
        if (listeners.delete(l)) {
            reconcile();
        }
    });
}

function enabled(): boolean {
    return vscode.workspace.getConfiguration('org').get<boolean>('liveEvents', true) !== false;
}

function dispatch(ev: OrgsEvent) {
    Array.from(listeners).forEach(l => {
        if (wants(l.kinds, ev.kind)) {
            try {
                l.fn(ev);
            } catch (e) {
                console.error('orgs event listener failed', e);
            }
        }
    });
}

// Opens, reopens or closes the stream to carry what is wanted, once the
// listeners arriving together (activation) have all said what they want.
// `force` reopens even when the kinds are the same: a new login or server.
function reconcile(force = false) {
    if (reconcileTimer) {
        clearTimeout(reconcileTimer);
    }
    reconcileTimer = setTimeout(() => {
        reconcileTimer = undefined;
        const kinds = enabled() ? wantedKinds(Array.from(listeners).map(l => l.kinds)) : '';
        if (conn && conn.kinds === kinds && !force) {
            return;
        }
        if (conn) {
            conn.close();
            conn = undefined;
        }
        if (!kinds) {
            setLive(false);
            stopWatching();
            return;
        }
        startWatching();
        conn = new Connection(kinds);
    }, 0);
}

// What reopens the stream, followed only while there is one.
function startWatching() {
    if (watching.length) {
        return;
    }
    watching = [
        // A login, a logout, a refresh: the stream is somebody's, so a new
        // token is a new stream. (A login made by connect() itself comes back
        // here with the token it already used, and is let be.)
        Auth.get().onTokenChanged(t => {
            if (!conn || conn.token !== (t ? t.token : null) || !live) {
                reconcile(true);
            }
        }),
        // The server is back (or wants no login now): try at once rather than
        // at the end of a long backoff.
        Auth.get().onAccessChanged(state => {
            if (state !== 'unreachable' && !live) {
                reconcile(true);
            }
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('org.orgsConnection') || e.affectsConfiguration('org.allowSelfSigned') ||
                e.affectsConfiguration('org.liveEvents')) {
                reconcile(true);
            }
        }),
    ];
}

function stopWatching() {
    watching.forEach(d => d.dispose());
    watching = [];
}

// How long a stream may say nothing before it is taken as dead: three beats.
const SILENCE = 60 * 1000;

class Connection {
    token: string | null = null;
    private req: http.ClientRequest | undefined;
    private closed = false;
    private attempt = 0;
    private retryTimer: NodeJS.Timeout | undefined;
    private quiet: NodeJS.Timeout | undefined;
    // Bumped per request, so the end, error and close of one request retry once.
    private generation = 0;

    constructor(public kinds: string) {
        this.connect();
    }

    private async connect() {
        if (this.closed) {
            return;
        }
        // Quietly: a stream is no reason to pop the login page. Without a
        // login it waits for one (onTokenChanged opens it again).
        if (!(await Auth.get().quietLogin()) || this.closed) {
            setLive(false);
            return;
        }
        let url: URL;
        try {
            url = new URL(Sets.orgsConnection + eventsPath(this.kinds));
        } catch (e) {
            setLive(false);
            return;
        }
        const gen = ++this.generation;
        this.token = Auth.get().getToken();
        const headers: { [k: string]: string } = { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' };
        if (this.token) {
            headers['Authorization'] = 'Bearer ' + this.token;
        }
        const parser = new SseParser();
        // https.request takes what http.request does, and the tls options besides.
        const mod: typeof http = url.protocol === 'https:' ? (https as unknown as typeof http) : http;
        const req = mod.request(url, { method: 'GET', headers, agent: orgsAgent() }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                if (res.statusCode === 401 || res.statusCode === 403) {
                    // Refused: perhaps the server wants a login now.
                    Auth.get().probe();
                }
                this.retry(gen);
                return;
            }
            res.setEncoding('utf8');
            this.attempt = 0;
            setLive(true);
            this.heard(gen);
            res.on('data', (chunk: string) => {
                this.heard(gen);
                for (const d of parser.feed(chunk)) {
                    const ev = parseEvent(d);
                    if (ev) {
                        dispatch(ev);
                    }
                }
            });
            res.on('end', () => this.retry(gen));
            res.on('error', () => this.retry(gen));
            res.on('close', () => this.retry(gen));
        });
        req.on('error', () => this.retry(gen));
        req.end();
        this.req = req;
    }

    // Something arrived: the stream is alive for another while.
    private heard(gen: number) {
        if (this.quiet) {
            clearTimeout(this.quiet);
        }
        this.quiet = setTimeout(() => {
            if (this.req) {
                this.req.destroy();
            }
            this.retry(gen);
        }, SILENCE);
    }

    private retry(gen: number) {
        if (this.closed || gen !== this.generation) {
            return;
        }
        this.generation++;
        if (this.quiet) {
            clearTimeout(this.quiet);
            this.quiet = undefined;
        }
        if (this.req) {
            this.req.destroy();
            this.req = undefined;
        }
        setLive(false);
        const wait = backoff(this.attempt++);
        this.retryTimer = setTimeout(() => this.connect(), wait);
    }

    close() {
        this.closed = true;
        this.generation++;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
        }
        if (this.quiet) {
            clearTimeout(this.quiet);
        }
        if (this.req) {
            this.req.destroy();
            this.req = undefined;
        }
    }
}

// Closes the stream for good, when the extension goes.
export function closeOrgsEvents() {
    listeners.clear();
    if (reconcileTimer) {
        clearTimeout(reconcileTimer);
        reconcileTimer = undefined;
    }
    if (conn) {
        conn.close();
        conn = undefined;
    }
    stopWatching();
    setLive(false);
}
