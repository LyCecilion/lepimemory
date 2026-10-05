/**
 * Lepimemory 运行时配置（Step 1）。
 *
 * 单一职责：把用户环境（.env / process env / 明确命令行值）解析成一份**显式、可校验**的
 * 运行时配置对象；外加一次性的旧 `.env` 迁移与显式 env 加载器。不启动任何服务、不注册 hook、
 * 不写回用户文件（derived env 只落在进程内存）。
 *
 * 关键约定（对应 PLAN Step 1 / 需求表）：
 *   - `resolveConfig(env=process.env)` 是**纯函数**：只读 env，不碰文件、不产生副作用。
 *   - 加载 `.env` 用 `process.loadEnvFile`（可选文件）；**已有进程环境优先**，不被文件覆盖。
 *   - 未配置 = 共享连接两端均为空；此时不得回落到任何默认官方 URL（fail-closed）。
 *   - 只填 URL 或 key 的一项 → `LEPI_CONNECTION_INCOMPLETE`。
 *   - 每路由 override 必须 URL/key **成组**，不部分继承共享组。
 *   - 旧 bank `lepimemory` 明确拒绝；旧 `.env` 别名在正常解析中不再支持（迁移会改写文件）。
 *   - key 只以 derived env 名出现在内存里，永不写回用户文件、永不进日志（见 redactConfig）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根（PLUGIN/lib → 上溯四级）。用于 DSH_HOME 默认值与默认 .env 路径。 */
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");

/** 默认 .env 路径（可被 LEPI_ENV_FILE 或显式参数覆盖）。 */
export const DEFAULT_ENV_FILE = path.join(REPO_ROOT, ".env");

/** 稳定错误码字面量（与 PLAN 一致，不自造别名）。 */
export const ErrorCodes = Object.freeze({
    /** 共享/路由连接只填了一半（URL 或 key 之一）。 */
    CONNECTION_INCOMPLETE: "LEPI_CONNECTION_INCOMPLETE",
    /** 某字段取值非法（类型/范围/枚举/时区/bank）。 */
    CONFIG_INVALID: "LEPI_CONFIG_INVALID",
});

/** 配置错误：带稳定 code 与出问题的字段名（不含 key 值）。 */
export class ConfigError extends Error {
    constructor(code, field = null, detail = null) {
        super(`${code}${field ? ` [${field}]` : ""}${detail ? `: ${detail}` : ""}`);
        this.name = "ConfigError";
        this.code = code;
        this.field = field;
        this.detail = detail;
    }
}

// ── 默认值（用户在 .env 里可覆盖；此处是唯一权威默认来源）────────────────
export const DEFAULTS = Object.freeze({
    roleModel: "deepseek-flash",
    processModel: "deepseek-flash",
    hindsightModel: "deepseek-flash",
    hindsightUrl: "http://127.0.0.1:8888",
    layaUrl: "http://127.0.0.1:8000",
    bank: "lepimemory-v2",
    admissionBackend: "laya",
    timeZone: "Asia/Shanghai",
    consentTimeoutMs: 600000,
    taskTtlMs: 604800000,
    grantTtlMs: 2592000000,
    inferenceHalfLifeMs: 1209600000,
    contextMaxChars: 12000,
    evidenceMaxCalls: 4,
    processMaxTokens: 4096,
    processTimeoutMs: 30000,
    controlTimeoutMs: 20000,
    acceptDurable: 0.65,
    rejectDurable: 0.2,
    acceptTransient: 0.85,
    rejectTransient: 0.35,
    port: 3080,
    embeddingsLocalModel: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    rerankerLocalModel: "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1",
    hfEndpoint: "https://hf-mirror.com",
});

/** 旧 bank：新 bank 接管，旧库保留但不作为默认写入目标。 */
export const LEGACY_BANK = "lepimemory";

/** 合法准入后端（显式选择，运行时不自动切换）。 */
export const ADMISSION_BACKENDS = Object.freeze(["laya", "generative"]);

/** 每路由的 env 前缀（决定 override 字段名与 derived apiKeyEnv 名）。 */
export const ROUTES = Object.freeze({
    role: "ROLE",
    process: "PROCESS",
    controlFallback: "CONTROL_FALLBACK",
    hindsight: "HINDSIGHT",
});

// ── 读取/校验原语 ────────────────────────────────────────────────────
function readString(env, key) {
    const value = env ? env[key] : undefined;
    return typeof value === "string" ? value.trim() : "";
}

