// Journeys 3 and 4: a viewer reports a channel, staff decide it in the admin console, the verdict
// reaches the extension; then the creator appeals, the channel is unhidden as Disputed during
// review, and the upheld appeal clears it. Staff work on the admin host, behind dev mode's stand-in
// for Cloudflare Access.
import type { Page } from '@playwright/test';
import { CARD, CHANNEL, REPORTED, SEARCH, adminSignIn, card, chip, expect, launch, onboard, syncNow, test, type Ext } from './harness.ts';
import { BASE_URL, LOCAL_ONLY, ORIGIN, STAFF, adminOrigin, listSequence, logMark, mailsSince, publishedAfter } from './stack.ts';

test.skip(!!BASE_URL, LOCAL_ONLY);

test.describe.configure({ mode: 'serial' });

const REASON = 'Uploads a dozen AI space facts videos a day with the same synthetic narrator.';
const DECISION = 'Staff review confirmed one narration template over generated space footage, many times a day.';
const CREATOR = 'studio@cosmicfacts.example.test';

let ext: Ext;
/** The search page, open the whole time: verdicts must reach it without a reload. */
let search: Page;
/** The website, where staff stay signed in. */
let site: Page;

test.beforeAll(async () => {
	ext = await launch();
	await onboard(ext);
});
test.afterAll(async () => {
	await ext?.close();
});

/** Opens the queue item for the reported channel in the admin console. */
async function openInConsole(kind: 'All' | 'Appeals') {
	await site.goto(`${adminOrigin()}/admin`);
	if (kind !== 'All') await site.getByRole('tab', { name: new RegExp(`^${kind}`) }).click();
	await site.getByRole('button', { name: new RegExp(REPORTED.name) }).click();
	await expect(site.getByRole('heading', { level: 2, name: REPORTED.name })).toBeVisible();
}

/** Waits for the server's next list, has the extension take it, and returns its sequence. */
async function nextListReachesExtension(before: number): Promise<number> {
	const seq = await publishedAfter(before);
	const options = await syncNow(ext);
	await expect(options.locator('dl.facts div', { hasText: 'Version' }).locator('dd')).toHaveText(`v.${seq}`);
	await options.close();
	return seq;
}

