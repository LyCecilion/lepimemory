/**
 * 历史/候选记录的纯展示投影：把不可信 JSON 行渲染为单行文本或摘要。
 * 无 React、无 fetch、无数据库知识。
 */
import type { HistoryEntry } from '../shared/api.js';
import type { CandidateRecord, HistoryState, RecallChain, Translate } from './types.js';
import { statusLabel } from './status.js';
import { fmtTime, recordOf } from './util.js';

/** 一条 entry 的展开 key（有 id 用 id，否则退回 at-序号）。 */
export function entryKey(e: HistoryEntry, index: number): string {
  return e.id != null ? `e${e.id}` : `${e.at}-${index}`;
}

/** 从不可信 `data` 中取出回忆来源链（非数组一律空）。 */
export function chainsOf(data: unknown): readonly RecallChain[] {
  const record = recordOf(data);
  return record && Array.isArray(record.chains) ? (record.chains as readonly RecallChain[]) : [];
}

/** 分组响应与 flat 响应统一取出条目集合（供回执汇聚/候选加载复用）。 */
export function entriesOf(hist: HistoryState | null | undefined): HistoryEntry[] {
  if (!hist || hist.ok !== true) return [];
  if (Array.isArray(hist.groups)) return hist.groups.flatMap((g) => g.entries);
  return Array.isArray(hist.entries) ? hist.entries : [];
}

/** 候选快照正文 → 单行摘要（超长截断）；拿不到正文（如已遗忘未揭晓）返回 null。 */
export function excerptOf(node: CandidateRecord | undefined): string | null {
  if (!node || node.phase !== 'ok') return null;
  const raw = recordOf(node.data.snapshot)?.text;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  return text.length > 60 ? text.slice(0, 60) + '…' : text;
}

/** 生命周期行 → 单行文本。 */
export function lifecycleText(lifecycle: unknown): string {
  const l = recordOf(lifecycle);
  if (!l) return '—';
  let s = String(l.status || '?');
  if (l.purpose) s += ' · ' + String(l.purpose);
  if (l.grant_id) s += ' · grant ' + String(l.grant_id);
  if (l.confirmed_by) s += ' · ' + String(l.confirmed_by);
  if (l.updated_at) s += ' · ' + fmtTime(l.updated_at);
  return s;
}

/** 来源证明引用 → 单行文本。 */
export function sourceText(source: unknown): string {
  const s = recordOf(source);
  if (!s) return '—';
  let out = String(s.id || '?');
  if (s.actor) out += ' · ' + String(s.actor);
  if (s.kind) out += ' · ' + String(s.kind);
  if (s.session_id) out += ' · session ' + String(s.session_id);
  if (s.message_id) out += ' · message ' + String(s.message_id);
  if (s.seq != null) out += ' · seq ' + String(s.seq);
  if (s.block_index != null)
    out += ' · block ' + String(s.block_index) + ':' + String(s.start) + '-' + String(s.end);
  if (s.at) out += ' · ' + fmtTime(s.at);
  return out;
}

/** 远端原始条目引用 → 单行文本。 */
export function rawText(raw: unknown): string {
  const r = recordOf(raw);
  if (!r) return '—';
  let out = String(r.raw_id || '?');
  if (r.document_id) out += ' · document ' + String(r.document_id);
  if (r.version_hash) out += ' · ' + String(r.version_hash).slice(0, 12);
  if (r.state) out += ' · ' + String(r.state);
  if (r.verified_at) out += ' · ' + fmtTime(r.verified_at);
  return out;
}

/** 候选相关 task → 单行文本（状态走本地化）。 */
export function taskText(t: Translate, task: unknown): string {
  const k = recordOf(task);
  if (!k) return '—';
  let out = String(k.id || '?') + ' · ' + statusLabel(t, k.status, false);
  if (k.kind) out += ' · ' + String(k.kind);
  if (k.error_code) out += ' · ' + String(k.error_code);
  return out;
}

/** operation 引用 → 单行文本。 */
export function opText(operation: unknown): string {
  const o = recordOf(operation);
  if (!o) return '—';
  return (
    String(o.operation_id || '?') +
    ' · task ' +
    String(o.task_id || '?') +
    ' · ' +
    String(o.status || '?')
  );
}

/** 授权行 → 单行文本（scope 解析后的 JSON 原样展示）。 */
export function grantText(grant: unknown): string {
  const g = recordOf(grant);
  if (!g) return '—';
  let out = String(g.id || '?');
  if (g.scope != null)
    out += ' · ' + (typeof g.scope === 'string' ? String(g.scope) : JSON.stringify(g.scope));
  if (g.expires_at) out += ' · exp ' + fmtTime(g.expires_at);
  if (g.revoked_at) out += ' · revoked ' + fmtTime(g.revoked_at);
  if (g.allow_inference != null) out += ' · inference=' + String(g.allow_inference);
  return out;
}
