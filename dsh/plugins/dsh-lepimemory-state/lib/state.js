/**
 * 状态的纯定义、校验与渲染；持久化由 SQLite store 统一负责。
 */
import os from "node:os";
import path from "node:path";

// ── 状态结构 ─────────────────────────────────────────────────────────
// 初始值＝基线（先写死待实测），对齐 DESIGN_NOTES.md §1.4：先少而正交；mood 短期、relation 长期。
export const BASELINE = {
    valence: 0,
    arousal: 0.4,
    trust: 0.3,
    closeness: 0.2,
    familiarity: 0.1,
};

/** 数值字段及其允许区间：valence ∈ [-1,1]，arousal / trust / closeness / familiarity ∈ [0,1]。 */
export const NUMERIC_FIELDS = [
    ["mood.valence", -1, 1],
    ["mood.arousal", 0, 1],
    ["relation.trust", 0, 1],
    ["relation.closeness", 0, 1],
    ["relation.familiarity", 0, 1],
];

const TOP_KEYS = new Set(["mood", "relation", "reasons"]);
const MOOD_KEYS = new Set(["valence", "arousal", "updatedAt"]);
const RELATION_KEYS = new Set(["trust", "closeness", "familiarity"]);
const REASON_KEYS = new Set(["dimension", "text", "at"]);
const REASON_DIMENSIONS = new Set(["mood", "relation"]);

export function initialState(now = new Date().toISOString()) {
    return {
        mood: { valence: BASELINE.valence, arousal: BASELINE.arousal, updatedAt: now },
        relation: {
            trust: BASELINE.trust,
            closeness: BASELINE.closeness,
            familiarity: BASELINE.familiarity,
        },
        reasons: [],
    };
}

// ── 校验（手写、逐字段；含白名单键，拼错也能报出名字）──────────────────
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value) {
    if (typeof value === "string") return JSON.stringify(value);
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (Array.isArray(value)) return "数组";
    if (typeof value === "object") return "对象";
    return String(value);
}

