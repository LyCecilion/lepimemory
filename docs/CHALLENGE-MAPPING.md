# Challenge Mapping

The interview challenge ([`CHALLENGE.md`](../CHALLENGE.md), Chinese) defines four levels plus two optional extensions, and closes with a list of open design questions. This document maps each requirement to the code that answers it — and, just as importantly, states which parts are **not** implemented.

Read this if you are evaluating the project against the brief, or if you want to know which level a module belongs to before changing it.

## Status at a glance

| Level | Requirement | Status | Where it lives |
| --- | --- | --- | --- |
| Lv1 | Multi-turn continuity, stable identity, observable internal state that affects replies | Implemented | Persona (`dsh/profiles/lepimemory/cordis.patch.yml`), compaction group, `src/machine.ts`, `src/state-runtime.ts`, `src/shared/state.ts` |
| Lv2 — Memory | Independent memory system with a lifecycle, not a chat log | Implemented | `src/evidence.ts`, `src/processor.ts`, `src/admission.ts`, `src/memory-authorization.ts`, `src/write-worker.ts`, `src/curate-worker.ts` |
| Lv2 — Action | At least one real action beyond text, and a distinction between claiming and doing | Implemented | `src/action.ts` (`write_note`), tool surface in `src/index.ts`, web search from the preset |
| Lv2 — Observability | Reconstruct what context/memory/state/tools were used and why | Implemented | `src/store.ts` (audit ledger), `src/panel.ts`, `src/client/**` |
| Lv2.5 | Storyline / world-line with bounded branches | **Not implemented** | — |
| Lv3 | An avatar that expresses internal state | Partially implemented (PNGTuber-style GIF differentials, not Live2D/3D) | `src/shared/avatar-assets.ts`, `src/shared/avatar-frames.ts`, `src/client/components/AvatarOverlay.tsx` |
| Lv4 | Real-time voice interaction | **Not implemented** | — |
| Lv4.5 | Natural overlapping conversation, interruption, mid-utterance revision | **Not implemented** | — |

The README states the project's own reading of this: almost everything claimed is implemented, the system is not asserted to be production-ready, and real-time voice is listed as a future direction rather than a delivered feature.

## Lv1 — a character that keeps existing

**Continuity across turns.** History is managed by the host's compaction backend, which the profile enables as an isolate realm (`compaction-basic`, `command-compact`, `tool-result-pruner`). Two properties of the plugin make that safe: the state section is placed at system-prompt order `50` (`STATE_SECTION_ORDER` in `src/index.ts`), which sits ahead of any compacted region, and recalled memory is re-injected every turn, so a compacted copy of a previous recall is a redundant duplicate rather than a loss.

**Stable identity.** The persona prefix in `dsh/profiles/lepimemory/cordis.patch.yml` defines who the character is (identity kernel, speaking style, boundaries) and masks the harness's default coding-assistant framing. It is static prompt text — deliberately, because identity is not something the model should rewrite turn by turn.

**Observable internal state that actually matters.** State is not a sentence in a prompt:

- `src/shared/state.ts` defines the state object: `mood.{valence, arousal}` and `relation.{trust, closeness, familiarity}`, with the baseline, numeric ranges and rendering helpers.
- `src/machine.ts` turns structural round facts into deltas. Three rules exist and each documents why: a user utterance increments familiarity, a successful action brightens mood and closes the relationship slightly, a genuine tool failure lowers mood — and *never* long-term trust, which only explicit user evidence may change.
- Mood decays towards the baseline with a six-hour half-life; relation does not decay on its own.
- `src/state-runtime.ts` observes real session events (`turn/start`, `user/message`, `tool/call`, `tool/result`, `turn/end`), commits decay and deltas in short transactions together with their audit rows, and renders the prompt section text. The rendered section is what the model actually sees, so state changes the reply.

Because the deltas are ±0.12 on a value rendered as a meters strip, a single visible event crosses the display threshold within one turn — the effect is observable, not theoretical ([STATE-AND-EMOTION.md](./STATE-AND-EMOTION.md)).

## Lv2 — memory with a lifecycle

The challenge asks what should become memory, when it should come back, and how it is updated, contradicted, or forgotten. The pipeline answers each in a separate stage:

