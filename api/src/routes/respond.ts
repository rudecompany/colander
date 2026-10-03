// What the API routes share (Go's internal/api/respond.go): strict JSON request decoding, the time
// and string forms of the wire, and Go's string, number and listfmt helpers the handlers lean on.
// JSON responses, errors and 429s come from src/http.ts and the token buckets from src/limits.ts.
import { IP_HASH_HEADER, jsonError } from '../http';
import { SIGNALS, TESTS, TEST_BIT, VERDICTS, type Signal, type Test } from '@colander/shared/verdicts';

/** Reads at most limit bytes of a body. Null when it is longer. */
export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
	if (!body) return new Uint8Array();
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

/**
 * Field kinds of a request body, as Go's struct fields decode them: `string` and `bool` keep their
 * zero value on null, `?` kinds are pointers (null or absent is undefined), `strings` is a []string
 * (undefined is nil), `[schema]` a slice of structs. `int?` (a *int64) and `raw` (a
 * json.RawMessage, the value's JSON text) need the value as written, so they work on top-level
 * fields only.
 */
type Kind = 'string' | 'string?' | 'bool' | 'bool?' | 'int?' | 'strings' | 'raw' | readonly [Schema];
export type Schema = { readonly [field: string]: Kind };
type Value<K> = K extends 'string'
	? string
	: K extends 'string?'
		? string | undefined
		: K extends 'bool'
			? boolean
			: K extends 'bool?'
				? boolean | undefined
				: K extends 'int?'
					? number | undefined
					: K extends 'strings'
						? string[] | undefined
						: K extends 'raw'
							? string
							: K extends readonly [infer S extends Schema]
								? Decoded<S>[] | undefined
								: never;
export type Decoded<S extends Schema> = { -readonly [F in keyof S]: Value<S[F]> };

/** A body that does not decode: an unknown field (Go's DisallowUnknownFields) or anything else. */
class DecodeError extends Error {
	constructor(readonly unknownField?: string) {
		super('decode');
	}
}

/**
 * Go's case folding of JSON field names: ASCII letters, plus the two non-ASCII runes that fold to
 * one (U+017F to S, U+212A to K). Field names are ASCII, so no other rune can match one.
 */
const fold = (s: string): string => s.replace(/[a-zſK]/g, (c) => (c === 'ſ' ? 'S' : c === 'K' ? 'K' : c.toUpperCase()));

/** The schema field a JSON key sets: the exact name first, then a case-insensitive match (Go's rule). */
function fieldFor(schema: Schema, key: string): string | undefined {
	if (Object.hasOwn(schema, key)) return key;
	const f = fold(key);
	return Object.keys(schema).find((k) => fold(k) === f);
}

const zero = (kind: Kind): unknown => (kind === 'string' || kind === 'raw' ? '' : kind === 'bool' ? false : undefined);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Go decodes a JSON string with lone surrogate escapes to U+FFFD. */
function str(v: unknown): string {
	if (typeof v !== 'string') throw new DecodeError();
	return v.toWellFormed();
}

function inInt64(lit: string): boolean {
	const n = BigInt(lit);
	return n >= -(2n ** 63n) && n < 2n ** 63n;
}

function decodeValue(kind: Kind, v: unknown, raw: string | undefined, current: unknown): unknown {
	if ((kind === 'raw' || kind === 'int?') && raw === undefined) throw new Error(`${kind} fields must be top-level`);
	if (kind === 'raw') return raw;
	if (v === null) return kind === 'string' || kind === 'bool' ? current : undefined;
	switch (kind) {
		case 'string':
		case 'string?':
			return str(v);
		case 'bool':
		case 'bool?':
			if (typeof v !== 'boolean') throw new DecodeError();
			return v;
		case 'int?':
			if (!/^-?(?:0|[1-9]\d*)$/.test(raw!) || !inInt64(raw!)) throw new DecodeError();
			return Number(raw);
		case 'strings':
			if (!Array.isArray(v)) throw new DecodeError();
			return v.map((e) => (e === null ? '' : str(e)));
		default: {
			if (!Array.isArray(v)) throw new DecodeError();
			const schema = kind[0];
			return v.map((e) => {
				if (e === null) return decodeObject(schema, []);
				if (!isObject(e)) throw new DecodeError();
				return decodeObject(schema, Object.entries(e));
			});
		}
	}
}

