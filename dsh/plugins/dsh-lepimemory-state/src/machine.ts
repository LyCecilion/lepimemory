/**
 * 状态机：把「发生的事」折算成状态增量 + 心境衰减。
 *
 * 原则（CONCEPTS §2 决策三 / DESIGN_NOTES §1.6）：
 *   - 规则是**显式数据**，纯函数 (facts) -> deltas，可列举、可测、可审；
 *   - **模型文本不直接写状态**——只吃结构事件（用户是否说话、工具是否失败）；
 *   - 每次变更产出「前值→后值 + 命中规则」，由 state-runtime.js 原子结算及审计。
 */
import { BASELINE, NUMERIC_FIELDS, STATE_CAUSES, type StateReason } from "./shared/state.js";

const RANGE = new Map(NUMERIC_FIELDS.map(([p, lo, hi]) => [p, [lo, hi] as const]));

/** 心境向基线回归的半衰期（ms）。relation 不自然衰减（DESIGN_NOTES §1.4）。 */
const MOOD_HALF_LIFE_MS = 6 * 60 * 60 * 1000;

function clamp(value: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, value));
}

/** 四舍五入到 4 位小数——状态与审计是给人看的，避免 0.12000000000000001 这类噪声。 */
function round4(value: number): number {
    return Math.round(value * 1e4) / 1e4;
}

/** 一轮回合的结构事实（只吃结构事件，不读模型文本）。 */
export interface RoundFacts {
    userMessages: number;
    actionSuccesses: number;
    toolFailures: number;
}

interface MachineState {
    mood: { valence: number; arousal: number; updatedAt: string };
    relation: { trust: number; closeness: number; familiarity: number };
    reasons: StateReason[];
}

interface Rule {
    id: string;
    why: string;
    when: (facts: RoundFacts) => boolean;
    deltas: Record<string, number>;
    reason?: string;
}

/**
 * 规则集（定稿三条；量级经标定：单次行动成功/失败即跨渲染阈值 |Δ|≥0.10 → 一轮可见）。
 * 每条都写清「为什么存在」；新增规则请同样注释。
 */
export const RULES: readonly Rule[] = [
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
        // 中性描述 + 代码在应用时写入真实 at（不写「刚刚」，避免旧因被读成新鲜事件）。
        reason: STATE_CAUSES.action.text,
    },
    {
        id: "tool.failure.dampen",
        why: "本轮有真实工具失败 → 心境下降（失败作为「经历」进入状态机，CONCEPTS §4.4）。",
        // 只降心境：审批拒绝/取消/unavailable 与一般控制错误不算工具失败，
        // 且不因一次失败下调对用户的长期信任（trust 只由明确的用户证据改变）。
        when: (facts) => facts.toolFailures > 0,
        deltas: { "mood.valence": -0.12 },
        reason: STATE_CAUSES.failure.text,
    },
];

/** 按经过时间把 mood 拉回基线；relation 不动。 */
export function decayMood(
    mood: { valence: number; arousal: number; updatedAt: string },
    nowMs: number,
): { valence: number; arousal: number; changed: boolean } {
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

/** 一轮推进的结果：是否变更、推进后的状态、命中规则、按字段的 [前, 后]。 */
export interface AdvanceResult {
    changed: boolean;
    state: MachineState;
    fired: string[];
    changes: Record<string, [number, number]>;
}

/**
 * 推进一轮：先衰减、再套用命中规则。**纯函数**（不改入参）。
 */
export function advance(state: MachineState, facts: RoundFacts, nowMs: number): AdvanceResult {
    const decayed = decayMood(state.mood, nowMs);
    const next = structuredClone(state);
    next.mood.valence = decayed.valence;
    next.mood.arousal = decayed.arousal;

    const before = { ...state.mood, ...state.relation } as unknown as Record<string, number>;
    const fired: string[] = [];
    const reasons: StateReason[] = [];
    for (const rule of RULES) {
        if (!rule.when(facts)) continue;
        fired.push(rule.id);
        for (const [p, delta] of Object.entries(rule.deltas)) {
            const [group, field] = p.split(".") as [string, string];
            const [lo, hi] = RANGE.get(p)!;
            const target = (next as unknown as Record<string, Record<string, number>>)[group]!;
            target[field] = round4(clamp(target[field]! + delta, lo, hi));
        }
        if (rule.reason) {
            reasons.push({ dimension: "mood", text: rule.reason, at: new Date(nowMs).toISOString() });
        }
    }

    const after = { ...next.mood, ...next.relation } as unknown as Record<string, number>;
    const changes: Record<string, [number, number]> = {};
    for (const key of Object.keys(before)) {
        if (Math.abs(before[key]! - after[key]!) > 1e-9) changes[key] = [round4(before[key]!), round4(after[key]!)];
    }

    const changed = decayed.changed || fired.length > 0;
    if (!changed) return { changed: false, state, fired: [], changes: {} };

    next.mood.updatedAt = new Date(nowMs).toISOString();
    if (reasons.length > 0) next.reasons = [...reasons, ...next.reasons].slice(0, 10);
    return { changed: true, state: next, fired, changes };
}
