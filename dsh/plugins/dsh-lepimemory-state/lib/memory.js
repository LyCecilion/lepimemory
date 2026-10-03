/**
 * 记忆桥：读路径（召回→归因→注入）+ 写路径（retain）+ 遗忘工具（forget）。
 *
 * 读路径：`agent/pre-step` → `await` Hindsight `recall(trace)` → 归因 → 注入 `source:{kind,form:'recall'}` 的 user 消息。
 * 写路径：`session/event` 收尾 → 写入判断（长度/疑问/请求/寒暄 + 去重）→ `retain`（concise 抽取）。
 * 遗忘：注册 `forget` **工具**（由模型调用）——先 recall 出**将受影响的记忆**，再经 `ctx.approval`
 *       做**结构化用户确认**（fail-closed、落 `approval/asked`+`decided`），同意才 `invalidate`（可 revert）。
 *       —— **不再对用户消息跑正则**（那是 hacky 且易误伤）。
 *
 * 一切失败都不阻断对话；全部落自有审计。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HindsightClient, attribute, renderRecall } from "./hindsight.js";

/** 本插件注入来源的 kind（MessageSourceMap 可合并扩展；参考仓内 session-reference 的自定义 kind）。 */
const RECALL_KIND = "lepimemory-recall";

/** 遗忘工具名（模型可见）。 */
const FORGET_TOOL = "forget";

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
                response = await client.recall(query, { trace: true, signal });
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
                picked: picked.map((m) => ({ id: m.id, text: m.text, semantic: Math.round(m.semantic * 1000) / 1000 })),
                excluded: excluded.map((m) => ({ id: m.id, reason: m.reason })),
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
                        "把某个对象从长期记忆里“忘掉”（检索抑制，可恢复）。会先列出将受影响的记忆并请用户确认，只有用户同意后才执行。当用户明确要求忘记某人/某事时调用。",
                    parameters: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            target: { type: "string", description: "要忘掉的对象（人名 / 事物 / 说法）" },
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
                                memories: { type: "array", items: { type: "string" } },
                            },
                            required: ["target", "planned", "executed", "outcome", "memories"],
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
                        const { picked } = attribute(response?.results, { minSemantic: 0.3, maxItems: 20 });
                        // 朴素 S1 切分：只取**文本确实提到目标**的候选（避免误伤无关片段）。
                        const selected = picked.filter((m) => String(m.text ?? "").includes(target));
                        const memories = selected.map((m) => String(m.text ?? ""));
                        if (selected.length === 0) {
                            return { target, planned: 0, executed: 0, outcome: "no-match", memories: [] };
                        }

                        const approver = ctx.get ? ctx.get("approval") : undefined;
                        if (!approver) {
                            return { target, planned: selected.length, executed: 0, outcome: "unavailable", memories };
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
                            return { target, planned: selected.length, executed: 0, outcome, memories };
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
                        return { target, planned: selected.length, executed: done, outcome, memories };
                    },
                }),
            "lepimemory.forget()",
        );
    }

    // ── 写路径：本轮用户说的话 → 写入判断 → retain ────────────────────────
    if (retainEnabled) {
        ctx.on("session/event", (session, event) => {
            const id = String(session.id);
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
            const texts = turnUserText.get(id);
            turnUserText.delete(id);
            if (!texts || texts.length === 0) return;

            const content = texts.join("\n").trim();
            const skipReason = writeSkipReason(content, retainMinChars);
            if (skipReason) {
                appendAudit(retainAudit, {
                    type: "retain", at: new Date().toISOString(), session: id, turn: event.data?.turn,
                    skipped: true, reason: skipReason, chars: content.length, content,
                }, logger);
                return;
            }
            const key = content.replace(/\s+/g, "");
            if (recentRetained.has(key)) {
                appendAudit(retainAudit, {
                    type: "retain", at: new Date().toISOString(), session: id, turn: event.data?.turn,
                    skipped: true, reason: "重复内容（去重）", content,
                }, logger);
                return;
            }
            recentRetained.add(key);
            if (recentRetained.size > 200) recentRetained.delete(recentRetained.values().next().value);
            const retainDeadlineMs = memory.retain?.deadlineMs ?? 30000;
            client
                .retain([{ content, context: "用户说的话", tags: ["origin:user-turn", "trust:fact"] }], { deadlineMs: retainDeadlineMs, maxRetries: 0 })
                .then((res) => appendAudit(retainAudit, {
                    type: "retain", at: new Date().toISOString(), session: id, turn: event.data?.turn,
                    ok: true, chars: content.length, items: res?.items_count, content,
                }, logger))
                .catch((err) => appendAudit(retainAudit, {
                    type: "retain", at: new Date().toISOString(), session: id, turn: event.data?.turn,
                    degraded: true, error: String(err?.message ?? err), content,
                }, logger));
        });
    }

    logger.info("记忆桥已装载：%s（bank=%s，retain=%s，forgetTool=%s）", client.baseUrl, client.bank, retainEnabled ? "on" : "off", forgetEnabled ? "on" : "off");
}
