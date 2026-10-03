<!--
@component Empty — empty-state placeholder.

Shown in a list, table, or panel when there's nothing to render. The
default layout centers an optional icon, a display-font title, an
optional muted body line, and an optional action slot underneath
(typically a Button).

`title` is required; everything else is optional. For an illustrated
empty state, pass an SVG via the `icon` snippet.

CSS lives in `./empty.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Props = HTMLAttributes<HTMLDivElement> & {
    title: string;
    description?: string;
    icon?: Snippet;
    action?: Snippet;
    class?: string;
  };

  let {
    title,
    description,
    icon,
    action,
    class: className,
    ...rest
  }: Props = $props();
</script>

<div class={cn('uin-empty', className)} {...rest}>
  {#if icon}
    <div class="uin-empty-icon" aria-hidden="true">{@render icon()}</div>
  {/if}
  <p class="uin-empty-title">{title}</p>
  {#if description}<p class="uin-empty-desc">{description}</p>{/if}
  {#if action}<div class="uin-empty-action">{@render action()}</div>{/if}
</div>
