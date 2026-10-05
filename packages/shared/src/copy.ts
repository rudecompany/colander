// Product copy that more than one surface shows. Every surface imports these; none keeps an
// inline duplicate. Verdict, strictness, tag and signal words live in verdicts.ts.
// Rules: sentence case, no exclamation marks, digits for numbers, verdict words never describe people.
import type { LayerKey } from './layers';
import type { Action, Platform, Signal, TagVerdict, Verdict } from './verdicts';

/**
 * The one public definition, said as what Colander does: the website, the welcome page and the
 * store copy all show this wording. The spec's own sentence stays in docs/product-requirements.md.
 */
export const DEFINITION_PUBLIC =
	'Colander treats AI-generated content as slop when it is mass-produced with little human effort to capture attention or money, and gives you little in return. AI use alone never makes something slop.';

export const TAGLINE = { first: 'Drain the slop.', second: 'Keep the substance.' } as const;

/* Privacy */

export const PRIVACY_HEADINGS = {
	leaves: 'What leaves your device',
	never: 'What never leaves your device'
} as const;

export const PRIVACY_LEAVES: { title: string; detail: string }[] = [
	{ title: 'List downloads', detail: 'The core list and its updates, fetched with no identifier at all.' },
	{ title: 'Adapter updates', detail: 'Signed selector updates for the four platforms, also with no identifier.' },
	{
		title: 'Tags you choose to send',
		detail:
			'Platform, the item or source ID, your choice, optional type and tests, whether the platform showed an AI label, the time, the extension version and a random install ID.'
	},
	{
		title: 'Reports you choose to send',
		detail: 'The source, up to three example items, your reason, optional type and tests, and the install ID.'
	},
	{ title: 'Plus, if you use it', detail: 'Your plan token to start a trial, renew, and sync settings across browsers.' },
	{ title: 'Review, for curators', detail: 'Decisions you make in the side panel, with your reviewer token.' }
];

export const PRIVACY_NEVER: string[] = [
	'The pages you visit or their addresses',
	'What you watch, read or scroll past',
	'Your account names on YouTube, TikTok, Instagram or Facebook',
	'Anything about items Colander hides for you'
];

export const PRIVACY_INSTALL_ID =
	'The install ID is 16 random bytes made on this device. The server stores only a hash of it. Delete local data to replace it.';

/** Draft rows: check against extension/wxt.config.ts before each release. */
export const PERMISSIONS: { permission: string; why: string; never: string }[] = [
	{
		permission: 'Site access to youtube.com, tiktok.com, instagram.com, facebook.com (asked per platform you choose)',
		why: 'Read feed cards and match them against the list on your device',
		never: 'Send what you watch to a server, or read anything outside feeds'
	},
	{ permission: 'Storage', why: 'Keep the list, your settings and your own tags', never: 'Share them, unless you turn on Plus sync' },
	{ permission: 'Alarms', why: 'Check for list updates on a schedule', never: 'Run anything on the pages you visit' },
	{ permission: 'Scripting', why: 'Hide slop, and draw chips and notices, on the platforms you chose', never: 'Run on any other site' },
	{ permission: 'Side panel', why: 'Show the review queue to curators who connect it', never: 'Open on its own' }
];

export const PERMISSIONS_HEADINGS = {
	permission: 'Permission',
	why: 'Why Colander asks',
	never: 'What Colander never does with it'
} as const;

/* Plans and prices. No strikethrough prices and no percent-off chips, anywhere. */

export const PLAN_COPY = {
	free: {
		name: 'Free',
		price: '$0',
		line: 'Blocking, forever. No account needed.',
		summary: '$0. Blocking, forever. No account needed.',
		features: ['Blocking on all 4 platforms', 'All 3 strictness levels', 'Tagging, reports and appeals', 'Your own block and allow lists'],
		cta: 'Add to Chrome'
	},
	plus: {
		name: 'Plus',
		price: '$30 a year',
		alt: 'or $3 a month',
		short: '$30 a year or $3 a month',
		monthly: '$3 a month',
		billed: { year: 'Billed $30 every 12 months', month: 'Billed $3 every month' },
		saves: 'Saves $6 a year',
		trial: '14 days free, no card',
		cta: 'Start 14 days free',
		pitch: 'Plus adds control',
		features: [
			'Sync across browsers',
			'Strictness per platform and per topic',
			'Keyword and hashtag rules',
			'A weekly summary',
			'Early access to new platforms'
		],
		gated: 'Part of Plus.'
	},
	family: { name: 'Family', line: 'Coming in 1.1' },
	supporter: {
		name: 'Supporter',
		line: 'Any amount, once or monthly',
		detail: 'No extra features. Optional credit on the supporters page.',
		cta: 'Support our work'
	},
	trust: 'Blocking never moves behind Plus. Cancel any time. Paying never changes a verdict.'
} as const;

