<!--
@component Label — caption / eyebrow for form fields.

Pair with Input/Textarea/Select. Tones: `eyebrow` (uppercase tracked,
default) and `strong` (regular case). `required` adds a small accent
dot. Pass `for` to wire it to a form field by id.

CSS lives in `./label.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLLabelAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Tone = 'eyebrow' | 'strong';

  type Props = HTMLLabelAttributes & {
    tone?: Tone;
    required?: boolean;
    class?: string;
    children: Snippet;
  };

  let {
    tone = 'eyebrow',
    required = false,
    class: className,
    children,
    ...rest
  }: Props = $props();
</script>

<label class={cn('uin-label', `uin-label-${tone}`, className)} {...rest}>
  {@render children()}
  {#if required}<span class="uin-label-required" aria-hidden="true">●</span>{/if}
</label>
