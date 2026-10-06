/**
 * 行动工具：能产生**真实副作用**的工具（注册到 `ctx.tools`），执行前经 `ctx.approval` 确认。
 *
 * 目前只有 `write_note`：把一段文字写成一张真实便条（落盘为 `<dataRoot>/notes/<action_id>.md`）。
 * 副作用落在**插件自有目录**，不越权写用户项目。
 *
 * 事实来源（本文件的核心约定）：
 *   - 每次调用分配一个 `action_id`，并先在 SQLite `actions` 表登记 `prepared`（事务外才做 I/O）。
 *   - 落盘先写同目录独占临时文件（`openSync('wx')`，记录 dev/ino）、fsync，再用 `link(final)`
 *     原子只创建；碰撞（EEXIST）**绝不覆盖、绝不宣称成功**。
 *   - 只有把落盘后的最终文件 hash 与登记值核对通过，才在**同一事务**里把该行改成 `executed` 并写完整 audit。
 *   - 审批 rejected/cancelled/unavailable 记录**真实 outcome**（executed=false），不造成功经历。
 *   - 任何文件写/hash/审计失败都抛稳定 `LEPI_NOTE_*` 错误码；工具**正常输出**的 outcome 只有
 *     `allowed-once`/`rejected`/`cancelled`/`unavailable` 四种，真正的 unknown 通过 journal + 抛错呈现。
 *   - 崩溃后遗留的 `prepared` 行由 `recoverActions({store,dataRoot})` 显式对账：最终文件 hash 匹配则
 *     “recovered executed”，否则 `unknown`；**绝不重写、绝不删除无所有权证明的临时文件**。
 *   - `toolResultInfo(message, meta)` 只依据 journal/meta 事实判定成功，不拿 `isError === false` 当成功。
 *
 * 真实身份：`installAction` 订阅原生 `session/event` 的 `tool/call`（含 `turn`/`step`/`callId`/`name`），
 * 在执行前记下本工具的精确 `(sessionId, callId) → {turn, step}`；`turn/end` 清理该会话索引。
 * 执行时按精确 `(sessionId, callId)` 取真实 turn/step（必须为正整数），否则抛 `LEPI_ACTION_IDENTITY`，
 * 绝不猜旧 step。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

/** 会产生真实副作用的工具名（供状态机 / 写路径识别）。 */
export const ACTION_TOOLS = new Set(["write_note"]);

/** 本模块注册的工具名。 */
const ACTION_TOOL = "write_note";

/** 持久 presentationMeta 的 kind。 */
const META_KIND = "lepimemory-action";

/** 工具**正常输出**允许的 outcome（其余真相一律通过 journal + 抛稳定码呈现）。 */
export const ACTION_OUTCOMES = new Set(["allowed-once", "rejected", "cancelled", "unavailable"]);

/** 稳定错误码。 */
export const ACTION_ERRORS = {
    empty: "LEPI_NOTE_EMPTY",
    invalid: "LEPI_NOTE_INVALID",
    identity: "LEPI_ACTION_IDENTITY",
    writeFailed: "LEPI_NOTE_WRITE_FAILED",
    collision: "LEPI_NOTE_COLLISION",
    unknown: "LEPI_NOTE_UNKNOWN",
    approvalUnavailable: "LEPI_APPROVAL_UNAVAILABLE",
};

/** `write_note` 参数 schema（dsh-tools 受限子集）。仅用于本地复核，不做任何 `String(...)` 修补。 */
const NOTE_ARGS_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        title: { type: "string" },
        body: { type: "string" },
    },
    required: ["title", "body"],
};

/** 工具输出 schema：`{action_id,path,title,outcome,executed}`。 */
const NOTE_OUTPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        action_id: { type: "string" },
        path: { type: "string" },
        title: { type: "string" },
        outcome: { type: "string" },
        executed: { type: "boolean" },
    },
    required: ["action_id", "path", "title", "outcome", "executed"],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ActionError extends Error {
    constructor(code) {
        super(code);
        this.name = "ActionError";
        this.code = code;
    }
}

