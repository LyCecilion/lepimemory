/**
 * Lepimemory Step 4 契约模块（PLUGIN/src/contracts.ts）。
 *
 * 单一职责：把「模型/后台 submit_result 的结构」与「来源引用」变成一份**显式、可校验、
 * 封闭**的契约。提供：
 *   - `SCHEMAS`：control/extract/grant/observation/history/admission 的 wire schema（dsh-tools
 *     受限子集：单一 type、oneOf、properties/required/additionalProperties、items、enum，
 *     可空字段用 `oneOf:[null, …]`）。字符/条数/范围/来源等语义限制在 schema 通过后用纯 JS 检查。
 *   - `TOOL_SCHEMAS` + `validateToolArgs`：`fetch_context`/`fetch_memory` 的严格参数 schema；
 *     不做任何 `String(...)` 修补，多传/漏传/类型不符即拒绝。
 *   - `validateResult(kind,value,{sources,candidateIds,historyNodes})`：先 schema 后语义/来源校验，
 *     返回已校验值或抛 `ContractError{code,issue,path}`。control 结果按同 kind 合并（并集 ID，不复制正文）。
 *     唯一对外 `code` 是已批准的 `LEPI_CONTROL_UNAVAILABLE`；细分只放不持久化的安全 `.issue`。
 *   - 封闭 reason 字典（grant/observation/admission）与错误码，绝不把模型自由文本当 reason 持久化。
 *
 * 类型约定：wire 值的静态形状直接复用 `./shared/domain.ts` 的封闭 union（单一事实来源），
 * 这里只补上「校验后成立」的结构；schema/校验失败仍是纯运行期检查，类型断言绝不代替它。
 *
 * 安全约定：
 *   - 诊断只含**唯一已批准 code + 安全 issue + 安全字段路径**（schema 声明名/数字下标），绝不回显非法取值，
 *     也不回显 `additionalProperties:false` 命中的未知（可能是私密）属性名——安全路径由
 *     「合法前缀行走」得到，遇未知键即截断。
 *   - 来源一律取自调用方提供的真实 map（id→{id,actor,kind,at,text}）；未知 id 报 `LEPI_SOURCE_UNKNOWN`。
 *   - 不信任模型自造的 UUID/时钟：`CandidateDraft` 的 `candidate_id/request_id/formed_at/explicit`
 *     由父级处理器绑定，不在本模块 schema 里；本模块既不生成也不读取它们。
 *   - 校验失败一律抛错（无成功回退）；grant/observation 的「无法判定」由父级在捕获 `ContractError`
 *     后自行映射为 uncertain / safe=false。
 *
 * 语义来源规则（对应 PLAN Step 4/8）：
 *   - origin=user：每个来源 actor 必须为 `user`。
 *   - origin=action：至少一个来源 actor=`action` 且 kind=`verified_action`；其余只能是 user/action。
 *   - origin=inference：每个来源 actor 必须为 `assistant`（只认公共 assistant 文本，不收 reasoning）。
 *   - occurrence=verified：仅当 origin=action。
 *   - control 请求/context_guard 的 source_ids 非空且至少一个 `user` 来源；候选 source_ids 非空。
 */
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools';
import type {
  AdmissionReasonCode,
  AdmissionVerdict,
  CandidateDraft,
  ContentKind,
  ControlKind,
  GrantMatch,
  GrantScope,
  HistoryDecision,
  ObservationReasonCode,
  Occurrence,
  Origin,
  RecallPurpose,
  ScopeKind,
  Sensitivity,
  SourceActor,
} from './shared/domain.js';

// ── 封闭枚举与常量（与 PLAN 字面量一致，不自造别名）──────────────────────
/**
 * 不可变封闭字面量表。元素类型取共享 domain union（唯一事实来源），同时让 `includes`
 * 接受未受信任的 `string`，使边界代码能先做成员判定再收窄，无需在调用点强转。
 */
export type ContractEnumList<T extends string> = ReadonlyArray<T> & {
  includes(searchElement: string): boolean;
};

function closedList<T extends string>(values: readonly T[]): ContractEnumList<T> {
  return Object.freeze(values) as ContractEnumList<T>;
}

