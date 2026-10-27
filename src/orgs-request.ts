// A request to the orgs server that never asks anybody anything: no login
// page, no error message. For what runs by itself - a poll, a refresh after an
// event - where ODb.doGet's "log in" page or "connection refused" toast every
// minute would be worse than saying nothing. Also the DELETE that ODb lacks.
//
// Undefined when there is no login to be had quietly, or the server could not
// be reached; otherwise the parsed JSON body, whatever the status (the orgs
// server explains a refusal in the body: {ok: false, msg}).
import * as http from 'http';
import * as https from 'https';
import { Sets } from './sets';
import { Auth, orgsAgent } from './auth';

export async function orgsRequest<T>(method: 'GET' | 'POST' | 'DELETE', path: string,
    params: { [k: string]: string } = {}, body?: any): Promise<T | undefined> {
    if (!(await Auth.get().quietLogin())) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(Sets.orgsConnection + path);
    } catch (e) {
        return undefined;
    }
    Object.keys(params).forEach(k => url.searchParams.append(k, params[k]));
    const headers: { [k: string]: string } = { 'Accept': 'application/json' };
    const token = Auth.get().getToken();
    if (token) {
        headers['Authorization'] = 'Bearer ' + token;
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(payload.length);
    }
    const mod: typeof http = url.protocol === 'https:' ? (https as unknown as typeof http) : http;
    return new Promise<T | undefined>(resolve => {
        const req = mod.request(url, { method, headers, agent: orgsAgent(), timeout: 15000 }, res => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode === 401) {
                    // The token was refused: let Auth find out, quietly.
                    Auth.get().probe();
                    resolve(undefined);
                    return;
                }
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
                } catch (e) {
                    resolve(undefined);
                }
            });
            res.on('error', () => resolve(undefined));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(undefined));
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}