function positiveInt(env, key, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const raw = readString(env, key);
    if (raw === "") return fallback;
    if (!/^[0-9]+$/.test(raw)) {
        throw new ConfigError(ErrorCodes.CONFIG_INVALID, key, "expected a positive integer");
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new ConfigError(ErrorCodes.CONFIG_INVALID, key, "out of range");
    }
    return value;
}

function unitNumber(env, key, fallback) {
    const raw = readString(env, key);
    if (raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw new ConfigError(ErrorCodes.CONFIG_INVALID, key, "expected a finite number");
    }
    if (value < 0 || value > 1) {
        throw new ConfigError(ErrorCodes.CONFIG_INVALID, key, "expected a value in [0, 1]");
    }
    return value;
}

function nonEmptyString(env, key, fallback) {
    const raw = readString(env, key);
    return raw === "" ? fallback : raw;
}

function expandHome(p) {
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
}

function timeZoneField(env, key, fallback) {
    const value = readString(env, key) || fallback;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
    } catch {
        throw new ConfigError(ErrorCodes.CONFIG_INVALID, key, "unknown IANA time zone");
    }
    return value;
}

function bankField(env, key, fallback) {
    const value = readString(env, key) || fallback;
    if (value === LEGACY_BANK) {
        throw new ConfigError(ErrorCodes.CONFIG_INVALID, key, "legacy bank rejected; use a v2 bank");
    }
    return value;
}

function admissionBackendField(env, key, fallback) {
    const value = readString(env, key) || fallback;
    if (!ADMISSION_BACKENDS.includes(value)) {
        throw new ConfigError(ErrorCodes.CONFIG_INVALID, key, `expected one of ${ADMISSION_BACKENDS.join(", ")}`);
    }
    return value;
}

/** 共享连接：两端都空 = unconfigured；只填一半 = CONNECTION_INCOMPLETE。 */
function resolveSharedConnection(env) {
    const baseUrl = readString(env, "LEPI_LLM_BASE_URL");
    const apiKey = readString(env, "LEPI_LLM_API_KEY");
    const hasUrl = baseUrl !== "";
    const hasKey = apiKey !== "";
    if (hasUrl !== hasKey) {
        throw new ConfigError(
            ErrorCodes.CONNECTION_INCOMPLETE,
            hasUrl ? "LEPI_LLM_API_KEY" : "LEPI_LLM_BASE_URL",
            "shared connection needs both base URL and API key",
        );
    }
    return { baseUrl, apiKey, configured: hasUrl && hasKey };
}

/** 单路由连接：未设置 → 继承共享组；设置 → 必须成组，否则 CONNECTION_INCOMPLETE。 */
function resolveRouteConnection(env, envPrefix, shared) {
    const urlKey = `LEPI_${envPrefix}_BASE_URL`;
    const keyKey = `LEPI_${envPrefix}_API_KEY`;
    const baseUrl = readString(env, urlKey);
    const apiKey = readString(env, keyKey);
    const hasUrl = baseUrl !== "";
    const hasKey = apiKey !== "";
    if (!hasUrl && !hasKey) {
        return {
            baseUrl: shared.baseUrl,
            apiKey: shared.apiKey,
            configured: shared.configured,
            source: shared.configured ? "shared" : "unconfigured",
            apiKeyEnv: keyKey,
        };
    }
    if (hasUrl !== hasKey) {
        throw new ConfigError(
            ErrorCodes.CONNECTION_INCOMPLETE,
            hasUrl ? keyKey : urlKey,
            "override must set both base URL and API key",
        );
    }
    return { baseUrl, apiKey, configured: true, source: "override", apiKeyEnv: keyKey };
}

function validateThresholdPair(env, acceptKey, rejectKey, acceptDefault, rejectDefault) {
    const accept = unitNumber(env, acceptKey, acceptDefault);
    const reject = unitNumber(env, rejectKey, rejectDefault);
    if (!(reject < accept)) {
        throw new ConfigError(ErrorCodes.CONFIG_INVALID, acceptKey, `${rejectKey} must be < ${acceptKey}`);
    }
    return { accept, reject };
}

// ── 解析 ─────────────────────────────────────────────────────────────
/**
 * 把 env 解析为运行时配置（纯函数；不读文件、不写回）。
 * @param {Record<string, string|undefined>} [env]
 * @returns {{
 *   configured: boolean,
 *   connection: {baseUrl: string, apiKey: string, configured: boolean},
 *   llm: {role: object, process: object, controlFallback: object, hindsight: object},
 *   services: {hindsight: {url: string}, laya: {url: string, apiKey: string, configured: boolean}},
 *   bank: string, admissionBackend: string, timeZone: string,
 *   timeouts: {consentTimeoutMs: number, taskTtlMs: number, grantTtlMs: number},
 *   inferenceHalfLifeMs: number,
 *   limits: {contextMaxChars: number, evidenceMaxCalls: number, processMaxTokens: number, processTimeoutMs: number, controlTimeoutMs: number},
 *   layaThresholds: {durable: {accept: number, reject: number}, transient: {accept: number, reject: number}},
 *   home: {dshHome: string, port: number},
 *   retrieval: {embeddingsLocalModel: string, rerankerLocalModel: string, hfEndpoint: string},
 * }}
 * @throws {ConfigError}
 */