test('a report goes through review and its verdict reaches the extension and My reports', async () => {
	search = await ext.youtube(SEARCH);
	await expect(card(search, CARD.reported)).not.toHaveAttribute('data-colander', /./);

	const channel = await ext.youtube(CHANNEL);
	await channel.locator('colander-ui[data-kind="report"] button').click();
	const dialog = channel.locator('colander-ui[data-kind="layer"] .report');
	await expect(dialog.getByRole('heading', { name: `Report ${REPORTED.handle}` })).toBeVisible();
	const examples = dialog.locator('.tile input[type="checkbox"]');
	await examples.nth(0).check();
	await examples.nth(1).check();
	await dialog.getByRole('button', { name: 'Next' }).click();
	await dialog.getByRole('radio', { name: /^Filler/ }).check();
	await dialog.getByRole('checkbox', { name: /^Mass-produced/ }).check();
	await dialog.getByLabel('Note, optional').fill(REASON);
	await dialog.getByRole('button', { name: 'Send report' }).click();
	await expect(dialog).toContainText('Report received. Track it in My reports.');

	const sent = ext.seen.find((s) => s.method === 'POST' && s.url === `${ORIGIN}/v1/reports`)!;
	expect(sent.by).toBe('worker');
	const body = JSON.parse(sent.body!) as Record<string, unknown>;
	expect(Object.keys(body).sort()).toEqual(['client_id', 'examples', 'ext_version', 'platform', 'reason', 'slop_type', 'source_id', 'source_name', 'tests']);
	expect(body).toMatchObject({ platform: 'yt', source_id: REPORTED.handle, source_name: REPORTED.name, reason: REASON, slop_type: 'filler', tests: ['mass_produced'] });
	expect(body.examples).toHaveLength(2);
	expect(sent.body).not.toMatch(/youtube|\/videos/i);

	const opened = ext.ctx.waitForEvent('page');
	await dialog.getByRole('button', { name: 'My reports' }).click();
	const reports = await opened;
	const row = reports.locator('li', { hasText: REPORTED.name });
	await expect(row).toContainText('Under review');
	await channel.close();

	// Staff sign in on the admin host and decide the channel in the admin console.
	site = await ext.ctx.newPage();
	await adminSignIn(site, STAFF);
	await expect(site.getByText('Staff, Rae')).toBeVisible();
	// Staff on the admin host see which seed list names a lead, with its provenance and, for
	// Colander's own lists, where staff saw it; it is never evidence. Every lead waits under Escalated.
	await site.getByRole('tab', { name: /^Escalated/ }).click();
	await site.getByRole('button', { name: /Seed lead/ }).first().click();
	const seeds = site.getByRole('region', { name: 'Seed lists' });
	await expect(seeds).toContainText('A seed list is a review lead, never evidence.');
	await expect(seeds).toContainText('Demo list');
	await expect(seeds).toContainText(/Listed as @\w+ in the file dated/);
	await expect(seeds).toContainText('Where staff saw it: Seen in a fictional demo report');
	await site.getByRole('tab', { name: /^All/ }).click();
	await site.getByRole('button', { name: new RegExp(REPORTED.name) }).click();
	await expect(site.getByRole('heading', { level: 2, name: REPORTED.name })).toBeVisible();
	await expect(site.getByText(REASON)).toBeVisible();
	// Slop needs AI evidence, so the console keeps it locked until staff record what they saw on the channel.
	const slop = site.getByRole('radio', { name: 'Slop', exact: true });
	await expect(slop).toBeDisabled();
	await site.locator('label.uin-checkbox', { hasText: 'The platform labels it AI-generated' }).click();
	await site.locator('label.uin-checkbox', { hasText: 'One template across titles and thumbnails' }).click();
	await site.locator('label.verdict-option').filter({ has: slop }).click();
	await site.getByLabel('Reason').fill(DECISION);
	const before = await listSequence();
	await site.getByRole('button', { name: 'Review decision' }).click();
	const confirm = site.getByRole('dialog', { name: 'Write this to the public log?' });
	await expect(confirm).toContainText('Rae');
	await expect(confirm.getByRole('button', { name: 'Write to the log' })).toBeVisible();
	await site.screenshot({ path: 'screenshots/console-decision.png', animations: 'disabled' });
	await confirm.getByRole('button', { name: 'Write to the log' }).click();
	await expect(site.getByText('Decision written to the public log.')).toBeVisible();

	await site.goto(`${ORIGIN}/log`);
	const entry = site.locator('ol.entries > li').first();
	await expect(entry.locator('.src')).toHaveText(REPORTED.name);
	await expect(entry).toContainText(DECISION);
	await expect(entry.locator('.change')).toContainText('Slop');
	await entry.locator('summary').click();
	await expect(entry.locator('details > .more')).toContainText('The platform labels it AI-generated');

	await nextListReachesExtension(before);
	await expect(card(search, CARD.reported)).toHaveAttribute('data-colander', 'hide');
	await expect(card(search, CARD.reported)).toBeHidden();

	// Other installs keep syncing too: their anonymous list downloads are what "protects" counts.
	for (let i = 0; i < 48; i++) await fetch(`${ORIGIN}/v1/list/snapshot`, { method: 'HEAD' });
	await reports.getByRole('button', { name: 'Refresh' }).click();
	await expect(row.locator('[data-v="slop"]')).toContainText('Slop');
	await row.locator('summary').click();
	await expect(row).toContainText(/Protects \d+ installs/);
	// 48 downloads in the last day estimate at least 2 installs, so "protects" counts every syncing install.
	expect(Number(/Protects (\d+) installs/.exec((await row.textContent())!)![1])).toBeGreaterThanOrEqual(2);
	await reports.screenshot({ path: 'screenshots/my-reports-verdict.png' });
	await reports.close();
});

