// A small client for Firefox's remote debugging protocol, which Playwright's Firefox cannot do
// itself: it installs the built add-on as a temporary add-on and runs code in the add-on's own
// pages, which Playwright cannot open or script in Firefox. Messages are `length:json` frames.
// Protocol: https://firefox-source-docs.mozilla.org/devtools/backend/protocol.html
import { connect, type Socket } from 'node:net';

type Packet = Record<string, any>;

export class Rdp {
	private buf = Buffer.alloc(0);
	private waiters: { match: (p: Packet) => boolean; resolve: (p: Packet) => void }[] = [];
	private backlog: Packet[] = [];
	private watcher = '';

	private constructor(private readonly sock: Socket) {
		sock.on('data', (d: Buffer) => this.read(d));
	}

	/** Connects to `-start-debugger-server` on the port, retrying while Firefox starts. */
	static async connect(port: number, timeoutMs = 15_000): Promise<Rdp> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				const sock = await new Promise<Socket>((resolve, reject) => {
					const s = connect(port, '127.0.0.1', () => resolve(s));
					s.once('error', reject);
				});
				const rdp = new Rdp(sock);
				await rdp.next((p) => p.from === 'root' && !!p.applicationType);
				return rdp;
			} catch (e) {
				if (Date.now() > deadline) throw e;
				await new Promise((r) => setTimeout(r, 200));
			}
		}
	}

	private read(d: Buffer) {
		this.buf = Buffer.concat([this.buf, d]);
		for (;;) {
			const colon = this.buf.indexOf(':');
			if (colon < 0) return;
			const n = Number(this.buf.subarray(0, colon).toString());
			if (this.buf.length < colon + 1 + n) return;
			const p = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + n).toString()) as Packet;
			this.buf = this.buf.subarray(colon + 1 + n);
			// A page that closed or navigated away takes its console with it.
			if (p.type === 'target-destroyed-form') this.backlog = this.backlog.filter((b) => b.target?.actor !== p.target?.actor);
			const w = this.waiters.findIndex((x) => x.match(p));
			if (w >= 0) this.waiters.splice(w, 1)[0]!.resolve(p);
			else this.backlog.push(p);
		}
	}

	private next(match: (p: Packet) => boolean): Promise<Packet> {
		const i = this.backlog.findIndex(match);
		if (i >= 0) return Promise.resolve(this.backlog.splice(i, 1)[0]!);
		return new Promise((resolve) => this.waiters.push({ match, resolve }));
	}

	private async request(to: string, type: string, extra: Packet = {}): Promise<Packet> {
		const reply = this.next((p) => p.from === to && !p.type);
		const body = Buffer.from(JSON.stringify({ to, type, ...extra }));
		this.sock.write(`${body.length}:`);
		this.sock.write(body);
		const p = await reply;
		if (p.error) throw new Error(`${type}: ${p.error} ${p.message ?? ''}`);
		return p;
	}

	/** Installs an unpacked add-on until the browser closes, then watches its pages. */
	async install(dir: string, id: string): Promise<void> {
		const root = await this.request('root', 'getRoot');
		await this.request(root.addonsActor, 'installTemporaryAddon', { addonPath: dir });
		const { addons } = await this.request('root', 'listAddons');
		const addon = (addons as Packet[]).find((a) => a.id === id);
		if (!addon) throw new Error(`${id} is not installed`);
		this.watcher = (await this.request(addon.actor, 'getWatcher', { isServerTargetSwitchingEnabled: true })).actor;
		await this.request(this.watcher, 'watchTargets', { targetType: 'frame' });
	}

	/** The console actor of the add-on page whose URL matches, waiting until it loads. */
	private async page(url: RegExp, timeoutMs = 15_000): Promise<string> {
		const found = this.next((p) => p.type === 'target-available-form' && url.test(p.target?.url ?? ''));
		const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no add-on page matches ${url}`)), timeoutMs));
		const p = await Promise.race([found, timeout]);
		// Keep it for the next caller: the same page answers many evaluations.
		this.backlog.push(p);
		return p.target.consoleActor as string;
	}

	/**
	 * Runs an async function body in the add-on page whose URL matches (the background page by
	 * default) and returns its JSON result.
	 */
	async eval<T = unknown>(body: string, url = /^moz-extension:\/\/[^/]+\/_generated_background_page\.html/): Promise<T> {
		const consoleActor = await this.page(url);
		const text = `(async () => JSON.stringify(await (async () => { ${body} })()))()`;
		const { resultID } = await this.request(consoleActor, 'evaluateJSAsync', { text, mapped: { await: true } });
		const res = await this.next((p) => p.type === 'evaluationResult' && p.resultID === resultID);
		if (res.exceptionMessage) throw new Error(res.exceptionMessage);
		const out = res.result;
		return (typeof out === 'string' ? JSON.parse(out) : out?.type === 'undefined' ? undefined : out) as T;
	}

	/**
	 * Runs an async function body with chrome privileges in Firefox's parent process, as the
	 * browser itself (needs devtools.chrome.enabled). Returns its JSON result.
	 */
	async evalChrome<T = unknown>(body: string): Promise<T> {
		const { processDescriptor } = await this.request('root', 'getProcess', { id: 0 });
		const { process: form } = await this.request(processDescriptor.actor, 'getTarget');
		const text = `(async () => JSON.stringify(await (async () => { ${body} })()))()`;
		const { resultID } = await this.request(form.consoleActor, 'evaluateJSAsync', { text, mapped: { await: true } });
		const res = await this.next((p) => p.type === 'evaluationResult' && p.resultID === resultID);
		if (res.exceptionMessage) throw new Error(res.exceptionMessage);
		return (typeof res.result === 'string' ? JSON.parse(res.result) : undefined) as T;
	}

	close() {
		this.sock.destroy();
	}
}