/**
 * 从 `tool/result` 事件的 message/meta 里取执行事实。
 * @param {{toolCallId?: string, isError?: boolean}} message - V4 first-class tool-role 消息（`toolCallId`/`isError` 在顶层）。
 * @param {unknown} meta - `tool/result` 事件 `data.meta`，即工具 `output.presentationMeta` 的持久投影。
 * @returns {{callId: string|null, isError: boolean, metadata: object|null}} 仅返回已校验形状的 metadata。
 */
export function toolResultInfo(message, meta) {
    const callId = message?.toolCallId ?? message?.callId ?? null;
    const isError = message?.isError === true;
    return { callId, isError, metadata: normalizeMeta(meta) };
}

/** 校验并归一化持久 meta；形状不合法一律返回 null（不因可疑 payload 破坏调用方）。 */
function normalizeMeta(meta) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
    if (meta.kind !== META_KIND) return null;
    if (typeof meta.action_id !== "string" || !meta.action_id) return null;
    if (!ACTION_OUTCOMES.has(meta.outcome)) return null;
    if (typeof meta.executed !== "boolean") return null;
    if (typeof meta.path !== "string") return null;
    return {
        kind: META_KIND,
        action_id: meta.action_id,
        outcome: meta.outcome,
        executed: meta.executed,
        path: meta.path,
    };
}

/** 把工具结果渲染成模型可见文本。只有 journal 确认 executed 才宣称已写下。 */
function renderNote(value) {
    if (value?.executed === true && typeof value.path === "string" && value.path) {
        return `已写下便条《${value.title}》→ ${value.path}`;
    }
    switch (value?.outcome) {
        case "rejected":
            return "用户拒绝了，未写便条。";
        case "cancelled":
            return "便条写入已取消。";
        case "unavailable":
            return "没有可用的确认通道，未写便条。";
        default:
            return `便条未写入（outcome=${value?.outcome ?? "unknown"}，executed=false）。`;
    }
}

/** 从 agent 取真实 session id。 */
function sessionIdOf(agent) {
    const id = agent?.session?.id ?? agent?.id;
    return id == null ? null : String(id);
}

/** 便条落盘正文（确定性；hash 基于它的 UTF-8 字节）。 */
function noteContent(title, body) {
    return `# ${title}\n\n${body}\n`;
}

function sha256hex(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}

function hashFile(file) {
    return sha256hex(fs.readFileSync(file));
}

/** 便条最终路径必须是我们自己推导的确切路径，否则不读、不写、不删。 */
function exactNotePath(dataRoot, actionId) {
    if (typeof dataRoot !== "string" || !dataRoot) return null;
    if (typeof actionId !== "string" || !UUID_RE.test(actionId)) return null;
    return path.join(dataRoot, "notes", `${actionId}.md`);
}

/** 只删除确实由本调用创建、且未被替换的临时文件（dev/ino 双重校验）。 */
function removeOwnTemp(temp, identity) {
    if (!identity || typeof temp !== "string" || !temp) return;
    try {
        const st = fs.statSync(temp, { bigint: true });
        if (st.dev !== identity.dev || st.ino !== identity.ino) return;
        fs.unlinkSync(temp);
    } catch {
        /* Already gone or replaced; never delete a foreign file. */
    }
}

function findAction(store, sessionId, callId) {
    return store.db
        .prepare("SELECT * FROM actions WHERE session_id=? AND call_id=?")
        .get(sessionId, callId);
}

function value(action_id, p, title, outcome, executed) {
    return { action_id, path: p, title, outcome, executed };
}

/** 事务：登记 prepared 行 + audit（I/O 之前，以便崩溃可对账）。 */
function insertPrepared(store, row) {
    store.transaction(() => {
        store.db
            .prepare(
                `INSERT INTO actions
                 (action_id,session_id,turn,step,call_id,title,path,temp_path,body_hash,status,error_code,state_applied)
                 VALUES (?,?,?,?,?,?,?,?,?,'prepared',NULL,0)`,
            )
            .run(
                row.action_id,
                row.session_id,
                row.turn,
                row.step,
                row.call_id,
                row.title,
                row.path,
                row.temp_path,
                row.body_hash,
            );
        store.audit({
            type: "action",
            status: "prepared",
            session_id: row.session_id,
            turn: row.turn,
            step: row.step,
            call_id: row.call_id,
            data: { action_id: row.action_id, outcome: "allowed-once", executed: false, hash: row.body_hash },
        });
    });
}

