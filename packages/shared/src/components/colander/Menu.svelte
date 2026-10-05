<!--
@component Menu: a trigger and a short list of actions (role="menu"). Click, Enter, Space or
Down opens it on the first item, Up on the last; arrow keys, Home and End move; Escape closes and
returns focus to the trigger; choosing an item does too. Items are 32 tall, each an optional 16 px
icon beside its word. The list floats in the top layer (the Popover API), so no overflow clips it,
with the one shadow, below the trigger, or above it when there is no room below.
No dependency: the popup and the website hero load it on every open.
-->
<script lang="ts" module>
	import type { Component } from 'svelte';

	export type MenuItem = { label: string; icon?: Component<{ size?: number; 'aria-hidden'?: 'true' }>; onSelect: () => void; disabled?: boolean };
</script>

<script lang="ts">
	import { tick, type Snippet } from 'svelte';

	let {
		items,
		trigger,
		label,
		align = 'end'
	}: {
		items: MenuItem[];
		/** The trigger's content; it renders inside a button that receives `props`. */
		trigger: Snippet<[Record<string, unknown>]>;
		label?: string;
		align?: 'start' | 'end';
	} = $props();

	const uid = $props.id();
	const ITEM = '[role="menuitem"]:not([aria-disabled="true"])';
	let open = $state(false);
	let menu = $state<HTMLElement>();
	let anchor: HTMLElement | null = null;

	function place() {
		if (!menu || !anchor) return;
		const win = menu.ownerDocument.defaultView!;
		const r = anchor.getBoundingClientRect();
		const w = menu.offsetWidth;
		const h = menu.offsetHeight;
		const m = 8;
		let top = r.bottom + 4;
		if (top + h > win.innerHeight - m && r.top - 4 - h >= m) top = r.top - 4 - h;
		const left = Math.min(Math.max(m, align === 'start' ? r.left : r.right - w), win.innerWidth - w - m);
		menu.style.top = `${Math.round(Math.max(m, top))}px`;
		menu.style.left = `${Math.round(left)}px`;
	}

	const list = () => [...(menu?.querySelectorAll<HTMLElement>(ITEM) ?? [])];

	/** Keyboard opens land on an item; a pointer open focuses the list, so nothing looks chosen. */
	async function show(focus: 'first' | 'last' | 'list') {
		open = true;
		await tick();
		if (!menu) return;
		menu.showPopover?.();
		place();
		const all = list();
		(focus === 'list' ? menu : focus === 'first' ? all[0] : all[all.length - 1])?.focus();
	}

	/** Closes; `restore` returns focus to the trigger when it is still on the page. */
	function hide(restore: boolean) {
		if (!open) return;
		open = false;
		if (menu?.matches(':popover-open')) menu.hidePopover();
		if (restore && anchor?.isConnected) anchor.focus();
	}

	// While open, the list follows its trigger through scrolls and resizes.
	$effect(() => {
		if (!open || !menu) return;
		const win = menu.ownerDocument.defaultView!;
		const follow = () => place();
		win.addEventListener('scroll', follow, { capture: true, passive: true });
		win.addEventListener('resize', follow, { passive: true });
		return () => {
			win.removeEventListener('scroll', follow, { capture: true });
			win.removeEventListener('resize', follow);
		};
	});

	const triggerProps = $derived({
		id: `${uid}-trigger`,
		'aria-haspopup': 'menu',
		'aria-expanded': open ? 'true' : 'false',
		'aria-controls': open ? `${uid}-menu` : undefined,
		onclick: (e: MouseEvent) => {
			anchor = e.currentTarget as HTMLElement;
			if (open) hide(false);
			// Enter and Space click with detail 0.
			else show(e.detail === 0 ? 'first' : 'list');
		},
		onkeydown: (e: KeyboardEvent) => {
			if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
			e.preventDefault();
			anchor = e.currentTarget as HTMLElement;
			show(e.key === 'ArrowDown' ? 'first' : 'last');
		}
	});

	function keydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			hide(true);
		} else if (e.key === 'Tab') hide(false);
		else {
			const all = list();
			const i = all.indexOf(menu!.ownerDocument.activeElement as HTMLElement);
			const n = all.length;
			const k = e.key;
			const next = k === 'ArrowDown' ? (i + 1) % n : k === 'ArrowUp' ? (i < 0 ? n - 1 : (i - 1 + n) % n) : k === 'Home' ? 0 : k === 'End' ? n - 1 : -1;
			if (next < 0 || !n) return;
			e.preventDefault();
			all[next]!.focus();
		}
	}

	function choose(item: MenuItem) {
		if (item.disabled) return;
		hide(true);
		item.onSelect();
	}
</script>

{@render trigger(triggerProps)}
{#if open}
	<div
		bind:this={menu}
		id="{uid}-menu"
		class="cl-menu"
		role="menu"
		tabindex="-1"
		aria-label={label}
		aria-labelledby={label ? undefined : `${uid}-trigger`}
		popover="auto"
		ontoggle={(e) => {
			if ((e as ToggleEvent).newState === 'closed') open = false;
		}}
		onkeydown={keydown}
	>
		{#each items as item (item.label)}
			<button
				type="button"
				class="cl-menu-item"
				role="menuitem"
				tabindex="-1"
				aria-disabled={item.disabled ? 'true' : undefined}
				onclick={() => choose(item)}
			>
				{#if item.icon}<item.icon size={16} aria-hidden="true" />{/if}
				<span>{item.label}</span>
			</button>
		{/each}
	</div>
{/if}

<style>
	.cl-menu {
		position: fixed;
		inset: auto;
		z-index: 60;
		min-width: 200px;
		margin: 0;
		padding: 4px;
		overflow: visible;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		color: var(--cl-text);
		box-shadow: var(--cl-shadow-pop);
		outline: none;
	}
	.cl-menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 32px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--cl-r-chip);
		background: transparent;
		color: inherit;
		font: var(--cl-body);
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}
	.cl-menu-item:hover,
	.cl-menu-item:focus {
		background: color-mix(in srgb, var(--cl-text) 6%, transparent);
	}
	.cl-menu-item:focus {
		outline: none;
	}
	/* Inside the menu's 4 px padding the ring is drawn inset, so it never covers the next item. */
	.cl-menu-item:focus-visible {
		outline: 2px solid var(--cl-brand);
		outline-offset: -2px;
		box-shadow: none;
	}
	.cl-menu-item[aria-disabled='true'] {
		opacity: 0.4;
		cursor: default;
	}
	.cl-menu-item :global(svg) {
		flex: none;
	}
</style>
