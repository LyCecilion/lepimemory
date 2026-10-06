/**
 * 共享的宽松 JSON 读取：只按调用处的 fallback 形状（数组/对象）收窄，不核验内部字段。
 * 非字符串输入或解析失败一律返回原 fallback。
 */
export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(fallback)
      ? Array.isArray(value)
        ? (value as T)
        : fallback
      : value && typeof value === 'object' && !Array.isArray(value)
        ? (value as T)
        : fallback;
  } catch {
    return fallback;
  }
}
