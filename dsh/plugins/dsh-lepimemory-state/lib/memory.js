/**
 * 记忆桥：读路径（召回→归因→注入）+ 写路径（retain）+ 遗忘工具（forget）+ 推断工具（remember）。
 *
 * 读路径：`agent/pre-step` → `await` Hindsight `recall(trace, prefer_observations)` → 归因（含**信任档衰减**）
 *         → 注入 `source:{kind,form:'recall'}` 的 user 消息。`prefer_observations` 让冲突**取最新**
 *         （Hindsight 的 observation supersede 原始事实）。
 * 写路径：`session/event` 收尾 → 写入判断（长度/疑问/请求/寒暄 + 去重）→ `retain`（concise 抽取）；
 *         按**信任档**写 `metadata.trust`：`fact`（用户明说）/ `experience`（行动成功）/ `inference`（`remember` 工具）。
 * 遗忘：注册 `forget` **工具**（由模型调用）——先 recall 出**将受影响的记忆**，再经 `ctx.approval`
 *       做**结构化用户确认**（fail-closed、落 `approval/asked`+`decided`），同意才 `invalidate`（可 revert）。
 *       —— **不再对用户消息跑正则**（那是 hacky 且易误伤）。
 * 推断：注册 `remember` 工具，让角色把**自己推断/察觉到**的印象记进长期记忆（信任档 inference，会衰减）。
 *
 * 一切失败都不阻断对话；全部落自有审计。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ACTION_TOOLS, toolResultInfo } from "./action.js";
import { HindsightClient, attribute, renderRecall } from "./hindsight.js";
import { TRUST } from "./trust.js";

/** 本插件注入来源的 kind（MessageSourceMap 可合并扩展；参考仓内 session-reference 的自定义 kind）。 */
const RECALL_KIND = "lepimemory-recall";

/** 遗忘工具名（模型可见）。 */
const FORGET_TOOL = "forget";
/** 恢复工具名（与 forget 对称：撤销抑制）。 */
const RESTORE_TOOL = "restore_memory";
/** 推断工具名（角色主动记下自己的推断，信任档 inference）。 */
const REMEMBER_TOOL = "remember";

function auditFileFor(stateFile, name) {
    return path.join(path.dirname(stateFile), name);
}

/** 从进入本步的消息里取「真·用户输入」文本（排除我们自己注入的 recall 消息）。 */
function userTextOf(messages) {
    return (messages ?? [])
        .filter((m) => m?.source?.kind === "user")
        .flatMap((m) => (m?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text))
        .join("\n")
        .trim();
}

/** 构造一条注入用的 user 消息。 */
function injectMessage(text, { kind, form, summary }) {
    const source = { kind, form };
    if (form === "notice") source.summary = String(summary ?? text).slice(0, 120);
    return { id: randomUUID(), role: "user", content: [{ type: "text", text }], source };
}

/** 从 `tool/call` 的 arguments（JSON 串）里取标题；解析失败返回空串。 */
function parseTitle(argumentsJson) {
    try {
        return String(JSON.parse(argumentsJson)?.title ?? "");
    } catch {
        return "";
    }
}

/**
 * 写路径层①「是否值得写」（v1.1：不只按长度）。
 * ⚠️ 只用**疑问/请求**做排除（保守）：陈述句里偶带「？」少见，宁可漏写一条也不写脏。返回跳过理由或 null。
 */
export function writeSkipReason(content, minChars) {
    if (content.length < minChars) return "过短（视为寒暄/噪声）";
    if (/[?？]/.test(content)) return "疑问句（不写入长期记忆）";
    if (/^(提醒我|帮我|告诉我|查一下|说一下|讲一下|找一下|看看|问一下)/.test(content)) return "请求句（不写入长期记忆）";
    if (/(吗|呢|吧)\s*[。.!！~～]?\s*$/.test(content)) return "征询/疑问句（不写入长期记忆）";
    if (/^(嗯+|哦+|好的?|收到|在吗|谢谢|多谢|哈哈+|嗨+|你好|在么)\s*[。.!！~～]?\s*$/.test(content)) return "寒暄";
    return null;
}

/** 追加一行 JSON 审计（best-effort）。 */
function appendAudit(file, entry, logger) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
        logger.error("审计写入失败（%s）：%s", file, err.message);
    }
}