/** Decodes members in document order; the first problem wins, as Go saves the first error. */
function decodeObject<S extends Schema>(schema: S, members: Iterable<[string, unknown, string?]>): Decoded<S> {
	const out: Record<string, unknown> = {};
	for (const [k, kind] of Object.entries(schema)) out[k] = zero(kind);
	for (const [key, value, raw] of members) {
		const name = fieldFor(schema, key);
		if (name === undefined) throw new DecodeError(key);
		out[name] = decodeValue(schema[name]!, value, raw, out[name]);
	}
	return out as Decoded<S>;
}

const WS = ' \t\n\r';
const skipWs = (t: string, i: number): number => {
	while (i < t.length && WS.includes(t[i]!)) i++;
	return i;
};

/** The end of the JSON value starting at i, in text already known to be valid JSON. */
function skipValue(t: string, i: number): number {
	const c = t[i];
	if (c === '"') {
		for (i++; t[i] !== '"'; i++) if (t[i] === '\\') i++;
		return i + 1;
	}
	if (c === '{' || c === '[') {
		let depth = 0;
		for (; ; i++) {
			const d = t[i];
			if (d === '"') i = skipValue(t, i) - 1;
			else if (d === '{' || d === '[') depth++;
			else if ((d === '}' || d === ']') && --depth === 0) return i + 1;
		}
	}
	while (i < t.length && !',}]'.includes(t[i]!) && !WS.includes(t[i]!)) i++;
	return i;
}

/** The members of a valid top-level JSON object as written: key, then the value's JSON text. */
function members(t: string): [string, string][] {
	const out: [string, string][] = [];
	let i = skipWs(t, skipWs(t, 0) + 1);
	while (t[i] !== '}') {
		const keyEnd = skipValue(t, i);
		const key = JSON.parse(t.slice(i, keyEnd)) as string;
		const start = skipWs(t, skipWs(t, keyEnd) + 1);
		const end = skipValue(t, start);
		out.push([key, t.slice(start, end)]);
		i = skipWs(t, end);
		if (t[i] === ',') i = skipWs(t, i + 1);
	}
	return out;
}

/** Go's json.Compact: the JSON text without insignificant whitespace, tokens as written. */
export function compact(t: string): string {
	let out = '';
	for (let i = 0; i < t.length; i++) {
		const c = t[i]!;
		if (c === '"') {
			const end = skipValue(t, i);
			out += t.slice(i, end);
			i = end - 1;
		} else if (!WS.includes(c)) {
			out += c;
		}
	}
	return out;
}

/**
 * Go's decode: reads one JSON object of at most limit bytes into the schema, refusing unknown
 * fields, trailing data and oversized bodies. Returns the decoded body, or the error response.
 */
export async function decode<S extends Schema>(request: Request, limit: number, schema: S): Promise<Decoded<S> | Response> {
	const bytes = await readLimited(request.body, limit);
	if (!bytes) return jsonError(413, 'too_large', `The request body is larger than ${limit} bytes.`);
	// Go's decoder refuses a byte order mark, so keep it in the text.
	const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
	try {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new DecodeError();
		}
		if (parsed === null) return decodeObject(schema, []);
		if (!isObject(parsed)) throw new DecodeError();
		return decodeObject(
			schema,
			members(text).map(([key, raw]): [string, unknown, string] => [key, JSON.parse(raw), raw])
		);
	} catch (err) {
		if (!(err instanceof DecodeError)) throw err;
		if (err.unknownField !== undefined) {
			return jsonError(400, 'unknown_field', `The request has a field this API does not accept: ${goQuote(err.unknownField)}.`);
		}
		return jsonError(400, 'invalid_json', 'The request body is not valid JSON for this route.');
	}
}

/** The salted hash of the client address the edge put on the request: the key of per-IP limits. */
export const clientIP = (request: Request): string => request.headers.get(IP_HASH_HEADER) ?? '';

/** A path parameter, percent-decoded once as Go's PathValue does. */
export function pathValue(params: Record<string, string | undefined>, name: string): string {
	const v = params[name] ?? '';
	try {
		return decodeURIComponent(v);
	} catch {
		return v;
	}
}

/** RFC 3339 in UTC, whole seconds (Go's time.Unix(unix, 0).UTC().Format(time.RFC3339)). */
export const rfc3339 = (unix: number): string => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** An RFC 3339 time, or null for zero. */
export const optTime = (unix: number): string | null => (unix === 0 ? null : rfc3339(unix));

/** The string, or null for "". */
export const optString = <T extends string = string>(s: string): T | null => (s === '' ? null : (s as T));

/** Go's unicode.IsSpace. */
const SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const TRIM = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, 'g');
const FIELDS = new RegExp(`[${SPACE}]+`);

/** Go's strings.TrimSpace. */
export const trimSpace = (s: string): string => s.replace(TRIM, '');

