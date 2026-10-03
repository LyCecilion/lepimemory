/**
 * 状态机：把「发生的事」折算成状态增量 + 心境衰减。
 *
 * 原则（CONCEPTS §2 决策三 / DESIGN_NOTES §1.6）：
 *   - 规则是**显式数据**，纯函数 (facts) -> deltas，可列举、可测、可审；
 *   - **模型文本不直接写状态**——只吃结构事件（用户是否说话、工具是否失败）；
 *   - 每次变更产出「前值→后值 + 命中规则」，由 index.js 落自有 audit.jsonl。
 */
import { BASELINE, NUMERIC_FIELDS } from "./state.js";

const RANGE = new Map(NUMERIC_FIELDS.map(([p, lo, hi]) => [p, [lo, hi]]));

/** 心境向基线回归的半衰期（ms）。relation 不自然衰减（DESIGN_NOTES §1.4）。 */
const MOOD_HALF_LIFE_MS = 6 * 60 * 60 * 1000;

function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
}

/** 四舍五入到 4 位小数——状态与审计是给人看的，避免 0.12000000000000001 这类噪声。 */
function round4(value) {
    return Math.round(value * 1e4) / 1e4;
}

/**
 * 规则集（定稿三条；量级经标定：单次行动成功/失败即跨渲染阈值 |Δ|≥0.10 → 一轮可见）。
 * 每条都写清「为什么存在」；新增规则请同样注释。
 */
export const RULES = [
    {
        id: "interaction.familiarity",
        why: "本轮用户说过话 → 熟悉度累积（关系不衰减）。",
        when: (facts) => facts.userMessages > 0,
        deltas: { "relation.familiarity": 0.03 },
    },
    {
        id: "action.success.brighten",
        why: "本轮角色成功办成一件事 → 心境上扬、更亲近（行动结果作为经历）。",
        when: (facts) => facts.actionSuccesses > 0,
        deltas: { "mood.valence": 0.12, "relation.closeness": 0.03 },
        reason: "刚刚帮你把事办成了。",
    },
    {
        id: "tool.failure.dampen",
        why: "本轮有工具失败 → 心境下降、信任略降（失败作为「经历」进入状态机，CONCEPTS §4.4）。",
        when: (facts) => facts.toolFailures > 0,
        deltas: { "mood.valence": -0.12, "relation.trust": -0.04 },
        reason: "刚才有个操作没成。",
    },
];

/** 按经过时间把 mood 拉回基线；relation 不动。 */
export function decayMood(mood, nowMs) {
    const last = Date.parse(mood.updatedAt);
    if (!Number.isFinite(last)) return { valence: mood.valence, arousal: mood.arousal, changed: false };
    const dt = Math.max(0, nowMs - last);
    const k = Math.pow(0.5, dt / MOOD_HALF_LIFE_MS); // 越久 → k 越小 → 越靠基线
    const valence = round4(BASELINE.valence + (mood.valence - BASELINE.valence) * k);
    const arousal = round4(BASELINE.arousal + (mood.arousal - BASELINE.arousal) * k);
    const changed =
        Math.abs(valence - mood.valence) > 1e-6 || Math.abs(arousal - mood.arousal) > 1e-6;
    return { valence, arousal, changed };
}

/**
 * 推进一轮：先衰减、再套用命中规则。**纯函数**（不改入参）。
 * @returns {{ changed: boolean, state: object, fired: string[], changes: Record<string,[number,number]> }}
 */
export function advance(state, facts, nowMs) {
    const decayed = decayMood(state.mood, nowMs);
    const next = structuredClone(state);
    next.mood.valence = decayed.valence;
    next.mood.arousal = decayed.arousal;

    const before = { ...state.mood, ...state.relation };
    const fired = [];
    const reasons = [];
    for (const rule of RULES) {
        if (!rule.when(facts)) continue;
        fired.push(rule.id);
        for (const [p, delta] of Object.entries(rule.deltas)) {
            const [group, field] = p.split(".");
            const [lo, hi] = RANGE.get(p);
            next[group][field] = round4(clamp(next[group][field] + delta, lo, hi));
        }
        if (rule.reason) {
            reasons.push({ dimension: "mood", text: rule.reason, at: new Date(nowMs).toISOString() });
        }
    }

    const after = { ...next.mood, ...next.relation };
    const changes = {};
    for (const key of Object.keys(before)) {
        if (Math.abs(before[key] - after[key]) > 1e-9) changes[key] = [round4(before[key]), round4(after[key])];
    }

    const changed = decayed.changed || fired.length > 0;
    if (!changed) return { changed: false, state, fired: [], changes: {} };

    next.mood.updatedAt = new Date(nowMs).toISOString();
    if (reasons.length > 0) next.reasons = [...reasons, ...next.reasons].slice(0, 10);
    return { changed: true, state: next, fired, changes };
}
