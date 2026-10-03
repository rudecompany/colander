<!--
@component Field — labeled form-field wrapper.

Lays out a `Label` + form control + optional description + optional
error message in a token-spaced vertical stack, and wires up the ARIA
plumbing so consumers don't have to.

Pass the actual control as the children snippet. Field calls it with
`{ id, describedBy, invalid }` so the control can claim a stable id,
link its description / error via `aria-describedby`, and signal
invalid state via `aria-invalid`.

If `id` isn't provided, Field generates one automatically (a
module-level counter; deterministic per page load).

For free-form layouts, write Label + Input by hand. This is the
wrapper for the common case.

CSS lives in `./field.css`.
-->
<script module lang="ts">
  let counter = 0;
  function nextFieldId() {
    return `uin-field-${++counter}`;
  }
</script>

<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';
  import Label from '../label/label.svelte';

  type ChildArgs = {
    id: string;
    describedBy: string | undefined;
    invalid: boolean;
  };

  type Props = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
    label?: string;
    description?: string;
    error?: string;
    required?: boolean;
    id?: string;
    class?: string;
    children?: Snippet<[ChildArgs]>;
  };

  let {
    label,
    description,
    error,
    required = false,
    id: idProp,
    class: className,
    children,
    ...rest
  }: Props = $props();

  const fallbackId = nextFieldId();
  const fieldId = $derived(idProp ?? fallbackId);
  const descId = $derived(description ? `${fieldId}-desc` : undefined);
  const errId = $derived(error ? `${fieldId}-err` : undefined);
  const describedBy = $derived(
    [descId, errId].filter(Boolean).join(' ') || undefined
  );
  const invalid = $derived(!!error);
</script>

<div
  class={cn('uin-field', invalid && 'uin-field-invalid', className)}
  {...rest}
>
  {#if label}
    <Label for={fieldId} tone="strong" {required}>{label}</Label>
  {/if}
  {#if children}
    {@render children({id: fieldId, describedBy, invalid})}
  {/if}
  {#if description && !error}
    <p id={descId} class="uin-field-desc">{description}</p>
  {/if}
  {#if error}
    <p id={errId} class="uin-field-error" role="alert">{error}</p>
  {/if}
</div>
