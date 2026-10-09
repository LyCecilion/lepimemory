# Glossary

The vocabulary used throughout these documents. Terms are grouped by the layer they belong to; where a term comes from an upstream dependency (dsh, Hindsight, Laya) the upstream meaning is stated as the code uses it, not as general documentation might define it.

## Host and toolchain

| Term | Meaning in this project |
| --- | --- |
| **dsh / DeepSeek Harness** | The Cordis-based agent host the project builds on. Pinned to `0.1.7-rc.2` in `dsh/plugins/dsh-lepimemory-state/src/shared/pins.ts`. |
| **Cordis** | The plugin/service framework dsh is built on: a `Context` with `ctx.on`, `ctx.effect`, `ctx.tools.register`, and service injection via `inject`. |
| **Plugin** | A Cordis module loaded by dsh. Lepimemory has exactly one: `@dsh-external/dsh-lepimemory-state`. |
| **Profile** | An installed dsh configuration tree (a `cordis.yml` entry list composed from bundles and patches). Lepimemory's profile is generated into `$DSH_HOME/profiles/lepimemory`. |
| **Bundle** | An upstream package contributing a set of profile rows. The Lepimemory profile bundles `dsh-base`, `dsh-web-app` and the plugin. |
| **Preset / agent preset** | The per-session capability and prompt surface. The `lepimemory` preset installs the persona, ask-user tool, web tool and compaction group, and deliberately excludes coding tools. |
| **Persona** | The `@deepseek-ai/dsh-persona` row in the profile that supplies the character's system-prompt prefix and masks the default coding-agent text. |
| **DSH_HOME** | The host state directory. Defaults to the repository-local `.dsh`; contains the profile install, sessions and the Lepimemory data directory. |
| **RUNTIME_CONTRACT** | The integer (`1`) the plugin exports to signal which launcher contract it implements. |
| **STATE_SECTION_ORDER** | `50` — the position of the state section in the assembled system prompt, after the persona prefix (`0`) and before policy (`500`). |
| **Generated artifact** | Anything produced by the build: `dsh/plugins/dsh-lepimemory-state/lib/**`, `client.js`, `scripts/dist/**`. Never edited by hand, never committed. |

## Services

| Term | Meaning in this project |
| --- | --- |
| **Hindsight** | The long-term memory engine (image `lepimemory-hindsight:0.10.0`). Reached over loopback REST on port 8888; ships its own UI on 9999. Owns retrieval, remote raw storage and remote curation. |
| **Laya** | The local model service (`lepimemory-laya:0.3.26`, port 8000) used as the *value admission* backend: given a candidate memory, it reports how worth keeping it is. |
| **Bank** | A Hindsight namespace. Lepimemory's default is `lepimemory-v2` (`LEPI_BANK`); the legacy bank name `lepimemory` is explicitly rejected so a misconfigured run cannot write into an old bank. |
| **Raw** | A Hindsight storage unit holding original text. Locally tracked through `raw_links` (`raw_id`, `document_id`, `version_hash`, `state`). |
| **Document** | The Hindsight container a raw item belongs to; used to verify that a recalled item still exists and is unchanged. |
| **Observation / synthesized unit** | Hindsight's derived memory unit built from several raws. Observations are used as *retrieval material and explanation*, never as an independent authorising source. |
| **Operation** | A Hindsight async write job identified by a stable `operation_id`. The write worker polls it; receipts depend on its terminal state plus local proof. |
| **Retain** | Locally, the act of submitting an approved snapshot to Hindsight (`retainAsync`). |
| **Curate** | Locally, the follow-up pass over already-retained items: re-verify, reconcile, or restore only when source proof is unchanged. |

## Memory lifecycle

