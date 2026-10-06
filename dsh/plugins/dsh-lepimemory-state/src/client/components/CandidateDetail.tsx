/**
 * 候选详情块：快照（可审计揭晓，不恢复）、生命周期、来源/链接/任务/操作/授权引用。
 * 无 fetch、无计时器、无数据库知识：只消费 props 并回调 onLoad。
 */
import * as React from 'react';
import type { ReactElement } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  grantText,
  lifecycleText,
  opText,
  rawText,
  sourceText,
  taskText,
} from '../history-model.js';
import type { CandidateRecord, LoadCandidate, Translate } from '../types.js';
import { fmtTime, recordOf } from '../util.js';
import { kv, listBlock } from './atoms.js';

export interface CandidateDetailProps {
  readonly t: Translate;
  readonly id: string;
  readonly record: CandidateRecord | undefined;
  readonly onLoad: LoadCandidate;
}

export function CandidateDetail({
  t,
  id,
  record,
  onLoad,
}: CandidateDetailProps): ReactElement | null {
  if (!record) return null;
  if (record.phase === 'loading') return <div className="lep-kv">{t('candLoading')}</div>;
  if (record.phase === 'error') {
    return <div className="lep-kv">{record.forbidden ? t('candForbidden') : t('candFailed')}</div>;
  }
  const data = record.data;
  const snap = recordOf(data.snapshot);
  const text = typeof snap?.text === 'string' ? snap.text : null;
  const hash = typeof snap?.payload_hash === 'string' ? snap.payload_hash : undefined;
  const snapshotBlock = (
    <div key="snapshot">
      {kv(
        t('snapshot'),
        snap ? `${hash ? hash.slice(0, 12) : '—'} · ${fmtTime(snap.created_at)}` : '—',
      )}
      {text ? (
        <div className="lep-snap-text">{text}</div>
      ) : (
        <div>
          <Button variant="ghost" size="sm" className="lep-rowbtn" onClick={() => onLoad(id, true)}>
            {t('reveal')}
          </Button>
        </div>
      )}
      {record.revealed ? (
        <Button variant="ghost" size="sm" className="lep-rowbtn" onClick={() => onLoad(id, false)}>
          {t('revealHide')}
        </Button>
      ) : null}
    </div>
  );
  return (
    <div className="lep-detail">
      {kv(t('candidateId'), data.candidate_id || id)}
      {kv(t('lifecycle'), lifecycleText(data.lifecycle))}
      {snapshotBlock}
      {listBlock(t('sources'), data.sources, sourceText)}
      {listBlock(t('rawLinks'), data.raw_links, rawText)}
      {listBlock(t('tasks'), data.tasks, (k) => taskText(t, k))}
      {listBlock(t('operations'), data.operations, opText)}
      {listBlock(t('grants'), data.grants, grantText)}
    </div>
  );
}
