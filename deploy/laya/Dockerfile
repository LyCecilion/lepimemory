# Lepimemory laya serve service — standalone multilingual router, CPU-only, hermetic.
#
# Base image pinned by digest (python:3.12.13-slim). Runtime dependencies install from
# a fully hash-pinned lock (requirements.lock) with --require-hashes: no resolver and no
# pip-tools ever run at image build. The fixed checkpoint is cached into HF_HOME during
# the build, after which the container runs with HF_HUB_OFFLINE=1 and never contacts the
# Hub. The vendor compose file supplies the network/port/env wiring; this image only
# packages and launches the server.
#
# Build context is the repository root:
#   docker build -f deploy/laya/Dockerfile -t <tag> .
# Pick the endpoint that matches the egress. On a direct network that cannot
# reach huggingface.co, add --build-arg HF_ENDPOINT=https://hf-mirror.com. With
# an HTTP proxy keep the official endpoint: the mirror redirects proxied clients
# to huggingface.co, so the pinned resolve metadata check fails.

FROM python:3.12.13-slim@sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36

# Build-time only: Hub endpoint used to warm the model cache. Runtime is offline.
ARG HF_ENDPOINT=https://huggingface.co

WORKDIR /opt/lepimemory-laya

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/lepimemory-laya/hf-cache \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    LAYA_MAX_CONCURRENT=1 \
    LAYA_MAX_TOKEN_BUDGET=8192

# Runtime deps. The lock file carries the PyTorch CPU extra-index line, so
# torch==2.8.0+cpu resolves from download.pytorch.org/whl/cpu — never a PyPI CUDA wheel.
COPY deploy/laya/requirements.lock /opt/lepimemory-laya/requirements.lock
RUN python -m pip install --require-hashes -r /opt/lepimemory-laya/requirements.lock

# Warm the Hub cache with the exact standalone repo revision the server pins.
# Online here (HF_HUB_OFFLINE=0 for this layer only); the cached snapshot is what
# the offline runtime loads. No --build-arg can change the revision.
COPY deploy/laya/server.py /opt/lepimemory-laya/server.py
RUN HF_HUB_OFFLINE=0 python - <<'PY'
import os

from huggingface_hub import snapshot_download

revision = "1720e3e3357cfe1e281542e223f8273b0890ca34"
endpoint = os.environ.get("HF_ENDPOINT") or "https://huggingface.co"
proxy = "configured" if any(os.environ.get(key) for key in (
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"
)) else "none"
print(f"warming laya-multilingual@{revision} endpoint={endpoint} proxy={proxy}", flush=True)
try:
    path = snapshot_download(
        "convaiinnovations/laya-multilingual",
        revision=revision,
        allow_patterns=["config.json", "rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"],
    )
except Exception as exc:  # noqa: BLE001
    raise SystemExit(
        f"cannot warm laya-multilingual@{revision}: {exc}\n"
        f"endpoint={endpoint} proxy={proxy}\n"
        "The mirror and an HTTP proxy are alternative egress paths, not a pair: "
        "behind a proxy hf-mirror.com redirects to huggingface.co and the pinned "
        "resolve metadata check fails. Build with HF_ENDPOINT=https://huggingface.co "
        "when a proxy is configured, or https://hf-mirror.com on a direct network."
    )
print(f"warmed {path}", flush=True)
PY

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