export function resolveConfig(env = process.env) {
    const connection = resolveSharedConnection(env);

    const roleModel = nonEmptyString(env, "LEPI_ROLE_MODEL", DEFAULTS.roleModel);
    const processModel = nonEmptyString(env, "LEPI_PROCESS_MODEL", DEFAULTS.processModel);
    // control fallback 默认取角色模型，启动时固定；不跟随 UI 临时选择。
    const controlFallbackModel = nonEmptyString(env, "LEPI_CONTROL_FALLBACK_MODEL", roleModel);
    const hindsightModel = nonEmptyString(env, "LEPI_HINDSIGHT_MODEL", DEFAULTS.hindsightModel);

    const roleConn = resolveRouteConnection(env, ROUTES.role, connection);
    const processConn = resolveRouteConnection(env, ROUTES.process, connection);
    const controlConn = resolveRouteConnection(env, ROUTES.controlFallback, connection);
    const hindsightConn = resolveRouteConnection(env, ROUTES.hindsight, connection);

    const llm = {
        role: { envPrefix: ROUTES.role, model: roleModel, ...roleConn },
        process: { envPrefix: ROUTES.process, model: processModel, ...processConn },
        controlFallback: { envPrefix: ROUTES.controlFallback, model: controlFallbackModel, ...controlConn },
        hindsight: { envPrefix: ROUTES.hindsight, model: hindsightModel, ...hindsightConn },
    };

    // Laya 是独立本地服务：不继承云 key；key 为独立服务 token（可空）。
    const layaUrl = nonEmptyString(env, "LEPI_LAYA_URL", DEFAULTS.layaUrl);
    const layaApiKey = readString(env, "LEPI_LAYA_API_KEY");

    const dshHomeRaw = readString(env, "DSH_HOME");
    const dshHome = dshHomeRaw === "" ? path.join(REPO_ROOT, ".dsh") : path.resolve(expandHome(dshHomeRaw));

    const thresholds = {
        durable: validateThresholdPair(env, "LEPI_LAYA_ACCEPT_DURABLE", "LEPI_LAYA_REJECT_DURABLE", DEFAULTS.acceptDurable, DEFAULTS.rejectDurable),
        transient: validateThresholdPair(env, "LEPI_LAYA_ACCEPT_TRANSIENT", "LEPI_LAYA_REJECT_TRANSIENT", DEFAULTS.acceptTransient, DEFAULTS.rejectTransient),
    };

    return {
        // 顶层 unconfigured 语义由角色 LLM 路由决定（checker 据此拒绝放行 stock 模型）。
        configured: llm.role.configured,
        connection,
        llm,
        services: {
            hindsight: { url: nonEmptyString(env, "LEPI_HINDSIGHT_URL", DEFAULTS.hindsightUrl) },
            laya: { url: layaUrl, apiKey: layaApiKey, configured: layaApiKey !== "" },
        },
        bank: bankField(env, "LEPI_BANK", DEFAULTS.bank),
        admissionBackend: admissionBackendField(env, "LEPI_ADMISSION_BACKEND", DEFAULTS.admissionBackend),
        timeZone: timeZoneField(env, "LEPI_TIME_ZONE", DEFAULTS.timeZone),
        timeouts: {
            consentTimeoutMs: positiveInt(env, "LEPI_CONSENT_TIMEOUT_MS", DEFAULTS.consentTimeoutMs),
            taskTtlMs: positiveInt(env, "LEPI_TASK_TTL_MS", DEFAULTS.taskTtlMs),
            grantTtlMs: positiveInt(env, "LEPI_GRANT_TTL_MS", DEFAULTS.grantTtlMs),
        },
        inferenceHalfLifeMs: positiveInt(env, "LEPI_INFERENCE_HALF_LIFE_MS", DEFAULTS.inferenceHalfLifeMs),
        limits: {
            contextMaxChars: positiveInt(env, "LEPI_CONTEXT_MAX_CHARS", DEFAULTS.contextMaxChars),
            evidenceMaxCalls: positiveInt(env, "LEPI_EVIDENCE_MAX_CALLS", DEFAULTS.evidenceMaxCalls),
            processMaxTokens: positiveInt(env, "LEPI_PROCESS_MAX_TOKENS", DEFAULTS.processMaxTokens),
            processTimeoutMs: positiveInt(env, "LEPI_PROCESS_TIMEOUT_MS", DEFAULTS.processTimeoutMs),
            controlTimeoutMs: positiveInt(env, "LEPI_CONTROL_TIMEOUT_MS", DEFAULTS.controlTimeoutMs),
        },
        layaThresholds: thresholds,
        home: {
            dshHome,
            port: positiveInt(env, "PORT", DEFAULTS.port, { min: 1, max: 65535 }),
        },
        // 部署检索栈的样例字段：由 compose/hindsight 消费，用户不重复填内部 LLM key。
        retrieval: {
            embeddingsLocalModel: nonEmptyString(env, "HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL", DEFAULTS.embeddingsLocalModel),
            rerankerLocalModel: nonEmptyString(env, "HINDSIGHT_API_RERANKER_LOCAL_MODEL", DEFAULTS.rerankerLocalModel),
            hfEndpoint: nonEmptyString(env, "HF_ENDPOINT", DEFAULTS.hfEndpoint),
        },
    };
}