test('an appeal unhides the channel as Disputed during review, and the upheld appeal clears it', async () => {
	await site.goto(`${ORIGIN}/s/yt/${REPORTED.handle}`);
	await expect(site.getByRole('heading', { level: 1, name: REPORTED.name })).toBeVisible();
	await expect(site.locator('.banner .chip-line')).toContainText('Slop');
	await site.getByRole('link', { name: 'Appeal this verdict' }).click();
	await site.getByLabel('Email').fill(CREATOR);
	await site.getByLabel('Your statement').fill('We research and narrate every episode ourselves; AI only draws the space backgrounds.');
	const mark = logMark();
	await site.getByRole('button', { name: 'Start the appeal' }).click();
	await expect(site).toHaveURL(/\/appeal\/status\/apl_\w+\?secret=/);
	await expect(site.getByRole('heading', { name: 'Waiting for the code' })).toBeVisible();
	const code = (await site.locator('.code').textContent())!.trim();
	expect(code).toMatch(/^colander-[A-Z0-9]{8}$/);
	// The status link is also emailed to the creator.
	await expect.poll(() => mailsSince(mark).find((m) => m.to === CREATOR)?.body ?? '').toContain(site.url());
	await site.getByRole('button', { name: 'Check my description' }).click();
	await expect(site.getByRole('heading', { name: 'Waiting for a manual check' })).toBeVisible();

	// No YouTube API key in this run, so staff confirm the code by hand.
	await openInConsole('Appeals');
	const appeal = site.locator('li.item-card', { hasText: code });
	await expect(appeal).toContainText('We research and narrate every episode ourselves');
	const before = await listSequence();
	await appeal.getByRole('button', { name: 'The code is on the channel' }).click();
	await expect(site.getByText('Appeal verified. The source now shows as Disputed.')).toBeVisible();

	await site.goto(`${ORIGIN}/s/yt/${REPORTED.handle}`);
	await expect(site.locator('.banner .chip-line')).toContainText('Disputed');
	await site.screenshot({ path: 'screenshots/source-disputed.png' });
	await expect(site.locator('.banner')).toContainText('Unhidden while staff review');
	await expect(site.locator('.banner')).toContainText('nothing from it is hidden');
	await site.goto(`${ORIGIN}/log`);
	await expect(site.locator('ol.entries > li').first().locator('.src')).toHaveText(REPORTED.name);
	await expect(site.locator('ol.entries > li').first().locator('.change')).toContainText('Disputed');

	// The extension moves forward by a delta from its own copy, not a new snapshot.
	const from = ext.seen.length;
	const base = (await ext.storage<{ sequence: number }>('listIndex')).sequence;
	const seq = await nextListReachesExtension(before);
	const lists = ext.seen.slice(from).filter((s) => s.url.startsWith(`${ORIGIN}/v1/list/`)).map((s) => s.url.slice(ORIGIN.length));
	expect(lists).toEqual([`/v1/list/delta?since=${base}`]);
	expect(await ext.storage<{ sequence: number }>('listIndex').then((i) => i.sequence)).toBe(seq);
	const reported = card(search, CARD.reported);
	await expect(reported).not.toHaveAttribute('data-colander', /./);
	await expect(chip(reported)).toContainText('Disputed');
	await search.bringToFront();
	await reported.scrollIntoViewIfNeeded();
	await reported.screenshot({ path: 'screenshots/disputed-chip.png' });

	await openInConsole('Appeals');
	await site.locator('li.item-card', { hasText: code }).getByRole('button', { name: 'Resolve' }).click();
	await site.getByRole('radio', { name: 'Upheld: set Clear' }).check();
	await site.getByLabel('Reasoning, published in the log').fill('The creator narrates on camera and writes the scripts; generated art alone is not slop.');
	await site.getByRole('button', { name: 'Resolve appeal' }).click();
	await expect(site.getByText('Appeal resolved and logged.')).toBeVisible();

	await site.goto(`${ORIGIN}/s/yt/${REPORTED.handle}`);
	await expect(site.locator('.banner .chip-line')).toContainText('Clear');
	await site.goto(`${ORIGIN}/log`);
	await expect(site.locator('ol.entries > li').first()).toContainText('generated art alone is not slop');

	await nextListReachesExtension(seq);
	await expect(reported).not.toHaveAttribute('data-colander', /./);
	await expect(chip(reported)).toHaveCount(0);
});
