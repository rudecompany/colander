<!--
@component FeedDemo: the recreated feed, decorated by the in-page builders the extension ships.

`full`: a BrowserFrame holding the host page, with the popup docked at the top right (PopupView)
over it; the host page runs on under the popup. The platform picks the page: a YouTube Home grid,
one TikTok For You video, an Instagram feed or a Facebook feed. `level`, `platform` and `paused`
are bindable, so a StrictnessControl or tabs outside drive it, and the docked popup drives them
back. Paused is the feed without Colander: the before and after, with no slider. Hidden items are
not drawn, so the page closes up around them, and the docked popup lists them with Show. The
evidence card of the AI-made item is open on first render, drawn in its final state: motion is
only for changes the visitor makes. The popup docks while the frame is at least 1200 wide, so it never covers the feed
or an open popover; narrower, it hides, and `below` can show the same popup, with the same state,
under the frame (the page wraps it and decides when it shows). With
a fixed `height`, the page fades out over its last 48 px.

Show in the popup puts the item back in its own slot, labeled, takes it off the badge and the
popup's counts, and says "Shown again." in a notice inside the frame, with Undo.

Keyboard: Why moves focus into the popover, Tab stays inside it, and Escape or any of its actions
closes it and returns focus to Why (or to the card when Why went away). The popover open on load
is only a picture until the visitor opens one: Tab moves on past it, and Escape still closes it.

