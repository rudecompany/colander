// Cloudflare Turnstile on the sign-in code requests, only when the build has a site key
// (PUBLIC_TURNSTILE_SITE_KEY) and the Worker a secret (docs/deploy.md). Its script loads from
// challenges.cloudflare.com, which the page's CSP then allows, once the person starts signing in.
import { PUBLIC_TURNSTILE_SITE_KEY } from '$app/env/public';
import { PlainError } from './api';

type Turnstile = { render(el: HTMLElement, o: Record<string, unknown>): string; reset(id: string): void; remove(id: string): void };
let script: Promise<Turnstile> | undefined;

export const turnstileOn = (): boolean => PUBLIC_TURNSTILE_SITE_KEY !== '';

function load(): Promise<Turnstile> {
	return (script ??= new Promise((resolve, reject) => {
		const s = document.createElement('script');
		s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
		s.async = true;
		s.onload = () => resolve((globalThis as unknown as { turnstile: Turnstile }).turnstile);
		s.onerror = () => {
			script = undefined;
			reject(new PlainError('The check that you are a person did not load. Check your connection and try again.'));
		};
		document.head.append(s);
	}));
}

/** A token that may still arrive. */
function pending() {
	let resolve!: (token: string) => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<string>((ok, fail) => ((resolve = ok), (reject = fail)));
	// Nobody may be waiting yet when it fails.
	promise.catch(() => undefined);
	return { promise, resolve, reject };
}

/** Runs a widget call that throws once its element has left the page. */
function quietly(fn: () => void): void {
	try {
		fn();
	} catch {
		// The widget is gone with its element.
	}
}

type Widget = { token(): Promise<string>; remove(): void };

/**
 * Renders the widget in el. Siteverify takes each token once, so token() waits for a token nobody
 * used yet and then starts the next one.
 */
async function mountTurnstile(el: HTMLElement): Promise<Widget> {
	const t = await load();
	let next = pending();
	const id = t.render(el, {
		sitekey: PUBLIC_TURNSTILE_SITE_KEY,
		appearance: 'interaction-only',
		callback: (token: string) => next.resolve(token),
		// The widget fetches a new token by itself; the old one must not be sent.
		'expired-callback': () => (next = pending()),
		'error-callback': () => next.reject(new PlainError('The check that you are a person did not finish. Try again.'))
	});
	return {
		async token() {
			try {
				return await next.promise;
			} finally {
				next = pending();
				quietly(() => t.reset(id));
			}
		},
		remove: () => quietly(() => t.remove(id))
	};
}

/**
 * The check in front of one form's code requests: mounted in its element on first use (and again
 * when that element was replaced), with a fresh token for every request, the first email, a new
 * code, another address and a step-up alike.
 */
export class Challenge {
	private el: HTMLElement | undefined;
	private widget: Promise<Widget> | undefined;

	/** Starts the check early, so a token is usually ready when the person sends the form. */
	prepare(el: HTMLElement | undefined): void {
		if (turnstileOn() && el) this.mount(el).catch(() => undefined);
	}

	/** A token for one request, or undefined when Turnstile is off. */
	async token(el: HTMLElement | undefined): Promise<string | undefined> {
		if (!turnstileOn()) return undefined;
		if (!el) throw new PlainError('The check that you are a person is not ready. Reload the page and try again.');
		return (await this.mount(el)).token();
	}

	remove(): void {
		void this.widget?.then((w) => w.remove(), () => undefined);
		this.el = undefined;
		this.widget = undefined;
	}

	private mount(el: HTMLElement): Promise<Widget> {
		if (this.widget && this.el === el && el.isConnected) return this.widget;
		this.remove();
		this.el = el;
		const widget = mountTurnstile(el).catch((e: unknown) => {
			// Try again on the next request.
			if (this.widget === widget) this.widget = undefined;
			throw e;
		});
		this.widget = widget;
		return widget;
	}
}
