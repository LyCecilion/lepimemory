# Troubleshooting

Operational failure modes: what you observe, where in the code it comes from, what to check, and what to do. Every entry is grounded in code, comments, `.env.example` or the compose file; judgement calls that go beyond that evidence are marked `[INFERENCE]`. For configuration semantics see [CONFIGURATION.md](./CONFIGURATION.md); this document is about things going wrong.

## How to read an entry

Each entry is a `###` section with four parts:

- **Symptom** — what the operator sees first (a terminal line, an HTTP status, a panel state).
- **Likely cause** — the code path, with the repo-relative module and the stable error code or log line.
- **Check** — the commands or rows that confirm or rule out the cause.
- **Fix** — the action, and whether the mitigation is prescribed by the code or a judgement call.

Most errors here are designed to be *stable codes* rather than prose. The launcher prints `lepimemory-runtime: <CODE>`, the build prints `lepimemory-build: <CODE>`, and the HTTP routes answer `{ "ok": false, "error": "<code>" }`.

## Startup and toolchain

### `make bootstrap` refuses to run or fails mid-download

**Symptom** — `LEPI_BOOTSTRAP_BUSY`, `LEPI_BOOTSTRAP_UNAVAILABLE: <tool>`, `LEPI_ARTIFACT_INTEGRITY`, or `LEPI_UNSUPPORTED_PLATFORM`.

**Likely cause** — `scripts/bootstrap-runtime.sh`. `LEPI_BOOTSTRAP_BUSY` means a `.runtime/bootstrap.lock` directory already exists (another bootstrap, or a crashed one). `LEPI_BOOTSTRAP_UNAVAILABLE` names a missing host tool from its required list (`curl`, `tar`, `openssl`, `shasum`, `find`, `sort`, `diff`). `LEPI_ARTIFACT_INTEGRITY` means the downloaded archive's checksum did not match the pinned hash, after which the partial file is quarantined as `*.corrupt-*`. `LEPI_UNSUPPORTED_PLATFORM` comes from the `uname` platform/arch switch.

**Check** — `ls .runtime/` (look for `bootstrap.lock` and `*.corrupt-*` entries); `ls .runtime/cache/` for quarantined downloads; `command -v curl tar openssl shasum`.

**Fix** — Install the missing host tool. Remove a stale `bootstrap.lock` only after confirming no bootstrap is running. A checksum failure is usually a truncated download or a proxy rewriting the response: clear `.runtime/cache/<file>*` and retry. Do not edit the hashes in the script; they pin official Node/pnpm builds deliberately.

### The build or launcher reports a Node/pnpm mismatch

**Symptom** — `LEPI_NODE_VERSION_MISMATCH`, `LEPI_NODE_UNBOUND`, `LEPI_PNPM_VERSION_MISMATCH`, or `LEPI_PNPM_MISSING`.

**Likely cause** — `scripts/build.mts` `assertPinnedNode()` / `runFrozenInstall()` and `scripts/src/runtime.ts` `assertPinnedNode()` verify that the interpreter really is `.runtime/bin/node` (v24.20.0) by comparing `fs.realpathSync(process.execPath)`. Running `node scripts/build.mts` with a system Node, or invoking the compiled launcher directly, produces these codes. `LEPI_PNPM_VERSION_MISMATCH` means the pnpm wrapper is not reporting 10.28.2.

**Check** — `.runtime/bin/node --version` should print `v24.20.0`; `.runtime/bin/pnpm --version` should print `10.28.2`.

**Fix** — Run everything through `make` (`make bootstrap` first if `.runtime/bin` is missing). `assertPinnedNode()` exists so the build cannot succeed against a toolchain the tests were not verified with.

### `LEPI_DEPS_MISSING` / `LEPI_LOCKFILE_MISSING` / `LEPI_INSTALL_FAILED`

**Symptom** — `lepimemory-build: LEPI_DEPS_MISSING: missing dependencies; run make install-profile`, or `LEPI_LOCKFILE_MISSING`, or `LEPI_INSTALL_FAILED: frozen pnpm install failed`.

**Likely cause** — `scripts/build.mts` `requireDependencies()` and `runFrozenInstall()`. Missing `node_modules/typescript` or `node_modules/esbuild` raises `LEPI_DEPS_MISSING`; an absent `pnpm-lock.yaml` raises `LEPI_LOCKFILE_MISSING`; a non-zero exit of `pnpm install --frozen-lockfile` raises `LEPI_INSTALL_FAILED`.

**Check** — `ls node_modules/typescript node_modules/esbuild`; `ls pnpm-lock.yaml`.

**Fix** — `make install-profile` runs the frozen install and then builds. A lockfile drift (`ERR_PNPM_OUTDATED_LOCKFILE` inside the pnpm output) means a `package.json` change was not accompanied by a lockfile update; regenerate the lock with the pinned pnpm deliberately, in its own commit, rather than relaxing `--frozen-lockfile`.

### `LEPI_CLI_MISSING` / `LEPI_CLI_VERSION_MISMATCH` / `LEPI_CORE_VERSION_MISMATCH`

**Symptom** — `lepimemory-runtime: LEPI_CLI_MISSING: repository dsh install absent; run 'make install-profile'`, or a version mismatch code.