/** 事务：记录未执行的真实 outcome（rejected/cancelled/unavailable），executed=false。 */
function recordTerminal(store, row, outcome, errorCode) {
    store.transaction(() => {
        store.db
            .prepare(
                `INSERT INTO actions
                 (action_id,session_id,turn,step,call_id,title,path,temp_path,body_hash,status,error_code,state_applied)
                 VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,?,0)`,
            )
            .run(row.action_id, row.session_id, row.turn, row.step, row.call_id, row.title, outcome, errorCode ?? null);
        store.audit({
            type: "action",
            status: outcome,
            session_id: row.session_id,
            turn: row.turn,
            step: row.step,
            call_id: row.call_id,
            data: { action_id: row.action_id, outcome, executed: false, error_code: errorCode ?? null },
        });
    });
}

/** 事务：最终文件 hash 已核对 → executed + 完整 audit。 */
function markExecuted(store, row, recovered) {
    store.transaction(() => {
        store.db
            .prepare("UPDATE actions SET status='executed', path=?, temp_path=NULL, error_code=NULL WHERE action_id=?")
            .run(row.path, row.action_id);
        store.audit({
            type: "action",
            status: "executed",
            session_id: row.session_id,
            turn: row.turn,
            step: row.step,
            call_id: row.call_id,
            data: {
                action_id: row.action_id,
                outcome: "allowed-once",
                executed: true,
                hash: row.body_hash,
                recovered: recovered === true,
            },
        });
    });
}

/** 事务：无法证明成功（碰撞/失配/对账失败）→ unknown；绝不重写。 */
function markUnknown(store, row, errorCode) {
    store.transaction(() => {
        store.db.prepare("UPDATE actions SET status='unknown', error_code=? WHERE action_id=?").run(errorCode, row.action_id);
        store.audit({
            type: "action",
            status: "unknown",
            session_id: row.session_id,
            turn: row.turn,
            step: row.step,
            call_id: row.call_id,
            data: { action_id: row.action_id, outcome: "unknown", executed: false, error_code: errorCode },
        });
    });
}

/** 事务：确证未落盘（I/O 前失败）→ failed。 */
function markFailed(store, row, errorCode) {
    store.transaction(() => {
        store.db.prepare("UPDATE actions SET status='failed', error_code=? WHERE action_id=?").run(errorCode, row.action_id);
        store.audit({
            type: "action",
            status: "failed",
            session_id: row.session_id,
            turn: row.turn,
            step: row.step,
            call_id: row.call_id,
            data: { action_id: row.action_id, outcome: "failed", executed: false, error_code: errorCode },
        });
    });
}

/**
 * 对账一条 `prepared` 行：仅当精确路径可推导、最终文件 hash 匹配才 recovered executed，否则 unknown。
 * 不读/删任何非精确推导出的路径，不清理临时文件（无持久所有权证明）。
 * @returns {'executed'|'unknown'} 对账后的 status。
 */
function finalizePrepared(store, row, dataRoot) {
    const expected = exactNotePath(dataRoot, row.action_id);
    let matches = false;
    if (expected && row.path === expected && typeof row.body_hash === "string" && row.body_hash.length === 64) {
        try {
            matches = hashFile(expected) === row.body_hash;
        } catch {
            matches = false;
        }
    }
    if (matches) {
        markExecuted(store, row, true);
        return "executed";
    }
    markUnknown(store, row, "LEPI_NOTE_UNKNOWN");
    return "unknown";
}

/**
 * 显式初始化对账：扫描遗留 `prepared` 行动，核对最终文件，绝不重写一次。
 * @param {{store: object, dataRoot: string}} deps
 * @returns {{scanned:number, recovered:string[], unknown:string[]}}
 */
export function recoverActions({ store, dataRoot }) {
    if (!store || typeof store.db?.prepare !== "function") return { scanned: 0, recovered: [], unknown: [] };
    const rows = store.db.prepare("SELECT * FROM actions WHERE status='prepared'").all();
    const recovered = [];
    const unknown = [];
    for (const row of rows) {
        const status = finalizePrepared(store, row, dataRoot);
        if (status === "executed") recovered.push(row.action_id);
        else unknown.push(row.action_id);
    }
    return { scanned: rows.length, recovered, unknown };
}