/**
 * 内部 derived env：把**已解析**的每路由 key 暴露为稳定 env 名，供 dsh provider 的 apiKeyEnv 引用。
 * 只落进程内存，**绝不写回用户 .env**，也绝不进日志（用 redactConfig 记录配置）。
 */
export function derivedEnv(config) {
    return {
        LEPI_ROLE_API_KEY: config.llm.role.apiKey,
        LEPI_ROLE_BASE_URL: config.llm.role.baseUrl,
        LEPI_PROCESS_API_KEY: config.llm.process.apiKey,
        LEPI_PROCESS_BASE_URL: config.llm.process.baseUrl,
        LEPI_CONTROL_FALLBACK_API_KEY: config.llm.controlFallback.apiKey,
        LEPI_CONTROL_FALLBACK_BASE_URL: config.llm.controlFallback.baseUrl,
        LEPI_HINDSIGHT_API_KEY: config.llm.hindsight.apiKey,
        LEPI_HINDSIGHT_BASE_URL: config.llm.hindsight.baseUrl,
    };
}

/** 把 derived env 写入给定 env 对象（默认 process.env）；不落盘。 */
export function applyDerivedEnv(env, config) {
    Object.assign(env, derivedEnv(config));
    return env;
}

/** 生成不含 key 的配置快照，供日志/审计。永不输出 key 值。 */
export function redactConfig(config) {
    const mask = (v) => (typeof v === "string" && v !== "" ? "***" : "");
    const route = (r) => ({ ...r, apiKey: mask(r.apiKey) });
    return {
        configured: config.configured,
        connection: { ...config.connection, apiKey: mask(config.connection.apiKey) },
        llm: {
            role: route(config.llm.role),
            process: route(config.llm.process),
            controlFallback: route(config.llm.controlFallback),
            hindsight: route(config.llm.hindsight),
        },
        services: {
            hindsight: { url: config.services.hindsight.url },
            laya: { ...config.services.laya, apiKey: mask(config.services.laya.apiKey) },
        },
        bank: config.bank,
        admissionBackend: config.admissionBackend,
        timeZone: config.timeZone,
        timeouts: config.timeouts,
        inferenceHalfLifeMs: config.inferenceHalfLifeMs,
        limits: config.limits,
        layaThresholds: config.layaThresholds,
        home: config.home,
        retrieval: config.retrieval,
    };
}

// ── 旧 .env 一次性迁移 ───────────────────────────────────────────────
/** 旧 key → 新 key（保留值）。 */
const LEGACY_MAP = Object.freeze([
    { from: "GEEK_TECH_CLUB_API_KEY", to: "LEPI_LLM_API_KEY" },
    { from: "HINDSIGHT_API_LLM_BASE_URL", to: "LEPI_HINDSIGHT_BASE_URL" },
    { from: "HINDSIGHT_API_LLM_API_KEY", to: "LEPI_HINDSIGHT_API_KEY" },
    { from: "HINDSIGHT_API_LLM_MODEL", to: "LEPI_HINDSIGHT_MODEL" },
]);
/** 旧 key → 删除（新 schema 无对应字段）。 */
const LEGACY_DROP = Object.freeze(["HINDSIGHT_API_LLM_PROVIDER"]);
const LEGACY_KEYS = new Set([...LEGACY_MAP.map((m) => m.from), ...LEGACY_DROP]);

const KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function lineKeys(text) {
    const keys = new Set();
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(KEY_RE);
        if (m) keys.add(m[1]);
    }
    return keys;
}

