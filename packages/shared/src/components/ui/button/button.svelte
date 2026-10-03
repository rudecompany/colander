<!--
@component Button: the one button for every Colander page. No app defines its own.

Variants:
- `primary`: brand fill. The "do the thing" button, one per view.
- `secondary`: surface with a strong outline.
- `quiet`: text in brand blue, for toolbars, rows and inline actions.
`outline` and `ghost` are the older names for `secondary` and `quiet` and still work.
There is no red or destructive variant: a destructive confirm is Primary inside a Dialog.

Sizes by context (height / padding / type):
- `sm` 28 / 10 / 600 12/16: in-page pills and toast actions.
- `md` 32 / 12 / 600 14/20: extension pages and in-page defaults.
- `lg` 36 / 14 / 600 14/20: the website header.
- `xl` 40 / 16 / 600 16/24: website default, options forms.
- `xxl` 44 / 20 / 600 16/24: website hero, mobile full width, welcome bar, footer CTA.

`href` renders a link styled as a button. `loading` shows a static 3-dot mark and "Loading"
with aria-busy. `block` fills the width. `icon` makes a square hit target for one glyph;
pair it with `aria-label`.

CSS lives in `./button.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLAnchorAttributes, HTMLButtonAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Variant = 'primary' | 'secondary' | 'quiet' | 'outline' | 'ghost';
  type Size = 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

  type Props = Omit<HTMLButtonAttributes, 'type'> &
    Pick<HTMLAnchorAttributes, 'href' | 'target' | 'rel' | 'download'> & {
      type?: 'button' | 'submit' | 'reset';
      variant?: Variant;
      size?: Size;
      icon?: boolean;
      block?: boolean;
      loading?: boolean;
      class?: string;
      children?: Snippet;
    };

  let {
    variant = 'primary',
    size = 'md',
    icon = false,
    block = false,
    loading = false,
    class: className,
    children,
    type = 'button',
    href,
    target,
    rel,
    download,
    ...rest
  }: Props = $props();

  const ALIAS: Record<Variant, string> = {primary: 'primary', secondary: 'outline', outline: 'outline', quiet: 'ghost', ghost: 'ghost'};
  const cls = $derived(
    cn('uin-btn', `uin-btn-${ALIAS[variant]}`, `uin-btn-${size}`, icon && 'uin-btn-icon', block && 'uin-btn-block', className),
  );
</script>

{#snippet body()}
  {#if loading}
    <span class="uin-btn-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <span>Loading</span>
  {:else if children}
    {@render children()}
  {/if}
{/snippet}

{#if href}
  <a {href} {target} {rel} {download} class={cls} aria-busy={loading || undefined} {...rest as HTMLAnchorAttributes}>
    {@render body()}
  </a>
{:else}
  <button {type} class={cls} aria-busy={loading || undefined} aria-disabled={loading || undefined} {...rest}>
    {@render body()}
  </button>
{/if}