export const CONTROL_KINDS: ContractEnumList<ControlKind> = closedList<ControlKind>([
  'remember',
  'correct',
  'forget',
  'restore',
  're_remember',
  'grant',
  'revoke',
]);
export const RECALL_PURPOSES: ContractEnumList<RecallPurpose> = closedList<RecallPurpose>([
  'current',
  'history',
]);
export const SCOPE_KINDS: ContractEnumList<ScopeKind> = closedList<ScopeKind>([
  'item',
  'topic',
  'continuous',
]);
export const CONTENT_KINDS: ContractEnumList<ContentKind> = closedList<ContentKind>([
  'stable_fact',
  'preference',
  'plan',
  'event',
  'temporary_state',
  'other',
]);
export const ORIGINS: ContractEnumList<Origin> = closedList<Origin>([
  'user',
  'action',
  'inference',
]);
export const SENSITIVITIES: ContractEnumList<Sensitivity> = closedList<Sensitivity>([
  'ordinary',
  'private',
  'excluded',
]);
export const OCCURRENCES: ContractEnumList<Occurrence> = closedList<Occurrence>([
  'planned',
  'reported',
  'verified',
  'unknown',
]);
export const GRANT_MATCHES: ContractEnumList<GrantMatch> = closedList<GrantMatch>([
  'covered',
  'not_covered',
  'uncertain',
]);
export const GRANT_REASON_CODES: ContractEnumList<GrantMatch> = GRANT_MATCHES;
export const OBSERVATION_REASON_CODES: ContractEnumList<ObservationReasonCode> =
  closedList<ObservationReasonCode>([
    'source_entailed',
    'source_unsupported',
    'source_unavailable',
  ]);
export const ADMISSION_VERDICTS: ContractEnumList<AdmissionVerdict> = closedList<AdmissionVerdict>([
  'accept',
  'defer',
  'reject',
]);
export const ADMISSION_REASON_CODES: ContractEnumList<AdmissionReasonCode> =
  closedList<AdmissionReasonCode>([
    'explicit_request',
    'value_accept',
    'value_reject',
    'value_uncertain',
    'backend_unavailable',
    'input_truncated',
  ]);
export const HISTORY_DECISIONS: ContractEnumList<HistoryDecision> = closedList<HistoryDecision>([
  'keep',
  'sanitize',
  'remove',
]);
export const SOURCE_ACTORS: ContractEnumList<SourceActor> = closedList<SourceActor>([
  'user',
  'assistant',
  'action',
  'context',
]);
/** 公共 action 证据的 kind：仅来自 journal 确认已执行的行动。 */
export const VERIFIED_ACTION_KIND = 'verified_action';
/** 单次 extraction 候选上限。 */
export const EXTRACT_MAX_CANDIDATES = 32;
/** 单条候选正文上限（UTF-16 code units）。 */
export const CANDIDATE_TEXT_MAX = 4000;

/**
 * 唯一对外错误码：PLAN 里唯一被批准用于此类通用处理失败的 `LEPI_*` 字面量。
 * 不新造 `LEPI_*` code；重试/定位所需的细分只放在**不持久化**的安全 `.issue` 枚举里。
 */
export const CONTRACT_CODE = 'LEPI_CONTROL_UNAVAILABLE';

/** 契约失败的本地细分（仅供父级重试/日志分支，绝不作为独立 `LEPI_*` code 落库）。 */
export const ContractIssues = Object.freeze({
  /** schema/结构不一致（类型、缺字段、未知属性、oneOf）。 */
  SCHEMA: 'schema',
  /** 引用了未提供的来源 id。 */
  SOURCE: 'source',
  /** 来源 actor 与该 origin/用途不符（含 action 缺 verified_action、context 单独成事实）。 */
  ACTOR: 'actor',
  /** candidate_id 不在允许清单内。 */
  CANDIDATE: 'candidate',
  /** reason_code 不在封闭字典，或与 verdict/match 语义不符。 */
  REASON: 'reason',
  /** 条数/长度越界（候选数、正文长度、空正文）。 */
  LIMIT: 'limit',
  /** 时间/offset 区间非法（ISO 无效、起止倒序）。 */
  RANGE: 'range',
  /** history 引用了给定的有效节点之外的 seq。 */
  HISTORY_SEQ: 'history_seq',
  /** 工具参数名/结构非法。 */
  TOOL_ARGS: 'tool_args',
});

/** `ContractError.issue` 的封闭取值（`ContractIssues` 的值联合）。 */
export type ContractIssue = (typeof ContractIssues)[keyof typeof ContractIssues];

/**
 * 契约错误：固定 `code='LEPI_CONTROL_UNAVAILABLE'` + 安全本地 `issue` + 安全字段 `path`（可为 null）。
 * message 只由这三者组成，绝不回显非法取值或未知（可能私密）属性名。
 */
export class ContractError extends Error {
  readonly code = CONTRACT_CODE;
  readonly issue: ContractIssue;
  readonly path: string | null;
  constructor(issue: ContractIssue, path: string | null = null) {
    super(path ? `${CONTRACT_CODE} (${issue}) [${path}]` : `${CONTRACT_CODE} (${issue})`);
    this.name = 'ContractError';
    this.issue = issue;
    this.path = path;
  }
}