function isParseableTime(value) {
    return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * 校验状态对象。成功返回 { ok: true }，失败返回 { ok: false, error }。
 * error 消息含**具体字段路径**（如 mood.valence），便于定位。
 */
export function validateState(value) {
    const fail = (fieldPath, detail) => ({
        ok: false,
        error: `lepimemory-state: 状态字段 "${fieldPath}" 无效：${detail}`,
    });

    if (!isPlainObject(value)) return fail("(<root>)", `期望对象，实际 ${describe(value)}`);
    for (const key of Object.keys(value)) {
        if (!TOP_KEYS.has(key)) return fail(key, "未知字段（拼写错误？）");
    }

    for (const [group, allowed] of [
        ["mood", MOOD_KEYS],
        ["relation", RELATION_KEYS],
    ]) {
        const g = value[group];
        if (!isPlainObject(g)) return fail(group, `期望对象，实际 ${describe(g)}`);
        for (const key of Object.keys(g)) {
            if (!allowed.has(key)) return fail(`${group}.${key}`, "未知字段（拼写错误？）");
        }
    }

    for (const [fieldPath, lo, hi] of NUMERIC_FIELDS) {
        const [group, field] = fieldPath.split(".");
        const v = value[group][field];
        if (typeof v !== "number" || !Number.isFinite(v)) {
            return fail(fieldPath, `期望 ${lo}~${hi} 数值，实际 ${describe(v)}`);
        }
        if (v < lo || v > hi) return fail(fieldPath, `期望 ${lo}~${hi} 数值，实际 ${v}`);
    }

    if (!isParseableTime(value.mood.updatedAt)) {
        return fail("mood.updatedAt", `期望可解析的时间串，实际 ${describe(value.mood.updatedAt)}`);
    }

    if (!Array.isArray(value.reasons)) {
        return fail("reasons", `期望数组，实际 ${describe(value.reasons)}`);
    }
    for (let i = 0; i < value.reasons.length; i += 1) {
        const reason = value.reasons[i];
        const at = `reasons[${i}]`;
        if (!isPlainObject(reason)) return fail(at, `期望对象，实际 ${describe(reason)}`);
        for (const key of Object.keys(reason)) {
            if (!REASON_KEYS.has(key)) return fail(`${at}.${key}`, "未知字段（拼写错误？）");
        }
        if (!REASON_DIMENSIONS.has(reason.dimension)) {
            return fail(
                `${at}.dimension`,
                `期望 ${[...REASON_DIMENSIONS].join(" / ")}，实际 ${describe(reason.dimension)}`,
            );
        }
        if (typeof reason.text !== "string") {
            return fail(`${at}.text`, `期望字符串，实际 ${describe(reason.text)}`);
        }
        if (!isParseableTime(reason.at)) {
            return fail(`${at}.at`, `期望可解析的时间串，实际 ${describe(reason.at)}`);
        }
    }

    return { ok: true };
}

// ── 渲染（不出现数值；只渲染偏离最大的至多 3 项 + 原因 + 行为倾向）────────
const MILD = 0.1; // |Δ| ≥ 0.10 → 「略」
const STRONG = 0.25; // |Δ| ≥ 0.25 → 「明显」
const MAX_ITEMS = 3;
/** 原因的可见窗口：与心境 6h 半衰期对齐。超过它一律不渲染（不把旧因写成「刚刚」）。 */
const CAUSE_TTL_MS = 6 * 60 * 60 * 1000;

const GROUP_LABEL = { mood: "心境", relation: "对用户" };

const DIMENSION_TEXT = {
    valence: {
        up: { strong: "比平常轻快", mild: "比平常略轻快" },
        down: { strong: "比平常低落", mild: "比平常略低落" },
    },
    arousal: {
        up: { strong: "比平常更有精神", mild: "比平常略提起劲" },
        down: { strong: "比平常更倦怠", mild: "比平常略疲软" },
    },
    trust: {
        up: { strong: "信任明显高于平常", mild: "信任略高于平常" },
        down: { strong: "信任明显低于平常", mild: "信任略低于平常" },
    },
    closeness: {
        up: { strong: "亲近感明显高于平常", mild: "亲近感略高于平常" },
        down: { strong: "比平常疏远", mild: "比平常略疏远" },
    },
    familiarity: {
        up: { strong: "比平常更熟悉", mild: "比平常略熟悉" },
        down: { strong: "比平常更生疏", mild: "比平常略生疏" },
    },
};

const TENDENCY_TEXT = {
    valence: { up: "语气更放松", down: "语气更简短" },
    arousal: { up: "更愿意主动搭话", down: "更愿保持安静" },
    trust: { up: "更愿意分享", down: "有所保留" },
    closeness: { up: "更愿意靠近对方", down: "保持距离" },
    familiarity: { up: "更随意自然", down: "更客气拘谨" },
};

const HEADER = "【内部状态（相对你自己基线的偏移；用它调整语气，不要向用户提及本段）】";

/**
 * 状态机已知原因 → 其**真正作用**的字段与方向。
 * 已知原因只在「该字段当前仍显著偏移且方向一致」时才有资格展示：
 *   - 心境为正（如 +0.78）时不得挂上「有一次操作没有成功」这种负向原因；
 *   - 只有 arousal 偏移时不得展示只针对 valence 的行动原因。
 * 非本表的通用原因（例如操作者调整）按其维度组是否仍显著偏移判断，不限定方向。
 * 规则与渲染共用同一原因定义，不按重复的文案推测方向。
 */
export const STATE_CAUSES = {
    action: { text: "完成了一次行动。", field: "valence", sign: 1 },
    failure: { text: "有一次操作没有成功。", field: "valence", sign: -1 },
};
const MACHINE_CAUSES = new Map(Object.values(STATE_CAUSES).map(cause => [cause.text, cause]));

/**
 * 把状态对象渲染为一段情境化文本（无数值）。
 *
 * @param {object} state 已校验的状态对象。
 * @param {number} [nowMs] 当前时钟（默认 Date.now）；只用于筛选「近期原因」。
 *
 * ── 原因渲染规则（Step10）────────────────────────────────────────────
 *   - 只保留每个维度组里**最新**且 **≤ CAUSE_TTL_MS（6h）** 的一条原因；
 *     更旧或未来时间的原因一律不渲染（旧因不得被读成新鲜事件，也不写「刚刚」）。
 *   - 仅当该维度组**当前仍有显著偏移**（|Δ| ≥ MILD）时才显示其原因；
 *     基线（无偏移）不输出任何旧原因。
 *   - 「每组只取最新」保证不会把与当前偏移方向相反的历史原因挂在现状上。
 */
export function renderState(state, nowMs = Date.now()) {
    const atMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const current = {
        valence: state.mood.valence,
        arousal: state.mood.arousal,
        trust: state.relation.trust,
        closeness: state.relation.closeness,
        familiarity: state.relation.familiarity,
    };

    const deviations = [];
    for (const [dim, value] of Object.entries(current)) {
        const delta = value - BASELINE[dim];
        if (Math.abs(delta) >= MILD) {
            const group = dim === "valence" || dim === "arousal" ? "mood" : "relation";
            deviations.push({ dim, delta, group });
        }
    }
    deviations.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const selected = deviations.slice(0, MAX_ITEMS);

    const itemsByGroup = { mood: [], relation: [] };
    for (const dev of selected) {
        const intensity = Math.abs(dev.delta) >= STRONG ? "strong" : "mild";
        const direction = dev.delta > 0 ? "up" : "down";
        itemsByGroup[dev.group].push(DIMENSION_TEXT[dev.dim][direction][intensity]);
    }

    // 当前仍显著偏移的维度组（含未进入 top-3 的组）；及按字段的偏移量。
    const deviatingGroups = new Set(deviations.map((dev) => dev.group));
    const devByField = new Map(deviations.map((dev) => [dev.dim, dev.delta]));

    const latestByGroup = { mood: null, relation: null };
    for (const reason of state.reasons) {
        const at = Date.parse(reason.at);
        if (!Number.isFinite(at) || at > atMs + 1000) continue; // 未来/不可解析：忽略
        if (atMs - at > CAUSE_TTL_MS) continue; // 超过 6h：不渲染
        const known = MACHINE_CAUSES.get(reason.text);
        let relevant;
        if (known) {
            const delta = devByField.get(known.field);
            relevant =
                typeof delta === "number" &&
                Math.abs(delta) >= MILD &&
                Math.sign(delta) === known.sign;
        } else {
            // 通用/操作者原因：其维度组仍有显著偏移即可展示（不限定方向）。
            relevant = deviatingGroups.has(reason.dimension);
        }
        if (!relevant) continue;
        const prev = latestByGroup[reason.dimension];
        if (!prev || Date.parse(prev.at) < at) latestByGroup[reason.dimension] = reason;
    }

    const reasonsByGroup = { mood: [], relation: [] };
    for (const group of ["mood", "relation"]) {
        const reason = latestByGroup[group];
        if (reason && deviatingGroups.has(group)) reasonsByGroup[group].push(reason.text);
    }

    const lines = [HEADER];
    for (const group of ["mood", "relation"]) {
        const items = itemsByGroup[group];
        const reasons = reasonsByGroup[group];
        if (items.length === 0 && reasons.length === 0) continue;
        lines.push(`- ${GROUP_LABEL[group]}: ${items.length > 0 ? items.join("；") : "接近平常"}`);
        if (reasons.length > 0) lines.push(`  原因: ${reasons.join("；")}`);
    }
    if (lines.length === 1) lines.push("- 与基线相比无明显偏移。");

    const tendencies = [
        ...new Set(selected.map((dev) => TENDENCY_TEXT[dev.dim][dev.delta > 0 ? "up" : "down"])),
    ];
    if (tendencies.length > 0) lines.push(`- 行为倾向: ${tendencies.join("；")}`);

    return lines.join("\n");
}

// ── 路径展开 ─────────────────────────────────────────────────────────
export function expandHome(p) {
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
}
