// Messages between content scripts, the service worker and extension pages.
import type { Platform, SlopType, TagVerdict, Test, Verdict, Action } from '@colander/shared/verdicts';
import type { Report } from '@colander/shared/api';
import type { Reason } from './match';
import type { Signal } from '@colander/shared/verdicts';
import type { Mode } from '../adapters/schema';
import type { Settings } from './settings';

/** One item the extension acted on, kept in the local activity log. Never leaves the device. */
export interface ActivityEntry {
	at: number;
	platform: Platform;
	itemId: string | null;
	sourceId: string | null;
	sourceName: string;
	title: string;
	verdict: Verdict | null;
	action: Action;
	reason: Reason;
}

/** A card the content script acted on in the open page, for the popup's recent actions. */
export interface PageAction extends ActivityEntry {
	/** Stable per page view; used to ask the page to show this card. */
	id: number;
	shown: boolean;
	signals: Signal[];
}

export interface PageCounts {
	hidden: number;
	collapsed: number;
	labeled: number;
}

export interface PageState {
	platform: Platform;
	surfaces: string[];
	mode: Mode | null;
	paused: { site: boolean; tab: boolean };
	counts: PageCounts;
	actions: PageAction[];
	source: { platform: Platform; sourceIds: string[]; name: string } | null;
	cards: { total: number; withItem: number; withSource: number; tracked: number };
	/** Per active surface, for adapter health checks. Cards include empty placeholders of virtualized feeds. */
	bySurface: Record<string, { total: number; withItem: number; withSource: number }>;
	/** Content script work. `reads` counts card extractions, so a rescan of unchanged cards shows at any machine speed. */
	perf: { batches: number; totalMs: number; p95Ms: number; maxMs: number; reads: number };
}

export interface TagRequest {
	platform: Platform;
	targetType: 'source' | 'item';
	targetId: string;
	sourceId?: string;
	verdict: TagVerdict;
	slopType?: SlopType | null;
	tests?: Test[];
	platformLabel: boolean;
	/** Display only, for My list and the activity log. */
	name?: string;
}

export interface ReportRequest {
	platform: Platform;
	sourceId: string;
	sourceName?: string;
	examples: string[];
	reason: string;
	slopType?: SlopType | null;
	tests?: Test[];
}

/** Content script or page -> service worker. */
export type ToWorker =
	| { type: 'hello' }
	| { type: 'counts'; platform: Platform; counts: PageCounts }
	| { type: 'activity'; entries: ActivityEntry[] }
	/** `hold`: queue it, but wait for a replacement (an open tag menu) before sending. */
	| { type: 'tag'; tag: TagRequest; hold?: boolean }
	| { type: 'report'; report: ReportRequest }
	| { type: 'allow'; key: string; name?: string }
	| { type: 'block'; key: string; name?: string }
	| { type: 'unlist'; list: 'allows' | 'blocks'; key: string }
	| { type: 'pause-tab'; tabId: number; paused: boolean }
	| { type: 'sync-now' }
	| { type: 'start-trial' }
	| { type: 'refresh-reports' }
	| { type: 'set-platform'; platform: Platform; on: boolean }
	| { type: 'open'; page: 'options' | 'welcome'; section?: string }
	| { type: 'delete-data' }
	| { type: 'settings'; patch: Partial<Settings> };

export type HelloReply = { tabPaused: boolean };
export type ReportReply = { ok: true; report: Report } | { ok: false; error: string };

/** Service worker or popup -> content script. */
export type ToPage =
	| { type: 'page-state' }
	| { type: 'show'; id: number }
	| { type: 'tab-paused'; paused: boolean }
	| { type: 'report-open' };