// ── schema 片段（受限子集；共享节点在多个属性间复用是安全的）──────────────
/**
 * 本模块自建的受信 wire schema：`dsh-tools` 受限子集 + 宿主 tool descriptor 需要的开放 JSON 对象面。
 * 索引签名让 schema 可直接作为 `parameters: Record<string, unknown>` 传递。
 */
export type WireSchema = JsonSchemaNode & { [key: string]: unknown };

const S = (values: readonly string[]): JsonSchemaNode => ({ type: 'string', enum: [...values] });
const NULLABLE_STRING: JsonSchemaNode = { oneOf: [{ type: 'null' }, { type: 'string' }] };
const STRING_ARRAY: JsonSchemaNode = { type: 'array', items: { type: 'string' } };

const SCOPE_SCHEMA: JsonSchemaNode = {
  oneOf: [
    { type: 'null' },
    {
      type: 'object',
      properties: {
        kind: S(SCOPE_KINDS),
        subject_key: { type: 'string' },
        topic: NULLABLE_STRING,
        session_id: NULLABLE_STRING,
        expires_at: NULLABLE_STRING,
        allow_inference: { type: 'boolean' },
      },
      required: ['kind', 'subject_key', 'topic', 'session_id', 'expires_at', 'allow_inference'],
      additionalProperties: false,
    },
  ],
};

const CONTROL_REQUEST_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    kind: S(CONTROL_KINDS),
    source_ids: STRING_ARRAY,
    candidate_ids: STRING_ARRAY,
    scope: SCOPE_SCHEMA,
  },
  required: ['kind', 'source_ids', 'candidate_ids', 'scope'],
  additionalProperties: false,
};

const CONTEXT_GUARD_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    source_ids: STRING_ARRAY,
    subject_key: NULLABLE_STRING,
    facet_key: NULLABLE_STRING,
  },
  required: ['source_ids', 'subject_key', 'facet_key'],
  additionalProperties: false,
};

/** 模型提交的候选内容：不含系统绑定的 candidate_id/request_id/formed_at/explicit。 */
const CANDIDATE_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    content_kind: S(CONTENT_KINDS),
    origin: S(ORIGINS),
    sensitivity: S(SENSITIVITIES),
    subject_key: { type: 'string' },
    facet_key: { type: 'string' },
    source_ids: STRING_ARRAY,
    valid_from: NULLABLE_STRING,
    valid_until: NULLABLE_STRING,
    occurred_start: NULLABLE_STRING,
    occurred_end: NULLABLE_STRING,
    occurrence: S(OCCURRENCES),
  },
  required: [
    'text',
    'content_kind',
    'origin',
    'sensitivity',
    'subject_key',
    'facet_key',
    'source_ids',
    'valid_from',
    'valid_until',
    'occurred_start',
    'occurred_end',
    'occurrence',
  ],
  additionalProperties: false,
};

const HISTORY_SPAN_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    block_index: { type: 'integer' },
    start: { type: 'integer' },
    end: { type: 'integer' },
    source_ids: STRING_ARRAY,
  },
  required: ['block_index', 'start', 'end', 'source_ids'],
  additionalProperties: false,
};

const HISTORY_NODE_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    seq: { type: 'integer' },
    decision: S(HISTORY_DECISIONS),
    keep_spans: { type: 'array', items: HISTORY_SPAN_SCHEMA },
  },
  required: ['seq', 'decision', 'keep_spans'],
  additionalProperties: false,
};

/** submit_result 的 kind 集合。 */
export type ContractKind =
  | 'control'
  | 'extract'
  | 'grant'
  | 'observation'
  | 'history'
  | 'admission';