| Challenge question | Answer in this codebase |
| --- | --- |
| What becomes a memory? | Structured candidates extracted per assertion (`processor.ts` prompt `extract`), each carrying `content_kind`, `origin`, `sensitivity`, `occurrence` and a validity window. Ordinary candidates then pass value admission; private candidates are judged in memory and wait for explicit consent. |
| When does it come back? | Recall runs per turn, gated by policy *before* relevance: source proof and lifecycle state are verified, then Hindsight scores what remains (`src/recall.ts`, `src/trust.ts`). |
| How are memories updated? | New information creates a *new* candidate; supersession flips the old lifecycle row to `superseded` while its immutable snapshot stays for audit (`src/control.ts`, `candidate-store.ts`). |
| What happens on contradiction? | The user's explicit correction (`correct`) or a later statement in the same facet supersedes the old value; the snapshot is never edited, so the history of belief survives. |
| How does forgetting work? | `forget` creates a forget scope, bumps the policy epoch, stops tasks that cannot be proven unrelated, redacts the live session surface through the history coordinator, and blocks recall of the affected raws (`src/history.ts`, `curate-worker.ts`). |
| How does it expire? | `valid_until` and `occurrence` are part of the candidate contract; expired snapshots are excluded from current use, and `plan`-like content becomes history-only rather than remaining current. |
| How do inferences differ from facts? | Trust tiers: `fact` (user), `experience` (journal-verified action), `inference` (the character's own, decaying with a half-life), `unknown` (unattributable). Only snapshot-bound candidates can reach the first two. |

Full detail: [MEMORY.md](./MEMORY.md) and [RECALL.md](./RECALL.md).

## Lv2 — real action

The action layer's whole point is the challenge's sentence: *"saying you did something" and "actually doing it" must be distinguishable*.

- `write_note` (`src/action.ts`) writes a real file to `<dataRoot>/notes/<action_id>.md`. The `action_id` row is registered as `prepared` before any I/O; the file is created with an exclusive temp file, `fsync`, then an atomic `link()` that never overwrites; the final file's hash must match the registered value before the row becomes `executed` — in the same transaction as its audit row.
- Operator approval (`ctx.approval`) gates the side effect, and the recorded outcome reflects what actually happened (`allowed-once`, `rejected`, `cancelled`, `unavailable`). Anything unprovable surfaces as `LEPI_NOTE_UNKNOWN` rather than as a success.
- A successful action can legitimately enter memory — via `origin: 'action'`, `occurrence: 'verified'`, which the contract only allows for journal-verified executions (`src/contracts.ts`).
- The model's own narration of its actions never reaches the ledger; receipts shown in conversation are computed from the ledger.

The preset also grants the upstream ask-user and web tools; the launcher forces `fetch: false` on the web tool row while the profile is generated (`forceToolWebFetchFalse` in `scripts/src/runtime.ts`), so the character can search but not fetch arbitrary URLs.

## Lv2 — observability and audit

The challenge lists four questions to answer after an interaction. All four are answerable from `runtime.sqlite` and the operator panel:

| Challenge question | Ledger answer |
| --- | --- |
| Which context and memories were used? | `evidence` rows for the cited session fragments, the `recall` audit kind with the picked/excluded entries, and the `raw_links` + `snapshots` chain back to the candidate. |
| Did internal state change? | Every state mutation writes before/after values, the fired rule ids and the reason in the `audit` table in the same transaction as the state row. |
| Which tools were called, with what input and result? | `actions` rows plus `action` audit events carrying session/turn/step/call identity; the tool result is persisted by the host with `presentationMeta`. |
| What was finally produced? | The session itself, plus receipts and control notices recorded with their request/task identity. |

Beyond reconstruction, the ledger supports explanation: the state machine records *which rule* fired, and policy exclusions record *which* code excluded an item (`source_unsupported`, `value_uncertain`, `LEPI_CURATE_UNPROVEN`, …). See [OBSERVABILITY.md](./OBSERVABILITY.md) for the schema and the panel routes, and [UI.md](./UI.md) for the human-facing views.

## Lv2.5 — storyline

**Not implemented.** There is no story state machine, no stage/branch model, and no bounded world-line in the codebase: a repository-wide search finds no storyline concept in `dsh/` or `scripts/`. The character's continuity comes from state, persona and memory, not from a narrative graph.

This is a scope decision, not an oversight — the challenge marks Lv2.5 as optional, and the project invested its remaining effort in the memory lifecycle, action honesty, and observability instead. Any claim that Lepimemory has a storyline system would be wrong.

## Lv3 — an avatar driven by state

Partially implemented, with an explicit trade-off: instead of Live2D or a 3D avatar, the character is a set of **62 PNGTuber-style GIF differentials** shown at 128 px.

What makes it a state output rather than a decorative animation:

- `src/shared/activity.ts` derives what the character is doing right now from real chat/session signals, with a fixed priority: approvals and questions outrank everything, then a running tool call, then the assistant stream (only a running assistant step counts as thinking/speaking), falling back to error or idle.
- `src/shared/avatar-frames.ts` maps activity + tone to candidate frames, and the tone comes from the state object (valence/arousal → bright/plain/low).
- Both the panel status strip and the avatar overlay consume the *same* rule module and the *same* 5-second state feed (`src/client/feed.ts`), so the picture and the numbers cannot disagree.

What it is not: no lip sync, no generated animation, no camera or scene; frames are pre-made assets. Voice and real-time media are out of scope (Lv4).

## Lv4 / Lv4.5 — real-time interaction

**Not implemented.** There is no speech-to-text, text-to-speech, streaming audio, or interruption handling in the repository, and therefore no measured "first perceivable feedback under 10 seconds" claim either. The README lists real-time voice conversation as a direction the project intends to build out later.

## The open questions from the challenge

The brief ends with a list of design questions and states there is no single correct architecture. Here is how this project actually answered them:

| Question | This project's answer |
| --- | --- |
| Should personality live in the prompt or be explicit state? | Both, split by kind: identity and style are static persona text; affect and relationship are explicit, decaying, audited state. |
| Should the agent have memories about itself? | Yes, but as `inference`-tier candidates that decay, and they can never be promoted to fact by prose (`src/trust.ts`). |
| Should the user–agent relationship be modelled? | Yes, as `relation.{trust, closeness, familiarity}` for affect, kept strictly separate from `grants`, which are permissions rather than feelings. |
| Should facts, inferences and experiences use different strategies? | Yes: different trust tiers, different decay (inference half-life), different authorisation requirements (actions need journal proof, inferences never authorise). |
| How are wrong memories corrected? | Supersession plus immutable snapshots: a new candidate for the same facet replaces the old one's *current* status while the old body stays for audit. `reveal=1` on the panel shows that old snapshot to the operator, and never restores it. |
| When do old memories expire? | `valid_until` on the candidate, checked during admission/recall; plans that have passed become history-only. There is no implicit “natural forgetting” of the kind a longer-lived system would need. |
| Should tool results enter long-term memory? | Yes, when a verified action produces an experience; the journal is the proof, and unverified results cannot claim `occurrence: verified`. |
| Should side-effecting operations require confirmation? | Yes, twice over: `ctx.approval` for the file write, and the private-consent question (`ctx.userQuestions.ask` via `askPrivate`) before anything private is persisted. |
| Should failure affect character state? | Only mood. A tool failure lowers valence; trust is unchanged, and approval refusals or control outages are explicitly not counted as tool failures (`src/machine.ts`). |
| What should the character do during long operations? | The task queue keeps real statuses (`pending`, `submitted`, `deferred`, …) and the plugin injects receipts, so the character can honestly say work is still in progress instead of inventing a result. |
| How are interruptions handled? | Aborts and epoch fencing: a request whose policy changed, whose signal aborted, or whose source proof no longer holds is rejected rather than answered from stale material (`src/index.ts`, `src/recall-source.ts`). |

## Related documents

- [ARCHITECTURE.md](./ARCHITECTURE.md) — the system these mappings point into
- [MEMORY.md](./MEMORY.md) / [RECALL.md](./RECALL.md) — Lv2 memory in depth
- [ACTION.md](./ACTION.md) — Lv2 action and the language/behaviour split
- [OBSERVABILITY.md](./OBSERVABILITY.md) — the audit substrate
- [STATE-AND-EMOTION.md](./STATE-AND-EMOTION.md) — Lv1 state and Lv3 presentation
- [UI.md](./UI.md) — panel and avatar surfaces
- [`CHALLENGE.md`](../CHALLENGE.md) — the original brief