/**
 * 一次性迁移旧 `.env`：
 *   - 先以 0600 保存 `.env.legacy-<timestamp>` 备份；
 *   - `GEEK_TECH_CLUB_API_KEY` → `LEPI_LLM_API_KEY`（保留既有 `LEPI_LLM_BASE_URL`）；
 *   - 旧 `HINDSIGHT_API_LLM_{BASE_URL,API_KEY,MODEL}` → `LEPI_HINDSIGHT_*` override，`_PROVIDER` 删除；
 *   - 检索样例 env（embeddings/reranker/HF_ENDPOINT）原样保留；
 *   - endpoint 缺失只报告**字段名**（不猜地址、不输出值）；
 *   - 迁移后旧 key 名不再存在（正常解析也不支持旧别名）。
 * 幂等：无旧 key 时不改动、不备份。
 * @param {{envFile?: string, now?: number}} [options]
 * @returns {{migrated: boolean, backupPath: string|null, missingFields: string[]}}
 */
export function migrateLegacyEnv({ envFile = null, now = Date.now() } = {}) {
    const file = envFile || DEFAULT_ENV_FILE;
    const result = { migrated: false, backupPath: null, missingFields: [] };
    if (!fs.existsSync(file)) return result;

    const text = fs.readFileSync(file, "utf8");
    const present = lineKeys(text);
    if (![...LEGACY_KEYS].some((k) => present.has(k))) return result;

    const taken = new Set([...present].filter((k) => !LEGACY_KEYS.has(k)));
    const outLines = [];
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(KEY_RE);
        if (!m) {
            outLines.push(line);
            continue;
        }
        const key = m[1];
        if (LEGACY_DROP.includes(key)) continue;
        const map = LEGACY_MAP.find((x) => x.from === key);
        if (!map) {
            outLines.push(line);
            continue;
        }
        if (taken.has(map.to)) continue; // 目标名已存在 → 不制造重复
        const idx = line.indexOf(key);
        outLines.push(line.slice(0, idx) + map.to + line.slice(idx + key.length));
        taken.add(map.to);
    }
    const newText = outLines.join("\n");

    // 备份（0600，唯一路径，不覆盖既有备份）。
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    let backupPath = `${file}.legacy-${stamp}`;
    let n = 1;
    while (fs.existsSync(backupPath)) backupPath = `${file}.legacy-${stamp}-${n++}`;
    fs.writeFileSync(backupPath, text, { mode: 0o600, flag: "wx" });
    result.backupPath = backupPath;

    fs.writeFileSync(file, newText);
    result.migrated = true;

    const finalKeys = lineKeys(newText);
    if (finalKeys.has("LEPI_LLM_API_KEY") && !finalKeys.has("LEPI_LLM_BASE_URL")) {
        result.missingFields.push("LEPI_LLM_BASE_URL");
    }
    if (finalKeys.has("LEPI_HINDSIGHT_API_KEY") && !finalKeys.has("LEPI_HINDSIGHT_BASE_URL")) {
        result.missingFields.push("LEPI_HINDSIGHT_BASE_URL");
    }
    return result;
}

// ── 显式 env 加载器 ──────────────────────────────────────────────────
/**
 * 加载可选 `.env`：先迁移旧文件，再用 `process.loadEnvFile` 载入；
 * **已有进程环境优先**（载入后回填快照，不被文件覆盖）。
 * @param {{envFile?: string, env?: Record<string,string|undefined>, migrate?: boolean, now?: number}} [options]
 * @returns {{file: string, loaded: boolean, migrated: boolean, backupPath: string|null, missingFields: string[]}}
 */
export function loadEnvFile({ envFile = null, env = process.env, migrate = true, now = Date.now() } = {}) {
    const file = envFile || readString(env, "LEPI_ENV_FILE") || DEFAULT_ENV_FILE;
    const result = { file, loaded: false, migrated: false, backupPath: null, missingFields: [] };

    if (migrate) {
        const m = migrateLegacyEnv({ envFile: file, now });
        result.migrated = m.migrated;
        result.backupPath = m.backupPath;
        result.missingFields = m.missingFields;
    }
    if (!fs.existsSync(file)) return result;

    const preserved = new Map();
    for (const key of Object.keys(process.env)) preserved.set(key, process.env[key]);
    process.loadEnvFile(file);
    for (const [key, value] of preserved) process.env[key] = value; // 已有环境优先

    if (env !== process.env) {
        for (const [key, value] of Object.entries(process.env)) {
            if (!(key in env)) env[key] = value;
        }
    }
    result.loaded = true;
    return result;
}
