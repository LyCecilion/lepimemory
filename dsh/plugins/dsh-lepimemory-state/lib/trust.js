/**
 * 记忆的信任档与衰减策略。
 *
 * 题目开放问题「事实、推断和经历是否应该使用不同的记忆策略？」——我们的答案：**是**。
 * 每段长期记忆写入时标注一个**信任档**（`metadata.trust`），读回时按档处理：
 *   - `fact`       用户明说的事实          → 不衰减；冲突由 Hindsight 的观察（observation）refine-not-overwrite 取代。
 *   - `experience` 角色亲历（做过的事）    → 不衰减；是关系演化的依据。
 *   - `inference`  角色自己的推断 / 印象    → **会衰减**：未被后续证据确认的推断随时间退居次席、直至淡出。
 * Hindsight 合成的观察（`type:'observation'`）是「当前有效版本」，按事实处理（不衰减）。
 *
 * 为什么推断要衰减：它是**模型推断**，可信度低于用户明说与亲历；留着不复盘的旧推断会
 * 伪装成事实污染后续判断。衰减让「被后续证据反复确认」的推断（会被 observation 吸收）
 * 留存，孤立旧推断自然退场——对设计文档 §4.2 那张表的落地。
 *
 * 见 `CONCEPTS.md` §4.2、`DESIGN_NOTES.md` §1.4。
 */

/** 三个信任档。写入用，读回用。 */
export const TRUST = Object.freeze({ FACT: "fact", EXPERIENCE: "experience", INFERENCE: "inference" });

/** 推断档的半衰期：14 天。比心境（6h）慢得多，但足以让旧推断自然退场。 */
export const INFERENCE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 解析一条 recall 结果的信任档：`metadata.trust` 优先；缺失时按 Hindsight 的 `fact_type` 兜底。
 * @param {object} result - recall 返回的单条结果。
 * @returns {"fact"|"experience"|"inference"}
 */
export function trustOf(result) {
    const declared = result?.metadata?.trust;
    if (declared === TRUST.FACT || declared === TRUST.EXPERIENCE || declared === TRUST.INFERENCE) return declared;
    if (result?.type === "experience") return TRUST.EXPERIENCE;
    return TRUST.FACT; // world / observation / 未知 → 按事实处理
}

/**
 * 衰减系数 ∈ (0,1]：**仅推断档**随时间衰减（按形成时间 `mentioned_at` 的半衰期）。
 * 缺可解析时间戳 → 1（不衰减，宁可保留不误杀）。
 */
export function decayFactor(trust, mentionedAt, nowMs) {
    if (trust !== TRUST.INFERENCE) return 1;
    const t = Date.parse(mentionedAt);
    if (!Number.isFinite(t)) return 1;
    const ageMs = Math.max(0, nowMs - t);
    return Math.pow(0.5, ageMs / INFERENCE_HALF_LIFE_MS);
}

/**
 * 一条结果的档位 + 衰减后有效分（纯函数，好测）。
 * @returns {{ trust: string, semantic: number, factor: number, effective: number }}
 */
export function scoreOf(result, nowMs) {
    const trust = trustOf(result);
    const semantic = Number.isFinite(result?.scores?.semantic) ? result.scores.semantic : 0;
    const factor = decayFactor(trust, result?.mentioned_at, nowMs);
    return { trust, semantic, factor, effective: semantic * factor };
}
