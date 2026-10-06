/**
 * 客户端的自有类型：UI 状态、hook 面、以及从宿主声明取用的最小 props。
 *
 * 宿主的 hook/服务类型直接引用声明（uuid 身份、selector hook、locale 座位），
 * 本文件只收窄为「面板/立绘真正读取的字段」，不复制整套宿主 Context。
 */
import type { MutableRefObject } from 'react';
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots';
import type {
  SessionSnapshotSelector,
  UseSessionStatus,
} from '@deepseek-ai/dsh-client-ui-session/client';
import type { UseChat } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type {
  CandidateResponse,
  HistoryEntry,
  HistoryGroup,
  PanelTone,
  StateCountsResponse,
  StateResponse,
} from '../shared/api.js';
import type { AvatarActivity } from '../shared/avatar-frames.js';
import type { Kind } from './constants.js';
import type { LepKey } from './locales.js';

/** 命名空间绑定的翻译函数（键域由 zh 字典封闭）。 */
export type Translate = (key: LepKey) => string;

/** 状态快照正文（共享 DTO）。 */
export type StateBody = StateResponse;

/** 共享状态 feed 的快照：三种失败相位 body 均为 null，只有 ok 带正文。 */
export type StateFeedSnapshot =
  | { readonly phase: 'loading'; readonly body: null }
  | { readonly phase: 'error'; readonly body: null }
  | { readonly phase: 'forbidden'; readonly body: null }
  | { readonly phase: 'ok'; readonly body: StateBody };

/** 面板持有的状态：解析后的成功正文，或本地的失败相位。 */
export type PanelState = StateBody | { readonly ok: false; readonly forbidden?: boolean };

/** 历史分页状态：成功形状（flat 或 grouped）或失败相位。 */
export type HistoryState =
  | { readonly ok: false; readonly forbidden?: boolean }
  | {
      readonly ok: true;
      readonly kind: string;
      readonly grouped: boolean;
      readonly total: number;
      readonly offset: number;
      readonly limit: number;
      readonly entries: HistoryEntry[];
      readonly groups: HistoryGroup[] | null;
    };

/** 单个候选的详情缓存：读取中 / 失败 / 成功（含是否已揭晓正文）。 */
export type CandidateRecord =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly forbidden: boolean }
  | { readonly phase: 'ok'; readonly data: CandidateResponse; readonly revealed: boolean };

export type CandidateMap = Record<string, CandidateRecord | undefined>;
export type ExpandedState = Record<string, boolean | undefined>;
export type RetryingState = Record<string, boolean | undefined>;

/** 一条系统回执（由历史记录汇聚或本地动作追加）。 */
export interface Receipt {
  readonly key: string;
  readonly at: number;
  readonly text: string;
}

/** 操作者编辑表单：五个数值字段（非法输入保持空串，提交时再校验）。 */
export interface FormState {
  mood: { valence: number | ''; arousal: number | '' };
  relation: { trust: number | ''; closeness: number | ''; familiarity: number | '' };
}

/** 表单字段路径（与共享 NUMERIC_FIELDS 的点分路径一致）。 */
export type FieldPath =
  | 'mood.valence'
  | 'mood.arousal'
  | 'relation.trust'
  | 'relation.closeness'
  | 'relation.familiarity';

/** 语气预览：dry-run 结果或失败。 */
export interface PreviewState {
  readonly failed?: boolean;
  readonly rendered?: string;
  readonly tone?: PanelTone;
}

/** 重试身份种类。 */
export type RetryKind = 'request' | 'task';

/** 展开/收起影响的最小候选身份（entry 与 recall 来源共用）。 */
export interface ToggleTarget {
  readonly candidate_id?: string | null;
}
export type ToggleEntry = (key: string, target: ToggleTarget) => void;
export type LoadCandidate = (id: string, reveal: boolean) => void;

