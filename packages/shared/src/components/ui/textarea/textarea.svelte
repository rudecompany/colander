<!--
@component Textarea — multi-line text input.

Mirrors `Input`'s look but renders a `<textarea>`. `autoResize` grows
the box vertically to fit the content, capped by `maxRows` lines.

CSS lives in `./textarea.css`.
-->
<script lang="ts">
  import type {HTMLTextareaAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Props = Omit<HTMLTextareaAttributes, 'class' | 'value'> & {
    value?: string;
    autoResize?: boolean;
    minRows?: number;
    maxRows?: number;
    class?: string;
  };

  let {
    value = $bindable(''),
    autoResize = false,
    minRows = 3,
    maxRows = 12,
    class: className,
    rows,
    ...rest
  }: Props = $props();

  let el: HTMLTextAreaElement | undefined = $state();

  function resize() {
    if (!autoResize || !el) return;
    el.style.height = 'auto';
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    const maxH = lineHeight * maxRows;
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
  }

  $effect(() => {
    if (autoResize) {
      void value;
      resize();
    }
  });
</script>

<textarea
  bind:this={el}
  class={cn('uin-textarea', className)}
  rows={rows ?? minRows}
  bind:value
  oninput={resize}
  {...rest}
></textarea>
