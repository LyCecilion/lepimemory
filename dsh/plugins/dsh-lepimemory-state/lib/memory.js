/**
 * 记忆桥：读路径（召回→归因→注入）+ 写路径（retain）+ 遗忘（计划预览→确认→执行）。
 *
 * 读路径：`agent/pre-step` → `await` Hindsight `recall(trace)` → 归因 → 注入 `source:{kind,form:'recall'}` 的 user 消息。
 * 写路径：`session/event` 收尾 → 写入判断（v1.1：长度/疑问/请求/寒暄 + 去重）→ `retain`（concise 抽取）。
 * 遗忘：`agent/pre-step` 里识别「忘掉 X / 确认 / 取消」→ 计划预览（注入 notice，角色复述并请确认）→
 *       确认后 `PATCH /memories/{id}` → `invalidated`（Hindsight S1 检索抑制，可 revert）；全程不越过用户确认。
 *
 * 一切失败都**不阻断**对话；全部落自有审计。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HindsightClient, attribute, renderRecall } from "./hindsight.js";

/** 本插件注入来源的 kind（MessageSourceMap 可合并扩展；参考仓内 session-reference 的自定义 kind）。 */
const RECALL_KIND = "lepimemory-recall";
const FORGET_KIND = "lepimemory-forget";

function auditFileFor(stateFile, name) {
    return path.join(path.dirname(stateFile), name);
}

/** 从进入本步的消息里取「真·用户输入」文本（排除我们自己注入的 recall/forget 消息）。 */
function userTextOf(messages) {
    return (messages ?? [])
        .filter((m) => m?.source?.kind === "user")
        .flatMap((m) => (m?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text))
        .join("\n")
        .trim();
}

/** 构造一条注入用的 user 消息（`notice` 需带 `summary`）。 */
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

const FORGET_RE = /(?:忘掉|忘记|别再记得|不要记得|抹掉)\s*([^。.!！?？\n]{0,40})/;
const CONFIRM_RE = /^\s*(确认|确定|好的?|可以|执行|是的|就这样|动手吧|嗯[，,]?执行)\s*[。.!！~～]?\s*$/;
const CANCEL_RE = /^\s*(算了|不用了?|取消|先不|别了?)\s*[。.!！~～]?\s*$/;

