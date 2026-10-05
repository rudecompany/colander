<!--
@component RadioGroup - single-select group of options.

Uses native `<input type="radio">` per option (visually hidden but
keyboard-focusable and accessible) wrapped in styled labels. Pass
`options: {value, label, disabled?}[]` and bind `value`.

`direction` controls layout: vertical (default) for stacked options or
horizontal for inline rows.

CSS lives in `./radio-group.css`.
-->
<script lang="ts" generics="T extends string">
  import {cn} from '../../../utils/cn';

  type Option = {
    value: T;
    label: string;
    disabled?: boolean;
  };

  type Props = {
    options: Option[];
    value?: T;
    onChange?: (next: T) => void;
    name?: string;
    direction?: 'vertical' | 'horizontal';
    size?: 'sm' | 'md';
    ariaLabel?: string;
    class?: string;
  };

  let {
    options,
    value = $bindable<T>('' as T),
    onChange,
    name = `uin-radio-${Math.random().toString(36).slice(2, 9)}`,
    direction = 'vertical',
    size = 'md',
    ariaLabel,
    class: className,
  }: Props = $props();

  function pick(v: T) {
    value = v;
    onChange?.(v);
  }
</script>

<div
  class={cn('uin-radio-group', `uin-radio-group-${direction}`, `uin-radio-group-${size}`, className)}
  role="radiogroup"
  aria-label={ariaLabel}
>
  {#each options as opt (opt.value)}
    <label class={cn('uin-radio', opt.disabled && 'uin-radio-disabled')}>
      <input
        type="radio"
        class="uin-radio-input"
        {name}
        value={opt.value}
        checked={value === opt.value}
        disabled={opt.disabled}
        onchange={() => pick(opt.value)}
      />
      <span class="uin-radio-dot" aria-hidden="true"></span>
      <span class="uin-radio-label">{opt.label}</span>
    </label>
  {/each}
</div>
