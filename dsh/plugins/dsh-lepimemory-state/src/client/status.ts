/**
 * 审计状态 → 文案 / 徽章配色 / dsh Tag tone / 活动圆点的映射。
 */
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives';
import type { AvatarActivity } from '../shared/avatar-frames.js';
import type { LepKey } from './locales.js';

/**
 * 真实 store 状态 → 本地化文案 key。缺省显示原始状态串（绝不当作成功）。
 * 覆盖 plan 明确的枚举 + store 里实际会用到的其余枚举。
 */
export const STATUS_KEYS: Record<string, LepKey> = {
  pending: 'st_pending',
  deferred: 'st_deferred',
  written: 'st_written',
  unknown: 'st_unknown',
  failed: 'st_failed',
  rejected: 'st_rejected',
  cancelled: 'st_cancelled',
  expired: 'st_expired',
  local_isolated: 'st_local_isolated',
  remote_pending: 'st_remote_pending',
  running: 'st_running',
  submitted: 'st_submitted',
  reconciled: 'st_reconciled',
  blocked: 'st_blocked',
  applied: 'st_applied',
  active: 'st_active',
  history_only: 'st_history_only',
  superseded: 'st_superseded',
  forgotten: 'st_forgotten',
  audit_only: 'st_audit_only',
  prepared: 'st_prepared',
  executed: 'st_executed',
  unavailable: 'st_unavailable',
  admission: 'st_admission',
  received: 'st_received',
  retry_pending: 'st_retry_pending',
  resubmit_required: 'st_resubmit_required',
  parked: 'st_parked',
};

/** 正向状态（只有真正可核对完成的才配。绝不按 !skipped 推断成功）。 */
export const OK_STATUS: Record<string, true> = {
  written: true,
  reconciled: true,
  executed: true,
  applied: true,
};
/** 进行中/等待。 */
export const PENDING_STATUS: Record<string, true> = {
  pending: true,
  deferred: true,
  running: true,
  submitted: true,
  prepared: true,
};
/** 负向/失败。 */
export const ERR_STATUS: Record<string, true> = {
  failed: true,
  rejected: true,
  cancelled: true,
  expired: true,
  unavailable: true,
  blocked: true,
};

/** 状态配色类。 */
export type StatusClass = 'ok' | 'warn' | 'err' | 'muted';

/** 状态 → 文案（legacy 记录加历史后缀；未知状态原样展示，绝不显示为成功）。 */
export function statusLabel(t: (key: LepKey) => string, status: unknown, legacy: unknown): string {
  const key = typeof status === 'string' ? STATUS_KEYS[status] : undefined;
  let label = key ? t(key) : status ? String(status) : t('st_unknown');
  if (legacy === true) label += t('legacySuffix');
  return label;
}

/** 状态 → 徽章配色类。 */
export function statusClass(status: string, legacy: boolean | undefined): StatusClass {
  if (legacy === true && OK_STATUS[status] !== true) return status === 'failed' ? 'err' : 'muted';
  if (OK_STATUS[status] === true) return 'ok';
  if (PENDING_STATUS[status] === true) return 'warn';
  if (ERR_STATUS[status] === true) return 'err';
  return 'muted';
}

/** 状态配色类 → dsh `Tag` 的 tone。 */
const TONE_OF: Record<StatusClass, TagTone> = {
  ok: 'success',
  warn: 'warning',
  err: 'danger',
  muted: 'quiet',
};

/** 状态配色类 → dsh `Tag` 的 tone（与共享 state 的 `toneOf` 区分名）。 */
export function statusTone(cls: StatusClass): TagTone {
  return TONE_OF[cls];
}

/** 活动 → dsh `StateDot` 的状态。 */
export function activityDot(activity: AvatarActivity): StateDotState {
  if (activity === 'error') return 'error';
  if (activity === 'idle') return 'idle';
  return 'ongoing';
}