/** 每个 kind 的 wire schema。 */
export const SCHEMAS: Record<ContractKind, WireSchema> = Object.freeze({
  control: {
    type: 'object',
    properties: {
      requests: { type: 'array', items: CONTROL_REQUEST_SCHEMA },
      recall_purpose: S(RECALL_PURPOSES),
      context_guards: { type: 'array', items: CONTEXT_GUARD_SCHEMA },
    },
    required: ['requests', 'recall_purpose', 'context_guards'],
    additionalProperties: false,
  },
  extract: {
    type: 'object',
    properties: {
      candidates: { type: 'array', items: CANDIDATE_SCHEMA },
      unresolved_source_ids: STRING_ARRAY,
    },
    required: ['candidates', 'unresolved_source_ids'],
    additionalProperties: false,
  },
  grant: {
    type: 'object',
    properties: {
      match: S(GRANT_MATCHES),
      source_ids: STRING_ARRAY,
      reason_code: S(GRANT_REASON_CODES),
    },
    required: ['match', 'source_ids', 'reason_code'],
    additionalProperties: false,
  },
  observation: {
    type: 'object',
    properties: {
      safe: { type: 'boolean' },
      used_source_ids: STRING_ARRAY,
      reason_code: S(OBSERVATION_REASON_CODES),
    },
    required: ['safe', 'used_source_ids', 'reason_code'],
    additionalProperties: false,
  },
  history: {
    type: 'object',
    properties: {
      nodes: { type: 'array', items: HISTORY_NODE_SCHEMA },
      uncertain_seqs: { type: 'array', items: { type: 'integer' } },
    },
    required: ['nodes', 'uncertain_seqs'],
    additionalProperties: false,
  },
  admission: {
    type: 'object',
    properties: {
      verdict: S(ADMISSION_VERDICTS),
      reason_code: S(ADMISSION_REASON_CODES),
    },
    // 模型只回 verdict + 封闭 reason_code；score/backend/model/revision/truncated 由
    // processor/admission 运行期装配成完整 typed AdmissionResult（generative score=null，
    // 不伪造概率），绝不从模型读入。
    required: ['verdict', 'reason_code'],
    additionalProperties: false,
  },
});

/** 处理模型可调用的取证工具参数 schema（严格；不注册到主角色全局）。 */
export type ToolSchemaMap = {
  readonly fetch_context: WireSchema;
  readonly fetch_memory: WireSchema;
};

export const TOOL_SCHEMAS: ToolSchemaMap = Object.freeze({
  fetch_context: {
    type: 'object',
    properties: { source_ids: STRING_ARRAY },
    required: ['source_ids'],
    additionalProperties: false,
  },
  fetch_memory: {
    type: 'object',
    properties: { query: { type: 'string' }, purpose: S(RECALL_PURPOSES) },
    required: ['query', 'purpose'],
    additionalProperties: false,
  },
});

// 装配期即校验 schema 属于受限子集；任何作者错误在模块加载时暴露，而不是等到运行期。
for (const schema of Object.values(SCHEMAS)) assertSupportedJsonSchema(schema);
for (const schema of Object.values(TOOL_SCHEMAS)) assertSupportedJsonSchema(schema);

/** verdict → 允许的 reason_code（封闭映射，禁止自由文本/伪造概率）。 */
const ADMISSION_REASONS_BY_VERDICT: Readonly<
  Partial<Record<AdmissionVerdict, readonly AdmissionReasonCode[]>>
> = Object.freeze({
  accept: ['explicit_request', 'value_accept'],
  reject: ['value_reject'],
  defer: ['value_uncertain', 'backend_unavailable', 'input_truncated'],
});

// ── 校验后成立的 wire 值形状（union 取自 ./shared/domain.ts）──────────────
/** 合并前的单条 control 请求（schema 已保证字段齐备）。 */
export interface ControlRequestWire {
  kind: ControlKind;
  source_ids: string[];
  candidate_ids: string[];
  scope: GrantScope | null;
}
/** 每条本次用户表达的非值主体/方面 guard。 */
export interface ControlGuardWire {
  source_ids: string[];
  subject_key: string | null;
  facet_key: string | null;
}
/** control 结果（同 kind 合并后）。 */
export interface ControlValue {
  requests: ControlRequestWire[];
  recall_purpose: RecallPurpose;
  context_guards: ControlGuardWire[];
}
/** extract 结果：候选正文即为 processor 待绑定身份的 `CandidateDraft`。 */
export interface ExtractValue {
  candidates: CandidateDraft[];
  unresolved_source_ids: string[];
}
/** grant 匹配结果。 */
export interface GrantValue {
  match: GrantMatch;
  source_ids: string[];
  reason_code: GrantMatch;
}
/** observation 蕴含判断结果。 */
export interface ObservationValue {
  safe: boolean;
  used_source_ids: string[];
  reason_code: ObservationReasonCode;
}
/** history 单段保留区间。 */
export interface HistorySpanWire {
  block_index: number;
  start: number;
  end: number;
  source_ids: string[];
}
/** history 单节点决策。 */
export interface HistoryNodeWire {
  seq: number;
  decision: HistoryDecision;
  keep_spans: HistorySpanWire[];
}
/** history 结果。 */
export interface HistoryValue {
  nodes: HistoryNodeWire[];
  uncertain_seqs: number[];
}
/** admission 结果（模型只回 verdict + 封闭 reason_code）。 */
export interface AdmissionValue {
  verdict: AdmissionVerdict;
  reason_code: AdmissionReasonCode;
}
/** `validateResult` 的返回值联合。 */
export type ContractValue =
  | ControlValue
  | ExtractValue
  | GrantValue
  | ObservationValue
  | HistoryValue
  | AdmissionValue;

