/**
 * 行动工具：能产生**真实副作用**的工具（注册到 `ctx.tools`），执行前经 `ctx.approval` 确认。
 *
 * 目前只有 `write_note`：把一段文字写成一张真实便条（落盘为 `<DSH_HOME>/lepimemory/notes/<slug>.md`）。
 * 副作用落在**插件自有目录**，不越权写用户项目。
 *
 * 成功/失败都经 dsh 原生 `tool/call` + `tool/result` 事件暴露：
 *   - index.js 的状态机据此累计 `actionSuccesses`（成功作为「经历」驱动状态）；
 *   - memory.js 的写路径据此把成功动作 retain 成 `origin:character-action` 的长期记忆；
 *   - 失败（execute 抛错 → `isError`）命中既有 `tool.failure.dampen` 规则。
 */
import fs from "node:fs";
import path from "node:path";

/** 会产生真实副作用的工具名（供状态机 / 写路径识别）。 */
export const ACTION_TOOLS = new Set(["write_note"]);

/** 本模块注册的工具名。 */
const ACTION_TOOL = "write_note";

/**
 * 从 `tool/result` 事件的 message 里取 `{ toolCallId, isError }`。
 * ⚠️ 以实际会话日志核对：本版本会话格式（V4）的 message 是 first-class tool-role 消息，
 * `toolCallId` / `isError` 在 **message 顶层**（旧 V2 的「user 消息里嵌 tool-result 块」已不是当前格式）。
 */
export function toolResultInfo(message) {
    return { toolCallId: message?.toolCallId, isError: message?.isError };
}

/** 把标题 slug 化成安全文件名（保留 Unicode 字母/数字）。 */
function slugify(title) {
    return (
        title
            .replace(/[^\p{L}\p{N}]+/gu, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "note"
    );
}

/** 把工具结果渲染成模型可见文本。 */
function renderNote(value) {
    switch (value?.outcome) {
        case "unavailable":
            return "没有可用的确认通道，未写便条。";
        case "rejected":
            return "用户拒绝了，未写便条。";
        case "cancelled":
            return "便条写入已取消。";
        case "allowed-once":
            return `已写下便条《${value.title}》→ ${value.path}`;
        default:
            return `便条处理完毕（outcome=${value?.outcome}）。`;
    }
}

/**
 * 安装行动工具（若 config.action.enabled === false 或工具注册表缺失则跳过）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @param {{ logger: any, stateFile: string }} deps
 */
export function installAction(ctx, config, { logger, stateFile }) {
    if (config?.action?.enabled === false) return;
    if (!ctx.tools || typeof ctx.tools.register !== "function") return;

    ctx.effect(
        () =>
            ctx.tools.register({
                name: ACTION_TOOL,
                description:
                    "把一段文字写成一张真实便条（落盘为文件）。执行前会请求用户确认。当用户明确要你“记下来/写下来/记一张便条”时调用。",
                parameters: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        title: { type: "string", description: "便条标题" },
                        body: { type: "string", description: "便条正文" },
                    },
                    required: ["title", "body"],
                },
                output: {
                    schema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            path: { type: "string" },
                            title: { type: "string" },
                            outcome: { type: "string" },
                        },
                        required: ["path", "title", "outcome"],
                    },
                    render: (_args, value) => [{ type: "text", text: renderNote(value) }],
                },
                execute: async (args, exec) => {
                    const title = String(args?.title ?? "").trim();
                    const body = String(args?.body ?? "").trim();
                    if (!title || !body) throw new Error(`${ACTION_TOOL} 需要非空 title 与 body`);

                    const notesDir = path.join(path.dirname(stateFile), "notes");
                    const file = path.join(notesDir, `${slugify(title)}.md`);

                    const approver = ctx.get ? ctx.get("approval") : undefined;
                    if (!approver) return { path: "", title, outcome: "unavailable" };

                    const outcome = await approver.request({
                        agent: exec.agent,
                        toolName: ACTION_TOOL,
                        callId: exec.callId,
                        reason: `写一张便条：${title}`,
                        displayReason: {
                            zh: `写一张便条：${title}`,
                            en: `Write a note titled "${title}".`,
                        },
                        ...(exec.signal ? { signal: exec.signal } : {}),
                    });
                    if (outcome !== "allowed-once") return { path: "", title, outcome };

                    // 副作用：真实落盘（写失败让其抛 → 工具 isError → 失败进状态）。
                    fs.mkdirSync(notesDir, { recursive: true });
                    fs.writeFileSync(file, `# ${title}\n\n${body}\n`, "utf8");

                    // 审计（best-effort；失败不影响已发生的副作用）。
                    try {
                        fs.appendFileSync(
                            path.join(path.dirname(stateFile), "action.jsonl"),
                            `${JSON.stringify({ type: "action", tool: ACTION_TOOL, title, path: file, outcome, at: new Date().toISOString() })}\n`,
                            "utf8",
                        );
                    } catch (err) {
                        logger.error("行动审计写入失败：%s", err.message);
                    }
                    return { path: file, title, outcome: "allowed-once" };
                },
            }),
        "lepimemory.write_note()",
    );
}