/** The spec's card-fee table on /plans: what a fixed fee per charge takes from each Plus price. */
export const PLAN_FEES = {
	title: 'Where your $3 goes',
	lead: 'Card payments carry a fixed fee per charge, so a fifth of a $3 monthly charge can go to fees. Checkout runs through a merchant of record, which handles sales tax and VAT in every country.',
	columns: ['Charge', 'Card processor, about 2.9% + $0.30', 'Merchant of record, about 5% + $0.50'],
	rows: [
		['$3 monthly', '$0.39, or 13%', '$0.65, or 22%'],
		['$30 yearly', '$1.17, or 3.9%', '$2.00, or 6.7%']
	]
} as const;

/* Platforms */

/** Surface words keyed by the adapter surface id in extension/src/adapters/default-config.json. */
export const SURFACE_WORD: Record<string, string> = {
	'yt.home': 'Home',
	'yt.shelf': 'Home',
	'yt.subscriptions': 'Subscriptions',
	'yt.search': 'Search',
	'yt.watch': 'Up next',
	'yt.shorts': 'Shorts',
	'yt.channel': 'Channel pages',
	'tt.feed': 'For You',
	'tt.search': 'Search',
	'tt.profile': 'Profiles',
	'ig.feed': 'Feed',
	'ig.reels': 'Reels',
	'ig.grid': 'Profile grids',
	'fb.feed': 'Feed',
	'fb.reels': 'Reels'
};

const SURFACE_ORDER: Record<Platform, string[]> = {
	yt: ['yt.home', 'yt.subscriptions', 'yt.search', 'yt.watch', 'yt.shorts', 'yt.channel'],
	tt: ['tt.feed', 'tt.search', 'tt.profile'],
	ig: ['ig.feed', 'ig.reels', 'ig.grid'],
	fb: ['fb.feed', 'fb.reels']
};

/** "Home, Subscriptions, Search, Up next, Shorts, Channel pages" */
export const PLATFORM_SURFACES = Object.fromEntries(
	Object.entries(SURFACE_ORDER).map(([p, ids]) => [p, ids.map((id) => SURFACE_WORD[id]).join(', ')])
) as Record<Platform, string>;

/** The item noun in feeds, as in "Tag this video" and "Skipped 2 slop videos". */
export const ITEM_NOUN: Record<Platform, string> = { yt: 'video', tt: 'video', ig: 'post', fb: 'post' };

/** The domain the popup names, as in "Active on youtube.com". */
export const PLATFORM_DOMAIN: Record<Platform, string> = {
	yt: 'youtube.com',
	tt: 'tiktok.com',
	ig: 'instagram.com',
	fb: 'facebook.com'
};

export const SUPPORTED_SITES = 'Colander works on YouTube, TikTok, Instagram and Facebook.';

/** The popup's weekly card, with the verb the stats and Options use: Colander hid them. `shown` is the formatted count. */
export const WEEKLY_HIDDEN = (n: number, shown: string) => `Colander hid ${shown} ${n === 1 ? 'item' : 'items'} for you this week.`;

/** When a source verdict is looked at again, as the source page and the side panel say it. */
export const RESCORE_LINE = (next: string | null) => `Re-scored every 90 days.${next ? ` Next: ${next}` : ''}`;

/* Tagging */

/** The one-line meaning under each tag choice. */
export const TAG_MEANING: Record<TagVerdict, string> = {
	slop: 'AI-made, and low effort, mass-produced or hollow',
	ai_fine: 'Made with AI, and worth seeing',
	not_slop: 'Made by people, or AI only helped'
};

/** The glyph each tag choice wears. */
export const TAG_GLYPH: Record<TagVerdict, Verdict> = { slop: 'slop', ai_fine: 'ai_made', not_slop: 'clear' };

