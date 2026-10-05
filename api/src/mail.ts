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

/** The sign-in code email. */
export function signInCode(code: string): [subject: string, body: string] {
	return [
		`${code} is your Colander sign-in code`,
		'Here is your code to sign in to Colander:\n\n    ' +
			code +
			'\n\nEnter it on the page where you asked for it. It works once and expires in 10 minutes.\n' +
			'Colander never asks for this code by phone, chat or email. If you did not ask to sign in, you can ignore this email.\n\nColander'
	];
}

/** Sent once when wrong codes used up an address's budget for the day. */
export function codeSignInPaused(): [subject: string, body: string] {
	return [
		'Sign-in codes are paused for your Colander account',
		'Someone entered too many wrong sign-in codes for this address, so we stopped sending and accepting codes for it for 24 hours.\n\n' +
			'If that was you, wait a day and ask for a new code, or sign in with a passkey, which keeps working.\n' +
			'If it was not you, you do not need to do anything: no code was accepted.\n\nColander'
	];
}

/** A security notice to the account's address: what happened, and what to do if it was not them. */
export function securityNotice(what: string, ifNotYou = 'sign in, open your account page and choose Sign out everywhere, then remove any passkey you do not recognize.'): [subject: string, body: string] {
	return ['Colander account: ' + what.charAt(0).toLowerCase() + what.slice(1), `${what}.\n\nIf this was not you, ${ifNotYou}\n\nColander`];
}

/** Confirms an action held for some days, with the link that cancels it. */
export function heldRequest(what: string, days: number, cancelLink: string): [subject: string, body: string] {
	return [
		`Your Colander request: ${what.toLowerCase()} in ${days} days`,
		`We received a request to ${what.toLowerCase()} for your Colander account. ` +
			`Your account has a passkey and the request was confirmed with an email code only, so it waits ${days} days.\n\n` +
			'If this was not you, cancel it here:\n\n' +
			cancelLink +
			'\n\nSigning in with your passkey also cancels it.\n\nColander'
	];
}

/** Confirms that an account and its data are deleted. */
export function accountDeleted(): [subject: string, body: string] {
	return [
		'Your Colander account is erased',
		'We erased your Colander account as you asked: your email, passkeys, sessions, plan and synced settings are gone.\n' +
			'Decisions you made as a reviewer stay in the public decision log without your name.\n' +
			'Blocking, tagging, reporting and appeals stay free on every platform, with no account.\n\nColander'
	];
}

/** Tells the old address that support will move the account to another address. */
export function emailChangeHeld(newEmail: string, days: number, cancelLink: string): [subject: string, body: string] {
	return [
		'Your Colander account is moving to another email address',
		`After a support request, your Colander account will move to ${newEmail} in ${days} days. ` +
			'When it moves, every session and passkey ends.\n\n' +
			'If you did not ask for this, cancel it here:\n\n' +
			cancelLink +
			'\n\nSigning in with your passkey also cancels it.\n\nColander'
	];
}

/** Tells both addresses that the move happened. */
export function emailChanged(newEmail: string): [subject: string, body: string] {
	return [
		'Your Colander account moved to another email address',
		`Your Colander account now uses ${newEmail}. Every session, passkey and reviewer token ended, so sign in again with the new address.\n\n` +
			'If you did not ask for this, reply to this email.\n\nColander'
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
