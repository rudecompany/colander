// Cloudflare Turnstile on the sign-in code form, only when the build has a site key
// (PUBLIC_TURNSTILE_SITE_KEY) and the Worker a secret (docs/deploy.md). Its script loads from
// challenges.cloudflare.com, which the page's CSP then allows.
import { PUBLIC_TURNSTILE_SITE_KEY } from '$app/env/public';

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
			reject(new Error('The check that you are a person did not load.'));
		};
		document.head.append(s);
	}));
}

/** Renders the widget in el; ontoken gets each new token ('' when it expires). Returns a cleanup. */
export async function mountTurnstile(el: HTMLElement, ontoken: (token: string) => void): Promise<{ reset(): void; remove(): void }> {
	const t = await load();
	const id = t.render(el, {
		sitekey: PUBLIC_TURNSTILE_SITE_KEY,
		appearance: 'interaction-only',
		callback: ontoken,
		'expired-callback': () => ontoken(''),
		'error-callback': () => ontoken('')
	});
	return { reset: () => t.reset(id), remove: () => t.remove(id) };
}