// ── 回忆来源链（`data` 为不可信 JSON，先按形状收窄）──────────────────
export interface RecallSourceRef {
  readonly raw_id?: string;
  readonly candidate_id?: string;
  readonly evidence_ids?: readonly string[];
}
export interface RecallChain {
  readonly observation_id?: string;
  readonly sources?: readonly RecallSourceRef[];
}
export interface RecallExcludedItem {
  readonly id?: string;
  readonly code?: string;
  readonly observation_id?: string;
}
export interface RecallPicked {
  readonly raw_ids?: readonly string[];
}

/** 失效扇出：epoch 递增 + 各 hook 清空自己的私有缓存。 */
export interface Invalidation {
  readonly epoch: MutableRefObject<number>;
  invalidate(): void;
  onInvalidate(reset: () => void): () => void;
}

// ── hooks 面 ─────────────────────────────────────────────────────────
export interface PanelHistoryArgs {
  readonly open: boolean;
  readonly kind: Kind;
  readonly offset: number;
  readonly debug: boolean;
  readonly invalidation: Invalidation;
}

export interface PanelHistoryResult {
  readonly hist: HistoryState | null;
  readonly refreshHistory: () => void;
}

export interface ReceiptsArgs {
  readonly hist: HistoryState | null;
  readonly t: Translate;
  readonly invalidation: Invalidation;
}

export interface ReceiptsResult {
  readonly receipts: Receipt[];
  readonly addReceipt: (key: string, at: number, text: string) => void;
}

export interface RetryArgs {
  readonly t: Translate;
  readonly invalidation: Invalidation;
  readonly addReceipt: ReceiptsResult['addReceipt'];
  readonly refreshHistory: PanelHistoryResult['refreshHistory'];
}

export interface RetryResult {
  readonly retrying: RetryingState;
  readonly retry: (kind: RetryKind, id: string) => void;
}

export interface CandidateDetailsArgs {
  readonly open: boolean;
  readonly hist: HistoryState | null;
  readonly expanded: ExpandedState;
  readonly invalidation: Invalidation;
}

export interface CandidateDetailsResult {
  readonly cand: CandidateMap;
  readonly loadCandidate: (id: string, reveal: boolean) => void;
  readonly dropCandidate: (id: string) => void;
}

export interface StateEditorArgs {
  readonly state: PanelState | null;
  readonly t: Translate;
  readonly invalidation: Invalidation;
  readonly addReceipt: ReceiptsResult['addReceipt'];
  readonly refreshLepState: () => void;
}

export interface StateEditorResult {
  readonly editorOpen: boolean;
  readonly toggleEditor: () => void;
  readonly form: FormState | null;
  readonly setNumber: (path: FieldPath, value: number) => void;
  readonly formError: string;
  readonly saving: boolean;
  readonly preview: PreviewState | null;
  readonly submitState: (event: { preventDefault(): void }) => void;
}

// ── 宿主 props（只取用到的字段）────────────────────────────────────
/** session 作用域槽提供的会话身份与 selector hook。 */
export interface HostSessionProps {
  readonly sessionId: SessionId;
  readonly useSession: SessionSnapshotSelector;
  readonly useSessionStatus: UseSessionStatus;
}

/** 面板正文 tab 与立绘 dock 共用的注入面。 */
export interface LepMemoryInjectedProps {
  readonly t: Translate;
  readonly useLepState: SnapshotSelectorHook<StateFeedSnapshot>;
  readonly refreshLepState: () => void;
  readonly useChat?: UseChat | undefined;
}

/** 右栏面板组件的完整 props。 */
export type PanelProps = HostSessionProps & LepMemoryInjectedProps;

/** 立绘 overlay 组件的完整 props。 */
export type AvatarProps = HostSessionProps & LepMemoryInjectedProps;

/** 状态条 props。 */
export interface StateStripProps {
  readonly t: Translate;
  readonly state: StateBody;
  readonly activity: AvatarActivity;
}

/** 徽章行 props。 */
export interface BadgesProps {
  readonly t: Translate;
  readonly counts: StateCountsResponse;
  readonly core: boolean;
}
