/**
 * 右侧栏状态面板：只拥有视图状态与 hook 组合。
 * 状态经共享 feed 刷新；历史/回执/重试/候选/编辑各自有 hook 拥有其数据生命周期。
 */
import * as React from 'react';
import type { ReactElement } from 'react';
import {
  Checkbox,
  IconArchiveOutlineRegular,
  IconCheckCircleOutlineRegular,
  IconDatabaseOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { UseChat } from '@deepseek-ai/dsh-client-ui-chat/client';
import { deriveChatSignal, resolveActivity } from '../../shared/activity.js';
import { GROUPS, type Kind } from '../constants.js';
import {
  useCandidateDetails,
  useInvalidation,
  usePanelHistory,
  useReceipts,
  useRetry,
  useStateEditor,
} from '../hooks.js';
import type { ExpandedState, PanelProps, PanelState, ToggleTarget } from '../types.js';
import { fmtTime } from '../util.js';
import { SectionHead } from './atoms.js';
import { Badges } from './Badges.js';
import { EditorForm } from './EditorForm.js';
import { HistoryBlock } from './HistoryBlock.js';
import { StateStrip } from './StateStrip.js';

/** useChat 缺席时的降级：立绘/活动只按会话状态推导（永不返回选择器结果）。 */
const fallbackChat: UseChat = () => null as never;

export function Panel(props: PanelProps): ReactElement | null {
  const { t, useLepState, refreshLepState, sessionId, useSessionStatus, useSession, useChat } =
    props;

  const [s, setS] = React.useState<PanelState | null>(null);
  const [open, setOpen] = React.useState(false);
  const [group, setGroup] = React.useState('memory');
  const [kind, setKind] = React.useState<Kind>('recall');
  const [offset, setOffset] = React.useState(0);
  const [expanded, setExpanded] = React.useState<ExpandedState>({});
  const [rawOpen, setRawOpen] = React.useState(false);
  const [debug, setDebug] = React.useState(false);

  const invalidation = useInvalidation();
  const { hist, refreshHistory } = usePanelHistory({ open, kind, offset, debug, invalidation });
  const { receipts, addReceipt } = useReceipts({ hist, t, invalidation });
  const { retrying, retry } = useRetry({ t, invalidation, addReceipt, refreshHistory });
  const { cand, loadCandidate, dropCandidate } = useCandidateDetails({
    open,
    hist,
    expanded,
    invalidation,
  });
  const editor = useStateEditor({ state: s, t, invalidation, addReceipt, refreshLepState });

  // 活动信号：审批/提问 > 运行中（tool/speak/think）> 出错 > 待机。
  const status = useSessionStatus((map) => (sessionId ? map.get(sessionId) : undefined));
  const agentError = useSession((sess) => (sess ? sess.lastAgentError : null));
  const useChatSafe: UseChat = typeof useChat === 'function' ? useChat : fallbackChat;
  const chatSignal = useChatSafe((cs) => deriveChatSignal(cs));
  const activity = resolveActivity(status, chatSignal, agentError);

  // 状态来自共享 feed（与立绘同一份快照）；错误/未授权按旧语义映射。
  // 声明在所有 hooks 之后：首个 forbidden 到达时，各 hook 的 reset 已注册。
  const feed = useLepState((st) => st);
  React.useEffect(() => {
    if (feed.phase === 'forbidden') {
      invalidation.invalidate();
      setS({ ok: false, forbidden: true });
      setExpanded({});
      return;
    }
    if (feed.phase === 'loading') return;
    if (feed.phase === 'ok') {
      setS(feed.body);
      return;
    }
    setS({ ok: false });
  }, [feed, invalidation]);

  const toggleEntry = React.useCallback(
    (key: string, target: ToggleTarget) => {
      setExpanded((prev) => {
        const next = { ...prev };
        if (next[key]) delete next[key];
        else next[key] = true;
        return next;
      });
      if (target.candidate_id) dropCandidate(target.candidate_id);
    },
    [dropCandidate],
  );

  const toggleGroup = React.useCallback((key: string) => {
    setExpanded((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  }, []);

  const selectGroup = React.useCallback((id: string) => {
    setGroup(id);
    const found = GROUPS.find((g) => g.id === id) ?? GROUPS[0];
    const first = found?.kinds[0];
    if (first) setKind(first);
    setOffset(0);
  }, []);

  const selectKind = React.useCallback((next: Kind) => {
    setKind(next);
    setOffset(0);
  }, []);

  if (s === null) return null;
  if (s.ok === false) {
    return <div className="lep-state">{s.forbidden ? t('forbidden') : t('unavailable')}</div>;
  }

  const rawBlock = (
    <div className="lep-section">
      <SectionHead
        icon={IconDatabaseOutlineRegular}
        title={t('stateRaw')}
        open={rawOpen}
        onToggle={() => setRawOpen((v) => !v)}
      />
      {rawOpen ? <div className="lep-raw__body">{s.rendered}</div> : null}
    </div>
  );

  const receiptsBlock = receipts.length ? (
    <div className="lep-section">
      <div className="lep-sechead is-static">
        <span className="lep-sechead__icon">
          <IconCheckCircleOutlineRegular size={15} />
        </span>
        <span className="lep-sechead__title">{t('receipts')}</span>
      </div>
      <ul className="lep-receipts">
        {receipts.map((r) => (
          <li key={r.key}>
            <time>{fmtTime(r.at)}</time>
            {r.text}
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return (
    <div className="lep-state">
      <StateStrip t={t} state={s} activity={activity} />
      <Badges t={t} counts={s.counts} core={s.core} />
      <div className="lep-toolbar">
        <Checkbox
          checked={debug}
          onChange={(v) => setDebug(v)}
          label={t('debugMode')}
          title={t('debugHint')}
        />
      </div>
      {rawBlock}
      {receiptsBlock}
      <div className="lep-section">
        <SectionHead
          icon={IconArchiveOutlineRegular}
          title={t('history')}
          open={open}
          onToggle={() => setOpen(!open)}
        />
        <HistoryBlock
          t={t}
          open={open}
          group={group}
          kind={kind}
          offset={offset}
          debug={debug}
          hist={hist}
          expanded={expanded}
          cand={cand}
          retrying={retrying}
          onGroup={selectGroup}
          onKind={selectKind}
          onOffset={setOffset}
          onToggle={toggleEntry}
          onToggleGroup={toggleGroup}
          onRetry={retry}
          onLoad={loadCandidate}
        />
      </div>
      <EditorForm
        t={t}
        editorOpen={editor.editorOpen}
        onToggle={editor.toggleEditor}
        form={editor.form}
        setNumber={editor.setNumber}
        formError={editor.formError}
        saving={editor.saving}
        preview={editor.preview}
        onSubmit={editor.submitState}
      />
    </div>
  );
}
