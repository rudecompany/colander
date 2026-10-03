<!--
@component Tooltip — short hover-/focus-triggered label.

Built on bits-ui's `Tooltip`. Smaller than `Popover` and non-
interactive — the content shouldn't accept clicks. Use for one-line
explanations of icon buttons, abbreviations, truncated text.

`delayDuration` (ms) controls how long the trigger must be hovered
before the tooltip appears (default 250).

Requires `bits-ui` (`npm install bits-ui`).

CSS lives in `./tooltip.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import {Tooltip as BT} from 'bits-ui';
  import {cn} from '../../../utils/cn';

  type Side = 'top' | 'right' | 'bottom' | 'left';

  type TriggerProps = Record<string, unknown>;

  type Props = {
    content: string;
    side?: Side;
    sideOffset?: number;
    delayDuration?: number;
    open?: boolean;
    class?: string;
    /**
     * Trigger snippet — receives bits-ui's wiring props you must spread
     * onto your own element. Avoids nesting a `<button>` inside the
     * bits-ui default trigger.
     *
     *   {#snippet trigger(props)}
     *     <Button {...props}>Hover me</Button>
     *   {/snippet}
     */
    trigger: Snippet<[TriggerProps]>;
  };

  let {
    content,
    side = 'top',
    sideOffset = 6,
    delayDuration = 250,
    open = $bindable(false),
    class: className,
    trigger,
  }: Props = $props();
</script>

<BT.Provider {delayDuration}>
  <BT.Root bind:open>
    <BT.Trigger>
      {#snippet child({props})}
        {@render trigger(props as TriggerProps)}
      {/snippet}
    </BT.Trigger>
    <BT.Portal>
      <BT.Content class={cn('uin-tooltip', className)} {side} {sideOffset}>
        {content}
      </BT.Content>
    </BT.Portal>
  </BT.Root>
</BT.Provider>
