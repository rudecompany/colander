// Helpers the account and billing ports share with each other (Go's respond.go): bounded body
// reads, request JSON decoded the way Go's decode() did, RFC 3339 times and Go's query escaping.
import { jsonError } from './http';

/**
 * Reads at most limit bytes of a body. over is true when more followed; the rest is never read
 * (Go's io.LimitReader, and http.MaxBytesReader when the caller refuses over).
 */
export async function readBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<{ bytes: Uint8Array; over: boolean }> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	let over = false;
	if (body) {
		const reader = body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (size + value.length > limit) {
				chunks.push(value.subarray(0, limit - size));
				size = limit;
				over = true;
				await reader.cancel();
				break;
			}
			chunks.push(value);
			size += value.length;
		}
	}
	const bytes = new Uint8Array(size);
	let o = 0;
	for (const c of chunks) {
		bytes.set(c, o);
		o += c.length;
	}
	return { bytes, over };
}

/** The JSON types a request field may have (Go struct fields string, int64, bool and *string). */
type Kind = 'string' | 'int' | 'bool' | 'string?';
type Decoded<F extends Record<string, Kind>> = {
	[K in keyof F]: F[K] extends 'string' ? string : F[K] extends 'int' ? number : F[K] extends 'bool' ? boolean : string | null;
};

const ZERO = { string: '', int: 0, bool: false, 'string?': null } as const;

function fits(kind: Kind, v: unknown): boolean {
	if (v === null) return true; // Go leaves the zero value for null
	switch (kind) {
		case 'string':
		case 'string?':
			return typeof v === 'string';
		case 'int':
			return Number.isSafeInteger(v);
		case 'bool':
			return typeof v === 'boolean';
	}
}

/**
 * Reads one JSON object with these fields, rejecting unknown fields, trailing data and bodies over
 * limit bytes, with Go's errors (too_large, unknown_field, invalid_json). Missing and null fields
 * keep their zero value. Returns the error response instead when the body does not fit.
 */
export async function decode<const F extends Record<string, Kind>>(request: Request, limit: number, fields: F): Promise<Decoded<F> | Response> {
	const { bytes, over } = await readBody(request.body, limit);
	if (over) return jsonError(413, 'too_large', `The request body is larger than ${limit} bytes.`);
	const invalid = () => jsonError(400, 'invalid_json', 'The request body is not valid JSON for this route.');
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return invalid();
	}
	const out = Object.fromEntries(Object.entries(fields).map(([k, kind]) => [k, ZERO[kind]])) as Record<string, unknown>;
	if (body === null) return out as Decoded<F>;
	if (typeof body !== 'object' || Array.isArray(body)) return invalid();
	const names = Object.keys(fields);
	// The first problem in the body decides, as Go kept the first error it met.
	for (const [key, v] of Object.entries(body)) {
		// Go matches an exact field name first, then one that differs only in case.
		const name = names.includes(key) ? key : names.find((n) => n.toLowerCase() === key.toLowerCase());
		if (name === undefined) {
			return jsonError(400, 'unknown_field', `The request has a field this API does not accept: ${JSON.stringify(key)}.`);
		}
		if (!fits(fields[name]!, v)) return invalid();
		if (v !== null) out[name] = v;
	}
	return out as Decoded<F>;
}

/** Unix seconds as RFC 3339 in UTC, without fractions (Go's time.RFC3339). */
export const rfc3339 = (unix: number): string => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Go's url.QueryEscape: spaces become +, and only letters, digits and -_.~ stay as they are. */
export const queryEscape = (s: string): string =>
	encodeURIComponent(s)
		.replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
		.replace(/%20/g, '+');