/** 契约层只读取的来源最小面（真实来源仍是调用方的 map/记录）。 */
export interface ContractSourceLike {
  readonly id?: unknown;
  readonly actor?: unknown;
  readonly kind?: unknown;
}
/** `validateResult` 的调用选项。 */
export interface ValidateOptions {
  sources?: Map<string, ContractSourceLike> | Record<string, ContractSourceLike>;
  primarySourceIds?: Set<string>;
  candidateIds?: readonly string[];
  historyNodes?: readonly unknown[];
}

// ── 安全诊断：只输出合法字段前缀，绝不回显非法值/未知属性名 ────────────────
const ROOT = 'value';
const PATH_TOKEN = /([^.[\]]+)|\[(\d+)\]/g;

/** 路径 token：`.key` 或 `[index]`。 */
type PathToken = { readonly key: string } | { readonly index: number };

function tokenizePath(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  PATH_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_TOKEN.exec(path)) !== null) {
    tokens.push(match[1] !== undefined ? { key: match[1] } : { index: Number(match[2]) });
  }
  return tokens;
}

/** 沿 schema 已声明结构下行一步；不匹配（含未知键）返回 null。 */
function descend(
  node: JsonSchemaNode | undefined,
  token: PathToken,
): { schema: JsonSchemaNode; suffix: string } | null {
  if (node === undefined || node === null || typeof node !== 'object') return null;
  if ('index' in token) {
    if (node.items !== undefined) return { schema: node.items, suffix: `[${token.index}]` };
    if (Array.isArray(node.oneOf)) {
      for (const branch of node.oneOf) {
        if (branch && branch.items !== undefined)
          return { schema: branch.items, suffix: `[${token.index}]` };
      }
    }
    return null;
  }
  const key = token.key;
  if (node.properties && Object.prototype.hasOwnProperty.call(node.properties, key)) {
    return { schema: node.properties[key]!, suffix: `.${key}` };
  }
  if (Array.isArray(node.oneOf)) {
    for (const branch of node.oneOf) {
      if (
        branch &&
        branch.properties &&
        Object.prototype.hasOwnProperty.call(branch.properties, key)
      ) {
        return { schema: branch.properties[key]!, suffix: `.${key}` };
      }
    }
  }
  return null;
}

/** 由「合法前缀行走」得到安全字段路径：遇未声明的键立即截断。 */
function safePath(schema: JsonSchemaNode, reported: unknown): string {
  if (typeof reported !== 'string' || reported.length === 0) return ROOT;
  const tokens = tokenizePath(reported);
  if (tokens.length === 0) return ROOT;
  let index = 0;
  if ('key' in tokens[0]! && tokens[0]!.key === ROOT) index = 1;
  let node: JsonSchemaNode = schema;
  let path = ROOT;
  for (; index < tokens.length; index++) {
    const step = descend(node, tokens[index]!);
    if (step === null) break;
    node = step.schema;
    path += step.suffix;
  }
  return path;
}

/** 把首个原生 violation 转成只含安全 path 的 ContractError。 */
function schemaError(schema: JsonSchemaNode, violations: string[]): ContractError {
  const message = typeof violations[0] === 'string' ? violations[0] : '';
  const quoted = /"([^"]*)"/.exec(message);
  return new ContractError(ContractIssues.SCHEMA, safePath(schema, quoted ? quoted[1] : null));
}

/** schema 校验通过返回 null，否则返回 ContractError。 */
function checkSchema(schema: JsonSchemaNode, value: unknown): ContractError | null {
  const violations = validateJsonSchemaValue(schema, value, ROOT);
  return violations.length === 0 ? null : schemaError(schema, violations);
}

// ── 来源/时间/ID 的纯 JS 检查 ─────────────────────────────────────────────
type SourceLookup = (id: string) => ContractSourceLike | undefined;

/** 规范化 sources 参数（Map 或普通对象）为 lookup 函数。 */
function sourceLookup(sources: ValidateOptions['sources']): SourceLookup {
  if (sources instanceof Map) return (id) => sources.get(id);
  if (sources && typeof sources === 'object') {
    return (id) => (Object.prototype.hasOwnProperty.call(sources, id) ? sources[id] : undefined);
  }
  return () => undefined;
}

/** 取真实来源；未知则抛错（不回显 id）。 */
function requireSource(lookup: SourceLookup, id: string, path: string): ContractSourceLike {
  const source = lookup(id);
  if (!source || typeof source !== 'object') throw new ContractError(ContractIssues.SOURCE, path);
  if (typeof source.actor !== 'string' || !SOURCE_ACTORS.includes(source.actor)) {
    throw new ContractError(ContractIssues.ACTOR, path);
  }
  return source;
}

