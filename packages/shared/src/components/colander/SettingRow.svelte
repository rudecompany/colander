<!--
@component SettingRow: a title in 600 14/20, a muted 12/16 description, and the control on the
right. At least 56 tall, with a hairline between rows. The whole row is the label: a click
anywhere toggles a Switch. The control snippet gets ids to wire its name and description.
Use `as="div"` for controls that are not one labelable element, such as a segmented control.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		as = 'label',
		control,
		children
	}: {
		title: string;
		description?: string;
		as?: 'label' | 'div';
		control?: Snippet<[{ labelledby: string; describedby: string | undefined }]>;
		children?: Snippet;
	} = $props();

	const uid = $props.id();
	const titleId = `${uid}-t`;
	const descId = $derived(description ? `${uid}-d` : undefined);
</script>

<svelte:element this={as} class="cl-setting">
	<span class="text">
		<span class="title" id={titleId}>{title}</span>
		{#if description}<span class="desc" id={descId}>{description}</span>{/if}
		{#if children}{@render children()}{/if}
	</span>
	{#if control}<span class="control">{@render control({ labelledby: titleId, describedby: descId })}</span>{/if}
</svelte:element>

<style>
	.cl-setting {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		min-height: 56px;
		padding: 8px 0;
		cursor: default;
	}
	label.cl-setting {
		cursor: pointer;
	}
	:global(.cl-setting + .cl-setting) {
		border-top: 1px solid var(--cl-border);
	}
	.text {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.title {
		font: var(--cl-body-strong);
	}
	.desc {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.control {
		display: flex;
		flex: none;
		align-items: center;
	}
</style>
