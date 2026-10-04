// Website-only copy: the Kapwing figures, the comparison and the FAQ. Copy shared with the
// extension lives in @colander/shared (copy.ts).

export const KAPWING_URL = 'https://www.kapwing.com/resources/the-tiktok-ai-slop-report/';

/**
 * Kapwing, The TikTok AI Slop Report, data from May 2026. One dot per video, filled row by row.
 * Each chart is 237.5 units wide, its column's width on desktop, so dots render at their size.
 */
export const KAPWING = [
	{
		number: '59%',
		share: 59,
		cols: 25,
		rows: 20,
		pitch: 9.5,
		dot: 4,
		filled: 295,
		caption: "of the first 500 videos TikTok's For You feed showed a new account",
		label: '295 of 500 dots filled: 59% of the first 500 videos TikTok showed a new account were AI slop'
	},
	{
		number: '57.4%',
		share: 57.4,
		cols: 50,
		rows: 40,
		pitch: 4.75,
		dot: 3,
		filled: 1148,
		caption: "of 2,000 videos in TikTok's Kids category",
		label: "1,148 of 2,000 dots filled: 57.4% of 2,000 videos in TikTok's Kids category were AI slop"
	},
	{
		number: '21%',
		share: 21,
		cols: 25,
		rows: 20,
		pitch: 9.5,
		dot: 4,
		filled: 105,
		caption: 'of the first 500 YouTube Shorts videos',
		label: '105 of 500 dots filled: 21% of the first 500 YouTube Shorts videos were AI slop'
	}
];

/** The date every comparison cell was last checked. Re-verify each release and move this date. */
export const COMPARISON_CHECKED = '2026-10-03';

/**
 * Rows of the comparison: released AI content blockers on the Chrome Web Store and Firefox Add-ons.
 * Competitors are never named.
 */
export const COMPARISON_SCOPE = 'AI content blockers on the Chrome Web Store and Firefox Add-ons';

export const COMPARISON: { check: string; common: string; colander: string }[] = [
	{
		check: 'What gets hidden',
		common: 'All AI content, or anything about AI',
		colander: 'Slop. AI-made items stay visible with a label at Standard.'
	},
	{
		check: 'Platforms',
		common: 'YouTube only, for most',
		colander: 'YouTube, TikTok, Instagram and Facebook'
	},
	{
		check: 'Why an item is hidden',
		common: 'Rarely shown',
		colander: 'Every hidden item says which signals agreed'
	},
	{ check: 'Undo', common: 'Varies', colander: 'One click, in the popup, for every hidden item' },
	{
		check: 'Creator appeals',
		common: 'Rare',
		colander: 'Yes. The source is unhidden while staff review.'
	},
	{
		check: 'Public record of decisions',
		common: 'None found',
		colander: 'Every verdict change is in the decision log'
	},
	{
		check: 'Price of blocking',
		common: 'Often part of a paid tier',
		colander: 'Free, forever. Plus is $3 a month for extra control.'
	}
];

export const FAQ: { q: string; a: string }[] = [
	{
		q: 'Why is blocking free?',
		a: 'Blocking is the job Colander exists to do, and it stays free for good. The list is built from tags by the people who use it, so it would be unfair to charge them for it. Plus adds control on top, never blocking.'
	},
	{
		q: 'How does Colander make money?',
		a: 'Plus at $3 a month or $30 a year, gifts of any amount, and grants. There are no ads, no affiliate links and no sale of data, and every funding source is published on the transparency page.'
	},
	{
		q: 'What does Colander hide, and what does it leave?',
		a: 'At Standard, the default, it hides Slop and Likely slop and labels AI-made items. Hidden items leave no gap, like blocked ads, and the popup lists each one with Show. AI use alone never makes something slop, so AI-made work stays visible with a label. You can pick Label or No AI instead.'
	},
	{
		q: 'Does Colander see what I watch?',
		a: 'No. The list downloads to your device and matching happens there, so the pages you visit and what you watch never leave your browser. Tags and reports you choose to send carry a random install ID, not your name.'
	},
	{
		q: 'What if Colander hides something it should not?',
		a: 'Every hidden item says why. Show brings it back in one click, Always allow keeps that source visible for you, and Not slop counts toward the shared list. Every verdict change is published in the decision log.'
	},
	{
		q: 'I make videos. What if my channel is labeled?',
		a: 'Your channel has a public page with its verdict and the evidence behind it. Appeals are free: verify that the channel is yours, and it is unhidden for everyone while staff review it. The outcome and the reason go in the decision log.'
	},
	{
		q: 'Which browsers does it work in?',
		a: 'Chrome on desktop. It also works in Edge and Brave, which install Chrome extensions. Phones do not run browser extensions, so send the link to your computer.'
	},
	{
		q: 'Can I cancel Plus any time?',
		a: 'Yes, in one click on your account page. Plus stays on until the end of the period you paid for, and if you were charged in the last 30 days you can have that charge refunded. Paying never changes a verdict.'
	}
];
