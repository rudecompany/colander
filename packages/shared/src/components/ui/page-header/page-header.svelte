<!--
@component PageHeader — header region for page-level layouts.

Pairs with `PageBody` and `PageFooter` to form a vertical page
chassis. Renders a sticky-able section with title, eyebrow, optional
description, and an actions slot on the right. For full-window
shells use `AppShell`; PageHeader is for content-page chrome inside
the main scroll area.

CSS lives in `./page-header.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Props = HTMLAttributes<HTMLElement> & {
    title?: string;
    eyebrow?: string;
    description?: string;
    sticky?: boolean;
    class?: string;
    actions?: Snippet;
    children?: Snippet;
  };

  let {
    title,
    eyebrow,
    description,
    sticky = false,
    class: className,
    actions,
    children,
    ...rest
  }: Props = $props();
</script>

<header
  class={cn('uin-pg-head', sticky && 'uin-pg-head-sticky', className)}
  {...rest}
>
  <div class="uin-pg-head-text">
    {#if eyebrow}<p class="uin-pg-head-eyebrow">{eyebrow}</p>{/if}
    {#if title}<h1 class="uin-pg-head-title">{title}</h1>{/if}
    {#if description}<p class="uin-pg-head-desc">{description}</p>{/if}
    {#if children}{@render children()}{/if}
  </div>
  {#if actions}
    <div class="uin-pg-head-actions">{@render actions()}</div>
  {/if}
</header>