function isIso(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return false;
  }
  // Date.parse normalizes impossible dates (e.g. February 30); reject them.
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10);
}

function unique<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/** 合并同 kind 的 control 请求（并集 ID；scope 取首个非空），不复制正文。 */
export function mergeControlRequests(
  requests: readonly ControlRequestWire[],
): ControlRequestWire[] {
  const merged: ControlRequestWire[] = [];
  const byKind = new Map<ControlKind, ControlRequestWire>();
  for (const request of requests) {
    const existing = byKind.get(request.kind);
    if (existing === undefined) {
      const entry: ControlRequestWire = {
        kind: request.kind,
        source_ids: unique(request.source_ids),
        candidate_ids: unique(request.candidate_ids),
        scope: request.scope ?? null,
      };
      byKind.set(request.kind, entry);
      merged.push(entry);
    } else {
      existing.source_ids = unique([...existing.source_ids, ...request.source_ids]);
      existing.candidate_ids = unique([...existing.candidate_ids, ...request.candidate_ids]);
      if (existing.scope === null && request.scope != null) existing.scope = request.scope;
    }
  }
  return merged;
}

function assertCandidateTimes(candidate: CandidateDraft, index: number): void {
  const keys = ['valid_from', 'valid_until', 'occurred_start', 'occurred_end'] as const;
  for (const key of keys) {
    const value = candidate[key];
    if (value !== null && !isIso(value))
      throw new ContractError(ContractIssues.RANGE, `candidates[${index}].${key}`);
  }
}

function assertOrigin(origin: Origin, actors: readonly ContractSourceLike[], index: number): void {
  if (origin === 'user') {
    if (!actors.every((source) => source.actor === 'user'))
      throw new ContractError(ContractIssues.ACTOR, `candidates[${index}].source_ids`);
    return;
  }
  if (origin === 'action') {
    if (!actors.every((source) => source.actor === 'user' || source.actor === 'action'))
      throw new ContractError(ContractIssues.ACTOR, `candidates[${index}].source_ids`);
    if (
      !actors.some((source) => source.actor === 'action' && source.kind === VERIFIED_ACTION_KIND)
    ) {
      throw new ContractError(ContractIssues.ACTOR, `candidates[${index}].source_ids`);
    }
    return;
  }
  // inference：只认公共 assistant 文本。
  if (!actors.every((source) => source.actor === 'assistant'))
    throw new ContractError(ContractIssues.ACTOR, `candidates[${index}].source_ids`);
}

function validateControl(
  value: ControlValue,
  lookup: SourceLookup,
  candidateIds: Set<string>,
  primarySourceIds?: Set<string>,
): ControlValue {
  const requests = mergeControlRequests(value.requests);
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i]!;
    if (request.source_ids.length === 0)
      throw new ContractError(ContractIssues.SCHEMA, `requests[${i}].source_ids`);
    // Only a real user source can authorize a control request.
    for (let j = 0; j < request.source_ids.length; j++) {
      const source = requireSource(
        lookup,
        request.source_ids[j]!,
        `requests[${i}].source_ids[${j}]`,
      );
      const sourceId = source.id;
      if (
        source.actor !== 'user' ||
        (primarySourceIds && (typeof sourceId !== 'string' || !primarySourceIds.has(sourceId)))
      )
        throw new ContractError(ContractIssues.ACTOR, `requests[${i}].source_ids[${j}]`);
    }
    for (let j = 0; j < request.candidate_ids.length; j++) {
      if (!candidateIds.has(request.candidate_ids[j]!))
        throw new ContractError(ContractIssues.CANDIDATE, `requests[${i}].candidate_ids[${j}]`);
    }
    if (
      request.scope !== null &&
      request.scope.expires_at !== null &&
      !isIso(request.scope.expires_at)
    ) {
      throw new ContractError(ContractIssues.RANGE, `requests[${i}].scope.expires_at`);
    }
  }
  for (let i = 0; i < value.context_guards.length; i++) {
    const guard = value.context_guards[i]!;
    if (guard.source_ids.length === 0)
      throw new ContractError(ContractIssues.SCHEMA, `context_guards[${i}].source_ids`);
    for (let j = 0; j < guard.source_ids.length; j++) {
      const source = requireSource(
        lookup,
        guard.source_ids[j]!,
        `context_guards[${i}].source_ids[${j}]`,
      );
      const sourceId = source.id;
      if (
        source.actor !== 'user' ||
        (primarySourceIds && (typeof sourceId !== 'string' || !primarySourceIds.has(sourceId)))
      )
        throw new ContractError(ContractIssues.ACTOR, `context_guards[${i}].source_ids[${j}]`);
    }
  }
  return { requests, recall_purpose: value.recall_purpose, context_guards: value.context_guards };
}

