/**
 * Toast — imperative API + module-scope queue.
 *
 * Pair this file with `<Toaster />` from `./toaster.svelte`. Mount the
 * Toaster once near the app root, then call `toast(...)` from anywhere.
 *
 * Examples:
 *   toast({title: 'Saved'})
 *   toast.success({title: 'Imported 1,204 books'})
 *   toast.error({title: 'Upload failed', description: 'Network error.'})
 *   toast({title: 'Sticky', duration: Infinity})
 */

export type ToastVariant = 'default' | 'success' | 'warn' | 'danger';

export type ToastOpts = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Auto-dismiss after this many ms (default 4000). Pass Infinity to pin. */
  duration?: number;
  action?: {label: string; onClick: () => void};
};

export type ToastItem = ToastOpts & {id: string; createdAt: number};

let counter = 0;
function uid() {
  return `t${Date.now()}-${++counter}`;
}

export const toasts = $state<ToastItem[]>([]);

function push(opts: ToastOpts): string {
  const item: ToastItem = {id: uid(), createdAt: Date.now(), ...opts};
  toasts.push(item);
  if (opts.duration !== Infinity) {
    const dur = opts.duration ?? 4000;
    setTimeout(() => dismiss(item.id), dur);
  }
  return item.id;
}

export function dismiss(id: string): void {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx >= 0) toasts.splice(idx, 1);
}

export function dismissAll(): void {
  toasts.length = 0;
}

export const toast = Object.assign(push, {
  success: (opts: Omit<ToastOpts, 'variant'>) => push({...opts, variant: 'success'}),
  warn: (opts: Omit<ToastOpts, 'variant'>) => push({...opts, variant: 'warn'}),
  error: (opts: Omit<ToastOpts, 'variant'>) => push({...opts, variant: 'danger'}),
});
