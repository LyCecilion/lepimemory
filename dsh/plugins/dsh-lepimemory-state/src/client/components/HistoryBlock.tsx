/**
 * 历史分节正文：筛选 Pill（分组/类型）+ 行列表（grouped 或 flat）+ 翻页。
 * 无 fetch、无计时器：数据来自 props，翻页/筛选通过回调交回面板。
 */
import * as React from 'react';
import type { ReactElement } from 'react';
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives';
import { GROUPS, KIND_LABEL, PAGE, type Kind } from '../constants.js';
import { entryKey } from '../history-model.js';
import type {
  CandidateMap,
  ExpandedState,
  HistoryState,
  LoadCandidate,
  RetryKind,
  RetryingState,
  ToggleEntry,
  Translate,
} from '../types.js';
import { fill } from '../util.js';
import { EntryRow, GroupRow } from './HistoryRows.js';

export interface HistoryBlockProps {
  readonly t: Translate;
  readonly open: boolean;
  readonly group: string;
  readonly kind: Kind;
  readonly offset: number;
  readonly debug: boolean;
  readonly hist: HistoryState | null;
  readonly expanded: ExpandedState;
  readonly cand: CandidateMap;
  readonly retrying: RetryingState;
  readonly onGroup: (id: string) => void;
  readonly onKind: (kind: Kind) => void;
  readonly onOffset: (offset: number) => void;
  readonly onToggle: ToggleEntry;
  readonly onToggleGroup: (key: string) => void;
  readonly onRetry: (kind: RetryKind, id: string) => void;
  readonly onLoad: LoadCandidate;
}

export function HistoryBlock({
  t,
  open,
  group,
  kind,
  offset,
  debug,
  hist,
  expanded,
  cand,
  retrying,
  onGroup,
  onKind,
  onOffset,
  onToggle,
  onToggleGroup,
  onRetry,
  onLoad,
}: HistoryBlockProps): ReactElement | null {
  if (!open) return null;
  const total = hist && hist.ok === true ? hist.total : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;
  // 切换 debug 后、effect 重取数前会先用**上一种**响应渲染：两种形状都必须安全取用。
  const groups = hist && hist.ok === true && Array.isArray(hist.groups) ? hist.groups : [];
  const entries = hist && hist.ok === true && Array.isArray(hist.entries) ? hist.entries : [];
  const groupDef = GROUPS.find((g) => g.id === group) ?? GROUPS[0];
  return (
    <div className="lep-hist__body">
      <div className="lep-tabs">
        {GROUPS.map((g) => (
          <Pill key={g.id} active={g.id === group} onClick={() => onGroup(g.id)}>
            {t(g.key)}
          </Pill>
        ))}
      </div>
      <div className="lep-tabs">
        {(groupDef?.kinds ?? []).map((k) => (
          <Pill key={k} active={k === kind} onClick={() => onKind(k)}>
            {t(KIND_LABEL[k])}
          </Pill>
        ))}
      </div>
      {hist === null || hist.ok !== true ? (
        <div className="lep-hist__empty">
          {hist && hist.forbidden ? t('forbidden') : t('unavailable')}
        </div>
      ) : (
        <div>
          {(debug ? entries.length === 0 : groups.length === 0) ? (
            <div className="lep-hist__empty">{t('empty')}</div>
          ) : (
            <ul className="lep-hist__list">
              {debug
                ? entries.map((e, i) => (
                    <EntryRow
                      key={entryKey(e, i)}
                      t={t}
                      e={e}
                      index={i}
                      expanded={expanded}
                      cand={cand}
                      debug={debug}
                      retrying={retrying}
                      onToggle={onToggle}
                      onRetry={onRetry}
                      onLoad={onLoad}
                    />
                  ))
                : groups.map((g) => (
                    <GroupRow
                      key={`grp:${g.key}`}
                      t={t}
                      entries={g.entries}
                      groupKey={g.key}
                      truncated={g.truncated}
                      expanded={expanded}
                      cand={cand}
                      retrying={retrying}
                      onToggle={onToggle}
                      onToggleGroup={onToggleGroup}
                      onRetry={onRetry}
                      onLoad={onLoad}
                    />
                  ))}
            </ul>
          )}
          <div className="lep-hist__nav">
            <Button
              variant="outline"
              size="sm"
              disabled={offset <= 0}
              onClick={() => onOffset(Math.max(0, offset - PAGE))}
            >
              {t('prev')}
            </Button>
            <span className="lep-pageinfo">
              {fill(debug ? t('pageOf') : t('pageOfGroups'), { p: page, q: pages, n: total })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE >= total}
              onClick={() => onOffset(offset + PAGE)}
            >
              {t('next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
