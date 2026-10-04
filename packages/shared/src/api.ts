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
	imported: boolean;
	/** Always null: public responses never name a data source. Kept for wire compatibility. */
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

export interface ReviewSourceResponse {
	source: Source;
	layers: Layers;
	reports: ReportDetail[];
	appeals: Appeal[];
	items: ItemSummary[];
	history: LogEntry[];
}

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
