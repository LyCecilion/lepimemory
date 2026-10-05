"""Standalone laya serve app for Lepimemory.

One fixed checkpoint — ``convaiinnovations/laya-multilingual`` pinned to the reviewed
commit — served as a standalone router (not the default ``convaiinnovations/laya`` bundle,
and with no global ``LAYA_REVISION``). The checkpoint is baked into ``HF_HOME`` at image
build time, so the running container is hermetic: ``HF_HUB_OFFLINE=1`` means no Hub call
ever happens, and a cold start never re-verifies a remote revision.

CPU-only, two torch threads. The server-side request caps (``LAYA_MAX_CONCURRENT``,
``LAYA_MAX_TOKEN_BUDGET``) and the bearer token (``LAYA_API_KEY``) are supplied from the
environment by the deployment, not hard-coded here.
"""

import torch

# Cap intra-op threads before any model construction or forward pass.
torch.set_num_threads(2)

import laya.serve  # noqa: E402  (must follow the thread cap)
from laya import Router  # noqa: E402

MODEL_REPO = "convaiinnovations/laya-multilingual"
MODEL_REVISION = "1720e3e3357cfe1e281542e223f8273b0890ca34"


router = Router(
    models={"multilingual": MODEL_REPO},
    device="cpu",
    revisions={"multilingual": MODEL_REVISION},
    default="multilingual",
    max_loaded=1,
).preload(["multilingual"])

app = laya.serve.create_app(router)
