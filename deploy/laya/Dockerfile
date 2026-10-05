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
# In a network that cannot reach huggingface.co, add:
#   --build-arg HF_ENDPOINT=https://hf-mirror.com

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
# the offline runtime loads.
COPY deploy/laya/server.py /opt/lepimemory-laya/server.py
RUN HF_HUB_OFFLINE=0 HF_ENDPOINT="$HF_ENDPOINT" python -c "\
from huggingface_hub import snapshot_download; \
snapshot_download('convaiinnovations/laya-multilingual', \
revision='1720e3e3357cfe1e281542e223f8273b0890ca34', \
allow_patterns=['config.json', 'rl_agent_config.json', 'model.safetensors', 'tokenizer/*', 'encoder/*'])"

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
