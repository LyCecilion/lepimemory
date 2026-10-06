/**
 * 面板的静态表与常量：分页尺寸、历史分组、审计类型标签与状态条配色。
 * 纯数据，无 React、无宿主依赖。
 */
import type { AvatarActivity } from '../shared/avatar-frames.js';
import type { LepKey } from './locales.js';

/** 插件身份（locale 命名空间、样式节点标记、tab id 前缀）。 */
export const NS = 'lepimemoryState';
/** 样式节点标记，Panel 生命周期据此清理旧副本。 */
export const STYLE_PLUGIN_ID = '@dsh-external/dsh-lepimemory-state';
/** 右侧栏标签页：本实现在 tab 系统的唯一身份，也是正文槽注册的 key。 */
export const PANEL_TAB_ID = '@dsh-external/dsh-lepimemory-state/panel';
/** tab 类型判别符（`sidebarRightTabs` 两步注册的第二阶段的 kind）。 */
export const PANEL_KIND = 'lepimemoryState';
/** 历史每页条目数。 */
export const PAGE = 10;

/** 八个既有/可达审计类型。 */
export type Kind =
  | 'audit'
  | 'recall'
  | 'retain'
  | 'forget'
  | 'action'
  | 'task'
  | 'control'
  | 'consent';

/** 前五个既有标签 + task/control/consent 三个可达标签。 */
export const KINDS: ReadonlyArray<readonly [Kind, LepKey]> = [
  ['audit', 'tab_audit'],
  ['recall', 'tab_recall'],
  ['retain', 'tab_retain'],
  ['forget', 'tab_forget'],
  ['action', 'tab_action'],
  ['task', 'tab_task'],
  ['control', 'tab_control'],
  ['consent', 'tab_consent'],
];

/** 类型 → 标签文案 key。 */
export const KIND_LABEL = Object.fromEntries(KINDS) as Record<Kind, LepKey>;

/** 历史分组：4 组各自拥有其 kinds 子标签。 */
export interface GroupDef {
  readonly id: string;
  readonly key: LepKey;
  readonly kinds: readonly Kind[];
}

export const GROUPS: readonly GroupDef[] = [
  { id: 'memory', key: 'grp_memory', kinds: ['recall', 'retain', 'forget'] },
  { id: 'action', key: 'grp_action', kinds: ['action', 'task'] },
  { id: 'why', key: 'grp_why', kinds: ['audit', 'control'] },
  { id: 'privacy', key: 'grp_privacy', kinds: ['consent'] },
];

/** 审计类型 → 「它想做什么」的人话标签（讲解优先视图用）。 */
export const INTENT_KEY: Record<string, LepKey> = {
  audit: 'it_audit',
  recall: 'it_recall',
  retain: 'it_retain',
  forget: 'it_forget',
  action: 'it_action',
  task: 'it_task',
  control: 'it_control',
  consent: 'it_consent',
};

/** 活动 → 状态条色配（复用现有徽章色）。 */
export const ACT_CLASS: Record<AvatarActivity, 'ok' | 'warn' | 'err' | 'muted'> = {
  idle: 'muted',
  think: 'warn',
  speak: 'warn',
  tool: 'warn',
  approval: 'ok',
  question: 'ok',
  error: 'err',
};