**Likely cause** — `assertInstallation()` checks `node_modules/@deepseek-ai/dsh/package.json`, the CLI bin, the plugin's `peerDependencies['@deepseek-ai/dsh']` and each helper dependency in `PLUGIN_HELPER_DEPS` against `DSH_VERSION`. Any drift raises the corresponding code.

**Check** — `node -e "console.log(require('./node_modules/@deepseek-ai/dsh/package.json').version)"`, and the same for `@deepseek-ai/dsh-llm` and friends; compare with `dsh/plugins/dsh-lepimemory-state/src/shared/pins.ts`.

**Fix** — `make install-profile`. When bumping the pinned dsh version, change `shared/pins.ts` and the plugin/root manifests together; the launcher deliberately refuses to mix versions because the tests bind to the released native graph.

### `make dev` stops with `LEPI_CORE_NOT_READY` before launching

**Symptom** — `lepimemory-runtime: LEPI_CORE_NOT_READY: new runtime cutover has not completed` or `entrypoint does not implement the approved runtime contract`.

**Likely cause** — `assertCoreReady()` requires the eight `CORE_MODULES` (`config.js`, `store.js`, `evidence.js`, `processor.js`, `contracts.js`, `control.js`, `admission.js`, `history.js`) to exist in `lib/`, and dynamically imports `lib/index.js` and checks `RUNTIME_CONTRACT === 1`. Stale or partially generated output fails this gate.

**Check** — `ls dsh/plugins/dsh-lepimemory-state/lib/`; `grep -n RUNTIME_CONTRACT dsh/plugins/dsh-lepimemory-state/src/index.ts`.

**Fix** — `make build` (or `make dev`, which builds first). If the module list was changed intentionally, update `CORE_MODULES` in `scripts/src/runtime.ts` in the same change — the gate is meant to prevent launching a legacy bridge.

### `make dev` stops with `LEPI_DEV_FAILED`

**Symptom** — `lepimemory-runtime: LEPI_DEV_FAILED: dsh exited early with code <N>`, usually within a second of launch.

**Likely cause** — `waitForCoreHealth()` polls `http://127.0.0.1:<PORT>/lepimemory/health` for up to 90 s at 500 ms intervals. If the child process exits first, the launcher reports its exit code instead of waiting out the timeout.

**Check** — Re-run with the child's stderr visible; the launcher passes `stdio: 'inherit'`, so dsh's own error appears directly above the launcher line. Check whether `PORT` is already serving something: `ss -ltnp | grep :3181` (or the configured port).

**Fix** — A port already in use is the most common cause and is not separately diagnosed by the launcher: pick another `PORT=…` (the launcher forwards `PORT` to the child via `childEnv.PORT`) or stop the process holding it. `[INFERENCE]` — the code proves the exit-code path, not the cause of the exit. If the port is free, the failure is inside dsh itself; check `$DSH_HOME/profiles/lepimemory/cordis.patch.yml` was generated (the launcher logs `launching locked dsh <version> (profile lepimemory, port <port>)` before spawning).

### `LEPI_PROFILE_CONFLICT` / `LEPI_PROFILE_SHAPE` / `LEPI_PROFILE_SOURCE_MISSING`

**Symptom** — `lepimemory-runtime: LEPI_PROFILE_CONFLICT: <dir> exists but was not generated by this launcher; refusing to overwrite`.

**Likely cause** — `inspectProfileOwnership()` returns `ours` only when `$DSH_HOME/profiles/lepimemory/.lepimemory-runtime.json` carries `creator: "lepimemory-runtime"`. A non-empty directory without that marker is refused rather than clobbered. `LEPI_PROFILE_SHAPE` comes from `forceToolWebFetchFalse()` failing to find the `tool-web` row or its `fetch:` key within eight lines; `LEPI_PROFILE_SOURCE_MISSING` means `dsh/profiles/lepimemory/cordis.patch.yml` is gone.

**Check** — `cat "$DSH_HOME/profiles/lepimemory/.lepimemory-runtime.json"`; confirm the `tool-web` preset row in `dsh/profiles/lepimemory/cordis.patch.yml` still has a `fetch: true|false` line immediately after `- id: tool-web`.

**Fix** — If the directory was created by the launcher, just run `make dev` again. If it holds something you care about, move it aside; the launcher will regenerate. Never hand-edit the generated `cordis.patch.yml` — it is rewritten on every run and starts with `# Generated by the lepimemory launcher … do not edit.` For `LEPI_PROFILE_SHAPE`, restore the source patch shape; the launcher rewrites `fetch: true` to `fetch: false` on purpose.

### Choosing and preserving `DSH_HOME`

**Symptom** — Data appears to move, or the profile is suddenly regenerated, after changing `DSH_HOME`.

**Likely cause** — Every `make` target that starts the runtime exports `DSH_HOME` only when it is set on the command line or in the environment (the Makefile forwards it explicitly); otherwise the plugin's default home applies (`./.dsh`, from the config defaults). `make reset` deletes `$DSH_HOME` when set, otherwise `$(CURDIR)/.dsh`.

