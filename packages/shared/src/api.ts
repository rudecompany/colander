// Wire types for the HTTP API in docs/contracts.md section 6. Keep in step with api/src/routes.
import type { Platform, Signal, SlopType, TagVerdict, Test, Verdict } from './verdicts';

export type ISODate = string;

export interface ApiError {
	error: { code: string; message: string };
}

export interface Tag {
	client_id: string;
	platform: Platform;
	target_type: 'source' | 'item';
	target_id: string;
	source_id?: string;
	verdict: TagVerdict;
	slop_type?: SlopType | null;
	tests?: Test[];
	platform_label: boolean;
	created_at: ISODate;
	ext_version: string;
}

export interface TagResponse {
	accepted: string[];
	rejected: { client_id: string; error: string }[];
}

export interface ReportInput {
	client_id: string;
	platform: Platform;
	source_id: string;
	source_name?: string;
	examples: string[];
	reason: string;
	slop_type?: SlopType | null;
	tests?: Test[];
	ext_version: string;
}

export type ReportStatus = 'under_review' | Verdict | 'dismissed';

export interface Report {
	id: string;
	platform: Platform;
	source_id: string;
	source_name: string | null;
	status: ReportStatus;
	verdict: Verdict | null;
	protects: number;
	created_at: ISODate;
	updated_at: ISODate;
}

export interface SourceEvidence {
	taggers: number;
	tags: { slop: number; ai_fine: number; not_slop: number };
	items_seen: number;
	ai_item_share: number | null;
	uploads_per_day: number | null;
}

export interface Source {
	platform: Platform;
	id: string;
	aliases: string[];
	name: string | null;
	verdict: Verdict | null;
	signals: Signal[];
	slop_type: SlopType | null;
	tests: Test[];
	large: boolean;
	/** Staff recorded the audience size (or, with YouTube derived use only, YouTube reported it). */
	audience_known: boolean;
	/** Always false in public responses; for reviewers, whether seed lists name the source as a review lead. */
	imported: boolean;
	/** Always null in public responses, which never name a data source; for staff, the lists that name it. */
	attribution: string | null;
	appeal_open: boolean;
	updated_at: ISODate | null;
	rescore_at: ISODate | null;
	evidence: SourceEvidence;
}

export type Actor = 'community' | 'curator' | 'staff' | 'appeal';

export interface LogEntry {
	id: string;
	at: ISODate;
	platform: Platform;
	target_type: 'source' | 'item';
	target_id: string;
	source_id: string;
	source_name: string | null;
	from: Verdict | null;
	to: Verdict | null;
	reason: string;
	signals: Signal[];
	actor: Actor;
	actor_name: string | null;
}

export interface SourceResponse {
	source: Source;
	history: LogEntry[];
}

export interface LogResponse {
	entries: LogEntry[];
	next_cursor: string | null;
}

export interface Stats {
	sources: Record<Verdict, number>;
	items: number;
	decisions_7d: number;
	appeals: { open: number; median_days: number | null };
	active_installs: number;
	list_sequence: number;
	list_updated_at: ISODate | null;
}

export type AppealStatus =
	| 'awaiting_verification'
	| 'pending_manual'
	| 'under_review'
	| 'upheld'
	| 'denied'
	| 'expired';

export interface Appeal {
	id: string;
	platform: Platform;
	source_id: string;
	source_name: string | null;
	code: string;
	status: AppealStatus;
	statement: string;
	outcome: 'upheld' | 'denied' | null;
	reasoning: string | null;
	created_at: ISODate;
	verified_at: ISODate | null;
	resolved_at: ISODate | null;
}

export type Role = 'member' | 'curator' | 'staff';

export interface Plan {
	plan: 'plus';
	interval: 'year' | 'month';
	status: 'active' | 'trialing' | 'past_due' | 'canceled';
	current_period_end: ISODate;
	cancel_at_period_end: boolean;
	refundable: boolean;
}

export interface Account {
	id: string;
	email: string;
	display_name: string | null;
	role: Role;
	plan: Plan | null;
	created_at: ISODate;
}

export interface QueueItem {
	id: string;
	kind: 'report' | 'appeal' | 'escalation';
	priority: number;
	created_at: ISODate;
	platform: Platform;
	source_id: string;
	source_name: string | null;
	summary: string;
	large: boolean;
	verdict: Verdict | null;
	computed_verdict: Verdict | null;
	report_count: number;
	/** A seed lead: seed lists name the source, which is not evidence (kind is escalation). */
	lead: boolean;
}

export interface Layer {
	met: boolean;
	signals: Signal[];
	detail: string;
}

export interface Layers {
	provenance: Layer;
	behavior: Layer;
	rubric: Layer;
	consensus: Layer;
}

export interface ReportDetail extends Report {
	reason: string;
	examples: string[];
	slop_type: SlopType | null;
	tests: Test[];
}

export interface ItemSummary {
	platform: Platform;
	id: string;
	verdict: Verdict | null;
	signals: Signal[];
	tags: { slop: number; ai_fine: number; not_slop: number };
	platform_label_reports: number;
}

/** One seed list entry behind a lead, with its full provenance. Staff only. */
export interface SeedProvenance {
	/** the registry ID */
	seed: string;
	name: string;
	license: string;
	use: 'lead' | 'seed' | 'frame';
	platform: Platform;
	/** the ID as the list file named it */
	alias: string;
	batch: number;
	imported_at: ISODate;
	/** the upstream date of the file that last listed it */
	listed_at: ISODate;
	expires_at: ISODate;
	/** for Colander's own lists, where staff saw the source */
	note: string | null;
}

export interface ReviewSourceResponse {
	source: Source;
	/** how many seed lists name the source as a review lead */
	seed_lists: number;
	/** staff only: each entry with its provenance */
	seeds?: SeedProvenance[];
	/** staff only: set while staff suppress seed lists on the source */
	seed_suppression?: { at: ISODate; reason: string } | null;
	layers: Layers;
	reports: ReportDetail[];
	appeals: Appeal[];
	items: ItemSummary[];
	history: LogEntry[];
}

/** A blind calibration item: only what the labeler needs to find it on its platform. */
export interface CalibrationItem {
	platform: Platform;
	source_id: string;
	/** labels it has so far, from other reviewers */
	labels: number;
}

export type CalibrationLabel = 'slop' | 'ai_not_slop' | 'not_ai' | 'gone' | 'unsure';

/**
 * What a source is in, as a labeler records it with any label but gone and unsure: a language
 * code, other, or none (no words, such as instrumental music). The calibration report groups by it.
 */
export const CALIBRATION_LANGUAGES = ['en', 'es', 'pt', 'fr', 'de', 'it', 'tr', 'ru', 'ar', 'hi', 'id', 'ja', 'ko', 'zh', 'other', 'none'] as const;
export type CalibrationLanguage = (typeof CALIBRATION_LANGUAGES)[number];

/** Whether a source is mostly music or other video, recorded and grouped like the language. */
export const CALIBRATION_KINDS = ['music', 'video'] as const;
export type CalibrationKind = (typeof CALIBRATION_KINDS)[number];

export interface DecisionInput {
	verdict: Verdict | 'none';
	reason: string;
	signals: Signal[];
	slop_type?: SlopType | null;
	tests?: Test[];
	large?: boolean;
	source_id?: string;
}

export interface PlanTokenPayload {
	v: 1;
	sub: string;
	plan: 'plus';
	trial: boolean;
	iat: number;
	exp: number;
}

export type ExternalMessage =
	| { type: 'colander:ping' }
	| { type: 'colander:plan-token'; token: string }
	| { type: 'colander:reviewer-token'; token: string };
