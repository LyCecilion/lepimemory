/**
 * @dsh-external/dsh-lepimemory-state
 *
 * 角色状态插件（Phase 3）：
 *   1) 读一份**持久化、结构化**的状态文件，在每次 prompt 组装时实时渲染成 system prompt section；
 *   2) 状态机（machine.js）吃**结构事件**（用户是否说话、工具是否失败）推进状态 + 心境衰减；
 *   3) 每次变更落一份**自有审计** `<DSH_HOME>/lepimemory/audit.jsonl`（前值→后值 + 命中规则）。
 *
 * 状态文件路径：补丁层 config.stateFile = !!js dshHomePath('lepimemory/state.json')（走 dsh 自身 home 解析：
 * 显式 home > $DSH_HOME > ~/.dsh）；未配置时插件内兜底 $DSH_HOME/~/.dsh 下 lepimemory/state.json。
 * ⚠️ 不用 storages/（那是 storage-json 后端的根）。
 *
 * 为什么审计落自有文件、而不往 session log 加事件：
 *   本版本 out-of-tree 插件**不能**追加新事件类型——Session.append() 无 ignorable 透传，读侧按静态白名单
 *   准入，追加即让整个会话重载被拒（实测见 docs/research/artifacts/session-event-spike.md）。
 *   因此「效果」靠已落的 system/message Prompt Diff，「原因」落自有 audit.jsonl（CONCEPTS §5.3）。
 *
 * ── 关于 section 的 order（重要，不要当魔数改）────────────────────────
 *   dsh 中央分配表中与人设相关的只有 DEPLOYMENT_PERSONA_PREFIX = 0、DEPLOYMENT_PERSONA_SUFFIX = 10200。
 *   这两个常量不可 import；运行时**可取但有意不用**（ctx.systemPrompt.getSectionOrder(...)）——取它会退化为
 *   section 名的 code-unit 比较，让位置取决于词典序巧合。故自持常量 + 写清依据。
 */
import fs from "node:fs";
import path from "node:path";
import { advance } from "./machine.js";
import {
    defaultStateFile,
    expandHome,
    readStateFile,
    renderState,
    writeInitialState,
    writeStateFile,
} from "./state.js";

export const name = "lepimemory-state";

/** 状态 section 的排序值：人设 prefix(order 0) 之后、策略段(500) 之前。依据见文件头注释。 */
export const STATE_SECTION_ORDER = 50;

/** 需要 prompt 注册表就绪后才 apply。 */
export const inject = ["systemPrompt"];

/** 审计文件与状态文件同目录。 */
function auditFileFor(stateFile) {
    return path.join(path.dirname(stateFile), "audit.jsonl");
}

/**
 * 注册状态 section + 状态机。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ stateFile?: string }} [config]
 */
export function apply(ctx, config) {
    const logger = ctx.logger("lepimemory-state");
    const file =
        config && typeof config.stateFile === "string" && config.stateFile.length > 0
            ? expandHome(config.stateFile)
            : defaultStateFile();
    const auditFile = auditFileFor(file);

    // 启动：文件不存在 → 写初始状态；存在 → 读取校验，失败即抛错（不改写、不回落默认）。
    if (!fs.existsSync(file)) {
        writeInitialState(file);
        logger.info("已写入初始状态：%s", file);
    }
    const first = readStateFile(file);
    if (!first.ok) throw new Error(first.error);
    let lastGood = first.state;
    let lastError = null;

    const noteFailure = (message) => {
        if (message !== lastError) {
            lastError = message;
            logger.error("%s", message);
        }
    };

    // ── 渲染 section：每次 prompt 组装都实时重读状态文件（无需重启）────────
    ctx.effect(
        () =>
            ctx.systemPrompt.section({
                name: "lepimemory:state",
                order: STATE_SECTION_ORDER,
                text: () => {
                    const read = readStateFile(file);
                    if (read.ok) {
                        lastGood = read.state;
                        lastError = null;
                    } else {
                        noteFailure(`状态重读失败，沿用上次有效状态：${read.error}`);
                    }
                    return renderState(lastGood);
                },
            }),
        "lepimemory-state.section()",
    );

    // ── 状态机：吃结构事件，在轮次收尾时推进状态 + 落审计 ──────────────────
    const turns = new Map(); // sessionId -> { turn, userMessages, toolFailures }

    function settle(facts) {
        const read = readStateFile(file);
        if (!read.ok) {
            noteFailure(read.error);
            return;
        }
        let result;
        try {
            result = advance(read.state, facts, Date.now());
        } catch (err) {
            noteFailure(`lepimemory-state: 状态推进失败：${err.message}`);
            return;
        }
        if (!result.changed) return;
        try {
            writeStateFile(file, result.state);
            const entry = {
                at: result.state.mood.updatedAt,
                turn: facts.turn,
                rules: result.fired,
                changes: result.changes,
            };
            fs.appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, "utf8");
        } catch (err) {
            noteFailure(`lepimemory-state: 状态/审计写入失败：${err.message}`);
        }
    }

    ctx.on("session/event", (session, event) => {
        try {
            const id = String(session.id);
            switch (event.type) {
                case "turn/start":
                    turns.set(id, { turn: event.data.turn, userMessages: 0, toolFailures: 0 });
                    break;
                case "user/message": {
                    const facts = turns.get(id);
                    if (facts && event.data?.source?.kind === "user") facts.userMessages += 1;
                    break;
                }
                case "tool/result": {
                    const facts = turns.get(id);
                    if (facts && event.data?.message?.isError === true) facts.toolFailures += 1;
                    break;
                }
                case "turn/end": {
                    const facts = turns.get(id);
                    turns.delete(id);
                    if (facts) settle(facts);
                    break;
                }
                default:
                    break;
            }
        } catch (err) {
            noteFailure(`lepimemory-state: 事件处理失败：${err.message}`);
        }
    });
}
