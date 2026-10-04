// Journeys 1, 2 and 8: passive blocking from the real signed list, a tag that reaches the server,
// and a privacy audit of every request the extension made along the way.
import { createHash } from 'node:crypto';
import { CARD, SEARCH, UNLISTED, card, chip, expect, launch, onboard, test, type Ext } from './harness.ts';
import { ORIGIN, asStaff, serverLog } from './stack.ts';

test.describe.configure({ mode: 'serial' });

let ext: Ext;
test.beforeAll(async () => {
	ext = await launch();
});
test.afterAll(async () => {
	await ext?.close();
});

const TAG_FIELDS = ['client_id', 'platform', 'target_type', 'target_id', 'source_id', 'verdict', 'slop_type', 'tests', 'platform_label', 'created_at', 'ext_version'];

test('the real signed list hides and labels by strictness, the popup keeps every hidden item, and No AI applies within 1 second', async () => {
	await onboard(ext);

	// The install synced the server's snapshot: the Lists section shows its sequence and size.
	const snapshot = await fetch(`${ORIGIN}/v1/list/snapshot`);
	const sequence = Number(snapshot.headers.get('X-Colander-Sequence'));
	const count = ((await snapshot.arrayBuffer()).byteLength - 104) / 16;
	expect(count).toBeGreaterThan(30);
	const options = await ext.page('options.html#lists');
	const facts = options.locator('dl.facts');
	await expect(facts.locator('div', { hasText: 'Version' }).locator('dd')).toHaveText(`v.${sequence}`);
	await expect(facts.locator('div', { hasText: 'Entries' }).locator('dd')).toHaveText(String(count));
	await options.close();

	// Standard hides Slop and Likely slop without a trace, and labels AI-made and Disputed.
	const page = await ext.youtube(SEARCH);
	for (const n of [CARD.slop, CARD.likely]) {
		await expect(card(page, n)).toHaveAttribute('data-colander', 'hide');
		await expect(card(page, n)).toBeHidden();
		await expect(card(page, n).locator('colander-ui')).toHaveCount(0);
	}
	await expect(chip(card(page, CARD.aiMade))).toContainText('AI-made');
	await expect(chip(card(page, CARD.disputed))).toContainText('Disputed');
	// YouTube's own AI label on a card from an unrated channel gives the AI-made chip (P0-4).
	await expect(chip(card(page, CARD.platformLabel))).toContainText('AI-made');
	for (const n of [CARD.aiMade, CARD.disputed, CARD.clear, CARD.unlisted, CARD.reported]) {
		await expect(card(page, n)).toBeVisible();
		await expect(card(page, n)).not.toHaveAttribute('data-colander', /./);
	}
	for (const n of [CARD.clear, CARD.unlisted, CARD.reported]) await expect(chip(card(page, n))).toHaveCount(0);

	// The popup still counts and lists both hidden items, and Why from its row opens on the card,
	// which links to the server's public page for the channel with the same verdict.
	let popup = await ext.popup(page);
	await expect(popup.locator('.cell').filter({ hasText: 'Hidden on this page' }).locator('.value')).toHaveText('2');
	const row = popup.getByRole('listitem').filter({ hasText: 'Likely slop' });
	await expect(row.getByRole('button', { name: 'Show' })).toBeVisible();
	await row.getByRole('button', { name: /Likely slop/ }).click();
	await popup.getByRole('menuitem', { name: 'Why' }).click();
	await expect(card(page, CARD.likely)).toBeVisible();
	const why = page.locator('colander-ui[data-kind="layer"] .cl-pop');
	await expect(why).toContainText('Why this is hidden');
	const opened = ext.ctx.waitForEvent('page');
	await why.getByRole('link', { name: 'Source page' }).click();
	const source = await opened;
	await expect(source).toHaveURL(`${ORIGIN}/s/yt/@catrescuetales`);
	await expect(source.getByRole('heading', { level: 1, name: 'Kitty Rescue Stories' })).toBeVisible();
	await expect(source.locator('.banner .chip-line')).toContainText('Likely slop');
	await source.close();
	await page.keyboard.press('Escape');
	await expect(why).toHaveCount(0);

	popup = await ext.popup(page);
	await expect(popup.getByRole('radio', { name: 'Standard' })).toBeChecked();
	await expect(popup.getByRole('radio')).toHaveText(['Label', 'Standard', 'No AI']);
	await popup.getByRole('radio', { name: 'No AI' }).click();
	const t0 = Date.now();
	await expect(card(page, CARD.aiMade)).toHaveAttribute('data-colander', 'hide', { timeout: 1000 });
	expect(Date.now() - t0).toBeLessThan(1000);
	// Disputed is always labeled and Clear is always allowed, at every level.
	await expect(chip(card(page, CARD.disputed))).toContainText('Disputed');
	await expect(card(page, CARD.clear)).not.toHaveAttribute('data-colander', /./);

	await popup.getByRole('radio', { name: 'Label' }).click();
	await expect(chip(card(page, CARD.slop))).toContainText('Slop', { timeout: 1000 });
	await expect(chip(card(page, CARD.aiMade))).toContainText('AI-made');

	await popup.getByRole('radio', { name: 'Standard' }).click();
	await expect(card(page, CARD.slop)).toHaveAttribute('data-colander', 'hide', { timeout: 1000 });
	await popup.close();
	await page.close();
});

