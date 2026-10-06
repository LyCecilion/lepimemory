/**
 * 历史行渲染：一条 entry / 一个阶段 / 一个主体分组，以及展开后的溯源块。
 * 组件只消费 props；展开与候选缓存的变更通过回调交回面板。
 */
import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import type { HistoryEntry } from '../../shared/api.js';
import { INTENT_KEY } from '../constants.js';
import { entryKey, excerptOf } from '../history-model.js';
import { statusClass, statusLabel, statusTone } from '../status.js';
import type {
  CandidateMap,
  ExpandedState,
  LoadCandidate,
  RetryKind,
  RetryingState,
  ToggleEntry,
  Translate,
} from '../types.js';
import { fmtTime, recordOf } from '../util.js';
import { kv } from './atoms.js';
import { CandidateDetail } from './CandidateDetail.js';
import { RecallDetail } from './RecallDetail.js';

/** 一条 entry 的溯源块结果（引用行 + 重试按钮 + 是否有内容）。 */
interface BuiltRefs {
  readonly refs: ReactNode[];
  readonly retryButtons: ReactNode[];
  readonly hasDetail: boolean;
}

/** 来源引用 + 重试按钮（溯源块的内容）。 */
function buildRefs(
  t: Translate,
  e: HistoryEntry,
  retrying: RetryingState,
  onRetry: (kind: RetryKind, id: string) => void,
): BuiltRefs {
  const data = recordOf(e.data);
  const refs: ReactNode[] = [];
  const pushRef = (label: string, value: unknown): void => {
    if (value != null && value !== '') refs.push(kv(label, value));
  };
  pushRef(t('refSession'), e.session_id);
  pushRef(t('refTurn'), e.turn);
  pushRef(t('refStep'), e.step);
  pushRef(t('refCall'), e.call_id);
  pushRef(t('refRequest'), e.request_id);
  pushRef(t('refTask'), e.task_id);
  pushRef(t('refCandidate'), e.candidate_id);
  pushRef(t('refOperation'), e.operation_id);
  pushRef(t('refAction'), data?.action_id);
  const actionCalls = data && Array.isArray(data.action_calls) ? data.action_calls : [];
  for (const call of actionCalls) {
    const record = recordOf(call);
    refs.push(
      <div key={String(record?.action_id)}>
        {kv(t('refAction'), record?.action_id)}
        {kv(t('refStep'), record?.step)}
        {kv(t('refCall'), record?.call_id)}
      </div>,
    );
  }
  const code = data && (data.code || data.error_code || data.reason_code);
  if (code != null) refs.push(kv(t('refCode'), code));
  if (e.type === 'retain' && e.status === 'admission' && data) {
    pushRef(t('refBackend'), data.backend);
    pushRef(t('refVerdict'), data.verdict);
    pushRef(t('refScore'), data.score);
    pushRef(t('refModel'), data.model);
    pushRef(t('refRevision'), data.revision);
    pushRef(t('refTruncated'), data.truncated);
  }
  const retryButtons: ReactNode[] = [];
  const requestId = e.request_id;
  if (requestId) {
    retryButtons.push(
      <Button
        key="rq"
        variant="outline"
        size="sm"
        className="lep-rowbtn"
        disabled={!!retrying[`request:${requestId}`]}
        onClick={() => onRetry('request', requestId)}
      >
        {t('retryRequest')}
      </Button>,
    );
  }
  const taskId = e.task_id;
  if (taskId) {
    retryButtons.push(
      <Button
        key="tk"
        variant="outline"
        size="sm"
        className="lep-rowbtn"
        disabled={!!retrying[`task:${taskId}`]}
        onClick={() => onRetry('task', taskId)}
      >
        {t('retryTask')}
      </Button>,
    );
  }
  return {
    refs,
    retryButtons,
    hasDetail: refs.length > 0 || !!e.candidate_id || retryButtons.length > 0,
  };
}

interface BaseRowProps {
  readonly t: Translate;
  readonly expanded: ExpandedState;
  readonly cand: CandidateMap;
  readonly retrying: RetryingState;
  readonly onToggle: ToggleEntry;
  readonly onRetry: (kind: RetryKind, id: string) => void;
  readonly onLoad: LoadCandidate;
}

export interface DetailBlockProps {
  readonly t: Translate;
  readonly e: HistoryEntry;
  readonly built: BuiltRefs;
  readonly expanded: ExpandedState;
  readonly cand: CandidateMap;
  readonly onToggle: ToggleEntry;
  readonly onLoad: LoadCandidate;
}

/** 一条 entry 的完整溯源块：来源引用 + 候选快照/生命周期 + 回忆来源链 + 重试。 */
export function DetailBlock({
  t,
  e,
  built,
  expanded,
  cand,
  onToggle,
  onLoad,
}: DetailBlockProps): ReactElement {
  return (
    <div className="lep-detail">
      {built.refs}
      {e.candidate_id ? (
        <CandidateDetail t={t} id={e.candidate_id} record={cand[e.candidate_id]} onLoad={onLoad} />
      ) : null}
      <RecallDetail
        t={t}
        data={e.data}
        entryId={e.id}
        expanded={expanded}
        cand={cand}
        onToggle={onToggle}
        onLoad={onLoad}
      />
      {built.retryButtons}
    </div>
  );
}

export type EntryRowProps = BaseRowProps & {
  readonly e: HistoryEntry;
  readonly index: number;
  readonly debug: boolean;
};

