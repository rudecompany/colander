<!--
@component Toaster: renders the current toast as the shared Colander toast (ink, 44 tall,
bottom center 24 px up), the same anatomy as the in-page skip notice.
Mount once near the app root; call `toast(...)` from `./toast.svelte.ts` anywhere.

CSS lives in `./toaster.css`.
-->
<script lang="ts">
  import {cn} from '../../../utils/cn';
  import Toast from '../../colander/Toast.svelte';
  import {toasts, dismiss} from './toast.svelte.js';

  type Position = 'top-right' | 'top-left' | 'top-center' | 'bottom-right' | 'bottom-left' | 'bottom-center';

  type Props = {
    position?: Position;
    class?: string;
  };

  let {position = 'bottom-center', class: className}: Props = $props();
</script>

<div class={cn('uin-toaster', `uin-toaster-${position}`, className)}>
  {#each toasts as t (t.id)}
    <Toast
      text={t.description ? `${t.title} ${t.description}` : t.title}
      paused={t.duration === Infinity}
      actions={t.action ? [{label: t.action.label, onClick: () => (t.action?.onClick(), dismiss(t.id))}] : []}
      onClose={() => dismiss(t.id)}
      onTimeout={() => dismiss(t.id)}
    />
  {/each}
</div>
