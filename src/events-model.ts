// The pure half of the event stream (events.ts): reading server-sent events
// out of the bytes as they arrive, deciding which kinds to ask the server for,
// and how long to wait before trying again. No vscode here, so
// test/events.test.ts can pin it.
//
// The server's side is orgs/internal/app/orgs/events.go: GET /events, an
// optional ?kinds=a,b, and one `data: {json}` line per event followed by a
// blank line, with a `: beat` comment every twenty seconds.

// Turns the stream's text into the data of each event. Text arrives in
// whatever pieces the network makes of it, so a line - even a character - can
// be cut in two; what is left over waits for the next piece.
export class SseParser {
    private buf = '';
    private data: string[] = [];

    // Feeds a piece of the stream in; answers the data of every event it
    // completed (an event's data lines joined with newlines, as the spec says).
    feed(chunk: string): string[] {
        this.buf += chunk;
        const out: string[] = [];
        let nl: number;
        while ((nl = this.buf.search(/\r\n|\r|\n/)) >= 0) {
            // A lone \r at the very end may be the first half of \r\n.
            if (this.buf[nl] === '\r' && nl === this.buf.length - 1) {
                break;
            }
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + (this.buf.startsWith('\r\n', nl) ? 2 : 1));
            if (line === '') {
                if (this.data.length) {
                    out.push(this.data.join('\n'));
                }
                this.data = [];
            } else if (line.startsWith(':')) {
                // A comment: the heartbeat. Nothing to hand on.
            } else {
                const colon = line.indexOf(':');
                const field = colon < 0 ? line : line.slice(0, colon);
                let value = colon < 0 ? '' : line.slice(colon + 1);
                if (value.startsWith(' ')) {
                    value = value.slice(1);
                }
                if (field === 'data') {
                    this.data.push(value);
                }
                // event:, id: and retry: are not used by the orgs server.
            }
        }
        return out;
    }

    reset() {
        this.buf = '';
        this.data = [];
    }
}

// What one event's data means: its parsed JSON, or null for anything that is
// not an object with a kind (dropped, as worg drops it).
export function parseEvent(data: string): { kind: string, data: any } | null {
    try {
        const e = JSON.parse(data);
        if (e && typeof e === 'object' && typeof e.kind === 'string') {
            return { kind: e.kind, data: e };
        }
    } catch (err) {
        // A malformed line: skip it.
    }
    return null;
}

// The kinds to ask for, given what each listener wants: the union, sorted and
// comma separated so two sets that are the same compare the same. A listener
// wanting every kind ([]) makes it '*': ask for everything. '' is nobody.
export function wantedKinds(sets: string[][]): string {
    if (sets.length === 0) {
        return '';
    }
    if (sets.some(s => s.length === 0)) {
        return '*';
    }
    const all = new Set<string>();
    sets.forEach(s => s.forEach(k => k && all.add(k.trim())));
    all.delete('');
    return all.size ? Array.from(all).sort().join(',') : '*';
}

// The query string for wantedKinds' answer. The server filters even its own
// `hello` by ?kinds=, so hello is always asked for: it is how a listener
// hears that the stream is (back) up.
export function eventsPath(kinds: string): string {
    if (!kinds || kinds === '*') {
        return '/events';
    }
    const list = kinds.split(',').filter(k => k);
    if (list.indexOf('hello') < 0) {
        list.push('hello');
    }
    return '/events?kinds=' + encodeURIComponent(list.join(','));
}

// Whether a listener gets an event. `hello` is the stream saying it is (back)
// up, which everybody wants to hear: whatever they show may have moved while
// it was down.
export function wants(kinds: string[], kind: string): boolean {
    return kinds.length === 0 || kind === 'hello' || kinds.indexOf(kind) >= 0;
}

// How long to wait before the n'th attempt in a row to reconnect (n from 0):
// one second, doubling, at most a minute, with a little jitter so a server
// that restarts is not met by every client in the same instant.
export function backoff(n: number, random: () => number = Math.random): number {
    const base = Math.min(60000, 1000 * Math.pow(2, Math.max(0, n)));
    return Math.round(base * (0.8 + 0.4 * random()));
}