**Check** — `echo "$DSH_HOME"`; `grep -n 'DSH_HOME\|CURDIR/.dsh' Makefile`; check `ls "$DSH_HOME/profiles"`.

**Fix** — Pass `DSH_HOME=…` consistently on every invocation (the README's quick start does). `make stop`/`make clean` keep volumes; only `make reset` removes data — use it deliberately.

### `make verify` fails with `LEPI_VERIFY_MISSING` or `LEPI_VERIFY_FAILED`

**Symptom** — `lepimemory-runtime: LEPI_VERIFY_MISSING: <file> not present (added at the Step-11 cutover)` or `LEPI_VERIFY_FAILED: <file> exited <N>`.

**Likely cause** — `runEntry()` in `scripts/src/runtime.ts` spawns each entry with the pinned Node and `cwd: REPO_ROOT`, failing closed if the file is absent or the child exits non-zero.

**Check** — `ls dsh/plugins/dsh-lepimemory-state/test/*.test.js scripts/dist/verify-runtime.js`; run the failing file directly to see the assertion.

**Fix** — If a file is missing, run `make build` (verify-runtime) or restore the test file; if a suite is added, register it in `commandVerify()`'s list. See [TESTING.md](./TESTING.md) for per-suite guidance.

## Memory services (Docker)

### First `make dev` takes many minutes before the memory services are healthy

**Symptom** — `docker compose up -d --build` builds and starts, but Hindsight's healthcheck stays unhealthy for several minutes while the panel shows no memory service.

**Likely cause** — The compose healthchecks allow for a first start that creates the Postgres instance and bakes/downloads the local embedding and reranker models. `docker-compose.yml` sets `start_period: 600s`, `interval: 15s`, `timeout: 5s`, `retries: 20` for `hindsight` and `start_period: 120s` for `laya`, with the comment "首次启动慢（建 PG + 拉模型），给足宽限".

**Check** — `docker compose ps` for `(health: starting)` vs `(healthy)`; `docker compose logs -f hindsight`.

**Fix** — Wait out the start period; the grace is deliberate. Model caches live in the named volume `hindsight-hf-cache`, so a container rebuild does not re-download them, while `hindsight-data` (the `.pg0` store) survives across rebuilds too. Do not remove those volumes to "fix" slowness.

### Model download fails during the image build: `FileMetadataError` / "Distant resource does not seem to be on huggingface.co"

**Symptom** — The image build fails while fetching the pinned embedding/reranker revisions; the message mentions a missing `X-Repo-Commit`.

**Likely cause** — The mirror and an HTTP proxy are alternative network paths, not a pair. `scripts/src/runtime.ts` `buildHfEndpoint()` resolves the endpoint from the effective egress: an explicit `HF_ENDPOINT` wins; otherwise a proxy (`HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy`) selects the official endpoint, and a direct network selects the mirror. Behind a proxy, `hf-mirror.com` answers with a cross-domain redirect to `huggingface.co`, whose resolve response then lacks `X-Repo-Commit`, so `snapshot_download` aborts a metadata check even though the revision is pinned. The compose file passes `HF_ENDPOINT` as a build arg with default `https://huggingface.co`.

**Check** — Look at the launcher's line `building memory-service images (pinned model bake endpoint: <endpoint>)`. Confirm whether `HTTP(S)_PROXY` is set in the environment used by `make dev`.

**Fix** — Leave `HF_ENDPOINT` unset and let the launcher choose, unless you are on a direct (proxy-less) campus network where only the mirror resolves — in that case set `HF_ENDPOINT=https://hf-mirror.com`. Do not set the mirror while a proxy is in effect: that is the exact failure documented in `.env.example` and the compose comment. Also remember `HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1` are set for the running containers, so runtime downloads are not attempted at all.

### Docker is unavailable and nothing else breaks

**Symptom** — `docker compose unavailable; memory services were not started (external dependency)` and a warning when services fail to start.

**Likely cause** — `startExternalServices()` probes `docker compose version`; a non-zero status warns and returns. A non-zero `up` exit warns `memory service startup failed; core UI and task status remain available`. This is intentional: the browser UI and core runtime do not depend on Docker.

**Check** — `docker compose version`; `docker info`.

**Fix** — Start Docker if you need memory. Recall will otherwise audit `status: 'unavailable'` with `LEPI_HINDSIGHT_UNAVAILABLE` (see "Recall returns nothing" below). If a host port is already bound, compose fails to publish `127.0.0.1:8888`/`:9999`/`:8000` — free the port or change the binding in `docker-compose.yml`. `[INFERENCE]` — the code proves the warning path, not the port-conflict cause.

## Configuration and credentials

### The system starts but no conversation can be started

**Symptom** — The UI loads and shows status, but sending a message does nothing useful. `make install-profile` printed `install complete` and the health endpoint works.

**Likely cause** — This is the designed unconfigured state. `.env.example` states it: an empty shared connection means "只读界面可用，不生成 provider/default-model，也不会回落到任何默认官方 URL". `resolveConfig()` returns `configured: false` with empty route endpoints; the generated profile gets `providers: {}`, and `dockerEnv()` sends `HINDSIGHT_API_LLM_PROVIDER: 'none'` to the memory service.

**Check** — Confirm `.env` has both `LEPI_LLM_BASE_URL` and `LEPI_LLM_API_KEY`; run `LEPI_RUNTIME_DEBUG=1 make install-profile` to print the redacted resolved config.

**Fix** — Fill both values in `.env` and re-run `make dev`. There is deliberately no other place to specify credentials: the project avoids credential conflicts by keeping the shared pair authoritative.

### `LEPI_CONNECTION_INCOMPLETE`

**Symptom** — `lepimemory-runtime: LEPI_CONNECTION_INCOMPLETE [LEPI_LLM_BASE_URL]` (or `[…_API_KEY]`), or the same code from `resolveConfig()` in a test.

**Likely cause** — `src/config.ts` treats a URL and its key as one atomic pair. Supplying a key without a base URL, or a URL without a key, throws `ConfigError(CONNECTION_INCOMPLETE, field)` naming the missing half — it never infers one from the other. The same rule applies to each per-route override (`LEPI_ROLE_*`, `LEPI_PROCESS_*`, `LEPI_CONTROL_FALLBACK_*`, `LEPI_HINDSIGHT_*`): overriding must be done as a pair, never partially inherited.

**Check** — Print the environment as the process sees it (`grep -E 'LEPI_(LLM|ROLE|PROCESS|CONTROL_FALLBACK|HINDSIGHT)_' .env`), remembering that an explicit process variable beats the file.

**Fix** — Add the missing field or remove the orphan. The field name in the error tells you which one.

### `LEPI_CONFIG_INVALID [LEPI_BANK]` — legacy bank rejected

**Symptom** — Startup fails with `LEPI_CONFIG_INVALID` naming `LEPI_BANK`; the message is `legacy bank rejected; use a v2 bank`.

**Likely cause** — `src/config.ts` `bankField()` rejects the reserved legacy name `lepimemory` (`LEGACY_BANK`). The default bank is `lepimemory-v2`.

**Check** — `grep -n LEPI_BANK .env`.

**Fix** — Use a v2 bank such as `lepimemory-v2` or a demo bank like `lepimemory-demo-*`. The old bank is not migrated, its data is retained: the compose header notes that "existing data/cache volumes and old banks are retained". Pointing the runtime at the old name would silently mix generations, so it is refused rather than aliased.

### Legacy `.env` keys were migrated and a `.env.legacy-*` file appeared

**Symptom** — A file named `.env.legacy-<timestamp>` appears beside `.env`, and the launcher logs `migrated legacy .env; backup written to <path>`.

**Likely cause** — `migrateLegacyEnv()` runs once on first load. It maps `GEEK_TECH_CLUB_API_KEY → LEPI_LLM_API_KEY` (keeping an existing `LEPI_LLM_BASE_URL`), the `HINDSIGHT_API_LLM_{BASE_URL,API_KEY,MODEL}` trio to `LEPI_HINDSIGHT_*`, deletes `HINDSIGHT_API_LLM_PROVIDER`, and writes a backup with mode `0600` containing the original file byte-for-byte. It is idempotent: with no legacy keys it changes nothing and writes no backup.

**Check** — `ls -l .env.legacy-*` (expect mode `-rw-------`); `grep -c GEEK_TECH_CLUB .env` should be `0`.

**Fix** — Nothing to fix; keep the backup out of version control (`.env.legacy*` is gitignored). If migration reported `missing <field>: add it to <file>; no endpoint is guessed`, add the named field — e.g. a legacy key with no endpoint reports `LEPI_LLM_BASE_URL` and still fails with `LEPI_CONNECTION_INCOMPLETE`, because no fallback endpoint is ever guessed.

## Data and the store

### `LEPI_STATE_INVALID`

**Symptom** — `lepimemory-runtime`-driven startup or a test fails with `LEPI_STATE_INVALID`.

**Likely cause** — `openStore()` validates the legacy `state.json` through `validateState()` before importing it. An invalid file (for example `{"mood":{"valence":"invalid"}}`) is left byte-identical on disk and no SQLite file is created.

**Check** — Read the offending `state.json`; the validator reports the exact field path (for example `mood.valence`) and the reason.

**Fix** — Correct the JSON in place and retry; the import is idempotent and will pick up the corrected file. Do not delete the file unless you intend to start from the baseline state.

### `LEPI_STORE_UNAVAILABLE`

**Symptom** — Startup fails with `LEPI_STORE_UNAVAILABLE`.

**Likely cause** — `openStore()` throws this stable error for several distinct conditions, all deliberately without repairing anything: the file is not a database (or is empty) and cannot be opened; it exists but `meta.schema_version` does not equal `SCHEMA_VERSION`; one of the expected tables is missing; the data directory sits on a network filesystem (NFS/SMB/CIFS are rejected by `statfsSync` type); or `readOnly: true` was requested for a file that does not exist.

**Check** — `file "$DBFILE"`; `sqlite3 "$DBFILE" "select value from meta where key='schema_version'"`; `stat -f -c %T "$(dirname "$DBFILE")"`.

**Fix** — Point `DSH_HOME`/the database path at a real local disk. For a genuinely corrupt file, move it aside and let the runtime create a fresh one; the runtime will never overwrite it for you. A schema-version mismatch means the file was written by a different build: keep it as evidence and start from a new path rather than editing the version row.

### `LEPI_STORE_OWNED`

**Symptom** — The runtime refuses to start, or `verify-runtime` reports that a second open was refused: `LEPI_STORE_OWNED`.

**Likely cause** — `initialize()` reads the `meta.owner` record and calls `ownerAlive()`. A live owner on the same host (a PID that exists) means another runtime process holds the database. A record from a *different* host is treated as alive unconditionally, so a remote session is never reclaimed.

**Check** — `sqlite3 "$DBFILE" "select value from meta where key='owner'"` and compare the `pid` with running processes; `pgrep -af 'dsh|runtime.js'`.

**Fix** — Stop the other runtime (`make stop` stops the containers; kill the `dsh` child if the launcher died). Recovery from a *crashed* owner is automatic: an owner PID that no longer exists is reclaimed on open, leases are cleared, and tasks stuck in `running` are moved back to `pending` or `submitted`. That exact behaviour is proven by `scripts/src/verify-runtime.ts`, so no manual cleanup should be needed.

### Legacy `.jsonl` data seems to have disappeared

**Symptom** — After the first start, `state.json` and the `audit/recall/retain/forget/action.jsonl` files are gone from the data directory, and the panel history shows rows tagged as legacy.

**Likely cause** — This is the one-shot migration in `store.initialize()`, guarded by `meta.legacy_migrated`. The five `LEGACY_FILES` plus `state.json` are copied into an archive directory whose path is recorded under `meta.legacy_archive`, then their contents become `audit` rows with `data.legacy: true` and status `unknown` (or `failed` when the record was an error). `scripts/src/verify-runtime.ts` asserts the archived copies are byte-identical to the originals.

**Check** — `sqlite3 "$DBFILE" "select value from meta where key in ('legacy_migrated','legacy_archive')"`, then look inside the archive directory.

**Fix** — Nothing is lost: the archive is the preserved original. Legacy rows carry `session_id: null`, `call_id: null` and status `unknown` on purpose — the runtime refuses to invent an identity for material it cannot prove. If you need the raw files back, copy them out of the archive directory.

## Panel and UI

### Panel requests return 401 or 403 rather than 404

**Symptom** — `/lepimemory/state`, `/lepimemory/history`, `/lepimemory/candidate`, `/lepimemory/retry` or `/lepimemory/avatar` answer `{"ok":false,"error":"unauthorized"}` (401) or `"forbidden"` (403), even for an ID that does not exist.

**Likely cause** — This is deliberate. `src/panel.ts` performs operator authentication *before* any database read or body action: `rejected()` calls `scope.connection.requestRejection(req)` and maps its return to 401/403. The module header states the rule — an unauthenticated request must never learn whether an ID exists, so it never receives a 404.

**Check** — Check the URL you opened: the launcher logs `core ready; open the authenticated link printed by dsh (303 clears the token)`. Opening the bare `http://127.0.0.1:<PORT>/` without the token, or reusing a token that has already been consumed, produces 401/403.

**Fix** — Re-run `make dev` and copy the freshly printed authenticated link. Only `GET /lepimemory/health` is public by design. If the token is rejected after a restart, that is expected: the session is bound to the running process.

### Panel data routes are missing entirely (404 from the web server)

**Symptom** — Only `/lepimemory/health` exists; every data route 404s. The log shows `面板：connection 不可用，仅装载公开 /lepimemory/health（数据路由不开放）` or `面板：webServer 不可用…`.

**Likely cause** — `installPanel()` injects `webServer` and `connection`. Without `connection`, the auth gate cannot be evaluated, so the data routes are not registered at all — the panel then renders "状态不可用" rather than exposing unauthenticated data. Without `webServer` (or with `ctx.inject` missing) nothing is registered.

**Check** — Grep the dsh stdout for the two Chinese warning lines; confirm the profile includes the web-app bundle (`$DSH_HOME/profiles/lepimemory/package.json` → `dsh.profile.bundles`).

**Fix** — Start through `make dev`, which launches the full profile. If you launched dsh by hand with a different profile, the plugin's `inject` list cannot be satisfied and data routes will not mount.

### `/lepimemory/health` reports `core: false` or an unhealthy service

**Symptom** — The health JSON shows `core: false`, `node: false`, `dsh: false`, `schema: false` or `serviceReady: false`.

**Likely cause** — `panel.ts` `coreReady()` requires the pinned Node version, the plugin's pinned dsh peer version to match the installed one, and `meta.schema_version` to match `SCHEMA_VERSION`. `serviceReady()` requires `coordinator.health()` to report `started: true` and `disposed: false`.

**Check** — `curl -s http://127.0.0.1:<PORT>/lepimemory/health`. Compare with `shared/pins.ts` and the installed `@deepseek-ai/dsh` version.

**Fix** — `core: false` after a version bump means a rebuild plus reinstall is needed (`make install-profile`). `serviceReady: false` while the process is running usually means memory is disposed or not started; check the launcher log for `LEPI_HISTORY_BLOCKED` or worker errors, and see [OBSERVABILITY.md](./OBSERVABILITY.md) for reading the audit tables.

### Avatar frames do not load

**Symptom** — The avatar shows nothing; the route answers `{"ok":false,"error":"not_found"}` (404) or `{"ok":false,"error":"LEPI_AVATAR_UNAVAILABLE"}` (500).

**Likely cause** — `src/panel.ts` `avatarRoute` accepts only keys matching `AVATAR_KEY_RE` that exist in `AVATAR_ASSETS`; anything else is 404. A read failure for a valid key (missing file on disk, permissions) is 500 `LEPI_AVATAR_UNAVAILABLE`. Responses are cached by mtime and answer 304 on `if-modified-since`, so replacing a GIF does not require a restart.

**Check** — `ls dsh/plugins/dsh-lepimemory-state/assets/avatar/`; compare against `src/shared/avatar-assets.ts`. `test/avatar.test.js` asserts the directory and the manifest are exactly equal.

**Fix** — Restore the missing asset or register the new one in the manifest (and re-run `make build` for the client bundle). The route only serves `assets/avatar/**` and only by manifest key — never by path.

## Memory behaviour

### Recall returns nothing

**Symptom** — The character replies without any recalled memories; the recall audit row has `status = 'unavailable'` and `code = 'LEPI_HINDSIGHT_UNAVAILABLE'`, or the row exists but `picked` is empty with exclusions.

**Likely cause** — Two families. (1) The backend could not be reached: `src/recall.ts` catches the failure, audits `status: 'unavailable'` with code `LEPI_HINDSIGHT_UNAVAILABLE`, and returns empty text — recall never blocks the conversation. (2) Sources were excluded by policy: `LEPI_MEMORY_SUPPRESSED` (excluded sensitivity, or a lifecycle status the requested purpose does not allow — `src/trust.ts` accepts only `active` for `current`, plus `history_only`/`superseded` for `history`, so a `forgotten` source is suppressed either way), `LEPI_SOURCE_CHANGED`/`LEPI_SOURCE_UNKNOWN` (unprovable or changed body), `LEPI_GRANT_INVALID` (a private grant no longer covers the item), `over_limit` (the explicit item budget) or `score_unavailable` (a missing semantic score).

**Check** — `sqlite3 "$DBFILE" "select status,data_json from audit where type='recall' order by id desc limit 5"`. Inspect the `excluded` array and its codes. For backend health, `docker compose ps` and `curl -s http://127.0.0.1:8888/health`.

**Fix** — For (1), bring Hindsight up and re-run `make dev`. For (2), the exclusion is the correct behaviour: a forgotten target must not return, and a source whose body changed mid-verification must not fall back to a local snapshot. To make a memory eligible again, use the `manage_memory` control path (restore) rather than editing the database directly.

### A write is stuck in `deferred` or `parked`

**Symptom** — A task row or panel row sits at `deferred`/`parked` and nothing happens on its own.

**Likely cause** — Parking is deliberate. The scheduler parks on an admission defer (the Laya value decision was `value_uncertain` or the backend was unavailable/truncated), on an unavailable operation read, or on a control outage. `memory.wake()` does not re-evaluate parked work: the tests assert that a `wake()` after a defer never re-asks the consent question, and that an operator recheck "never allocates another operation".

**Check** — `sqlite3 "$DBFILE" "select id,kind,status,error_code,next_at from tasks order by next_at"`; for a check request, `select status,error_code from requests`.

**Fix** — Use the operator retry: `POST /lepimemory/retry` (the panel exposes it), which wakes the existing request/task by identity without opening a new operation. Note that the write worker legitimately defers on `LEPI_HINDSIGHT_UNAVAILABLE` up to a bounded number of times, always keeping the same `operation_id`.

### `LEPI_CONTROL_UNAVAILABLE` and the turn ends as an error

**Symptom** — The user's input stays visible but the role never answers; the turn ends with an error carrying `LEPI_CONTROL_UNAVAILABLE`, and the check request row is `parked`.

**Likely cause** — `src/history.ts` uses `LEPI_CONTROL_UNAVAILABLE` as the stable failure for a control decision that cannot be produced (all control attempts and the fallback failed) or for a scope/commit that is no longer valid. The outage path is covered by `test/history.test.js`: the input and the error stay visible, no provider call is made, and the check request is parked for an operator.

**Check** — `sqlite3 "$DBFILE" "select status,error_code from requests where kind='check' order by updated_at desc limit 5"`; look at `audit` rows of type `control.*` for the reason.

**Fix** — An operator retry resumes the parked check. If it recurs, the configured provider or the fallback route is failing: verify `LEPI_LLM_BASE_URL`/`LEPI_LLM_API_KEY` and the `LEPI_CONTROL_FALLBACK_*` pair. The runtime intentionally does not downgrade to a stale decision.

### The user is asked to resubmit: `LEPI_INPUT_RESUBMIT_REQUIRED`

**Symptom** — The turn ends with an error and the message `LEPI_INPUT_RESUBMIT_REQUIRED`; the request row has `status = 'resubmit_required'`; the panel shows the history fence as `pending`/`blocked`.

**Likely cause** — A canonical-history fence is in effect (a forget/isolation is pending or failed) or the policy epoch changed while the decision was being assembled. `src/history.ts` throws `BLOCKED = 'LEPI_INPUT_RESUBMIT_REQUIRED'` for stale proofs, epoch races and fenced input. Rejected bodies are neither parked nor requeued — they must be re-sent as fresh input.

**Check** — `sqlite3 "$DBFILE" "select status,error_code from requests where status='resubmit_required'"`; the `history_work` rows record the fence state.

**Fix** — Let the sweep finish (`sweep()` runs on `turn/end`, `agent/created` and `agent/status: idle`), then resend the message. Retrying the *same* request only reports `resubmit_required` again, by design. If sweeps keep failing, the launcher logs `LEPI_HISTORY_BLOCKED` — see the next entry.

### `LEPI_HISTORY_BLOCKED` in the logs

**Symptom** — The runtime log (dsh's output, where the plugin logs) shows `LEPI_HISTORY_BLOCKED` repeatedly.

**Likely cause** — `src/index.ts` dispatches sweeps through an unref'd timer and logs this code when `history.sweep()` rejects: `history.sweep().catch(() => logger.error('LEPI_HISTORY_BLOCKED'))`. Sweeps run after turn end, on agent creation and when an agent goes idle. A blocked sweep usually means an epoch changed under the proof, the JSONL flush failed, or a replacement would break tool pairing.

**Check** — `sqlite3 "$DBFILE" "select * from history_work order by updated_at desc limit 5"`; look for `error_code` values (frequently `LEPI_INPUT_RESUBMIT_REQUIRED`) and the request status.

**Fix** — Treat it as a fence, not a crash: the runtime stays consistent and the pending request keeps its fence. For a stuck case, resolve the underlying condition (a failed session flush, a repeated policy change) and let the next sweep run. Do not clear `history_work` by hand — the fence is what keeps a forgotten target out of later provider requests.

### `LEPI_WORKER_STOPPED`

**Symptom** — A recall or memory operation throws `LEPI_WORKER_STOPPED`.

**Likely cause** — `src/memory.ts` `runRecall()` throws this when recall is requested after `dispose()`. It is a lifecycle error, not a data error: the plugin was shut down while work was in flight.

**Check** — Look for a shutdown in the same log window (the dispose effect disposes control, history and memory, then closes the store).

**Fix** — Nothing to repair; the request belongs to a runtime that has already stopped. `[INFERENCE]` On a clean restart, memory starts again (`memory.start()` runs during `apply`).

## Actions

### Why is `LEPI_RETAIN_EMPTY` reported for a write that "completed"?

**Symptom** — A write task finishes as `failed` with `error_code = 'LEPI_RETAIN_EMPTY'`, the lifecycle becomes `audit_only`, and no `raw_links` row exists.

**Likely cause** — The backend reported the operation completed but returned no usable raw unit. The runtime refuses to declare a written receipt or a current snapshot without usable raw material.

**Check** — `sqlite3 "$DBFILE" "select status,error_code from tasks where kind='write' order by next_at desc limit 5"`; Hindsight's own UI on `127.0.0.1:9999` shows what the document actually contains.

**Fix** — Investigate on the memory-service side (model configuration, document rejection). Do not convert the failure into success by inserting a `raw_links` row: the lifecycle `raw proof` checks are what make later recall trustworthy.

### `write_note` fails

**Symptom** — The tool returns an error whose message carries a `LEPI_NOTE_*` code; no file appears, or a file exists but the journal says `unknown`.

**Likely cause** — `src/action.ts` maps each failure to a stable code:

| Code | Trigger |
| --- | --- |
| `LEPI_NOTE_EMPTY` | Empty/whitespace title or body |
| `LEPI_NOTE_INVALID` | Schema violation reported by `validateJsonSchemaValue` |
| `LEPI_NOTE_WRITE_FAILED` | The file write, hash or commit failed |
| `LEPI_NOTE_COLLISION` | The atomic `link()` found an existing destination (`EEXIST`); the existing file is never overwritten or removed |
| `LEPI_NOTE_UNKNOWN` | The journal cannot prove the outcome (recovery found a missing or changed final file) |
| `LEPI_ACTION_IDENTITY` | The exact `(sessionId, callId)` turn/step could not be established; the tool refuses to guess an old step |
| `LEPI_APPROVAL_UNAVAILABLE` | The approval service is missing, so the tool cannot ask |

Note that a rejection by the operator is **not** an error code: it is a normal outcome (`rejected`/`cancelled`/`unavailable`) recorded with `executed: false`.

**Check** — `sqlite3 "$DBFILE" "select action_id,status,state_applied,path,error_code from actions order by rowid desc limit 10"`; `ls "$DSH_HOME/lepimemory/notes/"`.

**Fix** — For a collision, choose a different title or accept the existing file: the runtime will not clobber it. For `LEPI_NOTE_UNKNOWN`, inspect the recorded `path` and compare its content hash with the journal by hand; recovery deliberately neither rewrites nor deletes files it cannot prove it owns. For `LEPI_ACTION_IDENTITY`, treat it as a runtime bug in identity tracking rather than an input problem — the code requires a positive integer turn/step derived from the real `tool/call` event.

## Error-code index

A single place to look up where a code comes from.

| Code | Origin |
| --- | --- |
| `LEPI_UNSUPPORTED_PLATFORM`, `LEPI_BOOTSTRAP_BUSY`, `LEPI_BOOTSTRAP_UNAVAILABLE`, `LEPI_ARTIFACT_INTEGRITY` | `scripts/bootstrap-runtime.sh` |
| `LEPI_NODE_VERSION_MISMATCH`, `LEPI_NODE_UNBOUND`, `LEPI_PNPM_MISSING`, `LEPI_PNPM_VERSION_MISMATCH`, `LEPI_LOCKFILE_MISSING`, `LEPI_DEPS_MISSING`, `LEPI_INSTALL_FAILED`, `LEPI_TYPECHECK_FAILED` | `scripts/build.mts` |
| `LEPI_CLI_MISSING`, `LEPI_CLI_VERSION_MISMATCH`, `LEPI_CORE_VERSION_MISMATCH`, `LEPI_CORE_NOT_READY`, `LEPI_DEV_FAILED`, `LEPI_VERIFY_MISSING`, `LEPI_VERIFY_FAILED` | `scripts/src/runtime.ts` |
| `LEPI_PROFILE_CONFLICT`, `LEPI_PROFILE_SHAPE`, `LEPI_PROFILE_SOURCE_MISSING` | `scripts/src/runtime.ts` profile generation |
| `LEPI_CONNECTION_INCOMPLETE`, `LEPI_CONFIG_INVALID`, `LEPI_ENV_FILE` | `src/config.ts` |
| `LEPI_STATE_INVALID`, `LEPI_STORE_UNAVAILABLE`, `LEPI_STORE_OWNED` | `src/store.ts` |
| `LEPI_HINDSIGHT_UNAVAILABLE`, `LEPI_HINDSIGHT_CONFLICT` | `src/hindsight.ts` / `src/recall.ts` |
| `LEPI_CONTROL_UNAVAILABLE`, `LEPI_INPUT_RESUBMIT_REQUIRED`, `LEPI_NO_INITIATOR` | `src/history.ts`, `src/control.ts` |
| `LEPI_MEMORY_SUPPRESSED`, `LEPI_GRANT_INVALID` | `src/trust.ts`, `src/memory-authorization.ts` |
| `LEPI_SOURCE_CHANGED`, `LEPI_SOURCE_UNKNOWN`, `LEPI_SOURCE_MISSING`, `LEPI_SOURCE_ABORTED`, `LEPI_SOURCE_UNLINKED`, `LEPI_OBSERVATION_INCOMPLETE` | `src/recall-source.ts`, `src/trust.ts`, `src/hindsight.ts` |
| `LEPI_SNAPSHOT_INVALID` | `src/raw-source.ts`, `src/trust.ts`, `src/recall-source.ts`, `src/memory-authorization.ts` |
| `LEPI_SNAPSHOT_IMMUTABLE` | `src/store.ts` schema triggers |
| `LEPI_POLICY_CHANGED` | `src/memory-authorization.ts` (also checked in the workers and `src/recall-source.ts`) |
| `LEPI_WRITE_TARGET_CHANGED` | `src/write-worker.ts` |
| `LEPI_CURATE_INVALID`, `LEPI_CURATE_MISMATCH`, `LEPI_CURATE_SOURCE_MISSING`, `LEPI_CURATE_UNPROVEN` | `src/curate-worker.ts` |
| `LEPI_RETAIN_EMPTY` | `src/write-worker.ts` |
| `LEPI_EVIDENCE_BUDGET` | `src/processor.ts`, `src/memory-pipeline.ts` |
| `LEPI_INCOMPLETE_STREAM` | `src/processor.ts` |
| `LEPI_RECALL_UNAVAILABLE`, `LEPI_WORKER_STOPPED` | `src/recall.ts`, `src/memory.ts` |
| `LEPI_RETRY_FORBIDDEN` | `src/panel.ts` retry route |
| `LEPI_NOTE_*`, `LEPI_ACTION_IDENTITY`, `LEPI_APPROVAL_UNAVAILABLE` | `src/action.ts` |
| `LEPI_AVATAR_UNAVAILABLE` | `src/panel.ts` avatar route |
| `LEPI_HISTORY_BLOCKED` | `src/index.ts` sweep failure log |

## Related documents

- [CONFIGURATION.md](./CONFIGURATION.md) — every variable, its default and its validation.
- [RUNTIME.md](./RUNTIME.md) — install/dev/verify flow and the health gate.
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Docker services, volumes and the install profile.
- [TESTING.md](./TESTING.md) — how the fail-closed contracts above are pinned by tests.
- [MEMORY.md](./MEMORY.md) — the lifecycle and worker stages behind deferred/parked states.
- [RECALL.md](./RECALL.md) — why a source is excluded from recall.
- [ACTION.md](./ACTION.md) — the action journal and recovery semantics.
- [OBSERVABILITY.md](./OBSERVABILITY.md) — reading audit rows, history and health to diagnose.
