// Small byte helpers shared by the service worker, content scripts and pages.

export function b64encode(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

/** Decodes standard or URL-safe base64, padded or not. Throws on malformed input. */
export function b64decode(text: string): Uint8Array {
	const std = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
	const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function b64url(bytes: Uint8Array): string {
	return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hex(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += b.toString(16).padStart(2, '0');
	return s;
}

export function utf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