| Term | Meaning in this project |
| --- | --- |
| **Evidence** | A citation into the live session: a session/message/sequence/block/offset reference with an actor. Evidence rows store **metadata only**; text bodies live in the current processing heap and can be re-read from the canonical session surface. |
| **Actor** | Who produced a piece of evidence: `user`, `assistant`, `action`, or `context`. Only `user` (and verified actions) can authorise a memory operation; `context` never becomes an independent fact. |
| **Candidate** | A single, independently judgeable assertion extracted from the conversation, bound to real source ids. Candidates carry `content_kind`, `origin`, `sensitivity`, `occurrence` and a validity window. |
| **Content kind** | `stable_fact`, `preference`, `plan`, `event`, `temporary_state`, `other`. |
| **Origin** | Where a candidate came from: `user` (stated), `action` (verified execution), `inference` (the character's own guess). |
| **Sensitivity** | `ordinary`, `private`, `excluded`. Private candidates are judged for value **in memory** and only persisted after explicit consent; excluded content is never retained. |
| **Admission** | The value decision: should this candidate be kept for a long-term companion? Produces `accept` / `defer` / `reject` with a closed reason code. |
| **Authorization** | The policy decision: is this candidate covered by a grant, an explicit request, or a permission the user gave? Only authorisation may commit a snapshot. |
| **Snapshot** | The immutable, approved record of a candidate (`snapshots` table). Written once; `LEPI_SNAPSHOT_IMMUTABLE` guards updates. |
| **Lifecycle** | The status attached to a candidate id: `pending`, `active`, `history_only`, `superseded`, `forgotten`, `audit_only`, `unknown`. |
| **Supersession** | Replacing a remembered value with a newer one without deleting the old snapshot: the old row's body stays for audit, but it stops being *current*. |
| **Forget scope** | A persisted user decision that a candidate, topic, or continuous stream must stop being used (`forget_scopes` table). |
| **Trust tier** | How strong a remembered statement is: `fact` (user stated), `experience` (verified by journal), `inference` (the character's own, decays over a half-life), `unknown` (cannot be attributed). Only snapshot-bound candidates can be `fact` or `experience`. |
| **Policy epoch** | A monotonically increasing counter bumped whenever policy changes (grants, forgets, supersession). Async work captures it and re-checks after every `await`; a mismatch fails closed. |
| **Fence** | The barrier that stops stale work: a request whose policy changed, or whose source proof no longer holds, is rejected rather than completed. |
| **Receipt** | A short system notice injected into the conversation reporting the **actual** processing status of a memory request (`pending`, `written`, `deferred`, `resubmit_required`, …). Receipts never invent content. |
| **Notice** | A message the plugin injects with an explicit source kind: `lepimemory-recall`, `lepimemory-receipt`, `lepimemory-control`, or `lepimemory-redacted`. Notices are context, not user speech. |

## Tasks and scheduling

| Term | Meaning in this project |
| --- | --- |
| **Task kind** | `normalize`, `admit`, `write`, `curate`, `history` — the five queued job types in the `tasks` table. |
| **Task status** | `pending`, `running`, `submitted`, `deferred`, `written`, `reconciled`, `unknown`, `failed`, `cancelled`, `expired`. |
| **Lease** | The owner/claim marker held while a task runs, so a crash or a second tick cannot run the same job twice. |
| **Deferral** | A task parked with a retry time rather than being completed: used when a backend is unavailable or a judgement is genuinely uncertain. `deferred` means "not decided yet", never "done". |
| **Sweeper** | The scheduled pass that expires stale tasks, reclaims dead leases and reconciles orphaned candidates. Driven externally by a timer in `index.ts` (`scheduleSweep`) plus `turn/end` and idle transitions. |
| **Job slot** | A concurrency limit owned by the supervisor: one slot for normalize/admit work, one alternating slot for write/curate pumping. |

## Control and actions

| Term | Meaning in this project |
| --- | --- |
| **Control kind** | The memory operation the user is asking for: `remember`, `correct`, `forget`, `restore`, `re_remember`, `grant`, `revoke`. |
| **Grant** | A confirmed permission with a scope: `item`, `topic`, or `continuous`. Referenced by candidates at commit time. |
| **Contract** | A closed schema plus closed reason dictionary that every model/background result must satisfy before use (`src/contracts.ts`). |
| **Contract error** | `ContractError` with a public `code` (only `LEPI_CONTROL_UNAVAILABLE` is approved for persistence) and an internal, non-persisted `.issue` for diagnosis. |
| **Route** | A resolved LLM connection + model pair. Three model routes exist: `role` (the character), `process` (structured background judgement), `control-fallback` (fallback for control calls). A fourth connection, `hindsight`, is used by the memory engine itself. |
| **Action** | A tool call with a real side effect. Today: `write_note`. |
| **Journal** | The `actions` table, which records `prepared` before I/O and only commits `executed` after the written file's hash matches the registered value. |
| **Outcome** | The honest result of an action: `allowed-once`, `rejected`, `cancelled`, `unavailable`. Anything unprovable surfaces as an error code (`LEPI_NOTE_UNKNOWN`), never as success. |
| **Approval** | The host's consent mechanism (`ctx.approval`) used for side-effecting tools; the plugin records the real outcome of the operator's choice. |

## State and presentation

| Term | Meaning in this project |
| --- | --- |
| **Mood** | Short-term state: `valence` (-1..1) and `arousal` (0..1), with a six-hour half-life back to baseline. |
| **Relation** | Long-term state: `trust`, `closeness`, `familiarity` (0..1 each). It never decays on its own; only explicit adjustments change it. |
| **Baseline** | The initial value of every dimension; also the point mood decays towards. |
| **Fact (state machine sense)** | A structural event fed to the machine — the user spoke, a tool failed, a turn ended. Model prose is never a fact. |
| **Reason** | A short, neutral explanation attached to a state change (`StateReason`), rendered only while still relevant. |
| **Activity** | The derived "what is it doing right now" signal (`idle`, `think`, `speak`, `tool`, `approval`, `question`, `error`) shared by the status strip and the avatar. |
| **立绘 / avatar overlay** | The always-visible character image docked above the input box. Implemented as PNGTuber-style GIF differentials (62 frames, shown at 128 px), selected by activity and tone. |
| **Feed** | The single 5-second state polling feed shared by the panel and the avatar overlay. |

## Error code prefixes

| Prefix | Domain |
| --- | --- |
| `LEPI_CONFIG_*`, `LEPI_CONNECTION_INCOMPLETE` | Configuration resolution (`src/config.ts`) |
| `LEPI_STORE_*`, `LEPI_STATE_*` | SQLite store and state persistence |
| `LEPI_SOURCE_*`, `LEPI_SNAPSHOT_*`, `LEPI_RETAIN_*`, `LEPI_CURATE_*` | Source proof, snapshots and remote retention |
| `LEPI_CONTROL_*`, `LEPI_HISTORY_BLOCKED`, `LEPI_INPUT_RESUBMIT_REQUIRED`, `LEPI_MEMORY_SUPPRESSED`, `LEPI_POLICY_CHANGED` | Control plane, history fence and policy fences |
| `LEPI_NOTE_*`, `LEPI_ACTION_IDENTITY`, `LEPI_APPROVAL_UNAVAILABLE` | Action layer |
| `LEPI_HINDSIGHT_*`, `LEPI_RECALL_UNAVAILABLE`, `LEPI_WRITE_TARGET_CHANGED`, `LEPI_WORKER_STOPPED` | Memory services and workers |
| `LEPI_NODE_VERSION_MISMATCH`, `LEPI_CORE_VERSION_MISMATCH`, `LEPI_CORE_NOT_READY`, `LEPI_PROFILE_*`, `LEPI_VERIFY_*`, `LEPI_CLI_*` | Launcher and pinned toolchain |
| `LEPI_*_MS`, `LEPI_*_MODEL`, `LEPI_*_URL`, `LEPI_*_API_KEY` | Environment variable names, not error codes (see [CONFIGURATION.md](./CONFIGURATION.md)) |

## Related documents

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how these pieces fit together
- [MEMORY.md](./MEMORY.md) / [RECALL.md](./RECALL.md) — lifecycle in detail
- [STATE-AND-EMOTION.md](./STATE-AND-EMOTION.md) — mood, relation and rendering
- [CONTROL.md](./CONTROL.md) — control kinds, contracts and routes
- [OBSERVABILITY.md](./OBSERVABILITY.md) — ledger, table names and panel routes
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — what each error code means in practice