/** Go's strings.Fields. */
export const fields = (s: string): string[] => s.split(FIELDS).filter((f) => f !== '');

/** Go's utf8.RuneCountInString. */
export const runeCount = (s: string): number => {
	let n = 0;
	for (const _ of s) n++;
	return n;
};

/** Go's strconv.ParseInt(s, 10, 64), or undefined when it fails. */
export function parseInt64(s: string): number | undefined {
	return /^[+-]?\d+$/.test(s) && inInt64(s) ? Number(s) : undefined;
}

const daysIn = (year: number, month: number): number => {
	const d = new Date(0);
	d.setUTCFullYear(year, month, 0);
	return d.getUTCDate();
};

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Go's time.Parse(time.RFC3339, s) as unix seconds with the fraction, or undefined when s is not
 * one. Go's Time.Unix() is Math.floor of it.
 */
export function parseRFC3339(s: string): number | undefined {
	const m = RFC3339.exec(s);
	if (!m) return undefined;
	const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
	if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || se > 59) return undefined;
	let offset = 0;
	if (m[8]) {
		const [oh, om] = [Number(m[9]), Number(m[10])];
		if (oh > 23 || om > 59) return undefined;
		offset = (oh * 60 + om) * 60 * (m[8] === '-' ? -1 : 1);
	}
	const t = new Date(0);
	t.setUTCFullYear(y, mo - 1, d);
	t.setUTCHours(h, mi, se, 0);
	return t.getTime() / 1000 - offset + Number('0' + (m[7] ?? ''));
}

const ESCAPES: Record<string, string> = { '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' };

/** Go's strconv.Quote (the %q verb). */
export function goQuote(s: string): string {
	let out = '"';
	for (const c of s.toWellFormed()) {
		const cp = c.codePointAt(0)!;
		if (c === '"' || c === '\\') out += '\\' + c;
		else if ((cp >= 0x20 && cp < 0x7f) || (cp >= 0x80 && /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(c))) out += c;
		else if (ESCAPES[c]) out += ESCAPES[c];
		else if (cp < 0x80) out += '\\x' + cp.toString(16).padStart(2, '0');
		else if (cp < 0x10000) out += '\\u' + cp.toString(16).padStart(4, '0');
		else out += '\\U' + cp.toString(16).padStart(8, '0');
	}
	return out + '"';
}

/** Go's %.Nf: the exact binary value rounded half to even (toFixed rounds ties up). */
export function goFixed(x: number, prec: number): string {
	const exact = Math.abs(x).toFixed(100);
	const dot = exact.indexOf('.');
	let digits = exact.slice(0, dot) + exact.slice(dot + 1, dot + 1 + prec);
	const rest = exact.slice(dot + 1 + prec);
	if (rest[0]! > '5' || (rest[0] === '5' && (/[1-9]/.test(rest.slice(1)) || Number(digits.at(-1)) % 2 === 1))) {
		digits = (BigInt(digits) + 1n).toString().padStart(digits.length, '0');
	}
	const int = digits.slice(0, digits.length - prec) || '0';
	return (x < 0 ? '-' : '') + int + (prec > 0 ? '.' + digits.slice(-prec) : '');
}

// Go's listfmt name helpers, over the wire tables in packages/shared.

/** The verdict's code, 0 for "removed" or unknown (Go's lf.VerdictCode). */
export const verdictCode = (v: string): number => (VERDICTS as string[]).indexOf(v) + 1;

/** Signal names to a mask (Go's lf.SignalMask); the error message names the unknown signal. */
export function signalMask(names: string[]): number | Error {
	let m = 0;
	for (const n of names) {
		const i = (SIGNALS as readonly string[]).indexOf(n);
		if (i < 0) return new Error(`unknown signal ${goQuote(n)}`);
		m |= 1 << i;
	}
	return m;
}

/** The signals in mask, in bit order (Go's lf.SignalNames). */
export const signalNames = (mask: number): Signal[] => SIGNALS.filter((_, i) => mask & (1 << i));

/** Test names to detail bits (Go's lf.TestBits); undefined for an unknown test. */
export function testBits(names: string[] | undefined): number | undefined {
	let b = 0;
	for (const n of names ?? []) {
		if (!(TESTS as string[]).includes(n)) return undefined;
		b |= 1 << TEST_BIT[n as keyof typeof TEST_BIT];
	}
	return b;
}

/** The tests in detail bits, in display order (Go's lf.TestNames). */
export const testNames = (bits: number): Test[] => TESTS.filter((t) => bits & (1 << TEST_BIT[t]));