function validateExtract(
  value: ExtractValue,
  lookup: SourceLookup,
  primarySourceIds?: Set<string>,
): void {
  if (value.candidates.length > EXTRACT_MAX_CANDIDATES)
    throw new ContractError(ContractIssues.LIMIT, 'candidates');
  for (let i = 0; i < value.candidates.length; i++) {
    const candidate = value.candidates[i]!;
    if (candidate.text.length === 0 || candidate.text.length > CANDIDATE_TEXT_MAX)
      throw new ContractError(ContractIssues.LIMIT, `candidates[${i}].text`);
    if (candidate.source_ids.length === 0)
      throw new ContractError(ContractIssues.SCHEMA, `candidates[${i}].source_ids`);
    const actors: ContractSourceLike[] = [];
    for (let j = 0; j < candidate.source_ids.length; j++) {
      const id = candidate.source_ids[j]!;
      if (primarySourceIds && !primarySourceIds.has(id))
        throw new ContractError(ContractIssues.ACTOR, `candidates[${i}].source_ids[${j}]`);
      actors.push(requireSource(lookup, id, `candidates[${i}].source_ids[${j}]`));
    }
    assertOrigin(candidate.origin, actors, i);
    if (candidate.occurrence === 'verified' && candidate.origin !== 'action')
      throw new ContractError(ContractIssues.ACTOR, `candidates[${i}].occurrence`);
    assertCandidateTimes(candidate, i);
    if (
      candidate.valid_from !== null &&
      candidate.valid_until !== null &&
      Date.parse(candidate.valid_from) > Date.parse(candidate.valid_until)
    ) {
      throw new ContractError(ContractIssues.RANGE, `candidates[${i}].valid_until`);
    }
    if (
      candidate.occurred_start !== null &&
      candidate.occurred_end !== null &&
      Date.parse(candidate.occurred_start) > Date.parse(candidate.occurred_end)
    ) {
      throw new ContractError(ContractIssues.RANGE, `candidates[${i}].occurred_end`);
    }
  }
}

function validateGrant(value: GrantValue, lookup: SourceLookup): void {
  if (value.reason_code !== value.match)
    throw new ContractError(ContractIssues.REASON, 'reason_code');
  for (let i = 0; i < value.source_ids.length; i++)
    requireSource(lookup, value.source_ids[i]!, `source_ids[${i}]`);
}

function validateObservation(value: ObservationValue, lookup: SourceLookup): void {
  for (let i = 0; i < value.used_source_ids.length; i++)
    requireSource(lookup, value.used_source_ids[i]!, `used_source_ids[${i}]`);
  if (value.safe) {
    if (value.reason_code !== 'source_entailed')
      throw new ContractError(ContractIssues.REASON, 'reason_code');
    if (value.used_source_ids.length === 0)
      throw new ContractError(ContractIssues.SCHEMA, 'used_source_ids');
  } else if (value.reason_code === 'source_entailed') {
    throw new ContractError(ContractIssues.REASON, 'reason_code');
  }
}

/** 只提取当前 surface 节点的真实 seq 与其块列表；形状不符返回 null（不参与 known 表）。 */
function historyBlocks(node: unknown): { seq: number; blocks: readonly unknown[] } | null {
  if (!node || typeof node !== 'object') return null;
  if (!('seq' in node) || typeof node.seq !== 'number' || !Number.isInteger(node.seq)) return null;
  const seq = node.seq;
  if ('blocks' in node && Array.isArray(node.blocks)) return { seq, blocks: node.blocks };
  if ('text' in node && typeof node.text === 'string')
    return { seq, blocks: [{ block_index: 0, text: node.text }] };
  return { seq, blocks: [] };
}