/** 把已有 journal 行投影成工具输出。终态 executed 成功；unknown/failed 抛稳定码（绝不假成功）。 */
function existingValue(store, row, dataRoot, fallbackTitle) {
    let status = row.status;
    if (status === "prepared") status = finalizePrepared(store, row, dataRoot);
    if (status === "executed") return value(row.action_id, row.path, row.title ?? fallbackTitle, "allowed-once", true);
    if (status === "rejected" || status === "cancelled" || status === "unavailable") {
        return value(row.action_id, "", row.title ?? fallbackTitle, status, false);
    }
    throw new ActionError(row.error_code === "LEPI_NOTE_COLLISION" ? "LEPI_NOTE_COLLISION" : "LEPI_NOTE_UNKNOWN");
}

function isUniqueViolation(error) {
    return /UNIQUE/i.test(String(error?.message ?? ""));
}

/**
 * 安装行动工具（若 config.action.enabled === false、工具注册表缺失或缺少 store/dataRoot 则跳过）。
 * 显式初始化时先对账遗留 prepared 行动，并订阅原生 `session/event` 记录本工具调用的真实 turn/step。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @param {{ logger: any, store: object, dataRoot: string, evidence?: any }} deps
 */
export function installAction(ctx, config, { logger, store, dataRoot }) {
    if (config?.action?.enabled === false) return;
    if (!ctx.tools || typeof ctx.tools.register !== "function") return;
    if (!store || typeof store.transaction !== "function" || typeof dataRoot !== "string" || !dataRoot) return;

    try {
        recoverActions({ store, dataRoot });
    } catch {
        logger?.error?.("lepimemory-action: 遗留行动对账失败");
    }

    /** sessionId -> Map(callId -> {turn, step})：本工具真实调用的 turn/step。 */
    const callIndex = new Map();
    if (typeof ctx.on === "function") {
        ctx.on("session/event", (session, event) => {
            try {
                const sid = session?.id == null ? null : String(session.id);
                if (!sid || !event?.type) return;
                if (event.type === "tool/call" && event.data?.name === ACTION_TOOL) {
                    let byCall = callIndex.get(sid);
                    if (!byCall) {
                        byCall = new Map();
                        callIndex.set(sid, byCall);
                    }
                    byCall.set(String(event.data.callId), { turn: event.data.turn, step: event.data.step });
                } else if (event.type === "turn/end") {
                    callIndex.delete(sid);
                }
            } catch {
                /* never let bookkeeping break the event feed */
            }
        });
    }

    ctx.effect(
        () =>
            ctx.tools.register({
                name: ACTION_TOOL,
                description:
                    "把一段文字写成一张真实便条（落盘为文件）。执行前会请求用户确认。当用户明确要你“记下来/写下来/记一张便条”时调用。",
                parameters: NOTE_ARGS_SCHEMA,
                output: {
                    schema: NOTE_OUTPUT_SCHEMA,
                    render: (_args, val) => [{ type: "text", text: renderNote(val) }],
                    presentationMeta: (_args, val) => ({
                        kind: META_KIND,
                        action_id: val.action_id,
                        outcome: val.outcome,
                        executed: val.executed,
                        path: val.path,
                    }),
                },
                execute: async (args, exec) => {
                    const violations = validateJsonSchemaValue(NOTE_ARGS_SCHEMA, args, "args");
                    if (violations.length) throw new ActionError("LEPI_NOTE_INVALID");
                    const title = args.title.trim();
                    const body = args.body.trim();
                    if (!title || !body) throw new ActionError("LEPI_NOTE_EMPTY");

                    const sessionId = sessionIdOf(exec.agent);
                    const callId = exec.callId == null ? null : String(exec.callId);
                    if (!sessionId || !callId) throw new ActionError("LEPI_ACTION_IDENTITY");

                    const observed = callIndex.get(sessionId)?.get(callId);
                    const turn = observed?.turn;
                    const step = observed?.step;
                    if (!Number.isSafeInteger(turn) || turn <= 0 || !Number.isSafeInteger(step) || step <= 0) {
                        throw new ActionError("LEPI_ACTION_IDENTITY");
                    }
                    const identity = { session_id: sessionId, turn, step, call_id: callId, title };

                    const existing = findAction(store, sessionId, callId);
                    if (existing) return existingValue(store, existing, dataRoot, title);

                    const actionId = randomUUID();
                    const final = exactNotePath(dataRoot, actionId);
                    const content = noteContent(title, body);
                    const hash = sha256hex(Buffer.from(content, "utf8"));

                    if (exec.signal?.aborted) {
                        recordTerminal(store, { ...identity, action_id: actionId }, "cancelled", null);
                        return value(actionId, "", title, "cancelled", false);
                    }

                    const approver = ctx.get ? ctx.get("approval") : undefined;
                    let outcome = "unavailable";
                    let errorCode = null;
                    if (approver && typeof approver.request === "function") {
                        try {
                            outcome = await approver.request({
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
                        } catch {
                            outcome = "unavailable";
                            errorCode = ACTION_ERRORS.approvalUnavailable;
                        }
                    } else {
                        errorCode = ACTION_ERRORS.approvalUnavailable;
                    }

                    if (outcome === "rejected" || outcome === "cancelled" || outcome === "unavailable") {
                        recordTerminal(store, { ...identity, action_id: actionId }, outcome, errorCode);
                        return value(actionId, "", title, outcome, false);
                    }
                    if (outcome !== "allowed-once") {
                        recordTerminal(store, { ...identity, action_id: actionId }, "unavailable", ACTION_ERRORS.approvalUnavailable);
                        return value(actionId, "", title, "unavailable", false);
                    }
                    if (exec.signal?.aborted) {
                        recordTerminal(store, { ...identity, action_id: actionId }, "cancelled", null);
                        return value(actionId, "", title, "cancelled", false);
                    }

                    const temp = path.join(path.dirname(final), `.${actionId}.${randomUUID()}.tmp`);
                    const prepared = { ...identity, action_id: actionId, path: final, temp_path: temp, body_hash: hash };
                    try {
                        insertPrepared(store, prepared);
                    } catch (error) {
                        if (isUniqueViolation(error)) {
                            const row = findAction(store, sessionId, callId);
                            if (row) return existingValue(store, row, dataRoot, title);
                        }
                        throw new ActionError("LEPI_NOTE_WRITE_FAILED");
                    }

                    let tempIdentity = null;
                    try {
                        fs.mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 });
                        const fd = fs.openSync(temp, "wx", 0o600);
                        const st = fs.fstatSync(fd, { bigint: true });
                        tempIdentity = { dev: st.dev, ino: st.ino };
                        try {
                            fs.writeSync(fd, content);
                            fs.fsyncSync(fd);
                        } finally {
                            fs.closeSync(fd);
                        }
                        fs.linkSync(temp, final);
                    } catch (error) {
                        removeOwnTemp(temp, tempIdentity);
                        if (error?.code === "EEXIST") {
                            markUnknown(store, prepared, "LEPI_NOTE_COLLISION");
                            throw new ActionError("LEPI_NOTE_COLLISION");
                        }
                        markFailed(store, prepared, "LEPI_NOTE_WRITE_FAILED");
                        throw new ActionError("LEPI_NOTE_WRITE_FAILED");
                    }
                    removeOwnTemp(temp, tempIdentity);

                    let verified = false;
                    try {
                        verified = hashFile(final) === hash;
                    } catch {
                        verified = false;
                    }
                    if (!verified) {
                        markUnknown(store, prepared, "LEPI_NOTE_UNKNOWN");
                        throw new ActionError("LEPI_NOTE_UNKNOWN");
                    }

                    try {
                        markExecuted(store, prepared, false);
                    } catch {
                        // A real file exists but the execution audit did not commit: keep
                        // `prepared` for recovery and report unknown, never a false failure.
                        logger?.error?.("lepimemory-action: 行动执行审计未提交");
                        throw new ActionError("LEPI_NOTE_UNKNOWN");
                    }
                    return value(actionId, final, title, "allowed-once", true);
                },
            }),
        "lepimemory.write_note()",
    );
}