/** flat 视图的一行（含摘要与可选原始摘要）。 */
export function EntryRow({
  t,
  e,
  index,
  expanded,
  cand,
  debug,
  retrying,
  onToggle,
  onRetry,
  onLoad,
}: EntryRowProps): ReactElement {
  const key = entryKey(e, index);
  const isOpen = !!expanded[key];
  const legacy = !!(e.data && e.data.legacy);
  const built = buildRefs(t, e, retrying, onRetry);
  const intentKey = INTENT_KEY[e.type];
  const excerpt = e.candidate_id ? excerptOf(cand[e.candidate_id]) : null;
  return (
    <li className="lep-row">
      <time>{fmtTime(e.at)}</time>
      <span className="lep-intent">{intentKey ? t(intentKey) : e.type || ''}</span>
      <Tag tone={statusTone(statusClass(e.status, legacy))}>{statusLabel(t, e.status, legacy)}</Tag>
      {excerpt ? <span className="lep-excerpt">{excerpt}</span> : null}
      {debug ? <span className="lep-rawsum">{e.summary || ''}</span> : null}
      {built.hasDetail ? (
        <Button variant="ghost" size="sm" className="lep-rowbtn" onClick={() => onToggle(key, e)}>
          {isOpen ? t('collapse') : t('detail')}
        </Button>
      ) : null}
      {isOpen ? (
        <DetailBlock
          t={t}
          e={e}
          built={built}
          expanded={expanded}
          cand={cand}
          onToggle={onToggle}
          onLoad={onLoad}
        />
      ) : null}
    </li>
  );
}

export type StageRowProps = BaseRowProps & { readonly e: HistoryEntry; readonly index: number };

/** 折叠行内的一条「阶段」：时间 · 状态 · 意图 + 自己的「详情」。 */
export function StageRow({
  t,
  e,
  index,
  expanded,
  cand,
  retrying,
  onToggle,
  onRetry,
  onLoad,
}: StageRowProps): ReactElement {
  const key = entryKey(e, index);
  const isOpen = !!expanded[key];
  const legacy = !!(e.data && e.data.legacy);
  const built = buildRefs(t, e, retrying, onRetry);
  const intentKey = INTENT_KEY[e.type];
  return (
    <li className="lep-row lep-row--stage">
      <time>{fmtTime(e.at)}</time>
      <Tag tone={statusTone(statusClass(e.status, legacy))}>{statusLabel(t, e.status, legacy)}</Tag>
      <span className="lep-intent">{intentKey ? t(intentKey) : e.type || ''}</span>
      {built.hasDetail ? (
        <Button variant="ghost" size="sm" className="lep-rowbtn" onClick={() => onToggle(key, e)}>
          {isOpen ? t('collapse') : t('detail')}
        </Button>
      ) : null}
      {isOpen ? (
        <DetailBlock
          t={t}
          e={e}
          built={built}
          expanded={expanded}
          cand={cand}
          onToggle={onToggle}
          onLoad={onLoad}
        />
      ) : null}
    </li>
  );
}

export interface GroupRowProps extends BaseRowProps {
  readonly entries: readonly HistoryEntry[];
  readonly groupKey: string;
  readonly truncated: boolean;
  readonly onToggleGroup: (key: string) => void;
}

/** 讲解优先：host 已按主体分组，一行一组；展开看每个阶段（超限时提示截断）。 */
export function GroupRow({
  t,
  entries,
  groupKey,
  truncated,
  expanded,
  cand,
  retrying,
  onToggle,
  onToggleGroup,
  onRetry,
  onLoad,
}: GroupRowProps): ReactElement | null {
  const head = entries[0];
  if (!head) return null;
  const key = `grp:${groupKey}`;
  const isOpen = !!expanded[key];
  const legacy = !!(head.data && head.data.legacy);
  const intentKey = INTENT_KEY[head.type];
  const excerpt = head.candidate_id ? excerptOf(cand[head.candidate_id]) : null;
  const seq: string[] = [];
  for (const e of [...entries].reverse()) {
    const label = statusLabel(t, e.status, !!(e.data && e.data.legacy));
    if (seq[seq.length - 1] !== label) seq.push(label);
  }
  const collapsed = entries.length > 1;
  return (
    <li className="lep-row">
      <time>{fmtTime(head.at)}</time>
      <span className="lep-intent">{intentKey ? t(intentKey) : head.type || ''}</span>
      <Tag tone={statusTone(statusClass(head.status, legacy))}>
        {statusLabel(t, head.status, legacy)}
      </Tag>
      {excerpt ? <span className="lep-excerpt">{excerpt}</span> : null}
      {collapsed ? <span className="lep-stages">{seq.join(' › ')}</span> : null}
      {collapsed ? <Tag tone="quiet">{`×${entries.length}`}</Tag> : null}
      <Button variant="ghost" size="sm" className="lep-rowbtn" onClick={() => onToggleGroup(key)}>
        {isOpen ? t('collapse') : t('detail')}
      </Button>
      {isOpen ? (
        <ul className="lep-stages__list">
          {truncated === true ? (
            <li key="truncated" className="lep-note">
              {t('stagesTruncated')}
            </li>
          ) : null}
          {[...entries].reverse().map((e, i) => (
            <StageRow
              key={entryKey(e, i)}
              t={t}
              e={e}
              index={i}
              expanded={expanded}
              cand={cand}
              retrying={retrying}
              onToggle={onToggle}
              onRetry={onRetry}
              onLoad={onLoad}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