/** 把遗忘工具结果渲染成模型可见文本。 */
function renderForget(value) {
    const list = (value.memories ?? []).slice(0, 8).map((t) => `· ${t}`).join("\n");
    switch (value.outcome) {
        case "no-match":
            return `没有找到与「${value.target}」相关的长期记忆，无需遗忘。`;
        case "plan": {
            const ids = value.ids ?? [];
            const lines = (value.memories ?? [])
                .slice(0, 20)
                .map((t, i) => `· [${ids[i] ?? "?"}] ${t}`)
                .join("\n");
            return `关于「${value.target}」有 ${value.planned} 条候选。请把清单给用户看、让 ta 选择要抑制哪些，再用 ids 调用本工具执行：\n${lines}`;
        }
        case "unavailable":
            return `找到了 ${value.planned} 条关于「${value.target}」的记忆，但**没有可用的确认通道**，未执行（可稍后再试）。`;
        case "rejected":
            return `用户**拒绝**了这次遗忘，未执行；${value.planned} 条记忆保持原样。`;
        case "cancelled":
            return `遗忘请求被取消，未执行。`;
        case "allowed-once":
            return `遗忘已执行：抑制了 ${value.executed}/${value.planned} 条关于「${value.target}」的记忆（可撤销，用户反悔时可恢复）。\n${list}`;
        default:
            return `遗忘处理完毕（outcome=${value.outcome}）。`;
    }
}

/** 把恢复工具结果渲染成模型可见文本。 */
function renderRestore(value) {
    switch (value.outcome) {
        case "no-record":
            return `没有关于「${value.target}」的遗忘记录，无需恢复。`;
        case "unavailable":
            return `找到了 ${value.planned} 条可恢复记忆，但**没有可用的确认通道**，未恢复。`;
        case "rejected":
            return `用户**拒绝**了这次恢复，未执行。`;
        case "cancelled":
            return `恢复请求被取消，未执行。`;
        case "allowed-once":
            return `已恢复 ${value.restored}/${value.planned} 条关于「${value.target}」的记忆。`;
        default:
            return `恢复处理完毕（outcome=${value.outcome}）。`;
    }
}

/**
 * 安装记忆桥（若 config.memory.enabled === false 则跳过）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @param {{ logger: any, stateFile: string }} deps
 */
