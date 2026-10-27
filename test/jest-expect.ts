// Just enough of jest's expect() for the scenarios ported from worg's tests
// (kanban.test.ts, planner.test.ts) to read as they do there, line for line,
// so the three twins (worg, the Go server, this) stay easy to compare.
import * as assert from 'assert';

type Matchers = {
    toBe(want: any): void;
    toEqual(want: any): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeGreaterThan(n: number): void;
    toBeLessThan(n: number): void;
    toMatch(re: RegExp): void;
    toContain(v: any): void;
};

function matchers(got: any, negate: boolean): Matchers {
    const check = (ok: boolean, msg: string) => assert.ok(negate ? !ok : ok, (negate ? 'not ' : '') + msg);
    const equal = (a: any, b: any) => {
        try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
    };
    return {
        toBe: want => check(Object.is(got, want), `${JSON.stringify(got)} to be ${JSON.stringify(want)}`),
        toEqual: want => check(equal(got, want), `${JSON.stringify(got)} to equal ${JSON.stringify(want)}`),
        toBeNull: () => check(got === null, `${JSON.stringify(got)} to be null`),
        toBeUndefined: () => check(got === undefined, `${JSON.stringify(got)} to be undefined`),
        toBeGreaterThan: n => check(got > n, `${got} > ${n}`),
        toBeLessThan: n => check(got < n, `${got} < ${n}`),
        toMatch: re => check(re.test(String(got)), `${got} to match ${re}`),
        toContain: v => check(got.indexOf(v) >= 0, `${JSON.stringify(got)} to contain ${JSON.stringify(v)}`),
    };
}

export function expect(got: any): Matchers & { not: Matchers } {
    return Object.assign(matchers(got, false), { not: matchers(got, true) });
}