/* In-page UI: every string the shared builders show. */

export const INPAGE_COPY = {
	show: 'Show',
	why: 'Why',
	undo: 'Undo',
	close: 'Close',
	tag: 'Tag',
	reportSource: 'Report source',
	alwaysAllow: 'Always allow',
	notSlop: 'Not slop',
	addDetail: 'Add detail',
	save: 'Save',
	type: 'Type',
	tests: 'Tests',
	whyHidden: 'Why this is hidden',
	whyLabeled: 'Why this is labeled',
	sourcePage: 'Source page',
	shownAgain: 'Shown again.',
	coreList: (date: string) => `Core list, updated ${date}`,
	appeal: (sourceNoun: string) => `Is this your ${sourceNoun}? Appeal this verdict.`,
	tagTitle: (noun: string) => `Tag this ${noun}`,
	/** Under the tag choices, so it is said before the choice: the toasts stay one line. */
	tagCounts: 'Your tag counts toward the shared list.',
	/**
	 * The tag confirmation, one line. A Slop tag says what it did to the card, which depends on the
	 * strictness level and Always allow: hidden at Standard, labeled at Label, still shown when allowed.
	 */
	tagged: (t: TagVerdict, action: Action | 'none'): string =>
		t === 'ai_fine'
			? 'Tagged as AI-made but fine.'
			: t === 'not_slop'
				? 'Tagged as not slop.'
				: action === 'hide'
					? 'Tagged. Hidden for you.'
					: action === 'label'
						? 'Tagged. Labeled for you.'
						: 'Tagged. Shown for you.',
	/** AI-made items skip only at No AI and are never called slop; a mixed run names neither. */
	skipped: (n: number, noun: string, kind?: 'slop' | 'ai_made') =>
		`Skipped ${n} ${kind === 'ai_made' ? 'AI-made ' : kind === 'slop' ? 'slop ' : ''}${n === 1 ? noun : `${noun}s`}.`,
	chipName: (word: string, hidden: boolean) => `${word}, why this is ${hidden ? 'hidden' : 'labeled'}`,
	report: {
		title: (handle: string) => `Report ${handle}`,
		step: (n: number) => `Step ${n} of 2`,
		examples: 'Pick up to 3 examples',
		why: 'Why is this slop?',
		note: 'Note, optional',
		notePlaceholder: 'For example: every video is AI history narration with the same voice and title template.',
		next: 'Next',
		back: 'Back',
		send: 'Send report',
		sending: 'Sending',
		received: 'Report received. Track it in My reports.',
		myReports: 'My reports'
	}
};

/* The demo feed, shared by the website hero, the welcome page and the store art. */

export type ThumbScene = 'gears' | 'template-a' | 'tide-pool' | 'bread' | 'template-b' | 'kite' | 'coins' | 'kettle';

export interface DemoItem {
	id: number;
	title: string;
	/** Invented, and checked against all 4 platforms before shipping. */
	handle: string;
	verdict: Verdict | null;
	signals: Signal[];
	scene: ThumbScene;
	/** The large numeral on a template thumbnail. */
	part?: number;
	age: string;
	/** Evidence rows when the item's card is opened. */
	evidence?: { layer: LayerKey; text: string; agreed: boolean }[];
	/** Another framing of the scene's picture, for a second video from the same channel. */
	crop?: ThumbCrop;
}

/** Zoom into a scene's picture: `zoom` 1 is the whole image, `x` and `y` (0 to 1) pick the focus. */
export interface ThumbCrop {
	zoom: number;
	x: number;
	y: number;
}