export function installMemory(ctx, config, { logger, stateFile }) {
    const memory = config?.memory ?? {};
    if (memory.enabled === false) return;

    const client = new HindsightClient({
        baseUrl: memory.baseUrl ?? "http://127.0.0.1:8888",
        bank: memory.bank ?? "lepimemory",
        maxRetries: memory.maxRetries ?? 3,
        backoffMs: memory.backoffMs ?? 1000,
        deadlineMs: memory.deadlineMs ?? 3000,
    });
    const minSemantic = memory.minSemantic ?? 0.35;
    const maxItems = memory.maxItems ?? 4;
    const recallAudit = memory.auditFile ?? auditFileFor(stateFile, "recall.jsonl");
    const retainAudit = memory.retainAuditFile ?? auditFileFor(stateFile, "retain.jsonl");
    const forgetAudit = memory.forgetAuditFile ?? auditFileFor(stateFile, "forget.jsonl");

    const retainEnabled = memory.retain?.enabled !== false;
    const forgetEnabled = memory.forget?.enabled !== false;
    const retainMinChars = memory.retain?.minChars ?? 6;

    const injectedTurns = new Map(); // sessionId -> 已注入的 turn（每轮至多注入一次）
    const turnUserText = new Map(); // sessionId -> 本轮用户说过的话（写路径缓冲）
    const recentRetained = new Set(); // 去重
    const pendingAction = new Map(); // callId -> { name, title }（待配对的行动工具调用）
    const turnActions = new Map(); // sessionId -> 本轮成功动作 [{ name, title }]

    // ── 读路径：pre-step 召回 → 归因 → 注入 ─────────────────────────────
    ctx.on(
        "agent/pre-step",
        async ({ agent, turn, signal }, next) => {
            const decision = await next();
            if (decision.kind === "reject" || signal.aborted) return decision;

            const query = userTextOf(decision.messages);
            if (!query) return decision;
            const sessionId = String(agent.session.id);
            if (injectedTurns.get(sessionId) === turn) return decision;

            const started = Date.now();
            let response;
            try {
                // prefer_observations：冲突时只取 Hindsight 合成的「当前有效版本」，不返回被它取代的旧事实。
                response = await client.recall(query, { trace: true, signal, preferObservations: true });
            } catch (err) {
                appendAudit(recallAudit, {
                    type: "recall", at: new Date().toISOString(), session: sessionId, turn, query,
                    degraded: true, error: String(err?.message ?? err),
                }, logger);
                return decision; // 降级：无记忆回答
            }

            const { picked, excluded } = attribute(response?.results, { minSemantic, maxItems });
            appendAudit(recallAudit, {
                type: "recall", at: new Date().toISOString(), session: sessionId, turn, query,
                candidates: (response?.results ?? []).length,
                picked: picked.map((m) => ({
                    id: m.id, text: m.text, type: m.type, trust: m.trust,
                    semantic: Math.round(m.semantic * 1000) / 1000,
                    decay: Math.round(m.decay * 1000) / 1000,
                })),
                excluded: excluded.map((m) => ({ id: m.id, trust: m.trust, reason: m.reason })),
                // 本轮是否返回了「已更新的综合版本」（原记忆被 observation 取代）
                superseded: picked.some((m) => m.type === "observation"),
                ms: Date.now() - started,
            }, logger);

            if (picked.length === 0) return decision;
            injectedTurns.set(sessionId, turn);
            return {
                ...decision,
                messages: [...decision.messages, injectMessage(renderRecall(picked), { kind: RECALL_KIND, form: "recall" })],
            };
        },
        { prepend: true },
    );

    // ── 遗忘工具：模型调用 → 计划 → ctx.approval 确认 → 抑制 ───────────────
    if (forgetEnabled && ctx.tools) {
        ctx.effect(
            () =>
                ctx.tools.register({
                    name: FORGET_TOOL,
                    description:
                        "把某个对象从长期记忆里“忘掉”（检索抑制，可恢复）。**两段式**：先不带 ids 调一次 → 返回候选清单（计划），把它给用户看、让 ta 选择；再把选中的 ids 带上调一次 → 经用户确认后执行抑制。当用户明确要求忘记某人/某事时调用。",
                    parameters: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            target: { type: "string", description: "要忘掉的对象（人名 / 事物 / 说法）" },
                            ids: {
                                type: "array",
                                items: { type: "string" },
                                description: "只抑制这些记忆 id（来自上一次调用的候选 ids）；省略则仅返回候选计划",
                            },
                        },
                        required: ["target"],
                    },
                    output: {
                        schema: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                target: { type: "string" },
                                planned: { type: "number" },
                                executed: { type: "number" },
                                outcome: { type: "string" },
                                ids: { type: "array", items: { type: "string" } },
                                memories: { type: "array", items: { type: "string" } },
                            },
                            required: ["target", "planned", "executed", "outcome", "ids", "memories"],
                        },
                        render: (_args, value) => [{ type: "text", text: renderForget(value) }],
                    },
                    execute: async (args, exec) => {
                        const target = String(args?.target ?? "").trim();
                        if (!target) throw new Error(`${FORGET_TOOL} 需要非空的 target`);

                        let response;
                        try {
                            response = await client.recall(target, { trace: false, signal: exec.signal });
                        } catch (err) {
                            throw new Error(`记忆服务不可达，无法生成遗忘计划：${err?.message ?? err}`);
                        }
                        const { picked } = attribute(response?.results, { minSemantic: 0.3, maxItems: 20, applyDecay: false });
                        // 朴素 S1 切分：只取**文本确实提到目标**的候选（避免误伤无关片段）。
                        const related = picked.filter((m) => String(m.text ?? "").includes(target));
                        if (related.length === 0) {
                            return { target, planned: 0, executed: 0, outcome: "no-match", ids: [], memories: [] };
                        }

                        // 第一段（缺省 ids）：只返回候选计划——不请求审批、不执行。
                        if (!Array.isArray(args?.ids) || args.ids.length === 0) {
                            return {
                                target,
                                planned: related.length,
                                executed: 0,
                                outcome: "plan",
                                ids: related.map((m) => m.id),
                                memories: related.map((m) => String(m.text ?? "")),
                            };
                        }

                        // 第二段：只抑制用户选中的 id（避免「全量抑制」与模型陈述不符）。
                        const wanted = new Set(args.ids.map((s) => String(s)));
                        const selected = related.filter((m) => wanted.has(String(m.id)));
                        if (selected.length === 0) {
                            return { target, planned: 0, executed: 0, outcome: "no-match", ids: [], memories: [] };
                        }
                        const memories = selected.map((m) => String(m.text ?? ""));

                        const approver = ctx.get ? ctx.get("approval") : undefined;
                        if (!approver) {
                            return { target, planned: selected.length, executed: 0, outcome: "unavailable", ids: selected.map((m) => m.id), memories };
                        }
                        const outcome = await approver.request({
                            agent: exec.agent,
                            toolName: FORGET_TOOL,
                            callId: exec.callId,
                            reason: `抑制 ${selected.length} 条关于「${target}」的记忆`,
                            displayReason: {
                                zh: `将抑制 ${selected.length} 条关于「${target}」的记忆（可恢复）：\n${memories.slice(0, 5).map((t) => `· ${t}`).join("\n")}`,
                                en: `Suppress ${selected.length} memories about "${target}" (reversible).`,
                            },
                            ...(exec.signal ? { signal: exec.signal } : {}),
                        });
                        if (outcome !== "allowed-once") {
                            return { target, planned: selected.length, executed: 0, outcome, ids: selected.map((m) => m.id), memories };
                        }

                        let done = 0;
                        for (const m of selected) {
                            try {
                                await client.invalidate(m.id, { signal: exec.signal });
                                done += 1;
                            } catch {
                                /* 单条失败不中断 */
                            }
                        }
                        appendAudit(forgetAudit, {
                            type: "forget", at: new Date().toISOString(), tool: FORGET_TOOL, target,
                            planned: selected.length, executed: done, outcome, ids: selected.map((m) => m.id),
                        }, logger);
                        return { target, planned: selected.length, executed: done, outcome, ids: selected.map((m) => m.id), memories };
                    },
                }),
            "lepimemory.forget()",
        );

        // 与 forget 对称：恢复（撤销抑制）。ids 从 forget.jsonl 读回。
        ctx.effect(
            () =>
                ctx.tools.register({
                    name: RESTORE_TOOL,
                    description:
                        "把之前被「忘掉/抑制」的记忆**恢复**回来（撤销遗忘）。当用户表示反悔、要求恢复某人/某事时调用。",
                    parameters: {
                        type: "object",
                        additionalProperties: false,
                        properties: { target: { type: "string", description: "要恢复的对象（人名 / 事物 / 说法）" } },
                        required: ["target"],
                    },
                    output: {
                        schema: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                target: { type: "string" },
                                planned: { type: "number" },
                                restored: { type: "number" },
                                outcome: { type: "string" },
                            },
                            required: ["target", "planned", "restored", "outcome"],
                        },
                        render: (_args, value) => [{ type: "text", text: renderRestore(value) }],
                    },
                    execute: async (args, exec) => {
                        const target = String(args?.target ?? "").trim();
                        if (!target) throw new Error(`${RESTORE_TOOL} 需要非空的 target`);

                        // 从自有审计里读回「该目标被抑制过」的 ids。
                        let entries = [];
                        try {
                            entries = fs.readFileSync(forgetAudit, "utf8").split("\n").filter(Boolean)
                                .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                        } catch {
                            /* 无审计文件 */
                        }
                        const ids = new Set();
                        for (const e of entries) {
                            if (e.type !== "forget") continue;
                            if (!e.target || !String(e.target).includes(target)) continue;
                            if (!(e.outcome === "allowed-once" || e.executed > 0)) continue;
                            for (const id of e.ids ?? []) ids.add(id);
                        }
                        const list = [...ids];
                        if (list.length === 0) return { target, planned: 0, restored: 0, outcome: "no-record" };

                        const approver = ctx.get ? ctx.get("approval") : undefined;
                        if (!approver) return { target, planned: list.length, restored: 0, outcome: "unavailable" };
                        const outcome = await approver.request({
                            agent: exec.agent,
                            toolName: RESTORE_TOOL,
                            callId: exec.callId,
                            reason: `恢复 ${list.length} 条关于「${target}」的记忆`,
                            displayReason: {
                                zh: `恢复 ${list.length} 条关于「${target}」的被抑制记忆`,
                                en: `Restore ${list.length} suppressed memories about "${target}".`,
                            },
                            ...(exec.signal ? { signal: exec.signal } : {}),
                        });
                        if (outcome !== "allowed-once") return { target, planned: list.length, restored: 0, outcome };

                        let done = 0;
                        for (const id of list) {
                            try {
                                await client.revert(id, { signal: exec.signal });
                                done += 1;
                            } catch {
                                /* 单条失败不中断 */
                            }
                        }
                        appendAudit(forgetAudit, {
                            type: "restore", at: new Date().toISOString(), tool: RESTORE_TOOL, target,
                            planned: list.length, restored: done, outcome, ids: list,
                        }, logger);
                        return { target, planned: list.length, restored: done, outcome };
                    },
                }),
            "lepimemory.restore()",
        );
    }

    // ── 推断工具：角色主动记下「自己察觉到的判断」（信任档 inference，会随时间衰减）──
    if (retainEnabled && ctx.tools) {
        ctx.effect(
            () =>
                ctx.tools.register({
                    name: REMEMBER_TOOL,
                    description:
                        "把你自己**推断 / 察觉到**的关于对方的印象记进长期记忆——不是你被告知的事实（那些会自动记住），而是你自己拼出来的判断（比如 ta 好像喜欢安静的地方）。当你想留住这样一个印象时调用。content 请以「蝶忆觉得… / 蝶忆注意到…」这样的句子、用名字指代你自己来写。",
                    parameters: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            content: { type: "string", description: "你要记下的推断（一句话，第一人称）" },
                            about: { type: "string", description: "关于谁 / 什么（可选）" },
                        },
                        required: ["content"],
                    },
                    output: {
                        schema: {
                            type: "object",
                            additionalProperties: false,
                            properties: { content: { type: "string" }, outcome: { type: "string" } },
                            required: ["content", "outcome"],
                        },
                        render: (_args, value) => [
                            {
                                type: "text",
                                text:
                                    value.outcome === "stored"
                                        ? `记下了（我的推断）：${value.content}`
                                        : `没能记下（${value.outcome}）。`,
                            },
                        ],
                    },
                    execute: async (args, exec) => {
                        const content = String(args?.content ?? "").trim();
                        if (!content) throw new Error(`${REMEMBER_TOOL} 需要非空的 content`);
                        const about = String(args?.about ?? "").trim();
                        const context = about ? `我的推断（关于${about}）` : "我的推断";
                        // 用角色名成句：Hindsight 的抽取把「无主语的第一人称」当作**用户**在说话
                        // （「我猜她…」→「用户猜测她…」）。带上角色名，抽取才忠实（实测：见 memory-*.md）。
                        const persona = memory.personaName ?? "蝶忆";
                        const phrased = content.includes(persona) ? content : `${persona}的推断：${content}`;
                        try {
                            const res = await client.retain(
                                [{ content: phrased, context, tags: ["origin:character-inference"], metadata: { trust: TRUST.INFERENCE, origin: "character-inference" } }],
                                { deadlineMs: 30000, maxRetries: 0, ...(exec.signal ? { signal: exec.signal } : {}) },
                            );
                            appendAudit(retainAudit, {
                                type: "retain", origin: "character-inference", at: new Date().toISOString(),
                                ok: true, items: res?.items_count, content: phrased,
                            }, logger);
                            return { content, outcome: "stored" };
                        } catch (err) {
                            appendAudit(retainAudit, {
                                type: "retain", origin: "character-inference", at: new Date().toISOString(),
                                degraded: true, error: String(err?.message ?? err), content: phrased,
                            }, logger);
                            return { content, outcome: "unavailable" };
                        }
                    },
                }),
            "lepimemory.remember()",
        );
    }

    // ── 写路径：本轮用户说的话 → 写入判断 → retain ────────────────────────
    if (retainEnabled) {
        ctx.on("session/event", (session, event) => {
            const id = String(session.id);

            // 行动工具调用：记下待配对的 callId（含标题）。
            if (event.type === "tool/call") {
                if (ACTION_TOOLS.has(event.data?.name)) {
                    pendingAction.set(event.data.callId, { name: event.data.name, title: parseTitle(event.data.arguments) });
                }
                return;
            }
            // 行动工具结果：成功则记入本轮的「角色动作」。
            if (event.type === "tool/result") {
                const info = toolResultInfo(event.data?.message);
                const pending = info.toolCallId ? pendingAction.get(info.toolCallId) : undefined;
                if (pending) {
                    pendingAction.delete(info.toolCallId);
                    if (info.isError !== true) {
                        turnActions.set(id, [...(turnActions.get(id) ?? []), pending]);
                    }
                }
                return;
            }

            if (event.type === "user/message") {
                if (event.data?.source?.kind !== "user") return;
                const text = (event.data.content ?? [])
                    .filter((b) => b?.type === "text")
                    .map((b) => b.text)
                    .join("\n")
                    .trim();
                if (text) turnUserText.set(id, [...(turnUserText.get(id) ?? []), text]);
                return;
            }
            if (event.type !== "turn/end") return;

            // (a) 用户陈述 → retain（沿用既有的写入判断 / 去重）。
            const texts = turnUserText.get(id);
            turnUserText.delete(id);
            if (texts && texts.length > 0) {
                const content = texts.join("\n").trim();
                const skipReason = writeSkipReason(content, retainMinChars);
                if (skipReason) {
                    appendAudit(retainAudit, {
                        type: "retain", at: new Date().toISOString(), session: id, turn: event.data?.turn,
                        skipped: true, reason: skipReason, chars: content.length, content,
                    }, logger);
                } else {
                    const key = content.replace(/\s+/g, "");
                    if (recentRetained.has(key)) {
                        appendAudit(retainAudit, {
                            type: "retain", at: new Date().toISOString(), session: id, turn: event.data?.turn,
                            skipped: true, reason: "重复内容（去重）", content,
                        }, logger);
                    } else {
                        recentRetained.add(key);
                        if (recentRetained.size > 200) recentRetained.delete(recentRetained.values().next().value);
                        const retainDeadlineMs = memory.retain?.deadlineMs ?? 30000;
                        client
                            .retain([{ content, context: "用户说的话", tags: ["origin:user-turn"], metadata: { trust: TRUST.FACT, origin: "user-turn" } }], { deadlineMs: retainDeadlineMs, maxRetries: 0 })
                            .then((res) => appendAudit(retainAudit, {
                                type: "retain", at: new Date().toISOString(), session: id, turn: event.data?.turn,
                                ok: true, chars: content.length, items: res?.items_count, content,
                            }, logger))
                            .catch((err) => appendAudit(retainAudit, {
                                type: "retain", at: new Date().toISOString(), session: id, turn: event.data?.turn,
                                degraded: true, error: String(err?.message ?? err), content,
                            }, logger));
                    }
                }
            }

            // (b) 角色行动成功 → retain 成「经历」（fire-and-forget；与用户陈述互不干扰）。
            const actions = turnActions.get(id);
            turnActions.delete(id);
            for (const action of actions ?? []) {
                const content = `我写了张便条：${action.title}`;
                client
                    .retain([{ content, context: "角色做过的事", tags: ["origin:character-action"], metadata: { trust: TRUST.EXPERIENCE, origin: "character-action" } }], { deadlineMs: 30000, maxRetries: 0 })
                    .then((res) => appendAudit(retainAudit, {
                        type: "retain", origin: "character-action", at: new Date().toISOString(), session: id, turn: event.data?.turn,
                        ok: true, items: res?.items_count, content,
                    }, logger))
                    .catch((err) => appendAudit(retainAudit, {
                        type: "retain", origin: "character-action", at: new Date().toISOString(), session: id, turn: event.data?.turn,
                        degraded: true, error: String(err?.message ?? err), content,
                    }, logger));
            }
        });
    }

    logger.info("记忆桥已装载：%s（bank=%s，retain=%s，forgetTool=%s）", client.baseUrl, client.bank, retainEnabled ? "on" : "off", forgetEnabled ? "on" : "off");
}
