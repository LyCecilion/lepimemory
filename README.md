<!-- markdownlint-disable MD033 MD041 -->

<div align="center">

> Is there truly no turning of the tide?<br/>
> I ask myself, ask this ocean—if I were to cast myself into its embrace, would anything be different? Memory lives in the water, in the endless sea. It will tell you everything. It speaks of the deepest longings in the human heart: a world of mutual understanding has already been born, only to fall once more into slumber.<br/>
> It will return. It never left.

![Lepimemory Banner](/assets/banner.png)

# 🦋 Lepimemory ✒️

_✨ An AI Agent character that truly **persists**, ✨_<br/>
with persistent state, personality, long-term memory, and real action capabilities.

</div>

> [!NOTE]
> The project will stop adding new features before Geek Tech Club's Demo Day, and will only take bug fixes, experience improvements, and routine maintenance from here on.
>
> Almost all of the features the project claims are implemented, but the development team does not assert that the project is production-ready. The codebase still contains plenty of hardcoded logic and mock implementations written for the demo, and Lepimemory will keep needing the team's ongoing iteration and refinement.

## 📖 About

Lepimemory is the complete AI Agent system LyCecilion built for Geek Tech Club's [second interview challenge](https://join.geek-tech.club/problems2/heart-heart-heart) — "design and implement an intelligent character Agent with persistent state, personality, memory, and action capabilities".

The project aims to go beyond the unremarkable memory system designs of traditional AI Agent systems: instead of plain text and naive RAG, it uses a self-developed emotion module and a memory system built on Hindsight, SQLite, and the like. Above the underlying LLM, Lepimemory independently maintains a state machine, a controlled memory lifecycle, and genuine system action capabilities.

## ✨ Features

Lepimemory implements the following features, as required by the interview challenge.

- **The character's existence is continuous and coherent.** A self-developed emotion module keeps the character consistent across conversations.
- **It has a past and can act.** A mature system maintains memory, handles tool calls, and provides observability.
- **It shows the character's inner thoughts.** It supports Live2D integration, or a plain rotating-sticker scheme, to present the character's mood and thoughts.

The project intends to keep building out more capabilities in the future, such as real-time voice conversation.

## 🚀 Quick Start

Make sure the machine has the following:

- Docker (with Docker Compose v2)
- make, Bash, curl, tar, OpenSSL, shasum

Lepimemory's entry points are driven by the project's pinned toolchain, so there is no need to install Node, pnpm, and DeepSeek Harness globally beforehand. `make bootstrap` automatically downloads and verifies the pinned Node 24.20.0 and pnpm 10.28.2; `make install-profile` installs DeepSeek Harness into the specified directory.

```bash
# Prepare the pinned toolchain
make bootstrap

# Configure environment variables
cp .env.example .env
# Edit .env and fill in LEPI_LLM_BASE_URL and LEPI_LLM_API_KEY

# Install and generate the profile
make install-profile DSH_HOME=/tmp/lepimemory-home

# Start the development server
DSH_HOME=/tmp/lepimemory-home PORT=3181 LEPI_BANK=lepimemory-demo make dev
```

The first time `make dev` runs, it builds and starts the two memory service images, Hindsight and Laya, via Docker.

Configure the LLM credentials as described in [Configuration](#️-configuration). Without LLM credentials, the system starts in an unconfigured state: the frontend can display the status, but no conversation can be started. To avoid credential conflicts in the demo, Lepimemory does not support specifying LLM credentials from anywhere else for now.

Once startup succeeds, the terminal prints an access URL with authentication parameters; open it in a browser to get in.

## 📦 Installation

The launch scripts provided so far only support the installation route described in [Quick Start](#-quick-start). Other installation methods will be added in a future iteration.

## ⚙️ Configuration

Lepimemory manages LLM credentials uniformly through `LEPI_*` environment variables. Copy `.env.example` to `.env`, then modify the following fields:

- Shared LLM connection: `LEPI_LLM_BASE_URL` and `LEPI_LLM_API_KEY`.
- Per-route overrides: `LEPI_ROLE_*` (the character's main model), `LEPI_PROCESS_*` (the processing model), `LEPI_CONTROL_FALLBACK_*` (fallback route), and `LEPI_HINDSIGHT_*` (memory backend model); each can point at a different endpoint.
- Memory bank identifier: `LEPI_BANK`, which sets the storage bank identifier for long-term memory (defaults to `lepimemory-v2`).

## 📁 Project Structure

```text
lepimemory/
├── dsh/
│   ├── profiles/lepimemory/          the dsh install profile (model routes, agent preset, persona)
│   └── plugins/dsh-lepimemory-state/ the character kernel
│       ├── src/                      hand-written TypeScript
│       │   ├── index.ts              entry: wiring, hooks, notices
│       │   ├── config.ts store.ts    configuration and the single SQLite source of truth
│       │   ├── evidence.ts           session citations (metadata only)
│       │   ├── processor.ts contracts.ts control.ts
│       │   │                         structured model calls, closed schemas, memory intents
│       │   ├── memory*.ts admission.ts candidate-store.ts task-store.ts
│       │   │                         memory lifecycle: pipeline, authorisation, queue
│       │   ├── write-worker.ts curate-worker.ts hindsight.ts recall*.ts
│       │   │                         Hindsight retention, curation and recall
│       │   ├── machine.ts state-runtime.ts      mood / relation state machine
│       │   ├── action.ts                        tools with real side effects
│       │   ├── history.ts panel.ts              surface redaction and the HTTP panel
│       │   ├── shared/               browser-safe definitions shared with the client
│       │   └── client/               hand-written TSX for the browser panel and avatar
│       ├── test/                     six node:test behaviour suites
│       ├── assets/avatar/            62 GIF frames for the avatar overlay
│       ├── lib/                      GENERATED server output
│       └── client.js                 GENERATED browser bundle
├── scripts/                          pinned toolchain bootstrap, build driver, launcher, verification
├── deploy/                           Hindsight and Laya Dockerfiles, Laya service source
├── assets/                           repository imagery
└── docs/                             technical documentation (see below)
```

`lib/`, `client.js` and `scripts/dist/` are build outputs and are never edited by hand. The only supported entry points are the `make` targets listed above. Runtime state lives outside the source tree, in `DSH_HOME` (the repository-local `.dsh/` by default).

## 📚 Documentation

The full documentation set lives in [`docs/`](./docs/):

- [Architecture](./docs/ARCHITECTURE.md) — the system, one turn end to end, design principles
- [Project Structure](./docs/PROJECT-STRUCTURE.md) — every directory and module, with responsibilities
- [Runtime](./docs/RUNTIME.md) / [Deployment](./docs/DEPLOYMENT.md) / [Configuration](./docs/CONFIGURATION.md) — toolchain, services and the complete `LEPI_*` reference
- [Memory](./docs/MEMORY.md) / [Recall](./docs/RECALL.md) — the write and read halves of the memory lifecycle
- [State and Emotion](./docs/STATE-AND-EMOTION.md) / [Action](./docs/ACTION.md) / [Control](./docs/CONTROL.md) — the character kernel
- [Observability](./docs/OBSERVABILITY.md) / [UI](./docs/UI.md) — the audit ledger and the browser surface
- [Testing](./docs/TESTING.md) / [Development](./docs/DEVELOPMENT.md) / [Troubleshooting](./docs/TROUBLESHOOTING.md) — verification and day-to-day work
- [Challenge Mapping](./docs/CHALLENGE-MAPPING.md) / [Glossary](./docs/GLOSSARY.md) — how the implementation answers the brief, and the shared vocabulary

## 📄 License

[MIT LICENSE](./LICENSE)
