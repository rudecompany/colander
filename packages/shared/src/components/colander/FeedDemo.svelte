<!--
@component FeedDemo: the recreated feed, decorated by the in-page builders the extension ships.

`full`: a BrowserFrame holding the host page, with the popup docked at the top right (PopupView).
The platform picks the layout: YouTube a grid, TikTok and Instagram swipe, Facebook a list.
`level`, `platform` and `paused` are bindable, so a StrictnessControl or tabs outside drive it,
and the docked popup drives them back. Paused is the feed without Colander: the before and after,
with no slider. The evidence card of item 6 is open on first render. Below 900 px of width the
docked popup hides; the page shows PopupView under the frame instead.

`mini`: the rows of one strictness card at one level, static (inert), with a count line beside
it from demoCounts().
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import BrowserFrame from './BrowserFrame.svelte';
	import InPage from './InPage.svelte';
	import PopupView, { type PopupActions, type PopupState } from './PopupView.svelte';
	import { DEMO_FEED, DEMO_MINI_ITEMS, DEMO_OPEN_ITEM, DEMO_POPUP, ITEM_NOUN, PLATFORM_DOMAIN } from '../../copy';
	import { demoAction, demoCounts, demoFeed, demoHiddenCount, DEMO_CSS, PLATFORM_LAYOUT, type DemoLayout } from '../../inpage/demo';
	import type { Theme } from '../../inpage/host';
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
		site = ''
	}: {
		variant?: 'full' | 'mini';
		platform?: Platform;
		level?: Strictness;
		paused?: boolean;
		open?: number | null;
		/** Overrides the platform's layout, such as `list` on phones. */
		layout?: Exclude<DemoLayout, 'mini'>;
		/** Item ids to show, in order. Default: all 9, or the 4 mini rows. */
		items?: number[];
		popup?: boolean;
		height?: number;
		listDate?: string | null;
		/** The live list version for the popup's caption; omitted in store art. */
		list?: { sequence: number | null; updatedAt?: DateInput | null };
		theme?: Theme;
		site?: string;
	} = $props();

	let revealed = $state<number[]>([]);
	let allowed = $state<number[]>([]);
	let skipped = $state<number[]>([]);
	let changed = $state<number[]>([]);

	const pick = $derived(ids ?? (variant === 'mini' ? DEMO_MINI_ITEMS : DEMO_FEED.map((i) => i.id)));
	const items = $derived(pick.map((id) => DEMO_FEED.find((i) => i.id === id)!).filter((i) => !skipped.includes(i.id)));
	const mode = $derived<DemoLayout>(variant === 'mini' ? 'mini' : (layout ?? PLATFORM_LAYOUT[platform]));
	const badge = $derived(demoHiddenCount(level, paused, items));

	// Fade in only the items whose treatment changed.
	let prev = untrack(() => ({ level, paused }));
	$effect.pre(() => {
		const next = { level, paused };
		if (next.level === prev.level && next.paused === prev.paused) return;
		const was = prev;
		prev = next;
		untrack(() => {
			changed = items.filter((i) => demoAction(i, was.level, was.paused) !== demoAction(i, next.level, next.paused)).map((i) => i.id);
			revealed = [];
		});
	});

	const handlers = {
		show: (id: number) => ((revealed = [...revealed, id]), (open = null)),
		why: (id: number) => (open = open === id ? null : id),
		allow: (id: number) => ((allowed = [...allowed, id]), (open = null)),
		notSlop: (id: number) => ((allowed = [...allowed, id]), (open = null)),
		skip: (id: number) => (skipped = [...skipped, id])
	};

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

	let root = $state<HTMLElement>();
	$effect(() => {
		if (variant !== 'full' || !root) return;
		const win = root.ownerDocument.defaultView!;
		const close = (e: Event) => {
			if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
			if (e instanceof PointerEvent && e.composedPath().some((n) => n instanceof Element && (n.classList.contains('cl-pop') || n.hasAttribute('aria-haspopup')))) return;
			open = null;
		};
		win.addEventListener('pointerdown', close, true);
		win.addEventListener('keydown', close);
		return () => {
			win.removeEventListener('pointerdown', close, true);
			win.removeEventListener('keydown', close);
		};
	});
</script>

{#snippet feed()}
	<InPage
		kind="demo"
		{theme}
		{site}
		css={DEMO_CSS}
		build={(ctx) =>
			demoFeed(ctx, { layout: mode, level, paused, platform, items, revealed, allowed, open, listDate, changed }, handlers)}
	/>
{/snippet}

{#snippet docked()}<PopupView state={popupState} actions={popupActions} />{/snippet}

{#if variant === 'mini'}
	<div class="mini" inert role="img" aria-label="{STRICTNESS_WORD[level]}: {demoCounts(level, items)}">{@render feed()}</div>
{:else}
	<div class="full" bind:this={root}>
		<BrowserFrame count={badge} {paused} {height} docked={popup ? docked : undefined}>
			<div class="host" class:beside={popup}>{@render feed()}</div>
		</BrowserFrame>
	</div>
{/if}

<style>
	.full {
		container-type: inline-size;
	}
	.host {
		height: 100%;
	}
	.beside {
		max-width: 780px;
	}
	.mini {
		overflow: hidden;
		border-radius: var(--cl-r-chip);
	}
	@container (max-width: 899px) {
		.full :global(.docked) {
			display: none;
		}
		.beside {
			max-width: none;
		}
	}
</style>
