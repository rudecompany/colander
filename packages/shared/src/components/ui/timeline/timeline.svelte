<!--
@component Timeline — vertical chronological event list.

A vertical line with markers at each event. Each event has an
optional time eyebrow, a title, and an optional description. Markers
use `<Lamp>`-style colors per `tone`.

Pass `events: TimelineEvent[]` for the simple shape, or use the
children snippet for richer per-event content.

CSS lives in `./timeline.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import {cn} from '../../../utils/cn';

  type Tone = 'default' | 'success' | 'warn' | 'danger';

  type TimelineEvent = {
    time?: string;
    title: string;
    description?: string;
    tone?: Tone;
  };

  type Props = {
    events: TimelineEvent[];
    class?: string;
    children?: Snippet;
  };

  let {events, class: className}: Props = $props();
</script>

<ol class={cn('uin-timeline', className)}>
  {#each events as ev, i (i)}
    <li class={cn('uin-tl-event', `uin-tl-event-${ev.tone ?? 'default'}`)}>
      <span class="uin-tl-marker" aria-hidden="true"></span>
      <div class="uin-tl-body">
        {#if ev.time}<p class="uin-tl-time">{ev.time}</p>{/if}
        <p class="uin-tl-title">{ev.title}</p>
        {#if ev.description}<p class="uin-tl-desc">{ev.description}</p>{/if}
      </div>
    </li>
  {/each}
</ol>
