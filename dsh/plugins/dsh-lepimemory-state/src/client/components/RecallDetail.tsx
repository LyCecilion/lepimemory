/**
 * 回忆来源链详情：每个综合观察 → 原始记忆来源 → 入选/排除判定 + 候选引用。
 * 无 fetch、无计时器、无数据库知识。
 */
import * as React from 'react';
import type { ReactElement } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { chainsOf } from '../history-model.js';
import type {
  CandidateMap,
  LoadCandidate,
  RecallExcludedItem,
  RecallPicked,
  ToggleEntry,
  Translate,
} from '../types.js';
import { recordOf } from '../util.js';
import { kv, listBlock } from './atoms.js';
import { CandidateDetail } from './CandidateDetail.js';

export interface RecallDetailProps {
  readonly t: Translate;
  readonly data: unknown;
  readonly entryId: number;
  readonly expanded: Record<string, boolean | undefined>;
  readonly cand: CandidateMap;
  readonly onToggle: ToggleEntry;
  readonly onLoad: LoadCandidate;
}

/** 排除项 → 单行文本（`id · code [· 观察]`）。 */
function excludedText(t: Translate, item: unknown): string {
  const record = recordOf(item);
  const observation =
    record && record.observation_id
      ? ` · ${t('refObservation')} ${String(record.observation_id)}`
      : '';
  return `${String(record?.id)} · ${String(record?.code)}${observation}`;
}

export function RecallDetail({
  t,
  data,
  entryId,
  expanded,
  cand,
  onToggle,
  onLoad,
}: RecallDetailProps): ReactElement | null {
  const record = recordOf(data);
  if (!record || !Array.isArray(record.chains)) return null;
  const chains = chainsOf(data);
  const picked = Array.isArray(record.picked) ? (record.picked as readonly RecallPicked[]) : [];
  const excluded = Array.isArray(record.excluded)
    ? (record.excluded as readonly RecallExcludedItem[])
    : [];
  const selected = new Set(picked.flatMap((item) => item.raw_ids ?? []));
  return (
    <div className="lep-sources">
      {chains.map((chain, i) => (
        <div key={i} className="lep-detail">
          {kv(t('refObservation'), chain.observation_id || '—')}
          {(chain.sources || []).map((source, j) => {
            const candidateKey = `c${entryId}-${source.candidate_id}`;
            const excludedItem = excluded.find((item) => item.id === source.raw_id);
            return (
              <div key={j} className="lep-detail">
                {kv(t('refRaw'), source.raw_id)}
                {kv(t('refCandidate'), source.candidate_id || '—')}
                {kv(t('refEvidence'), (source.evidence_ids || []).join(' · ') || '—')}
                {kv(
                  t('refVerdict'),
                  source.raw_id && selected.has(source.raw_id)
                    ? t('recallSelected')
                    : excludedItem?.code || t('recallNotSelected'),
                )}
                {source.candidate_id ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="lep-rowbtn"
                    onClick={() => onToggle(candidateKey, { candidate_id: source.candidate_id })}
                  >
                    {expanded[candidateKey] ? t('collapse') : t('detail')}
                  </Button>
                ) : null}
                {source.candidate_id && expanded[candidateKey] ? (
                  <CandidateDetail
                    t={t}
                    id={source.candidate_id}
                    record={cand[source.candidate_id]}
                    onLoad={onLoad}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
      {listBlock(t('recallExcluded'), record.excluded, (item) => excludedText(t, item))}
    </div>
  );
}
