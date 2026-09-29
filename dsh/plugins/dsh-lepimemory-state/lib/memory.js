/**
 * 记忆桥：读路径（召回→归因→注入）+ 写路径（retain）。
 *
 * 读路径（2026-09-29 定）：
 *   `agent/pre-step` waterfall —— `await` Hindsight `recall(trace)` → 归因筛选 →
 *   注入 `source:{kind, form:'recall'}` 的 user 消息（落库可回放）。
 *
 * 写路径（本文）：
 *   `session/event` 收尾时，对**本轮用户说过的话**做最笨的「写入判断」→ `retain`。
 *   三层判断（CONCEPTS §4.2）：① 过短/寒暄 → 不写；② 其余用户陈述 → 交 Hindsight `concise` 抽取
 *   （它本身会过滤填充语、抽成事实）；③ trust 等级先用 tags 标注（`trust:fact`）。
 *   失败/退避耗尽 → 写 `retain.jsonl` 审计，绝不影响对话。
 *
 * 降级：任何记忆操作失败都**不阻断**对话；全部落自有审计。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HindsightClient, attribute, renderRecall } from "./hindsight.js";

/** 本插件注入来源的 kind（MessageSourceMap 可合并扩展；参考仓内 session-reference 的自定义 kind）。 */
const SOURCE_KIND = "lepimemory-recall";

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

    const retainEnabled = memory.retain?.enabled !== false;
    const retainMinChars = memory.retain?.minChars ?? 6;

    /** sessionId -> 已注入的 turn（每轮至多注入一次）。 */
    const injectedTurns = new Map();
    /** sessionId -> 本轮用户说过的话（写路径缓冲）。 */
    const turnUserText = new Map();

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
                messages: [
                    ...decision.messages,
                    {
                        id: randomUUID(),
                        role: "user",
                        content: [{ type: "text", text: renderRecall(picked) }],
                        source: { kind: SOURCE_KIND, form: "recall" },
                    },
                ],
            };
        },
        { prepend: true },
    );

    // ── 写路径：本轮用户说的话 → 最笨的写入判断 → retain ─────────────────
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
            // ① 过短/寒暄 → 不写
            if (content.length < retainMinChars) {
                appendAudit(retainAudit, {
                    type: "retain", at: new Date().toISOString(), session: id, turn: event.data?.turn,
                    skipped: true, reason: "过短（视为寒暄/噪声）", chars: content.length,
                }, logger);
                return;
            }
            // ② 交 Hindsight concise 抽取；③ 信任等级以 tags 标注。fire-and-forget（后台，不在乎延迟，给足预算）。
            const retainDeadlineMs = memory.retain?.deadlineMs ?? 30000;
            client
                .retain([{ content, context: "用户说的话", tags: ["origin:user-turn", "trust:fact"] }], { deadlineMs: retainDeadlineMs })
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

    logger.info("记忆桥已装载：%s（bank=%s，retain=%s）", client.baseUrl, client.bank, retainEnabled ? "on" : "off");
}
