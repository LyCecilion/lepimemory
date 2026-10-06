/**
 * 浏览器侧的小工具：HTTP 取数、模板插值、时间格式化。
 */

/** fetch → { status, ok, body } 的统一形状；body 缺失/非 JSON 回退空对象。 */
export interface FetchResult {
  readonly status: number;
  readonly ok: boolean;
  readonly body: Record<string, unknown>;
}

/** fetch → { status, ok, body }。body 缺失/非 JSON 则回退 {}。 */
export function fetchJson(url: string, init?: RequestInit): Promise<FetchResult> {
  return fetch(url, init).then((resp) =>
    resp
      .json()
      .catch(() => null)
      .then((parsed: unknown) => ({
        status: resp.status,
        ok: resp.ok,
        body: (parsed || {}) as Record<string, unknown>,
      })),
  );
}

/** 未类型化的 JSON 对象收窄；数组与原始值视为「无字段」。 */
export function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 用 {k} 占位符做极简插值。 */
export function fill(template: string, vars: Record<string, string | number>): string {
  return String(template).replace(/\{(\w+)\}/g, (_m, k: string) =>
    k in vars ? String(vars[k]) : `{${k}}`,
  );
}

/** 时间戳 → 本地时间串（解析失败则原样返回）。 */
export function fmtTime(at: unknown): string {
  if (!at) return '';
  const d = new Date(typeof at === 'string' || typeof at === 'number' ? at : String(at));
  return Number.isNaN(d.getTime()) ? String(at) : d.toLocaleTimeString();
}
