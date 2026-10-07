# Lepimemory Hindsight memory service image (runtime-convergence plan, step 2).
#
# Base is the exact upstream image by digest (local inspect reports
# version=0.10.0, Python 3.11.16, user hindsight). The vendor ENTRYPOINT/CMD and
# runtime user are preserved untouched.
#
# The base already ships python + huggingface_hub + torch(CPU) +
# sentence-transformers, so we install nothing: we only bake the fixed
# multilingual retrieval stack into /opt/lepimemory-models so the runtime loads
# local snapshots at pinned revisions and never reaches for a floating model.

FROM ghcr.io/vectorize-io/hindsight@sha256:3edcb6165cefdeaa6721dd0fce43cfd13b7a9c346ce0d2c5f4b4bf7bc3c8ac0b

# Model identity is hardcoded in the RUN below (exact commits + expected
# dimension), so no build arg can float the baseline. Only the download endpoint
# is a build arg, and it cannot change which revision is fetched. Pick the
# endpoint that matches the egress: with an HTTP proxy use the official
# https://huggingface.co (the proxy reaches it), on a direct network use
# https://hf-mirror.com. Combining the mirror *with* a proxy fails: the mirror
# redirects proxied clients to huggingface.co and the resolve metadata then has
# no X-Repo-Commit, which snapshot_download rejects for any pinned revision.
ARG HF_ENDPOINT=https://huggingface.co

LABEL org.lepimemory.embedding.model="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42" \
      org.lepimemory.embedding.dimension="384" \
      org.lepimemory.reranker.model="cross-encoder/mmarco-mMiniLMv2-L12-H384-v1@1427fd652930e4ba29e8149678df786c240d8825"

USER root
RUN mkdir -p /opt/lepimemory-models/embedding /opt/lepimemory-models/reranker

# Download the pinned snapshots into fixed local paths, then confirm the real
# embedding dimension by loading the model.
#
# Build-time egress is required here. BuildKit forwards the predefined
# HTTP_PROXY/HTTPS_PROXY/NO_PROXY args to RUN automatically, so behind a proxy
# pass them as --build-arg. A fresh build starts with no HF cache, so a wrong
# endpoint/proxy pair fails loudly instead of silently picking a floating model;
# the exact-revision retry below only helps when a cache was pre-seeded under
# $HOME/.cache/huggingface.
RUN /app/api/.venv/bin/python - <<'PY'
import os
import shutil
import sys

from huggingface_hub import snapshot_download

endpoint = os.environ.get("HF_ENDPOINT") or "https://huggingface.co"
proxy = "configured" if any(os.environ.get(key) for key in (
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"
)) else "none"
embedding_repo = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
embedding_rev = "e8f8c211226b894fcb81acc59f3b34ba3efd5f42"
reranker_repo = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"
reranker_rev = "1427fd652930e4ba29e8149678df786c240d8825"

# Only the files a SentenceTransformers / CrossEncoder pipeline reads; skip the
# onnx/openvino/tf duplicates and the duplicate .bin weights to keep the layer
# reasonable. The pinned revision is what makes the result reproducible.
SKIP = ["*.onnx", "onnx/*", "openvino/*", "*openvino*", "*.h5", "pytorch_model.bin"]


def fetch(repo_id, revision, dest):
    print(f"baking {repo_id}@{revision} from endpoint={endpoint} -> {dest}", flush=True)
    try:
        snapshot_download(
            repo_id=repo_id,
            revision=revision,
            local_dir=dest,
            endpoint=endpoint,
            ignore_patterns=SKIP,
            max_workers=4,
        )
        print(f"downloaded {repo_id}@{revision} -> {dest}", flush=True)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"online fetch failed for {repo_id}@{revision}: {exc}\n")
        sys.stderr.write("retrying from the local hub cache for that exact revision only\n")
        # With local_dir, the hub may return an existing empty directory on a
        # cache miss. Resolve the exact cached snapshot first, then copy it. A
        # fresh build has no populated cache, so this only succeeds when the
        # caller pre-seeded one; otherwise fail loudly with the real cause.
        try:
            cached = snapshot_download(
                repo_id=repo_id,
                revision=revision,
                local_files_only=True,
                ignore_patterns=SKIP,
            )
        except Exception as cache_exc:  # noqa: BLE001
            raise SystemExit(
                f"cannot bake {repo_id}@{revision}: online fetch failed ({exc}); "
                f"no cached snapshot for that exact revision either ({cache_exc}).\n"
                f"endpoint={endpoint} proxy={proxy}\n"
                "The mirror and an HTTP proxy are alternative egress paths, not a "
                "pair: behind a proxy hf-mirror.com redirects to huggingface.co and "
                "the resolve metadata has no X-Repo-Commit. Build with "
                "HF_ENDPOINT=https://huggingface.co when a proxy is configured, or "
                "HF_ENDPOINT=https://hf-mirror.com on a direct network."
            )
        shutil.copytree(cached, dest, dirs_exist_ok=True)
        print(f"materialized {repo_id}@{revision} from cache -> {dest}", flush=True)


fetch(embedding_repo, embedding_rev, "/opt/lepimemory-models/embedding")
fetch(reranker_repo, reranker_rev, "/opt/lepimemory-models/reranker")

# Confirm the actual dimension against the loaded model, fully offline.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
from sentence_transformers import SentenceTransformer, CrossEncoder

embedder = SentenceTransformer("/opt/lepimemory-models/embedding")
dim = embedder.get_sentence_embedding_dimension()
expected = 384
if dim != expected:
    raise SystemExit(f"embedding dimension {dim} != expected {expected}")
print(f"embedding dimension verified: {dim}", flush=True)

reranker = CrossEncoder("/opt/lepimemory-models/reranker")
print(f"reranker loaded: hidden_size={reranker.model.config.hidden_size}", flush=True)
PY

RUN chown -R hindsight:hindsight /opt/lepimemory-models

# Point the vendor local providers at the baked snapshots and persist raw
# document text so unknown writes can be reconciled against the original payload.
ENV HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL=/opt/lepimemory-models/embedding \
    HINDSIGHT_API_RERANKER_LOCAL_MODEL=/opt/lepimemory-models/reranker \
    HINDSIGHT_API_STORE_DOCUMENT_TEXT=true

# Restore the vendor runtime user; ENTRYPOINT/CMD stay untouched.
USER hindsight