export const DEMO_FEED: DemoItem[] = [
	{ id: 1, title: 'Restoring a 1952 bench vise', handle: '@workbench.notes', verdict: null, signals: [], scene: 'gears', age: '2 days ago' },
	{
		id: 2,
		title: 'Ancient Rome facts you never knew, Part 46',
		handle: '@romefacts.minute',
		verdict: 'slop',
		signals: ['high_volume', 'platform_label', 'templated', 'community_consensus'],
		scene: 'template-a',
		part: 46,
		age: '6 hours ago'
	},
	{
		id: 3,
		title: 'Tide pools at low tide, a field guide',
		handle: '@coastline.journal',
		verdict: 'ai_made',
		signals: ['creator_statement'],
		scene: 'tide-pool',
		age: '1 week ago'
	},
	{
		id: 4,
		title: 'Ancient Rome facts you never knew, Part 47',
		handle: '@romefacts.minute',
		verdict: 'slop',
		signals: ['high_volume', 'platform_label', 'templated', 'community_consensus'],
		scene: 'template-a',
		part: 47,
		age: '2 hours ago'
	},
	{ id: 5, title: 'Why sourdough needs a cold proof', handle: '@breadwork', verdict: null, signals: [], scene: 'bread', age: '3 weeks ago' },
	{
		id: 6,
		title: '10 sleep habits, explained in 60 seconds',
		handle: '@dailyrest.tips',
		verdict: 'likely_slop',
		signals: ['high_volume', 'platform_label', 'templated'],
		scene: 'template-b',
		part: 10,
		age: '1 day ago',
		evidence: [
			{ layer: 'provenance', text: 'The platform labels it AI-generated.', agreed: true },
			{ layer: 'behavior', text: 'One title template, numbered part after part.', agreed: true },
			{ layer: 'consensus', text: 'Tags are still coming in.', agreed: false }
		]
	},
	{ id: 7, title: 'Building a kite from one sheet of paper', handle: '@kiteday', verdict: null, signals: [], scene: 'kite', age: '4 days ago' },
	{
		id: 8,
		title: 'A lecture on medieval coinage',
		handle: '@coin.lectures',
		verdict: 'disputed',
		signals: ['open_appeal'],
		scene: 'coins',
		age: '5 days ago'
	},
	{ id: 9, title: 'Descaling a kettle with one lemon', handle: '@kitchen.fixes', verdict: null, signals: [], scene: 'kettle', age: '1 month ago' },
	// More clear videos from the same channels, framed from their pictures, so a hidden item never
	// leaves a short last row in view: the grid stays full at every level and after any Show.
	{ id: 10, title: 'Setting up a small home workshop', handle: '@workbench.notes', verdict: null, signals: [], scene: 'gears', crop: { zoom: 1.9, x: 0.05, y: 0.1 }, age: '3 weeks ago' },
	{ id: 11, title: 'Lining a proofing basket with linen', handle: '@breadwork', verdict: null, signals: [], scene: 'bread', crop: { zoom: 1.9, x: 0.9, y: 0.1 }, age: '5 days ago' },
	{ id: 12, title: 'Reading the wind on an open field', handle: '@kiteday', verdict: null, signals: [], scene: 'kite', crop: { zoom: 1.8, x: 0, y: 1 }, age: '2 weeks ago' },
	{ id: 13, title: 'Three ways to clean with a lemon', handle: '@kitchen.fixes', verdict: null, signals: [], scene: 'kettle', crop: { zoom: 1.9, x: 1, y: 0.75 }, age: '6 days ago' },
	{ id: 14, title: 'Lapping the jaws of an old vise', handle: '@workbench.notes', verdict: null, signals: [], scene: 'gears', crop: { zoom: 1.8, x: 0.45, y: 0.35 }, age: '2 months ago' },
	{ id: 15, title: 'Scoring patterns for a country loaf', handle: '@breadwork', verdict: null, signals: [], scene: 'bread', crop: { zoom: 1.8, x: 0.4, y: 0.6 }, age: '1 week ago' },
	{ id: 16, title: 'Tying bows for a kite tail', handle: '@kiteday', verdict: null, signals: [], scene: 'kite', crop: { zoom: 2.2, x: 0.6, y: 0.85 }, age: '3 days ago' }
];

/** The item whose evidence card is open when the demo first renders: labeled, so it is on the page at Standard. */
export const DEMO_OPEN_ITEM = 3;

/** The rows of a strictness card: Slop, Likely slop, AI-made and a clear item, before any is hidden. */
export const DEMO_MINI_ITEMS = [2, 6, 3, 1];

/** The title of the evidence card on full surfaces: the source page and the side panel. */
export const EVIDENCE_TITLE = 'Evidence by layer';

/** Demo popup values for the hero and the store art. Never live community counts. */
export const DEMO_POPUP = { hiddenToday: 44 } as const;

/** The disclosure shown with every picture of the demo feed, in caption style. */
export const DEMO_THUMBS_NOTE = 'Thumbnails are AI-generated illustrations.';
