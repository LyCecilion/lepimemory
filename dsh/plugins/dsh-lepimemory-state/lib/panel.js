/**
 * 状态面板（Host 侧）：注册本机 HTTP 路由，把角色状态与**历史账本**投影成 JSON，
 * 供浏览器半的面板组件（client.js）显示。
 *
 * 为什么走自定义路由而不是「projection」：本项目状态是 **host 文件派生**（读 state.json / *.jsonl），
 * 浏览器读不到 DSH_HOME 文件；projection 只适合日志派生值。
 *
 * 路由：
 *   - `GET /lepimemory/state`                              当前状态（renderState + 数值）
 *   - `GET /lepimemory/history?kind=&limit=&offset=`       历史账本分页（最新在前）
 *
 * 信任栅栏：自定义路由落在 dsh 的 `/api/*` 栅栏之外，故此处**自行校验**来源是本机
 * （Host / Origin 均为 loopback）；否则 403。绝不因此停工：无 webServer 时仅告警跳过。
 */
import fs from "node:fs";
import path from "node:path";
import { readStateFile, renderState } from "./state.js";

/** loopback 主机白名单（去掉端口后比较）。 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** 可查询的历史账本白名单：kind → 文件名（白名单即防路径穿越）。 */
const HISTORY_KINDS = {
    audit: "audit.jsonl",
    recall: "recall.jsonl",
    retain: "retain.jsonl",
    forget: "forget.jsonl",
    action: "action.jsonl",
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/** 只接受来自本机的请求（Host 头 + 可选 Origin 头）。 */
function isLocalRequest(req) {
    const host = String(req.headers?.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (!LOOPBACK_HOSTS.has(host)) return false;
    const origin = req.headers?.origin;
    if (!origin) return true; // 同源导航/本地工具可不带 Origin
    try {
        return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
    } catch {
        return false;
    }
}

/** 发一个 JSON 响应。 */
function sendJson(res, status, body) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
}

/** 为一条历史记录生成一行给人看的摘要（模型/前端都不必懂内部字段）。 */
function summarize(kind, e) {
    switch (kind) {
        case "audit": {
            const chg = Object.entries(e.changes ?? {})
                .map(([k, v]) => `${k} ${v?.[0]}→${v?.[1]}`)
                .join("；");
            return `命中 ${(e.rules ?? []).join(", ") || "—"}${chg ? ` · ${chg}` : ""}`;
        }
        case "recall":
            return `「${e.query ?? ""}」候选 ${e.candidates ?? 0} · 入选 ${(e.picked ?? []).length}${e.degraded ? `（降级：${e.error ?? ""}）` : ""}`;
        case "retain":
            return e.skipped
                ? `跳过（${e.reason ?? ""}）`
                : `写入「${String(e.content ?? "").slice(0, 40)}」${e.origin ? ` [${e.origin}]` : ""}`;
        case "forget":
            return `${e.type === "restore" ? "恢复" : "遗忘"}「${e.target ?? ""}」 ${e.executed ?? e.restored ?? 0}/${e.planned ?? 0}`;
        case "action":
            return `写便条《${e.title ?? ""}》→ ${e.path ?? ""}`;
        default:
            return "";
    }
}

/** 读取一个历史账本的分页（最新在前；坏行跳过）。 */
function readHistory(file, kind, limit, offset) {
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    } catch {
        return { entries: [], total: 0 };
    }
    const rows = [];
    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            rows.push(JSON.parse(t));
        } catch {
            /* 坏行跳过，不因一行脏数据让整页失败 */
        }
    }
    rows.reverse(); // 最新在前
    const entries = rows.slice(offset, offset + limit).map((e) => ({
        at: e.at ?? "",
        summary: summarize(kind, e),
        raw: e,
    }));
    return { entries, total: rows.length };
}

/**
 * 安装面板路由（若 config.panel.enabled === false 或无 webServer 则跳过）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @param {{ logger: any, stateFile: string }} deps
 */
export function installPanel(ctx, config, { logger, stateFile }) {
    if (config?.panel?.enabled === false) return;

    if (typeof ctx.inject !== "function") {
        logger.warn("面板：ctx.inject 不可用，跳过 /lepimemory/* 路由（面板将显示「状态不可用」）");
        return;
    }

    const dir = path.dirname(stateFile);

    // webServer 在本插件 apply 时通常尚未就绪 → 用 ctx.inject 延迟到服务可用再挂路由。
    ctx.inject(["webServer"], (scope) => {
        const server = scope.webServer;
        if (!server || typeof server.register !== "function") {
            logger.warn("面板：webServer 不可用，跳过 /lepimemory/* 路由（面板将显示「状态不可用」）");
            return;
        }

        const stateRoute = {
            kind: "exact",
            path: "/lepimemory/state",
            handler: (req, res) => {
                if (!isLocalRequest(req)) {
                    sendJson(res, 403, { ok: false, error: "forbidden" });
                    return;
                }
                const read = readStateFile(stateFile);
                if (!read.ok) {
                    sendJson(res, 200, { ok: false, error: read.error });
                    return;
                }
                sendJson(res, 200, {
                    ok: true,
                    rendered: renderState(read.state),
                    mood: read.state.mood,
                    relation: read.state.relation,
                    updatedAt: read.state.mood.updatedAt,
                });
            },
        };

        const historyRoute = {
            kind: "exact",
            path: "/lepimemory/history",
            handler: (req, res) => {
                if (!isLocalRequest(req)) {
                    sendJson(res, 403, { ok: false, error: "forbidden" });
                    return;
                }
                const url = new URL(req.url ?? "/", "http://localhost");
                const kind = url.searchParams.get("kind") ?? "audit";
                const file = HISTORY_KINDS[kind];
                if (file === undefined) {
                    sendJson(res, 400, { ok: false, error: `unknown kind: ${kind}` });
                    return;
                }
                const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));
                const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
                const { entries, total } = readHistory(path.join(dir, file), kind, limit, offset);
                sendJson(res, 200, { ok: true, kind, total, offset, limit, entries });
            },
        };

        scope.effect(() => {
            const disposeState = server.register(stateRoute);
            const disposeHistory = server.register(historyRoute);
            return () => {
                disposeState();
                disposeHistory();
            };
        }, "lepimemory.panel.routes()");

        logger.info("面板路由已装载：/lepimemory/state、/lepimemory/history");
    });
}