test('a tag in two clicks hides the card at once and reaches the server with contract fields only', async () => {
	const page = await ext.youtube(SEARCH);
	const target = card(page, CARD.unlisted);
	await target.hover();
	await target.locator('colander-ui[data-kind="tag"] button').click();
	const layer = page.locator('colander-ui[data-kind="layer"]');
	await layer.getByRole('menuitem', { name: /^Slop/ }).click();
	await expect(target).toHaveAttribute('data-colander', 'hide');
	// One tag per menu: it is held while its toast can still undo or refine it, and sent when the toast ends.
	await expect(layer.locator('.cl-toast')).toContainText('Tagged and hidden.');
	await layer.locator('.cl-toast').getByRole('button', { name: 'Close' }).click();

	await expect.poll(() => ext.seen.filter((s) => s.method === 'POST' && s.url === `${ORIGIN}/v1/tags`).length).toBe(1);
	const sent = ext.seen.find((s) => s.method === 'POST' && s.url === `${ORIGIN}/v1/tags`)!;
	expect(sent.by).toBe('worker');
	expect(sent.headers.authorization).toMatch(/^Install [A-Za-z0-9_-]{22}$/);
	const tags = (JSON.parse(sent.body!) as { tags: Record<string, unknown>[] }).tags;
	expect(tags).toHaveLength(1);
	expect(Object.keys(tags[0]!).filter((k) => !TAG_FIELDS.includes(k))).toEqual([]);
	expect(tags[0]).toMatchObject({ platform: 'yt', target_type: 'item', target_id: UNLISTED.item, source_id: UNLISTED.channelId, verdict: 'slop', platform_label: false });
	expect(sent.body).not.toMatch(/youtube|results|search_query|history documentary/i);

	// The server stored it: the review API counts one slop tag on that video of that channel.
	await expect
		.poll(async () => {
			const r = await asStaff(`/v1/review/sources/yt/${UNLISTED.channelId}`);
			return r.status === 200 ? r.json.items.find((i: { id: string }) => i.id === UNLISTED.item)?.tags : r.status;
		})
		.toEqual({ slop: 1, ai_fine: 0, not_slop: 0 });
	await page.close();
});

test('privacy audit: only contract endpoints, no identifiers on list downloads, no page addresses (P0-11)', async () => {
	const extension = ext.seen.filter((s) => s.by !== 'page' && !s.url.startsWith('chrome-extension://'));
	const fromPages = ext.seen.filter((s) => s.by === 'page');
	expect(extension.length).toBeGreaterThan(0);

	// Contract section 8: the only requests the extension makes.
	const ALLOWED: [string, RegExp][] = [
		['GET', /^\/v1\/list\/snapshot$/],
		['GET', /^\/v1\/list\/delta\?since=\d+$/],
		['GET', /^\/v1\/config\/adapters$/],
		['POST', /^\/v1\/tags$/],
		['POST', /^\/v1\/reports$/],
		['GET', /^\/v1\/reports$/],
		['POST', /^\/v1\/trial$/],
		['POST', /^\/v1\/entitlement\/refresh$/],
		['GET', /^\/v1\/sync$/],
		['PUT', /^\/v1\/sync$/],
		['GET', /^\/v1\/review\//],
		['POST', /^\/v1\/review\//]
	];
	for (const s of extension) {
		const url = new URL(s.url);
		expect(url.origin, s.url).toBe(ORIGIN);
		const path = url.pathname + url.search;
		expect(ALLOWED.some(([m, re]) => m === s.method && re.test(path)), `${s.method} ${path}`).toBe(true);
		if (path.startsWith('/v1/list/')) {
			expect(s.headers.authorization, path).toBeUndefined();
			expect(s.headers.cookie, path).toBeUndefined();
		}
		// No page URL, platform address or anything from the page, in the URL, the headers or the body.
		expect(JSON.stringify([s.url, s.headers, s.body]), path).not.toMatch(/youtube|results\?|search_query|history documentary/i);
	}
	expect(extension.filter((s) => s.url.includes('/v1/list/')).length).toBeGreaterThan(0);
	for (const s of fromPages) {
		const host = new URL(s.url).host;
		// YouTube pages, with the content scripts in them, only load YouTube's own files.
		if (s.frame.startsWith('https://www.youtube.com/') || host === 'www.youtube.com') expect(host, `${s.url} from ${s.frame}`).toBe('www.youtube.com');
		// The only other pages were the website's own, opened from Why.
		else expect(`${s.url} from ${s.frame}`).toMatch(new RegExp(`^${ORIGIN}/`));
	}

	// The server log never pairs an install with an item or source: it holds neither.
	const install = await ext.storage<string>('installId');
	const hash = createHash('sha256').update(`colander-install:${install}`).digest('hex');
	const log = serverLog();
	expect(log).toContain('route="POST /v1/tags"');
	for (const secret of [install, hash, UNLISTED.item, UNLISTED.channelId, UNLISTED.handle]) expect(log).not.toContain(secret);
});
