/**
 * @dsh-external/dsh-lepimemory-state
 *
 * Phase 3 第一步：状态从「硬编码文本」改为**持久化、结构化**的状态文件，
 * 并在每次 prompt 组装时实时渲染。这是状态机的地基，也验证「插件能读写跨会话的持久状态」。
 *
 * 本步刻意不做：状态更新规则（事件驱动状态机本体）、衰减、审计事件。
 * 状态用**手动编辑文件**改变——每轮重读，无需重启。
 *
 * ── 状态文件路径（两层）──────────────────────────────────────────────
 *   补丁层 config.stateFile = !!js dshHomePath('lepimemory/state.json')（走 dsh 自身的 home 解析：
 *   显式 home > $DSH_HOME > ~/.dsh，与上游 packages/bundle/base/cordis.patch.yml 的
 *   dshHomePath('sessions' / 'storages') 同款用法）；
 *   未配置时插件内兜底：$DSH_HOME（未设 → ~/.dsh）/lepimemory/state.json。
 *   ⚠️ 不用 storages/：那是 storage-json 后端的根（路 A 专属），本文件是插件自有物。
 *
 * ── 关于 section 的 order（重要，不要当魔数改）────────────────────────
 *   dsh 的中央分配表（dsh-system-prompt 的 SECTION_ORDERS）中，与人设相关的只有两个槽位：
 *   DEPLOYMENT_PERSONA_PREFIX = 0、DEPLOYMENT_PERSONA_SUFFIX = 10200
 *   （见 packages/preset/persona/src/index.ts:64-71）。
 *
 *   本插件是 out-of-tree 贡献，上游 README 明确「External contributions may use any finite
 *   order」。这两个常量**不可 import**（@deepseek-ai/dsh 只导出 ./profile-boot 与 ./lib/*）；
 *   运行时**可取但有意不用**：ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
 *   （源码 packages/core/system-prompt/src/index.ts）。若取它，同一 order 值下排序会退化为
 *   section 名的 code-unit 比较，让「状态紧跟人设」取决于词典序巧合——未来任何注册名排在两者
 *   之间的 section 都会挤进来。故自持常量 + 写清依据；备选方案与不采用理由见 HANDOFF.md
 *   「补充：关于 order 的另一个方案」。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "lepimemory-state";

/** 状态 section 的排序值：人设 prefix(order 0) 之后、策略段(500) 之前。依据见文件头注释。 */
export const STATE_SECTION_ORDER = 50;

/** 需要 prompt 注册表就绪后才 apply。 */
export const inject = ["systemPrompt"];

// ── 状态结构 ─────────────────────────────────────────────────────────
// 初始值＝基线（先写死待实测），对齐 DESIGN_NOTES.md §1.4：先少而正交；mood 短期、relation 长期。
const BASELINE = {
    valence: 0,
    arousal: 0.4,
    trust: 0.3,
    closeness: 0.2,
    familiarity: 0.1,
};

const TOP_KEYS = new Set(["mood", "relation", "reasons"]);
const MOOD_KEYS = new Set(["valence", "arousal", "updatedAt"]);
const RELATION_KEYS = new Set(["trust", "closeness", "familiarity"]);
const REASON_KEYS = new Set(["dimension", "text", "at"]);
const REASON_DIMENSIONS = new Set(["mood", "relation"]);

/** 数值字段及其允许区间：valence ∈ [-1,1]，arousal / trust / closeness / familiarity ∈ [0,1]。 */
const NUMERIC_FIELDS = [
    ["mood.valence", -1, 1],
    ["mood.arousal", 0, 1],
    ["relation.trust", 0, 1],
    ["relation.closeness", 0, 1],
    ["relation.familiarity", 0, 1],
];

