// Colander's few emails (Go's internal/mail). They go out through the Email Sending binding, and
// through the Resend HTTP API when the binding fails for any reason, with no switch to flip
// (hosting plan section 1.2). In dev mode (COLANDER_DEV=1) messages are printed instead of sent,
// in the exact block e2e/tests/stack.ts parses from the `wrangler dev` output.
import { readBody } from './routes/respond';

/** The parts of Env the mailer reads. RESEND_API_KEY is an optional secret. */
export type MailEnv = Pick<Env, 'EMAIL' | 'COLANDER_DEV' | 'COLANDER_MAIL_FROM'> & { RESEND_API_KEY?: string };

/** Sends plain-text email (Go's mail.Mailer). */
export class Mailer {
	readonly from: string;
	readonly dev: boolean;
	readonly resendKey: string;
	readonly binding: SendEmail;
	endpoint = 'https://api.resend.com/emails';
	/** Where dev mode prints messages. */
	out: (text: string) => void = (text) => console.log(text);
	fetch: typeof fetch = (input, init) => fetch(input, init);

	constructor(env: MailEnv) {
		this.from = env.COLANDER_MAIL_FROM || 'Colander <hello@colander.local>';
		this.dev = env.COLANDER_DEV === '1';
		this.resendKey = env.RESEND_API_KEY ?? '';
		this.binding = env.EMAIL;
	}

	/** Delivers one message. */
	async send(to: string, subject: string, body: string): Promise<void> {
		if (this.dev) {
			// console.log ends the line, so this ends with one newline where Go's Fprintf wrote two.
			this.out(`\n==== Colander dev mail (not sent) ====\nTo: ${to}\nSubject: ${subject}\n\n${body}\n======================================\n`);
			return;
		}
		try {
			await this.binding.send({ from: address(this.from), to, subject, text: body });
			return;
		} catch (err) {
			const code = (err as { code?: unknown }).code;
			console.warn(JSON.stringify({ message: 'email sending failed, trying Resend', code: typeof code === 'string' ? code : null, error: String(err) }));
		}
		if (!this.resendKey) {
			console.warn(JSON.stringify({ message: 'email not sent: RESEND_API_KEY is not set', subject }));
			throw new Error('email delivery is not configured');
		}
		const res = await this.fetch(this.endpoint, {
			method: 'POST',
			headers: { Authorization: `Bearer ${this.resendKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ from: this.from, to: [to], subject, text: body }),
			signal: AbortSignal.timeout(10_000)
		});
		if (res.status >= 300) {
			const msg = new TextDecoder().decode((await readBody(res.body, 512)).bytes);
			throw new Error(`resend: status ${res.status}: ${msg.trim()}`);
		}
		await res.body?.cancel();
	}
}

/** "Name <a@b>" as the binding's EmailAddress; a bare address stays a string. */
function address(from: string): string | EmailAddress {
	const m = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(from);
	return m ? { name: m[1]!.replace(/^"(.*)"$/, '$1'), email: m[2]! } : from;
}

/** The sign-in email. */
export function signIn(link: string): [subject: string, body: string] {
	return [
		'Your Colander sign-in link',
		'Here is your link to sign in to Colander:\n\n' +
			link +
			'\n\nIt works once and expires in 20 minutes.\n' +
			'If you did not ask to sign in, you can ignore this email.\n\nColander'
	];
}

/** The email a creator gets after filing an appeal. */
export function appeal(sourceName: string, sourceNoun: string, code: string, link: string): [subject: string, body: string] {
	return [
		'Your Colander appeal for ' + sourceName,
		'We received your appeal for ' +
			sourceName +
			'.\n\n' +
			'To show that you run this ' +
			sourceNoun +
			', add this code to its description:\n\n    ' +
			code +
			'\n\n' +
			'Then open this link and choose Verify:\n\n' +
			link +
			'\n\n' +
			'Keep this link to yourself. It shows the status of your appeal.\n' +
			'Once the code is verified, the ' +
			sourceNoun +
			' shows as Disputed for every Colander user while staff review your case, ' +
			'and you can remove the code.\n' +
			'The outcome and the reasoning are published in the decision log.\n\nColander'
	];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Confirms a cancellation at the end of the paid period. until is unix seconds. */
export function plusCancelled(until: number): [subject: string, body: string] {
	const d = new Date(until * 1000);
	// Go's "2 January 2006" in UTC.
	const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
	return [
		'Your Colander Plus is cancelled',
		'We cancelled Plus as you asked.\n\n' +
			'Plus stays on until ' +
			date +
			', and you will not be charged again.\n' +
			'Blocking, tagging, reporting and appeals stay free on every platform.\n\n' +
			'Thank you for supporting Colander.\n\nColander'
	];
}

/** Confirms a refund that ended Plus at once. */
export function plusRefunded(): [subject: string, body: string] {
	return [
		'Your Colander Plus refund',
		'We refunded your last Plus charge, and Plus has ended.\n\n' +
			'The refund goes back to the way you paid. Most banks show it within 5 to 10 business days.\n' +
			'Blocking, tagging, reporting and appeals stay free on every platform.\n\n' +
			'Thank you for trying Plus.\n\nColander'
	];
}
