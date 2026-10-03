// Website to extension handoff (docs/contracts.md section 7). The extension lists this site in
// externally_connectable, so Chrome exposes chrome.runtime.sendMessage to these pages only when
// the extension is installed.
import { PUBLIC_EXTENSION_ID } from '$app/env/public';
import type { ExternalMessage } from '@colander/shared/api';

type Runtime = {
	sendMessage?: (id: string, message: unknown, callback: (reply: unknown) => void) => void;
	lastError?: { message?: string };
};

export type ExtensionState =
	| { kind: 'checking' }
	| { kind: 'not_chrome' }
	| { kind: 'missing' }
	| { kind: 'installed'; version: string };

function runtime(): Runtime | undefined {
	return (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime;
}

/** Sends one message and resolves with the reply, or rejects when nothing answers in time. */
export function sendToExtension<T = { ok: boolean }>(message: ExternalMessage, timeoutMs = 3000): Promise<T> {
	const rt = runtime();
	if (!PUBLIC_EXTENSION_ID || !rt?.sendMessage) return Promise.reject(new Error('Colander is not installed in this browser.'));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Colander did not answer.')), timeoutMs);
		try {
			rt.sendMessage!(PUBLIC_EXTENSION_ID, message, (reply) => {
				clearTimeout(timer);
				const failed = rt.lastError;
				if (failed || !reply) reject(new Error(failed?.message ?? 'Colander did not answer.'));
				else resolve(reply as T);
			});
		} catch (e) {
			clearTimeout(timer);
			reject(e instanceof Error ? e : new Error(String(e)));
		}
	});
}

/** Chromium browsers expose window.chrome; the runtime appears only when the extension is installed. */
export async function detectExtension(): Promise<ExtensionState> {
	if (!('chrome' in globalThis)) return { kind: 'not_chrome' };
	try {
		const reply = await sendToExtension<{ ok: boolean; version?: string }>({ type: 'colander:ping' }, 1500);
		return reply.ok ? { kind: 'installed', version: reply.version ?? '' } : { kind: 'missing' };
	} catch {
		return { kind: 'missing' };
	}
}
