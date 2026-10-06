/**
 * 面板/立绘共享的 `/lepimemory/state` 轮询源（ObservableSnapshot 形状）。
 *
 * 首个订阅者出现时开始 5s 轮询，最后一个离开时停止；两处 UI 共用同一份快照。
 * 无 React 依赖：只暴露 getSnapshot/subscribe/refresh。
 */
import type { StateBody, StateFeedSnapshot } from './types.js';
import { fetchJson } from './util.js';

/** 共享状态源：宿主 hooks 座位与组件都通过它读取。 */
export interface StateFeed {
  getSnapshot(): StateFeedSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): void;
}

export function createStateFeed(): StateFeed {
  const listeners = new Set<() => void>();
  let snap: StateFeedSnapshot = { phase: 'loading', body: null };
  let timer: number | undefined;
  let ctrl: AbortController | null = null;
  let seq = 0;
  const emit = (): void => {
    for (const fn of listeners) fn();
  };
  const load = (): void => {
    const my = ++seq;
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    void fetchJson('/lepimemory/state', { signal: ctrl.signal })
      .then((r) => {
        if (my !== seq) return;
        if (r.status === 401 || r.status === 403) {
          snap = { phase: 'forbidden', body: null };
          emit();
          return;
        }
        if (!r.ok || r.body.ok === false) {
          snap = { phase: 'error', body: null };
          emit();
          return;
        }
        // 本插件自有只读路由：正文按共享 DTO 消费，边界只做类型断言，不伪造字段。
        snap = { phase: 'ok', body: r.body as unknown as StateBody };
        emit();
      })
      .catch((err: { name?: string }) => {
        if (my === seq && err.name !== 'AbortError') {
          snap = { phase: 'error', body: null };
          emit();
        }
      });
  };
  return {
    getSnapshot: () => snap,
    refresh: load,
    subscribe(fn) {
      listeners.add(fn);
      if (!timer) {
        load();
        timer = setInterval(load, 5000);
      }
      return () => {
        listeners.delete(fn);
        if (!listeners.size) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
  };
}