function validateHistory(
  value: HistoryValue,
  lookup: SourceLookup,
  historyNodes: readonly unknown[],
): void {
  const known = new Map<number, readonly unknown[]>();
  for (const node of Array.isArray(historyNodes) ? historyNodes : []) {
    const parsed = historyBlocks(node);
    if (parsed !== null) known.set(parsed.seq, parsed.blocks);
  }
  const seenSeqs = new Set<number>();
  for (let i = 0; i < value.nodes.length; i++) {
    const node = value.nodes[i]!;
    if (!known.has(node.seq))
      throw new ContractError(ContractIssues.HISTORY_SEQ, `nodes[${i}].seq`);
    if (seenSeqs.has(node.seq)) throw new ContractError(ContractIssues.SCHEMA, `nodes[${i}].seq`);
    seenSeqs.add(node.seq);
    if (node.decision === 'remove' && node.keep_spans.length > 0)
      throw new ContractError(ContractIssues.SCHEMA, `nodes[${i}].keep_spans`);
    const byIndex = new Map<number, string>();
    for (const block of known.get(node.seq) ?? []) {
      if (!block || typeof block !== 'object' || !('block_index' in block) || !('text' in block))
        continue;
      const blockIndex = block.block_index;
      const text = block.text;
      if (
        typeof blockIndex !== 'number' ||
        !Number.isInteger(blockIndex) ||
        typeof text !== 'string'
      )
        continue;
      byIndex.set(blockIndex, text);
    }
    for (let k = 0; k < node.keep_spans.length; k++) {
      const span = node.keep_spans[k]!;
      const text = byIndex.get(span.block_index);
      if (text === undefined)
        throw new ContractError(ContractIssues.RANGE, `nodes[${i}].keep_spans[${k}].block_index`);
      if (!(span.start >= 0 && span.start <= span.end && span.end <= text.length))
        throw new ContractError(ContractIssues.RANGE, `nodes[${i}].keep_spans[${k}]`);
      for (let j = 0; j < span.source_ids.length; j++) {
        requireSource(lookup, span.source_ids[j]!, `nodes[${i}].keep_spans[${k}].source_ids[${j}]`);
      }
    }
  }
  for (let i = 0; i < value.uncertain_seqs.length; i++) {
    if (!known.has(value.uncertain_seqs[i]!))
      throw new ContractError(ContractIssues.HISTORY_SEQ, `uncertain_seqs[${i}]`);
  }
}

function validateAdmission(value: AdmissionValue): void {
  const allowed = ADMISSION_REASONS_BY_VERDICT[value.verdict];
  if (allowed === undefined || !allowed.includes(value.reason_code))
    throw new ContractError(ContractIssues.REASON, 'reason_code');
}

/**
 * 校验一份 submit_result。
 * @param kind control/extract/grant/observation/history/admission。
 * @param value 模型/后台解析后的 JSON 值（未受信任，先 schema 后语义）。
 * @returns 已校验值（control 为同 kind 合并后的结果）。
 * @throws {ContractError}
 */
export function validateResult(
  kind: ContractKind,
  value: unknown,
  options: ValidateOptions = {},
): ContractValue {
  const schema: WireSchema | undefined = SCHEMAS[kind];
  if (schema === undefined) throw new ContractError(ContractIssues.SCHEMA, null);
  const structural = checkSchema(schema, value);
  if (structural !== null) throw structural;
  const lookup = sourceLookup(options.sources);
  const candidateIds = new Set<string>(
    Array.isArray(options.candidateIds) ? options.candidateIds : [],
  );
  if (kind === 'control')
    return validateControl(value as ControlValue, lookup, candidateIds, options.primarySourceIds);
  if (kind === 'extract') {
    validateExtract(value as ExtractValue, lookup, options.primarySourceIds);
    return value as ExtractValue;
  }
  if (kind === 'grant') {
    validateGrant(value as GrantValue, lookup);
    return value as GrantValue;
  }
  if (kind === 'observation') {
    validateObservation(value as ObservationValue, lookup);
    return value as ObservationValue;
  }
  if (kind === 'history') {
    validateHistory(value as HistoryValue, lookup, options.historyNodes ?? []);
    return value as HistoryValue;
  }
  validateAdmission(value as AdmissionValue);
  return value as AdmissionValue;
}

/**
 * 校验 `fetch_context`/`fetch_memory` 工具参数（严格，无 `String(...)` 修补）。
 * @param name 工具名。
 * @param args 未受信任的工具参数。
 * @returns 原样 args（已校验）。
 * @throws {ContractError}
 */
export function validateToolArgs(name: string, args: unknown): unknown {
  const schema =
    name === 'fetch_context'
      ? TOOL_SCHEMAS.fetch_context
      : name === 'fetch_memory'
        ? TOOL_SCHEMAS.fetch_memory
        : undefined;
  if (schema === undefined) throw new ContractError(ContractIssues.TOOL_ARGS, null);
  const structural = checkSchema(schema, args);
  if (structural !== null) throw structural;
  if (name === 'fetch_context') {
    if (
      args &&
      typeof args === 'object' &&
      'source_ids' in args &&
      Array.isArray(args.source_ids)
    ) {
      const ids = args.source_ids;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (typeof id === 'string' && id.length === 0)
          throw new ContractError(ContractIssues.TOOL_ARGS, `source_ids[${i}]`);
      }
    }
  } else if (name === 'fetch_memory') {
    if (
      args &&
      typeof args === 'object' &&
      'query' in args &&
      typeof args.query === 'string' &&
      args.query.length === 0
    ) {
      throw new ContractError(ContractIssues.TOOL_ARGS, 'query');
    }
  }
  return args;
}
