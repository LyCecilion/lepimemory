# Deployment

This document is the operator reference for the two fixed memory services Lepimemory depends on: `hindsight` (memory engine) and `laya` (local admission router). It covers their images, ports, volumes, healthchecks, environment contract, the build-time egress rules that decide which model hub is used, and the commands needed to run them. Read it when bringing up a machine, rebuilding images, or diagnosing a service that will not become healthy.

Both services are defined once, in `docker-compose.yml`, with pinned image tags and pinned model revisions. There is no separate production stack: the same compose project is used for the documented local development flow and for a long-running host.

## The two services at a glance

| | `hindsight` | `laya` |
| --- | --- | --- |
| Image | `lepimemory-hindsight:0.10.0` | `lepimemory-laya:0.3.26` |
| Dockerfile | `deploy/hindsight/Dockerfile` | `deploy/laya/Dockerfile` |
| Base | `ghcr.io/vectorize-io/hindsight@sha256:3edcb616…8ac0b` (upstream 0.10.0) | `python:3.12.13-slim@sha256:229a2c5b…30d36` |
| Container name | `hindsight` (explicit `container_name`) | unset — compose generates one from the project name |
| Published ports | `127.0.0.1:8888` (REST), `127.0.0.1:9999` (built-in UI) | `127.0.0.1:8000` (HTTP) |
| Volumes | `hindsight-data` → `/home/hindsight/.pg0`, `hindsight-hf-cache` → `/home/hindsight/.cache/huggingface` | none (image content is immutable) |
| Health probe | Python `urllib` GET `/health` | Python `urllib` GET `/health` and assert the loaded revision |
| Grace period | `start_period: 600s` | `start_period: 120s` |
| Restart policy | `unless-stopped` | `unless-stopped` |
| Build network | `network: host` (build only) | `network: host` (build only) |
| Consumes | resolved Hindsight LLM route + retrieval models | independent service token + request caps |

Both bind to loopback only. The dsh process runs on the host, not in a container, so the resolved service URLs in `.env` must use those loopback addresses: `LEPI_HINDSIGHT_URL=http://127.0.0.1:8888` and `LEPI_LAYA_URL=http://127.0.0.1:8000`. Reaching either service from another machine requires an SSH tunnel; the compose file does not offer a remote-bind option.

## Hindsight

### Image

`deploy/hindsight/Dockerfile` pins the upstream image by digest (`FROM ghcr.io/vectorize-io/hindsight@sha256:3edcb6165cefdeaa6721dd0fce43cfd13b7a9c346ce0d2c5f4b4bf7bc3c8ac0b`, locally inspected as version 0.10.0, Python 3.11.16, user `hindsight`). The vendor `ENTRYPOINT`/`CMD` and runtime user are preserved: the Dockerfile installs nothing and adds no Python packages, because the base already ships `python`, `huggingface_hub`, CPU `torch`, and `sentence-transformers`.

What the image does add is a **baked, revision-pinned retrieval stack**:

