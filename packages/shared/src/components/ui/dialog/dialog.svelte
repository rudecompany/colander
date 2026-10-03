<!--
@component Dialog — modal overlay built on bits-ui's Dialog primitive.

A controlled modal: bind `open` and the consumer drives visibility.
The headless behavior — focus trap, ESC handling, click-outside,
portal mount, scroll lock — is delegated to `bits-ui`. Our chrome is
a centered card with a header (title + optional description), a body
slot, an optional footer slot, and a small × close button.

`size` picks the max-width: `sm` (400), `md` (480, default), or `lg`
(640).

Requires `bits-ui` to be installed in the consumer project:
`npm install bits-ui`.

CSS lives in `./dialog.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import {Dialog as BD} from 'bits-ui';
  import {cn} from '../../../utils/cn';

  type Size = 'sm' | 'md' | 'lg';

  type Props = {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    title: string;
    description?: string;
    size?: Size;
    closeLabel?: string;
    class?: string;
    children: Snippet;
    footer?: Snippet;
  };

  let {
    open = $bindable(false),
    onOpenChange,
    title,
    description,
    size = 'md',
    closeLabel = 'Close',
    class: className,
    children,
    footer,
  }: Props = $props();
</script>

<BD.Root
  bind:open
  onOpenChange={(v: boolean) => onOpenChange?.(v)}
>
  <BD.Portal>
    <BD.Overlay class="uin-dialog-overlay" />
    <BD.Content class={cn('uin-dialog', `uin-dialog-${size}`, className)}>
      <header class="uin-dialog-head">
        <BD.Title class="uin-dialog-title">{title}</BD.Title>
        {#if description}
          <BD.Description class="uin-dialog-desc">{description}</BD.Description>
        {/if}
      </header>
      <div class="uin-dialog-body">{@render children()}</div>
      {#if footer}
        <footer class="uin-dialog-foot">{@render footer()}</footer>
      {/if}
      <BD.Close class="uin-dialog-close" aria-label={closeLabel}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </BD.Close>
    </BD.Content>
  </BD.Portal>
</BD.Root>