`mini`: the rows of one strictness card at one level, static (inert), with a count line beside
it from demoCounts().
-->
<script lang="ts">
	import { tick, untrack, type Snippet } from 'svelte';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import BrowserFrame from './BrowserFrame.svelte';
	import InPage from './InPage.svelte';
	import PopupView, { type PopupActions, type PopupState } from './PopupView.svelte';
	import Toast from './Toast.svelte';
	import { DEMO_FEED, DEMO_MINI_ITEMS, DEMO_OPEN_ITEM, DEMO_POPUP, INPAGE_COPY, ITEM_NOUN, PLATFORM_DOMAIN } from '../../copy';
	import { DEMO_CSS, DEMO_ORDER, PLATFORM_LAYOUT, demoAction, demoCounts, demoFeed, demoHiddenCount, type DemoLayout } from '../../inpage/demo';
	import type { InpageContext, Theme } from '../../inpage/host';
	import type { DateInput } from '../../utils/format';
	import { STRICTNESS_WORD, type Platform, type Strictness } from '../../verdicts';

	let {
		variant = 'full',
		platform = $bindable('yt'),
		level = $bindable('standard'),
		paused = $bindable(false),
		open = $bindable(variant === 'full' ? DEMO_OPEN_ITEM : null),
		layout,
		items: ids,
		popup = true,
		height,
		listDate = null,
		list,
		theme = 'auto',
		site = '',
		below
	}: {
		variant?: 'full' | 'mini';
		platform?: Platform;
		level?: Strictness;
		paused?: boolean;
		open?: number | null;
		/** Overrides the platform's layout, such as `list` on phones. */
		layout?: Exclude<DemoLayout, 'mini'>;
		/** Item ids to show, in order. Default: the layout's order of all 9, or the 4 mini rows. */
		items?: number[];
		popup?: boolean;
		height?: number;
		listDate?: string | null;
		/** The live list version for the popup's caption; omitted in store art. */
		list?: { sequence: number | null; updatedAt?: DateInput | null };
		theme?: Theme;
		site?: string;
		/** Under the frame: the page's wrapper, given the popup to render inside it. */
		below?: Snippet<[Snippet]>;
	} = $props();

	let revealed = $state<number[]>([]);
	let allowed = $state<number[]>([]);

	const mode = $derived<DemoLayout>(variant === 'mini' ? 'mini' : (layout ?? PLATFORM_LAYOUT[platform]));
	const pick = $derived(ids ?? (variant === 'mini' ? DEMO_MINI_ITEMS : (DEMO_ORDER[mode] ?? DEMO_FEED.map((i) => i.id))));
	const items = $derived(pick.map((id) => DEMO_FEED.find((i) => i.id === id)!));
	// The badge counts what is hidden now: Show and Always allow take an item off it.
	const badge = $derived(demoHiddenCount(level, paused, items, [...revealed, ...allowed]));
	/** The item the "Shown again." notice is about, until it times out, closes or is undone. */
	let shownAgain = $state<number | null>(null);
	/** The visitor opened a popover: from then on it keeps focus inside, as the extension's does. */
	let trap = $state(false);

	// One-shot effects of the visitor's last change, read by the next build and then cleared:
	// what fades in, which popover opens with motion, and where focus goes. Never set on load.
	const pending: { changed: number[]; opened: number | null; focus: string[] } = { changed: [], opened: null, focus: [] };

	let prev = untrack(() => ({ level, paused, open }));
	$effect.pre(() => {
		const next = { level, paused, open };
		const was = prev;
		prev = next;
		untrack(() => {
			if (next.level !== was.level || next.paused !== was.paused) {
				pending.changed = items.filter((i) => demoAction(i, was.level, was.paused) !== demoAction(i, next.level, next.paused)).map((i) => i.id);
				revealed = [];
			}
			if (next.open !== was.open && next.open != null) {
				pending.opened = next.open;
				trap = true;
				// Why on a hidden item (from a popup row) shows it first, so its evidence has a card to open on.
				const it = items.find((i) => i.id === next.open);
				if (it && demoAction(it, next.level, next.paused) === 'hide' && !revealed.includes(it.id)) {
					revealed = [...revealed, it.id];
					pending.changed = [it.id];
				}
			}
		});
	});

	const back = (id: number) => [`why-${id}`, `card-${id}`];
	const handlers = {
		show: (id: number) => ((pending.changed = [id]), (revealed = [...revealed, id]), (open = null), (shownAgain = id)),
		why: (id: number) => {
			if (open === id) {
				pending.focus = back(id);
				open = null;
				return;
			}
			pending.focus = [`pop-allow-${id}`, `pop-${id}`];
			open = id;
		},
		allow: (id: number) => ((allowed = [...allowed, id]), (open = null)),
		notSlop: (id: number) => ((allowed = [...allowed, id]), (open = null))
	};
	// Actions taken in the feed hand focus back to the item; the popup's own rows keep theirs.
	const feedHandlers = {
		...handlers,
		allow: (id: number) => ((pending.focus = back(id)), handlers.allow(id)),
		notSlop: (id: number) => ((pending.focus = back(id)), handlers.notSlop(id))
	};

	function build(ctx: InpageContext) {
		const el = demoFeed(
			ctx,
			{ layout: mode, level, paused, platform, items, revealed, allowed, open, listDate, changed: pending.changed, opened: pending.opened, focus: pending.focus, trap },
			feedHandlers
		);
		pending.changed = [];
		pending.opened = null;
		pending.focus = [];
		return el;
	}

	const popupState = $derived<PopupState>({
		status: paused ? 'paused' : 'active',
		domain: PLATFORM_DOMAIN[platform],
		pausedScope: 'site',
		strictness: level,
		hiddenToday: DEMO_POPUP.hiddenToday,
		noun: ITEM_NOUN[platform],
		rows: paused
			? []
			: items
					.filter((i) => i.verdict && demoAction(i, level) !== 'allow' && !allowed.includes(i.id))
					.map((i) => ({ id: i.id, verdict: i.verdict, title: i.title, action: demoAction(i, level), shown: revealed.includes(i.id) })),
		list
	});
	const popupActions: PopupActions = {
		strictness: (l) => (level = l),
		pause: () => (paused = true),
		resume: () => (paused = false),
		show: (r) => handlers.show(Number(r.id)),
		allow: (r) => handlers.allow(Number(r.id)),
		notSlop: (r) => handlers.notSlop(Number(r.id)),
		why: (r) => (open = Number(r.id))
	};

	// Undo hides the item again, and hands focus to its Show in the popup.
	async function undoShow() {
		const id = shownAgain;
		shownAgain = null;
		if (id == null) return;
		revealed = revealed.filter((r) => r !== id);
		await tick();
		const row = [...(root?.querySelectorAll<HTMLElement>('[data-row]') ?? [])].find((el) => el.dataset.row === String(id));
		row?.querySelector<HTMLElement>('.row-show, .row-btn')?.focus();
	}
	// A new level or a pause starts over: the notice belongs to the Show that made it.
	$effect.pre(() => {
		void level;
		void paused;
		untrack(() => (shownAgain = null));
	});

	let root = $state<HTMLElement>();
	$effect(() => {
		if (variant !== 'full' || !root) return;
		const el = root;
		const win = el.ownerDocument.defaultView!;
		const down = (e: PointerEvent) => {
			if (e.composedPath().some((n) => n instanceof Element && (n.classList.contains('cl-pop') || n.hasAttribute('aria-haspopup')))) return;
			open = null;
		};
		const key = (e: KeyboardEvent) => {
			if (e.key !== 'Escape' || open == null) return;
			if (e.composedPath().includes(el)) pending.focus = back(open);
			open = null;
		};
		win.addEventListener('pointerdown', down, true);
		win.addEventListener('keydown', key);
		return () => {
			win.removeEventListener('pointerdown', down, true);
			win.removeEventListener('keydown', key);
		};
	});
