<!--
@component Popover — anchored floating panel.

Built on bits-ui's `Popover` primitive: positioning, focus management,
ESC handling, and click-outside dismissal come from the headless layer.

The consumer provides a `trigger` snippet (the element that opens the
popover) and a default snippet (the panel content). `side` and `align`
position the panel relative to the trigger.

Requires `bits-ui` (`npm install bits-ui`).

CSS lives in `./popover.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import {Popover as BP} from 'bits-ui';
  import {cn} from '../../../utils/cn';

  type Side = 'top' | 'right' | 'bottom' | 'left';
  type Align = 'start' | 'center' | 'end';

  type TriggerProps = Record<string, unknown>;

  type Props = {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    side?: Side;
    align?: Align;
    sideOffset?: number;
    class?: string;
    /**
     * Trigger snippet — receives bits-ui's wiring props you must spread
     * onto your own button element. This avoids nesting a `<button>`
     * inside bits-ui's default `<button>`.
     *
     *   {#snippet trigger(props)}
     *     <Button {...props}>Open</Button>
     *   {/snippet}
     */
    trigger: Snippet<[TriggerProps]>;
    children: Snippet;
  };

  let {
    open = $bindable(false),
    onOpenChange,
    side = 'bottom',
    align = 'center',
    sideOffset = 6,
    class: className,
    trigger,
    children,
  }: Props = $props();
</script>

<BP.Root bind:open onOpenChange={(v: boolean) => onOpenChange?.(v)}>
  <BP.Trigger>
    {#snippet child({props})}
      {@render trigger(props as TriggerProps)}
    {/snippet}
  </BP.Trigger>
  <BP.Portal>
    <BP.Content
      class={cn('uin-popover', className)}
      {side}
      {align}
      {sideOffset}
    >
      {@render children()}
    </BP.Content>
  </BP.Portal>
</BP.Root>
