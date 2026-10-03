/**
 * 状态面板（Host 侧）：注册一条本机 HTTP 路由，把当前角色状态投影成 JSON，
 * 供浏览器半的面板组件（client.js）轮询显示。
 *
 * 为什么走自定义路由而不是「projection」：本项目状态是 **host 文件派生**（读 state.json），
 * 浏览器读不到 DSH_HOME 文件；projection 只适合日志派生值。
 *
 * 信任栅栏：自定义路由落在 dsh 的 `/api/*` 栅栏之外，故此处**自行校验**来源是本机
 * （Host / Origin 均为 loopback）；否则 403。绝不因此停工：无 webServer 时仅告警跳过。
 */
import { readStateFile, renderState } from "./state.js";

/** loopback 主机白名单（去掉端口后比较）。 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

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

/**
 * 安装状态面板路由（若 config.panel.enabled === false 或无 webServer 则跳过）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @param {{ logger: any, stateFile: string }} deps
 */
export function installPanel(ctx, config, { logger, stateFile }) {
    if (config?.panel?.enabled === false) return;

    if (typeof ctx.inject !== "function") {
        logger.warn("面板：ctx.inject 不可用，跳过 /lepimemory/state 路由（面板将显示「状态不可用」）");
        return;
    }

    // webServer 在本插件 apply 时通常尚未就绪 → 用 ctx.inject 延迟到服务可用再挂路由。
    ctx.inject(["webServer"], (scope) => {
        const server = scope.webServer;
        if (!server || typeof server.register !== "function") {
            logger.warn("面板：webServer 不可用，跳过 /lepimemory/state 路由（面板将显示「状态不可用」）");
            return;
        }

        scope.effect(
            () =>
                server.register({
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
                }),
            "lepimemory.panel.route()",
        );
        logger.info("面板路由已装载：/lepimemory/state");
    });
}
