<!--
@component Toaster — renderer for the toast queue.

Mount once near the app root. The toast queue and the imperative
`toast()` API live in `./toast.svelte.ts` (Sonner-style). Calling
`toast(...)` from anywhere pushes onto the shared queue; this
component reads it and renders.

`position` controls where the stack lands on screen.

CSS lives in `./toaster.css`.
-->
<script lang="ts">
  import {cn} from '../../../utils/cn';
  import {toasts, dismiss} from './toast.svelte.js';

  type Position =
    | 'top-right'
    | 'top-left'
    | 'top-center'
    | 'bottom-right'
    | 'bottom-left'
    | 'bottom-center';

  type Props = {
    position?: Position;
    class?: string;
  };

  let {position = 'top-right', class: className}: Props = $props();
</script>

<div class={cn('uin-toaster', `uin-toaster-${position}`, className)} aria-live="polite">
  {#each toasts as t (t.id)}
    <div
      class={cn('uin-toast', `uin-toast-${t.variant ?? 'default'}`)}
      role={t.variant === 'danger' || t.variant === 'warn' ? 'alert' : 'status'}
    >
      <div class="uin-toast-body">
        <p class="uin-toast-title">{t.title}</p>
        {#if t.description}<p class="uin-toast-desc">{t.description}</p>{/if}
      </div>
      {#if t.action}
        <button
          class="uin-toast-action"
          type="button"
          onclick={() => {
            t.action?.onClick();
            dismiss(t.id);
          }}
        >
          {t.action.label}
        </button>
      {/if}
      <button
        class="uin-toast-close"
        type="button"
        aria-label="Dismiss"
        onclick={() => dismiss(t.id)}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  {/each}
</div>