</script>

{#snippet feed()}
	<InPage kind="demo" {theme} {site} css={DEMO_CSS} class={height ? 'crop' : undefined} {build} />
{/snippet}

{#snippet docked()}<PopupView state={popupState} actions={popupActions} />{/snippet}

{#if variant === 'mini'}
	<!-- The picture's summary is announced; the rows inside are inert, so they take no focus. -->
	<div class="mini" role="img" aria-label="{STRICTNESS_WORD[level]}: {demoCounts(level, items)}"><div inert>{@render feed()}</div></div>
{:else}
	<div class="full" bind:this={root}>
		<BrowserFrame count={badge} {paused} {height} docked={popup ? docked : undefined}>
			<div class="host" class:beside={popup}>
				{@render feed()}
				{#if shownAgain != null}
					<div class="notice">
						<Toast
							text={INPAGE_COPY.shownAgain}
							actions={[{ label: INPAGE_COPY.undo, icon: Undo2, onClick: undoShow }]}
							onClose={() => (shownAgain = null)}
							onTimeout={() => (shownAgain = null)}
						/>
					</div>
				{/if}
			</div>
		</BrowserFrame>
		{#if below}{@render below(docked)}{/if}
	</div>
{/if}

<style>
	.full {
		container-type: inline-size;
	}
	.host,
	.host :global(colander-ui) {
		height: 100%;
	}
	.host {
		position: relative;
	}
	/* The notice sits bottom center over the feed, clear of the docked popup, as it does on a host page. */
	.notice {
		position: absolute;
		right: var(--demo-end, 16px);
		bottom: 24px;
		left: var(--demo-start, 16px);
		z-index: 4;
		display: flex;
		justify-content: center;
		pointer-events: none;
	}
	.notice :global(.cl-toast) {
		pointer-events: auto;
	}
	/* The host page runs under the docked popup; its feed keeps to the left 780 px, and a popover at
	   the grid's right edge may reach 56 px into the gap before the popup, clear of the next card's
	   title. */
	.beside {
		--demo-end: max(16px, calc(100% - 764px));
		--demo-pop-out: -56px;
	}
	.mini {
		overflow: hidden;
		border-radius: var(--cl-r-chip);
	}
	@container (max-width: 1199px) {
		.full :global(.docked) {
			display: none;
		}
		/* Undocked, the same 780 px feed sits in the middle, so its rows and popover keep their size. */
		.beside {
			--demo-start: max(16px, calc((100% - 748px) / 2));
			--demo-end: max(16px, calc((100% - 748px) / 2));
		}
	}
	/* Too narrow for the popover to reach past the grid's edge. */
	@container (max-width: 859px) {
		.beside {
			--demo-pop-out: 0px;
		}
	}
</style>
