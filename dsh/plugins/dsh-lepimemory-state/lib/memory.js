/**
 * 记忆桥：每轮按用户输入去 Hindsight 召回长期记忆，归因筛选后注入模型上下文。
 *
 * 扩展点（2026-09-29 复核，见 docs/research/artifacts/memory-recall.md）：
 *   `agent/pre-step` waterfall —— 监听器可 `await` 异步召回，再把消息并入 `enter(messages)`。
 *   注入的消息带 `source: { kind, form: 'recall' }`，会作为普通 `user/message` 落库（可回放/可审计）。
 *   （`agent.inject()` 是「无唤醒的下一界推送」，可能错过本轮，不用于此处。）
 *
 * 降级：召回失败/超时 → **无记忆回答**，并写自有审计（别让演示当场 500）。
 * 审计落 `recall.jsonl`（与状态机的 audit.jsonl 分开）。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HindsightClient, attribute, renderRecall } from "./hindsight.js";

/** 本插件注入来源的 kind（MessageSourceMap 可合并扩展；未知 kind 由消费方按不透明处理）。 */
const SOURCE_KIND = "lepimemory-recall";

function recallAuditFileFor(stateFile) {
    return path.join(path.dirname(stateFile), "recall.jsonl");
}

/** 从进入本步的消息里取「真·用户输入」文本（排除我们自己注入的 recall 消息）。 */
function userTextOf(messages) {
    return (messages ?? [])
        .filter((m) => m?.source?.kind === "user")
        .flatMap((m) => (m?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text))
        .join("\n")
        .trim();
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
    const auditFile = memory.auditFile ?? recallAuditFileFor(stateFile);

    /** sessionId -> 已注入的 turn（每轮至多注入一次）。 */
    const injectedTurns = new Map();

    function audit(entry) {
        try {
            fs.mkdirSync(path.dirname(auditFile), { recursive: true });
            fs.appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, "utf8");
        } catch (err) {
            logger.error("recall 审计写入失败：%s", err.message);
        }
    }

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
                audit({
                    type: "recall",
                    at: new Date().toISOString(),
                    session: sessionId,
                    turn,
                    query,
                    degraded: true,
                    error: String(err?.message ?? err),
                });
                return decision; // 降级：无记忆回答
            }

            const { picked, excluded } = attribute(response?.results, { minSemantic, maxItems });
            audit({
                type: "recall",
                at: new Date().toISOString(),
                session: sessionId,
                turn,
                query,
                candidates: (response?.results ?? []).length,
                picked: picked.map((m) => ({ id: m.id, text: m.text, semantic: Math.round(m.semantic * 1000) / 1000 })),
                excluded: excluded.map((m) => ({ id: m.id, reason: m.reason })),
                ms: Date.now() - started,
            });

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

    logger.info("记忆桥已装载：%s（bank=%s）", client.baseUrl, client.bank);
}
