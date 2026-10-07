/**
 * 浏览器半入口：注册右侧栏标签页与立绘 dock，并绑定 locale 命名空间。
 *
 * 经宿主 `window.__ModuleLoader__` 以 lazy-CJS factory 装载（见 scripts/build.mts 的
 * esbuild 包装）；本模块只导出 `inject` 与 `apply`，不再自行调用 loader。
 * `require` 只能取平台 seed（react / react-dom / dsh-client-ui-primitives）。
 */
import type { Context } from '@deepseek-ai/cordis';
// 类型专用导入：加载各宿主服务的 Context/locale/SlotMap augmentation（不产生 runtime require）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
import { NS, PANEL_KIND, PANEL_TAB_ID, STYLE_PLUGIN_ID } from './constants.js';
import { createStateFeed, type StateFeed } from './feed.js';
import { dicts } from './locales.js';
import { AvatarOverlay } from './components/AvatarOverlay.js';
import { Panel } from './components/Panel.js';
import panelCss from './panel.css';

/** 需要的宿主服务：slot 注册表、locale、右栏 tab 类型注册表。 */
export const inject = ['slots', 'locale', 'sidebarRightTabs'];

/** 面板与立绘共享同一份 /lepimemory/state 轮询源的注入口径。 */
interface FeedInjection {
  readonly hooks: { readonly lepState: StateFeed };
  readonly refreshLepState: () => void;
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    document.querySelectorAll(`style[data-plugin="${STYLE_PLUGIN_ID}"]`).forEach((n) => n.remove());
    const style = document.createElement('style');
    style.dataset.plugin = STYLE_PLUGIN_ID;
    style.textContent = panelCss;
    document.head.append(style);
    return () => style.remove();
  }, 'lepimemory-state: shared styles');
  ctx.effect(() => ctx.locale.register(NS, dicts), 'lepimemory-state: locale');
  const tLe = ctx.locale.bind(NS);
  // 面板与立绘共享同一份 /lepimemory/state 轮询源；注册各自独立
  // （ctx.slots.inject 回调必须返回单个 disposer，不能聚合多个 register）。
  const feed = createStateFeed();
  const injectFeed = (): FeedInjection => ({
    hooks: { lepState: feed },
    refreshLepState: () => feed.refresh(),
  });
  // 面板：右侧栏标签页（类型定义 + session 作用域正文）。
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: PANEL_TAB_ID,
        kind: PANEL_KIND,
        title: () => tLe('panelTitle'),
        guide: [
          {
            id: 'lepimemory-state',
            order: 40,
            title: () => tLe('panelTitle'),
            description: () => tLe('panelGuide'),
          },
        ],
      }),
    'lepimemory-state: right-sidebar tab type',
  );
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: PANEL_TAB_ID, locale: NS, inject: injectFeed },
      Panel,
    ),
  );
  // dock 只提供会话 hooks；立绘通过 portal 固定在视口右下角，不占输入框布局。
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'lepimemory-avatar',
        order: 6,
        locale: NS,
        inject: injectFeed,
      },
      AvatarOverlay,
    ),
  );
}
