<!--
@component Menu: a trigger and a short list of actions, on bits-ui's dropdown menu (role="menu",
arrow keys, Escape closes and focus returns to the trigger). Items are 32 tall, each an optional
16 px icon beside its word. The list floats with the one shadow.
-->
<script lang="ts" module>
	import type { Component } from 'svelte';

	export type MenuItem = { label: string; icon?: Component<{ size?: number; 'aria-hidden'?: 'true' }>; onSelect: () => void; disabled?: boolean };
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { DropdownMenu } from 'bits-ui';

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
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}{@render trigger(props)}{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content class="cl-menu" {align} sideOffset={4} aria-label={label}>
		{#each items as item (item.label)}
			<DropdownMenu.Item class="cl-menu-item" disabled={item.disabled} onSelect={item.onSelect}>
				{#if item.icon}<item.icon size={16} aria-hidden="true" />{/if}
				<span>{item.label}</span>
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>

<style>
	:global(.cl-menu) {
		z-index: 60;
		min-width: 200px;
		padding: 4px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		color: var(--cl-text);
		box-shadow: var(--cl-shadow-pop);
		outline: none;
	}
	:global(.cl-menu-item) {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 8px;
		border-radius: var(--cl-r-chip);
		font: var(--cl-body);
		cursor: pointer;
		outline: none;
	}
	:global(.cl-menu-item[data-highlighted]) {
		background: color-mix(in srgb, var(--cl-text) 6%, transparent);
	}
	:global(.cl-menu-item[data-disabled]) {
		opacity: 0.4;
		cursor: default;
	}
</style>
