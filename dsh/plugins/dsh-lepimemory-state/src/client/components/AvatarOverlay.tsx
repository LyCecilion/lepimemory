/**
 * Lv3 立绘 overlay：portal 到 document.body，一帧只由 (activity, tone, near) 决定；
 * 自身不产生可见 DOM、不发业务请求、没有独立时间轴。
 */
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import type { ReactElement } from 'react';
import type { UseChat } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { AvatarKey } from '../../shared/avatar-assets.js';
import { AVATAR_PRELOAD_KEYS, avatarCandidates } from '../../shared/avatar-frames.js';
import { deriveChatSignal, resolveActivity } from '../../shared/activity.js';
import type { AvatarProps } from '../types.js';

/** useChat 缺席时的降级（活动只按会话状态推导）。 */
const fallbackChat: UseChat = () => null as never;

/** 立绘素材 URL（key 缺失时与原实现一致地落为 `undefined`）。 */
function avatarSrc(key: AvatarKey | undefined): string {
  return '/lepimemory/avatar?key=' + encodeURIComponent(String(key));
}

export function AvatarOverlay({
  sessionId,
  useSessionStatus,
  useSession,
  useChat,
  useLepState,
  t,
}: AvatarProps): ReactElement {
  const status = useSessionStatus((map) => (sessionId ? map.get(sessionId) : undefined));
  const agentError = useSession((s) => (s ? s.lastAgentError : null));
  const useChatSafe: UseChat = typeof useChat === 'function' ? useChat : fallbackChat;
  const chatSignal = useChatSafe((s) => deriveChatSignal(s));
  const feed = useLepState((st) => st);

  const activity = resolveActivity(status, chatSignal, agentError);
  const body = feed.phase === 'ok' ? feed.body : null;
  const tone = body && body.tone ? body.tone : 'plain';
  const near = !!(body && body.near === true);
  const candidates = avatarCandidates(activity, tone, near);

  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => {
    setIdx(0);
  }, [activity, tone, near]);
  const key = candidates[Math.min(idx, candidates.length - 1)];

  // 双层交叉淡入：front 淡入、stash 留在底层淡出；240ms 后清掉底层。
  const [view, setView] = React.useState<{
    front: AvatarKey | undefined;
    stash: AvatarKey | undefined;
    on: boolean;
  }>({ front: key, stash: undefined, on: false });
  React.useEffect(() => {
    setView((prev) => (prev.front === key ? prev : { front: key, stash: prev.front, on: false }));
  }, [key]);
  React.useEffect(() => {
    if (!view.stash) return;
    const at = setTimeout(
      () => setView((prev) => (prev.stash ? { ...prev, stash: undefined } : prev)),
      240,
    );
    return () => clearTimeout(at);
  }, [view.stash]);

  // 挂载后一次性预热全部候选帧，首次切换不闪烁；同时按需给出一次降级告警。
  React.useEffect(() => {
    AVATAR_PRELOAD_KEYS.forEach((k) => {
      const img = new Image();
      img.src = avatarSrc(k);
    });
    if (typeof useChat !== 'function')
      console.warn('[lepimemory] useChat 不可用：立绘只按会话状态推导活动');
  }, [useChat]);

  const layer = (k: AvatarKey | undefined, on: boolean, isTop: boolean): ReactElement => (
    <img
      key={k}
      src={avatarSrc(k)}
      className={on ? 'is-on' : ''}
      alt=""
      onLoad={
        isTop
          ? () => setView((prev) => (prev.front === k ? { ...prev, on: true } : prev))
          : undefined
      }
      onError={isTop ? () => setIdx((i) => i + 1) : undefined}
    />
  );
  const nodes: ReactElement[] = [];
  if (view.stash) nodes.push(layer(view.stash, true, false));
  nodes.push(layer(view.front, view.on, true));
  return ReactDOM.createPortal(
    <div className="lep-avatar" role="img" aria-label={t('avatarAlt')}>
      {nodes}
    </div>,
    document.body,
  );
}
