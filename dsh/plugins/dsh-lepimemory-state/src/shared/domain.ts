/**
 * Shared domain vocabulary for the Lepimemory plugin.
 *
 * Browser-safe: no `node:` imports, so the client bundle and the server runtime
 * can both consume it. Enum unions mirror the closed contract literals
 * (`contracts.ts`) and the SQLite CHECK constraints owned by `store.ts`; add a
 * member here only when the schema/contract already allows it.
 */

// ── contract enums (wire + policy) ───────────────────────────────────
export type ControlKind =
  | 'remember'
  | 'correct'
  | 'forget'
  | 'restore'
  | 're_remember'
  | 'grant'
  | 'revoke';
export type RecallPurpose = 'current' | 'history';
export type ScopeKind = 'item' | 'topic' | 'continuous';
export type ContentKind =
  | 'stable_fact'
  | 'preference'
  | 'plan'
  | 'event'
  | 'temporary_state'
  | 'other';
export type Origin = 'user' | 'action' | 'inference';
export type Sensitivity = 'ordinary' | 'private' | 'excluded';
export type Occurrence = 'planned' | 'reported' | 'verified' | 'unknown';
export type GrantMatch = 'covered' | 'not_covered' | 'uncertain';
export type ObservationReasonCode = 'source_entailed' | 'source_unsupported' | 'source_unavailable';
export type AdmissionVerdict = 'accept' | 'defer' | 'reject';
export type AdmissionReasonCode =
  | 'explicit_request'
  | 'value_accept'
  | 'value_reject'
  | 'value_uncertain'
  | 'backend_unavailable'
  | 'input_truncated';
export type HistoryDecision = 'keep' | 'sanitize' | 'remove';
export type SourceActor = 'user' | 'assistant' | 'action' | 'context';

// ── persistence enums (SQLite CHECK literals) ────────────────────────
export type Trust = 'fact' | 'experience' | 'inference' | 'unknown';
export type LifecycleStatus =
  | 'pending'
  | 'active'
  | 'history_only'
  | 'superseded'
  | 'forgotten'
  | 'audit_only'
  | 'unknown';
export type TaskKind = 'normalize' | 'admit' | 'write' | 'curate' | 'history';
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'submitted'
  | 'deferred'
  | 'written'
  | 'reconciled'
  | 'unknown'
  | 'failed'
  | 'cancelled'
  | 'expired';
export type HistoryWorkStatus = 'pending' | 'applied' | 'blocked';
export type ActionStatus =
  | 'prepared'
  | 'executed'
  | 'rejected'
  | 'cancelled'
  | 'unavailable'
  | 'failed'
  | 'unknown';

// ── entities ─────────────────────────────────────────────────────────
/** A real session-sourced piece of evidence (id → frozen text/actor/time). */
export interface EvidenceSource {
  id: string;
  actor: SourceActor;
  kind: string;
  at: string;
  text: string;
}

/** A granted scope (item / topic / continuous), as stored on a grant row. */
export interface GrantScope {
  kind: ScopeKind;
  subject_key: string;
  topic: string | null;
  session_id: string | null;
  expires_at: string | null;
  allow_inference: boolean;
  candidate_id?: string;
}

/** Candidate as bound by the processor: schema fields + system-assigned identity. */
export interface Candidate {
  candidate_id: string;
  request_id: string;
  formed_at: string;
  explicit: boolean;
  text: string;
  content_kind: ContentKind;
  origin: Origin;
  sensitivity: Sensitivity;
  subject_key: string;
  facet_key: string;
  source_ids: string[];
  valid_from: string | null;
  valid_until: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  occurrence: Occurrence;
}

/** Raw model candidate content, before the processor binds identity. */
export type CandidateDraft = Omit<
  Candidate,
  'candidate_id' | 'request_id' | 'formed_at' | 'explicit'
>;

/** Full admission result assembled by processor/admission (never read from the model). */
export interface AdmissionResult {
  verdict: AdmissionVerdict;
  reason_code: AdmissionReasonCode;
  score: number | null;
  backend: 'laya' | 'generative';
  model: string | null;
  revision: string | null;
  truncated: boolean;
}

/** Row shape of `tasks` as this plugin reads/writes it. */
export interface TaskRow {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  operation_id: string | null;
  attempts: number;
  next_at: number;
  expires_at: number | null;
  lease_owner: string | null;
  submitted_at: number | null;
  draft_json: string | null;
  payload_json: string | null;
}
