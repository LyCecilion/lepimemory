/**
 * 活动信号与活动枚举的纯规则：由 Chat 快照 + 会话状态推导「它此刻在做什么」。
 *
 * 面板状态条与立绘 overlay 共用同一份实现（不各自维护一套近似规则）：
 *   - 工具（尚未出结果）优先于助手输出；
 *   - 审批/提问优先于一切；
 *   - 助手流只在存在 running 的 assistant-step 时才算「在想/在说」。
 *
 * Browser-safe：只做结构化收窄，不依赖任何宿主运行时对象。
 */
import type { AvatarActivity } from './avatar-frames.js';

/** 助手流活动信号。 */
export type ChatSignal = 'tool' | 'speak' | 'think';

/** Chat 快照里被读取的一个节点（其余字段不参与判定）。 */
export interface ChatSignalNode {
  readonly kind?: unknown;
  readonly data?: unknown;
}

/** 结构化收窄后的 Chat 快照：只需要一个 `values()` 迭代器。 */
export interface ChatSignalSnapshot {
  readonly nodes?: { values(): Iterable<ChatSignalNode> } | null | undefined;
}

/** 会话状态的被判据字段（避免依赖具体 session 控制器声明）。 */
export interface ActivityStatus {
  readonly running?: boolean | undefined;
  readonly pendingInteraction?: { readonly kind: string } | null | undefined;
}

/** 未类型化的宿主节点按对象收窄；数组/原始值一律视为「无字段」。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Chat 快照 → 'tool' | 'speak' | 'think' | null。工具（未出结果）优先于助手输出。
 * 判据对齐 ui-chat ApprovalCommand：运行中的工具 root 不含 `kind`（即尚未 tool-result）；
 * 助手流只在存在 running 的 assistant-step 时才算「在想/在说」。
 */
export function deriveChatSignal(
  snapshot: ChatSignalSnapshot | null | undefined,
): ChatSignal | null {
  if (!snapshot || !snapshot.nodes) return null;
  let running = false;
  let speaking = false;
  for (const node of snapshot.nodes.values()) {
    if (node.kind === 'tool-call') {
      const data = asRecord(node.data);
      const root = data?.root;
      if (root) {
        const rootKind = asRecord(root)?.kind;
        if (rootKind !== 'tool-result') return 'tool';
      }
    } else if (node.kind === 'assistant-step') {
      const data = asRecord(node.data);
      if (data && data.status === 'running') {
        running = true;
        const blocks = Array.isArray(data.blocks) ? data.blocks : [];
        if (
          blocks.some((block) => {
            const record = asRecord(block);
            return (
              record?.kind === 'text' &&
              typeof record.text === 'string' &&
              record.text.trim() !== ''
            );
          })
        ) {
          speaking = true;
        }
      }
    }
  }
  if (!running) return null;
  return speaking ? 'speak' : 'think';
}

/** (SessionStatus, chatSignal, lastAgentError) → 活动枚举。审批/提问优先于一切。 */
export function resolveActivity(
  status: ActivityStatus | null | undefined,
  chatSignal: ChatSignal | null,
  agentError: string | null | undefined,
): AvatarActivity {
  if (status && status.pendingInteraction) {
    return status.pendingInteraction.kind === 'approval' ? 'approval' : 'question';
  }
  if (status && status.running === true) {
    if (chatSignal === 'tool') return 'tool';
    if (chatSignal === 'speak') return 'speak';
    return 'think';
  }
  if (agentError) return 'error';
  return 'idle';
}