| Role | Repository | Revision | Local path |
| --- | --- | --- | --- |
| Embeddings | `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` | `e8f8c211226b894fcb81acc59f3b34ba3efd5f42` | `/opt/lepimemory-models/embedding` |
| Reranker | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` | `1427fd652930e4ba29e8149678df786c240d8825` | `/opt/lepimemory-models/reranker` |

Both repositories and revisions are hardcoded in the `RUN` heredoc, and the same pairs appear as `LABEL` metadata (`org.lepimemory.embedding.model`, `org.lepimemory.embedding.dimension="384"`, `org.lepimemory.reranker.model`). The only build argument is `HF_ENDPOINT`, which can change *where* the snapshots are fetched from but cannot change *which revision* is fetched. `SKIP = ["*.onnx", "onnx/*", "openvino/*", "*openvino*", "*.h5", "pytorch_model.bin"]` keeps the layer to the files a SentenceTransformers/CrossEncoder pipeline actually reads.

After downloading, the build turns the Hub off (`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`), instantiates `SentenceTransformer` on the baked directory, and **asserts the real embedding dimension is 384**, then loads the `CrossEncoder` so a broken reranker fails the build rather than the first request. The tree is `chown`ed to `hindsight:hindsight` and the runtime user is restored.

If the online fetch fails, the script retries from the local Hub cache **for that exact revision only** and copies the resolved snapshot into place. A fresh build has no populated cache, so this path only helps when the caller pre-seeded one; otherwise the build aborts with the endpoint, proxy state, and the mirror-vs-proxy explanation printed.

### Runtime contract

| Compose environment | Source | Meaning |
| --- | --- | --- |
| `HINDSIGHT_API_LLM_PROVIDER` | launcher `dockerEnv()` | `openai` when the Hindsight LLM route is configured, else `none` (read-only) |
| `HINDSIGHT_API_LLM_BASE_URL` | launcher | resolved Hindsight route base URL |
| `HINDSIGHT_API_LLM_MODEL` | launcher | resolved Hindsight model (default `deepseek-flash`) |
| `HINDSIGHT_API_LLM_API_KEY` | launcher | resolved Hindsight route key; absent when unconfigured, so no key is ever sent to a default endpoint |
| `HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL` | compose (`/opt/lepimemory-models/embedding`) | overrides the sample `.env` value with the baked path |
| `HINDSIGHT_API_RERANKER_LOCAL_MODEL` | compose (`/opt/lepimemory-models/reranker`) | overrides the sample `.env` value with the baked path |
| `HINDSIGHT_API_STORE_DOCUMENT_TEXT` | compose (`"true"`) | persist raw document text so an unknown write can be reconciled against the original payload |
| `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE` | compose (`"1"`) | runtime never contacts the Hub |

Volumes are pinned by explicit name rather than by compose's project-prefixed default:

- `hindsight-data` → `/home/hindsight/.pg0` — the embedded Postgres data directory; the fixed name keeps existing deployments (and existing memory banks) attached across rebuilds and across directories the compose project is started from.
- `hindsight-hf-cache` → `/home/hindsight/.cache/huggingface` — the Hub cache; keeping it out of the container means a rebuild does not re-download models.

`restart: unless-stopped` means a crashed service comes back after a host reboot or Docker daemon restart, but an operator-issued `docker compose stop` is respected.

### Healthcheck

```yaml
test: ["CMD", "python3", "-c",
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8888/health', timeout=3)"]
interval: 15s
timeout: 5s
retries: 20
start_period: 600s
```

The image has no `curl`/`wget`, hence `python3`. The probe proves that the service's own HTTP `/health` endpoint answers on its internal port, inside the container, after the vendor entrypoint has finished initialising. `start_period: 600s` is generous on purpose: the very first start creates the Postgres database and loads the baked models.

## Laya

### Image

`deploy/laya/Dockerfile` builds from `python:3.12.13-slim` pinned by digest. Two properties define it:

**Hash-pinned dependencies, no resolver at build time.** Only `deploy/laya/requirements.lock` is copied and installed:

```dockerfile
RUN python -m pip install --require-hashes -r /opt/lepimemory-laya/requirements.lock
```

The lock was generated by `pip-compile` (the exact command is recorded in its header) from `deploy/laya/requirements.in`, which states the two deliberate inputs:

```
laya[serve]==0.3.26
torch==2.8.0+cpu
```

The lock carries `--extra-index-url https://download.pytorch.org/whl/cpu` (so `torch==2.8.0+cpu` resolves from the PyTorch CPU wheel index, never a PyPI CUDA wheel) and per-package `--hash=sha256:…` entries. `pip-tools` is not installed in the image; the lock is never re-resolved during a build.

**Hermetic runtime.** The checkpoint is warmed into `HF_HOME=/opt/lepimemory-laya/hf-cache` during the build with `HF_HUB_OFFLINE=0` for that layer only:

```python
snapshot_download(
    "convaiinnovations/laya-multilingual",
    revision="1720e3e3357cfe1e281542e223f8273b0890ca34",
    allow_patterns=["config.json", "rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"],
)
```

A failure aborts the build with the endpoint/proxy state and the mirror-vs-proxy explanation. The image environment then sets `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `PYTHONUNBUFFERED=1`, `PYTHONDONTWRITEBYTECODE=1`, `PIP_NO_CACHE_DIR=1`, plus the two request caps `LAYA_MAX_CONCURRENT=1` and `LAYA_MAX_TOKEN_BUDGET=8192`. The container serves with:

```dockerfile
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
```

There are **no volumes** for Laya. Everything it needs is baked into the image; state written at runtime would not survive a recreation, and the service is designed not to need any.

### What `server.py` exposes

`deploy/laya/server.py` is deliberately small and fixed:

| Aspect | Behavior |
| --- | --- |
| Thread cap | `torch.set_num_threads(2)` is called *before* importing `laya.serve` or constructing any model, so intra-op parallelism cannot exceed two threads on CPU |
| Model identity | `MODEL_REPO = "convaiinnovations/laya-multilingual"`, `MODEL_REVISION = "1720e3e3357cfe1e281542e223f8273b0890ca34"` as module constants |
| Router | `Router(models={"multilingual": MODEL_REPO}, device="cpu", revisions={"multilingual": MODEL_REVISION}, default="multilingual", max_loaded=1).preload(["multilingual"])` |
| App | `app = laya.serve.create_app(router)` served by uvicorn as `server:app` |
| Standalone | This is the standalone `laya-multilingual` router, not the default `convaiinnovations/laya` bundle, and no global `LAYA_REVISION` is set |
| Auth | The bearer token comes from `LAYA_API_KEY` in the environment; the plugin sends `Authorization: Bearer <token>` only when the key is non-empty (`dsh/plugins/dsh-lepimemory-state/src/admission.ts`) |
| Request caps | `LAYA_MAX_CONCURRENT` and `LAYA_MAX_TOKEN_BUDGET` are supplied by the deployment, not hardcoded |
| Offline | With `HF_HUB_OFFLINE=1` a cold start loads the cached snapshot and never re-verifies a remote revision |

The compose service maps the plugin-facing token into the container and pins the caps explicitly:

| Compose environment | Value |
| --- | --- |
| `LAYA_API_KEY` | `${LEPI_LAYA_API_KEY:-}` — the same token the plugin uses as `LEPI_LAYA_API_KEY` |
| `LAYA_MAX_CONCURRENT` | `"1"` |
| `LAYA_MAX_TOKEN_BUDGET` | `"8192"` |
| `HF_HUB_OFFLINE` | `"1"` |

### Healthcheck

```yaml
test:
  - CMD
  - python
  - -c
  - "import json,os,urllib.request; key=os.environ.get('LAYA_API_KEY',''); r=urllib.request.Request('http://127.0.0.1:8000/health', headers={'Authorization':'Bearer '+key} if key else {}); h=json.load(urllib.request.urlopen(r, timeout=3)); assert h['revisions']['multilingual']=='1720e3e3357cfe1e281542e223f8273b0890ca34'"
interval: 15s
timeout: 5s
retries: 20
start_period: 120s
```

This probe does three things a plain liveness check would not: it sends the bearer token when one is configured (proving the auth path the plugin uses works), parses the JSON body, and **asserts the loaded revision** of the `multilingual` route equals the pinned commit. A container serving a different checkpoint is reported unhealthy instead of silently answering with the wrong model. Note the field is `revisions` on the response body (the Router's property is `loaded_revisions`).

## Build-time egress: proxy versus mirror

Both Dockerfiles take exactly one egress build argument, `HF_ENDPOINT`, defaulting to `https://huggingface.co`. The compose file forwards it and the proxy variables:

```yaml
build:
  context: .
  dockerfile: deploy/hindsight/Dockerfile
  # Build-only host network reaches a loopback proxy; runtime stays bridged.
  network: host
  args:
    HF_ENDPOINT: ${HF_ENDPOINT:-https://huggingface.co}
    HTTP_PROXY: ${HTTP_PROXY:-${http_proxy:-}}
    HTTPS_PROXY: ${HTTPS_PROXY:-${https_proxy:-}}
```

`network: host` applies to the build only — the running container is bridged. It exists because a proxy listening on the host's loopback is unreachable from a build container on the default bridge network.

The pitfall, documented in the compose comments and in both Dockerfiles, is that **the Hugging Face mirror and an HTTP proxy are alternative egress paths, not a pair**:

- Behind an HTTP proxy, `hf-mirror.com` answers with a cross-domain redirect to `huggingface.co`. The resolve response in that flow carries no `X-Repo-Commit`, so `snapshot_download` aborts with a `FileMetadataError` ("Distant resource does not seem to be on huggingface.co") even though the revision is pinned. Use `https://huggingface.co` when a proxy is configured.
- On a direct network — e.g. a campus network where `huggingface.co` is DNS-poisoned — only the mirror is reachable. Use `https://hf-mirror.com` with no proxy.

The launcher resolves this automatically via `buildHfEndpoint()` in `scripts/src/runtime.ts` and passes the result as `HF_ENDPOINT` in the compose child environment:

| Condition | Endpoint used |
| --- | --- |
| `HF_ENDPOINT` set in the environment or `.env` (non-blank) | that value, verbatim |
| otherwise, any of `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` non-blank | `https://huggingface.co` |
| otherwise | the configured default `https://hf-mirror.com` |

Because the resolved value is placed in the compose process environment, the `${HF_ENDPOINT:-https://huggingface.co}` substitutions in the build args and the container env pick it up. Whichever endpoint wins, model identity is unaffected: revisions and hashes are hardcoded, and a wrong endpoint/proxy pairing fails the build loudly rather than falling back to a floating model.

## Operator commands

Bring up both services through the launcher (recommended — it injects resolved connections in memory and resolves `HF_ENDPOINT`):

```bash
make dev                 # builds images on first run, then starts the pinned dsh CLI
```

Or manage the compose project directly:

```bash
docker compose up -d hindsight laya     # start (building if necessary)
docker compose build hindsight laya     # rebuild images, keep volumes
docker compose ps                       # status + health
docker compose logs -f hindsight        # first start is slow: database + models
docker compose logs -f laya
```

Probe the services by hand:

```bash
curl -s http://127.0.0.1:8888/health
curl -s -H "Authorization: Bearer $LEPI_LAYA_API_KEY" http://127.0.0.1:8000/health
```

Rebuild an image without compose, reproducing the build args the compose file would pass:

```bash
docker build -f deploy/hindsight/Dockerfile -t lepimemory-hindsight:0.10.0 .
docker build -f deploy/laya/Dockerfile -t lepimemory-laya:0.3.26 .
# direct network, no proxy:      --build-arg HF_ENDPOINT=https://hf-mirror.com
# behind a proxy:                --build-arg HTTPS_PROXY=... --build-arg HTTP_PROXY=...
```

Lifecycle and data-safety commands:

| Command | Effect |
| --- | --- |
| `make stop` | `docker compose stop` — containers stopped, data and volumes intact |
| `make clean` | `docker compose down` — containers and network removed, **named volumes preserved** |
| `make reset` | `docker compose down -v` **plus** `rm -rf ${DSH_HOME:-./.dsh}` — destroys both memory volumes and all dsh runtime state, including the SQLite store and sessions |

`make reset` is the only command that destroys memory data. It is never part of verification: the runtime plan explicitly forbids using it to validate new behavior.

## Local development versus a deployment

There is no separate deployment mode — the difference is who starts the services and how credentials arrive.

| | Local development | Deployment |
| --- | --- | --- |
| Orchestration | `make dev` via `scripts/dist/runtime.js dev`, which runs `docker compose --progress plain up -d --build` and then boots dsh | `docker compose up -d` (same file, same tags), dsh started separately or via `make dev` |
| Build | happens on first `make dev`, using the resolved `HF_ENDPOINT` and forwarded proxy | images built ahead of time on a machine with egress, then either built on the host or shipped |
| Credentials | resolved from `.env` + process env and injected into containers/child in memory | same, but the resolved values come from the host environment; nothing is written into the profile |
| Unconfigured connection | allowed: Hindsight runs with `HINDSIGHT_API_LLM_PROVIDER=none`, the UI is read-only, no default endpoint is contacted | same behavior; a deployment that must be read-only can simply omit the LLM connection |
| Endpoint reachability | all three ports are loopback-bound on one host | loopback-bound as well; provide access through an SSH tunnel rather than rebinding |

Note that the repository's own README states the project is not asserted to be production-ready; this section describes the intended deployment shape of the two services, not a support commitment.

## Related documents

- [RUNTIME.md](./RUNTIME.md) — the launcher that starts these services, `dockerEnv()`/`buildHfEndpoint()`, and the `make` graph
- [CONFIGURATION.md](./CONFIGURATION.md) — `LEPI_HINDSIGHT_*`, `LEPI_LAYA_*`, `LEPI_BANK`, and the retrieval sample fields
- [MEMORY.md](./MEMORY.md) — how the plugin uses the Hindsight REST API (banks, operations, documents)
- [ACTION.md](./ACTION.md) — how admission calls Laya with the bearer token and request caps
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — diagnosing unhealthy services and failed model bakes