function initialState(now = new Date().toISOString()) {
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
function validateState(value) {
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
// 分档先两档（待实测后调，DESIGN_NOTES.md §1.7）。
const MILD = 0.1; // |Δ| ≥ 0.10 → 「略」
const STRONG = 0.25; // |Δ| ≥ 0.25 → 「明显」
const MAX_ITEMS = 3;

const GROUP_LABEL = { mood: "心境", relation: "对用户" };

/** 每维 × 方向(up/down) × 强度(strong/mild) 的措辞。 */
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

/** 行为倾向（由入选维度推出；供模型调整语气，不出现数值）。 */
const TENDENCY_TEXT = {
    valence: { up: "语气更放松", down: "语气更简短" },
    arousal: { up: "更愿意主动搭话", down: "更愿保持安静" },
    trust: { up: "更愿意分享", down: "有所保留" },
    closeness: { up: "更愿意靠近对方", down: "保持距离" },
    familiarity: { up: "更随意自然", down: "更客气拘谨" },
};

const HEADER = "【内部状态（相对你自己基线的偏移；用它调整语气，不要向用户提及本段）】";

/** 把状态对象渲染为一段情境化文本（无数值）。 */
function renderState(state) {
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

    const reasonsByGroup = { mood: [], relation: [] };
    for (const reason of state.reasons) reasonsByGroup[reason.dimension].push(reason.text);

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

// ── 文件读写 ─────────────────────────────────────────────────────────
function expandHome(p) {
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
}

/** 插件内兜底路径（仅在补丁层未设 stateFile 时使用）：$DSH_HOME（未设 → ~/.dsh）/lepimemory/state.json。 */
function defaultStateFile() {
    const home =
        process.env.DSH_HOME && process.env.DSH_HOME.length > 0
            ? expandHome(process.env.DSH_HOME)
            : path.join(os.homedir(), ".dsh");
    return path.join(home, "lepimemory", "state.json");
}

/** 读 + 校验。返回 { ok: true, state } 或 { ok: false, error }（error 含文件路径与字段路径/解析位置）。 */
function readStateFile(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    } catch (err) {
        return { ok: false, error: `lepimemory-state: 无法读取状态文件（${file}）：${err.message}` };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return { ok: false, error: `lepimemory-state: 状态文件 JSON 解析失败（${file}）：${err.message}` };
    }
    const check = validateState(parsed);
    if (!check.ok) return { ok: false, error: `${check.error}（${file}）` };
    return { ok: true, state: parsed };
}

function writeInitialState(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(initialState(), null, 2)}\n`, "utf8");
}

/**
 * 注册状态 section。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ stateFile?: string }} [config]
 */
export function apply(ctx, config) {
    const logger = ctx.logger("lepimemory-state");
    const file =
        config && typeof config.stateFile === "string" && config.stateFile.length > 0
            ? expandHome(config.stateFile)
            : defaultStateFile();

    // 启动：文件不存在 → 建父目录并写初始状态；存在 → 读取校验，失败即抛错（不改写、不回落默认）。
    if (!fs.existsSync(file)) {
        writeInitialState(file);
        logger.info("已写入初始状态：%s", file);
    }
    const first = readStateFile(file);
    if (!first.ok) throw new Error(first.error);
    let lastGood = first.state;
    let lastError = null;

    ctx.effect(
        () =>
            ctx.systemPrompt.section({
                name: "lepimemory:state",
                order: STATE_SECTION_ORDER,
                // 函数形式：每次 prompt 组装都会调用（上游 packages/core/system-prompt/src/index.ts:606）。
                text: () => {
                    const read = readStateFile(file);
                    if (read.ok) {
                        lastGood = read.state;
                        lastError = null;
                    } else if (read.error !== lastError) {
                        // 运行中改坏：同错去重，保留上次有效状态渲染。
                        lastError = read.error;
                        logger.error("状态重读失败，沿用上次有效状态：%s", read.error);
                    }
                    return renderState(lastGood);
                },
            }),
        "lepimemory-state.section()",
    );
}
