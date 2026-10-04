// The mailer (src/mail.ts): Go's TestResendAndDevMode, plus the order Workers adds in front of
// Resend: the Email Sending binding first, Resend on any error, and dev mode printing instead.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { appeal, Mailer, plusCancelled, plusRefunded, signIn } from '../src/mail';

interface Sent {
	auth: string | null;
	body: Record<string, unknown>;
}

/** A mailer with a stub binding and a stub Resend endpoint that record what they got. */
function mailer(opts: { dev?: boolean; key?: string; binding?: (m: EmailMessageBuilder) => Promise<EmailSendResult>; resendStatus?: number }) {
	const binding: EmailMessageBuilder[] = [];
	const resend: Sent[] = [];
	const printed: string[] = [];
	const m = new Mailer({
		EMAIL: {
			send: async (msg: EmailMessage | EmailMessageBuilder) => {
				binding.push(msg as EmailMessageBuilder);
				return opts.binding ? opts.binding(msg as EmailMessageBuilder) : { messageId: 'msg_1' };
			}
		} as SendEmail,
		COLANDER_DEV: opts.dev ? '1' : '',
		COLANDER_MAIL_FROM: 'Colander <hello@colander.test>',
		RESEND_API_KEY: opts.key
	});
	m.endpoint = 'https://resend.fake/emails';
	m.out = (text) => printed.push(text);
	m.fetch = async (input, init) => {
		const req = new Request(input, init);
		expect(req.url).toBe('https://resend.fake/emails');
		resend.push({ auth: req.headers.get('Authorization'), body: await req.json() });
		return new Response(opts.resendStatus ? '{"message":"domain not verified"}' : '{"id":"email_1"}', { status: opts.resendStatus ?? 200 });
	};
	return { m, binding, resend, printed };
}

const failing = () => Promise.reject(Object.assign(new Error('sender not verified'), { code: 'E_SENDER_NOT_VERIFIED' }));

describe('Mailer', () => {
	const [subject, body] = signIn('https://colander.test/auth/callback?token=t');

	it('sends through the Email Sending binding first', async () => {
		const { m, binding, resend } = mailer({ key: 're_test' });
		await m.send('maya@example.test', subject, body);
		expect(binding).toEqual([{ from: { name: 'Colander', email: 'hello@colander.test' }, to: 'maya@example.test', subject, text: body }]);
		expect(resend).toEqual([]);
	});

	it('falls back to Resend on any binding error', async () => {
		const { m, binding, resend } = mailer({ key: 're_test', binding: failing });
		await m.send('maya@example.test', subject, body);
		expect(binding).toHaveLength(1);
		expect(resend).toEqual([
			{ auth: 'Bearer re_test', body: { from: 'Colander <hello@colander.test>', to: ['maya@example.test'], subject, text: body } }
		]);
		expect((resend[0]!.body.text as string).includes('token=t')).toBe(true);
	});

	it('fails when the binding fails and Resend is not configured or refuses', async () => {
		await expect(mailer({ binding: failing }).m.send('maya@example.test', subject, body)).rejects.toThrow('email delivery is not configured');
		await expect(mailer({ key: 're_test', binding: failing, resendStatus: 422 }).m.send('maya@example.test', subject, body)).rejects.toThrow(
			'resend: status 422: {"message":"domain not verified"}'
		);
	});

	it('prints instead of sending in dev mode', async () => {
		const { m, binding, resend, printed } = mailer({ dev: true, key: 're_test' });
		await m.send('maya@example.test', subject, body);
		expect(binding).toEqual([]);
		expect(resend).toEqual([]);
		// Go's block; console.log adds the final newline.
		expect(printed).toEqual([`\n==== Colander dev mail (not sent) ====\nTo: maya@example.test\nSubject: ${subject}\n\n${body}\n======================================\n`]);
		expect(printed[0]).toContain('token=t');
		expect(printed[0]).toContain('not sent');
	});

	it('uses the configured sender, and Go default without one', () => {
		expect(new Mailer(env).from).toBe('Colander <hello@getcolander.com>');
		expect(new Mailer({ ...env, COLANDER_MAIL_FROM: '' }).from).toBe('Colander <hello@colander.local>');
	});
});

describe('templates', () => {
	it('words the sign-in, appeal and Plus emails as Go did', () => {
		expect(signIn('L')).toEqual([
			'Your Colander sign-in link',
			'Here is your link to sign in to Colander:\n\nL\n\nIt works once and expires in 20 minutes.\nIf you did not ask to sign in, you can ignore this email.\n\nColander'
		]);
		const [as, ab] = appeal('Some Channel', 'channel', 'colander-7KQ2M9XD', 'L');
		expect(as).toBe('Your Colander appeal for Some Channel');
		expect(ab).toContain('To show that you run this channel, add this code to its description:\n\n    colander-7KQ2M9XD\n\nThen open this link and choose Verify:\n\nL\n\n');
		expect(ab).toContain('the channel shows as Disputed for every Colander user while staff review your case, and you can remove the code.\n');
		// Go's "2 January 2006" in UTC.
		expect(plusCancelled(Date.UTC(2027, 9, 1, 23, 30) / 1000)[1]).toContain('Plus stays on until 1 October 2027, and you will not be charged again.\n');
		expect(plusRefunded()).toEqual([
			'Your Colander Plus refund',
			'We refunded your last Plus charge, and Plus has ended.\n\nThe refund goes back to the way you paid. Most banks show it within 5 to 10 business days.\nBlocking, tagging, reporting and appeals stay free on every platform.\n\nThank you for trying Plus.\n\nColander'
		]);
	});
});