/** 识别遗忘相关意图。返回 `{kind:'request',target}` / `{kind:'confirm'}` / `{kind:'cancel'}` / null。 */
export function detectForgetIntent(text) {
    const t = (text ?? "").trim();
    if (!t) return null;
    if (CONFIRM_RE.test(t)) return { kind: "confirm" };
    if (CANCEL_RE.test(t)) return { kind: "cancel" };
    const m = t.match(FORGET_RE);
    if (m) return { kind: "request", target: (m[1] || "").trim() || "（未指明）" };
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
    const pendingForget = new Map(); // sessionId -> { target, ids }

    // ── 读路径 + 遗忘（都在 pre-step，先忘后召）────────────────────────────
    ctx.on(
        "agent/pre-step",
        async ({ agent, turn, signal }, next) => {
            const decision = await next();
            if (decision.kind === "reject" || signal.aborted) return decision;

            const query = userTextOf(decision.messages);
            if (!query) return decision;
            const sessionId = String(agent.session.id);
            if (injectedTurns.get(sessionId) === turn) return decision;

            // ── 遗忘：识别 → 计划预览 → 确认执行 / 取消 ──────────────────
            if (forgetEnabled) {
                const intent = detectForgetIntent(query);
                if (intent) {
                    const pending = pendingForget.get(sessionId);
                    const addNotice = (text, summary) => ({
                        ...decision,
                        messages: [...decision.messages, injectMessage(text, { kind: FORGET_KIND, form: "notice", summary })],
                    });

                    if (intent.kind === "confirm" && pending) {
                        let done = 0;
                        let failed = 0;
                        for (const id of pending.ids) {
                            try {
                                await client.invalidate(id, { signal });
                                done += 1;
                            } catch {
                                failed += 1;
                            }
                        }
                        pendingForget.delete(sessionId);
                        appendAudit(forgetAudit, {
                            type: "forget", at: new Date().toISOString(), session: sessionId, target: pending.target,
                            executed: done, failed, ids: pending.ids,
                        }, logger);
                        injectedTurns.set(sessionId, turn);
                        return addNotice(
                            `遗忘已执行：已抑制 ${done} 条关于「${pending.target}」的记忆${failed ? `（${failed} 条失败）` : ""}。可撤销。`,
                            `遗忘已执行：${done} 条`,
                        );
                    }
                    if (intent.kind === "cancel" && pending) {
                        pendingForget.delete(sessionId);
                        appendAudit(forgetAudit, {
                            type: "forget", at: new Date().toISOString(), session: sessionId, target: pending.target, cancelled: true,
                        }, logger);
                        injectedTurns.set(sessionId, turn);
                        return addNotice("遗忘已取消，什么都没删。", "遗忘已取消");
                    }
                    if (intent.kind === "request") {
                        let plan;
                        try {
                            plan = await client.recall(intent.target, { trace: false, signal });
                        } catch (err) {
                            appendAudit(forgetAudit, {
                                type: "forget", at: new Date().toISOString(), session: sessionId, target: intent.target,
                                degraded: true, error: String(err?.message ?? err),
                            }, logger);
                            injectedTurns.set(sessionId, turn);
                            return addNotice("记忆服务暂时不可达，没法生成遗忘计划。稍后再试。", "遗忘计划生成失败");
                        }
                        const { picked } = attribute(plan?.results, { minSemantic: 0.2, maxItems: 20 });
                        // 朴素 S1 切分：只留**文本确实提到目标**的候选（避免把无关的检索噪声一起抑制）；
                        // 目标不是字面词（如「刚才那个人」）时回退为全部候选。
                        const target = intent.target;
                        const related = picked.filter((m) => String(m.text ?? "").includes(target));
                        const selected = related.length > 0 ? related : picked;
                        const ids = selected.map((m) => m.id);
                        pendingForget.set(sessionId, { target, ids });
                        appendAudit(forgetAudit, {
                            type: "forget", at: new Date().toISOString(), session: sessionId, target,
                            plan: true, candidates: picked.length, selected: selected.length, ids,
                        }, logger);
                        const list = selected.slice(0, 10).map((m) => `- ${m.text}`).join("\n");
                        const text = [
                            "【遗忘计划预览（待用户确认）】",
                            `用户请求忘掉「${intent.target}」。将抑制 ${selected.length} 条相关记忆（可撤销，不是永久删除）：`,
                            list || "（无匹配，可能无需处理）",
                            "",
                            "请把这份计划用你自己的话向用户复述，并在**普通回复里**直接问「确认执行吗？」——",
                            "**不要调用提问工具**（否则我收不到确认）。用户下一条普通消息回复「确认」时我会执行，回复「算了」则取消。",
                            "**在收到确认前，不要声称已经忘记。**",
                        ].join("\n");
                        injectedTurns.set(sessionId, turn);
                        return addNotice(text, `遗忘计划预览：${picked.length} 条`);
                    }
                }
            }

            // ── 召回 → 归因 → 注入 ────────────────────────────────────────
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
                messages: [
                    ...decision.messages,
                    injectMessage(renderRecall(picked), { kind: RECALL_KIND, form: "recall" }),
                ],
            };
        },
        { prepend: true },
    );

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
            // ① 写入判断（长度 / 疑问 / 请求 / 寒暄）→ 不写
            const skipReason = writeSkipReason(content, retainMinChars);
            if (skipReason) {
                appendAudit(retainAudit, {
                    type: "retain", at: new Date().toISOString(), session: id, turn: event.data?.turn,
                    skipped: true, reason: skipReason, chars: content.length, content,
                }, logger);
                return;
            }
            // 去重：同内容不重复写
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
            // ② 交 Hindsight concise 抽取；③ 信任等级以 tags 标注。fire-and-forget（给足预算）。
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

    logger.info("记忆桥已装载：%s（bank=%s，retain=%s，forget=%s）", client.baseUrl, client.bank, retainEnabled ? "on" : "off", forgetEnabled ? "on" : "off");
}
