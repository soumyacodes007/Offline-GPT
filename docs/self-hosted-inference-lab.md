# Self-hosted inference lab: architecture, models, benchmarks, and a $30 Modal run

Status: research plan, 2026-11-23. Nothing here is built yet. Claims marked
**(verify)** came from secondary sources or memory and must be checked against
the pinned version before a paid run.

## 0. TL;DR

- **Goal:** turn OfflineGPT into a self-hostable stack for regulated, air-gapped
  orgs (PSU-style): our own models on a few GPUs, with routing, GPU sharing, and
  failover, plus benchmark evidence that it works.
- **Stack:** Den inference gateway → **vLLM Semantic Router** (chooses which
  model and how much reasoning) → **GPU manager** (ours: sleeps and wakes models,
  session leases) → **vLLM Router** per model pool (session- and cache-aware
  load balancing) → **vLLM** replicas, with **LMCache** for keeping KV cache in
  CPU memory.
- **Models:** one main model (Inkling 2 Mini: agent, vision, drawings), one OCR
  model (0.9B class), one embedding model and a reranker, plus a big coder model
  only on large profiles. No Indic-language model and no GPU-hungry safety
  model; safety checks run on CPU.
- **Benchmarks:** 29 experiments in 8 groups. **AIPerf** is the single load tool,
  because it replays the AgentX agent traces natively and sends session IDs.
- **Run:** Modal Starter gives $30 a month and allows at most 10 GPUs at once.
  Seven GPU lanes run in parallel for about 60 minutes and cost about **$19**,
  which leaves roughly $11 for dry runs and one re-run. Month 2's $30 can buy a
  30-minute 8×H100 lane for the big coder model.
- **Demos that show the skills:** 12 scripted scenarios (section 7). Examples:
  "a vision request arrives, the coder model sleeps and the vision model wakes",
  "kill a replica mid-agent-run", and "routing reasoning effort halves GPU time".

---

## 1. What we are proving

1. **Agent workloads are different.** Agents resend almost the same prompt at
   every step, so prefix caching and session-sticky routing dominate the results.
2. **A few GPUs can serve many models.** Sleep mode plus a GPU manager lets two
   GPUs serve main, OCR, embedding, and nightly batch work without users noticing
   the swaps.
3. **Routing pays.** Semantic routing (choosing the model and the effort) and
   load balancing (choosing the replica) each cut cost or latency in a way we can
   measure.
4. **It's safe without spending GPUs on safety.** Permissions, approvals, audit
   and CPU-only checks, with red-team numbers to back them up.
5. **We know where each technique stops helping:** speculative decoding at high
   concurrency, cache hit rate as replicas are added, and so on.

---

## 2. Current architecture (as of this branch)

```
 ┌──────────────────────────── Desktop (Electron) ────────────────────────────┐
 │ apps/app (React UI)  ──HTTP/SSE──>  apps/server (offlinegpt-server)          │
 │   • chat, subagent strip, trajectory        • spawns managed OpenCode v2     │
 │   • opencode-v2-adapter maps v2 events      • writes opencode.json:          │
 │     (subagent → task)                         permissions + plugins          │
 │                                               (managed-policy, offlinegpt-   │
 │                                                office, offlinegpt-tools)     │
 │                                             • engine: OpenCode v2.3.2        │
 └───────────────┬──────────────────────────────────────────────────────────────┘
                 │ model calls (any of 50+ providers, or the OfflineGPT provider)
                 ▼
 ┌───────────────────────────── Den (ee/apps) ─────────────────────────────────┐
 │ den-api      orgs, roles (owner > super-admin > admin > member), teams,      │
 │              desktop policies (member/team/role) → executionRules()          │
 │ den-web      admin console                                                    │
 │ den-gateway  MCP gateway (search_capabilities / execute_capability)           │
 │ den-controller / den-worker-runtime   cloud workers (offlinegpt-server +      │
 │              vendored OpenCode)                                               │
 │ inference    Hono proxy at /api/v1/chat/completions and /api/v1/models:      │
 │              inference keys, per-org limits/buckets, analytics, Sentry;       │
 │              upstream = OpenRouter only (OPENROUTER_UPSTREAM_URL);            │
 │              model catalog = INFERENCE_MODEL_ALIASES (GLM-5.2, Kimi K2.x,     │
 │              DeepSeek V4 Flash, …) in packages/types/src/den/inference.ts     │
 └──────────────────────────────────────────────────────────────────────────────┘
 Packaging: packaging/helm/offlinegpt-ee (den-api, den-web, inference, ingress,
 migration job); packaging/docker (Dockerfile.inference, otel-lgtm compose, eval
 compose, microsandbox). Test worlds: worlds/litellm-per-member.ts,
 worlds/cloud-model-infra.ts. Benchmarks so far: evals/bench (app and engine
 latency, v1 vs v2), documented in docs/opencode-v1-v2-benchmarks.md.
```

### Gaps for self-hosting

| Gap | Today | Needed |
|---|---|---|
| Self-hosted model upstream | The inference proxy forwards only to OpenRouter | An upstream that can be any OpenAI-compatible URL (our routing stack) |
| GPU awareness | None | A GPU manager with model states, leases, sleep/wake, and a fallback order |
| Routing | The client picks the model alias | Semantic choice of model and effort, then session-aware replica choice |
| Session affinity | None | Forward a session ID header (from the OpenCode session) all the way to vLLM Router |
| Model policy | Org-level allowlist of managed models | Per-team allowed model roles; the router may only choose inside that set |
| Retrieval | No vector database in the repo | Permission-aware hybrid search: pgvector, BM25, a reranker, and per-chunk ACLs |
| Observability | OTel/LGTM compose exists | vLLM `/metrics`, GPU telemetry, and per-request routing decisions in the audit log |
| `managed-policy` v2 plugin | Listed in `build-v2-plugins.mjs`, but its source is missing from `src/opencode-plugins/v2/` **(verify)** | Fix this before relying on policy enforcement in v2 |

---

## 3. Target architecture

```
 Desktop app / web ──► Den inference gateway (ee/apps/inference, extended)
                          • auth (inference key / SSO), team → allowed roles
                          • usage limits, audit log (routing decision included)
                          • forwards x-session-id (OpenCode session id)
                          │
                          ▼
                Envoy + vLLM Semantic Router (ext_proc, CPU classifiers)
                          • signals: domain/intent, keywords, has-image, length,
                            PII/jailbreak (CPU), session-aware SAAR
                          • decision: role (main/coder/ocr/embed) + reasoning effort
                          • unsure → main
                          │
                          ▼
                GPU manager (ours)  ── controls ──► vLLM /sleep, /wake_up
                          • model state: hot / warm(sleep L1) / cold(L2 or unloaded)
                          • leases for active agent sessions
                          • priority, idle timeout, time-of-day batch windows
                          • fallback inside the allowed set
                          │
                          ▼
                vLLM Router (one per model pool)
                          • consistent_hash on x-session-id (agents)
                          • cache_aware (shared system prompts), power_of_two (bursty)
                          • P/D disaggregation on L profile
                          │
                          ▼
                vLLM replicas (+ LMCache CPU KV offload, spec decode, FP8/NVFP4)
                          │
        Prometheus ◄──────┘   (vLLM /metrics, router metrics, GPU telemetry)
        Grafana / LGTM (packaging/docker/docker-compose.otel-lgtm.yml)
```

### Components and why we chose them

| Layer | Choice | Why | Alternatives considered |
|---|---|---|---|
| Engine | vLLM, pinned version | Day-0 recipes for new models (Inkling 2), sleep mode, prefix caching, spec decode, LMCache and NIXL connectors | SGLang: faster on some shared-prefix workloads, but the vLLM Router and Semantic Router ecosystem fits better |
| Replica load balancer | vLLM Router (Rust) | Policies `round_robin`, `random`, `consistent_hash`, `power_of_two`, `cache_aware`; prefill/decode aware | llm-d (Kubernetes-heavy), Dynamo |
| Model and effort selection | vLLM Semantic Router | Go and Rust (Candle) ext_proc on Envoy; ModernBERT/mmBERT LoRA classifiers run on CPU in single-digit to roughly 20 ms; `use_reasoning` per decision | LiteLLM routing (rules only), our own classifier |
| GPU sharing | Our GPU manager on vLLM sleep mode | Must understand agent sessions (leases, KV saved before sleep). llmux and Sardeenz swap models but know nothing about sessions | llmux (CRIU needs `--privileged`), Red Hat kvcached + Sardeenz, GPUStack (fixed placement) |
| KV beyond GPU | LMCache (`LMCacheConnectorV1`, `kv_both`) | Keeps an agent's KV in CPU RAM through tool pauses and model swaps | vLLM's native offload connector (an independent study found it competitive; benchmark both) |
| Observability | Prometheus metrics from vLLM and the router, Grafana | `vllm:time_to_first_token_seconds`, `vllm:prefix_cache_hits`/`_queries`, `vllm:kv_cache_usage_perc`, `vllm:spec_decode_num_accepted_tokens_per_pos` (names vary by version: **verify**) | DCGM exporter (not available on Modal) |
| Retrieval | Postgres + pgvector + BM25 (tsvector) + reranker; per-chunk ACLs | One database to run in an air-gapped install; Qdrant only at scale | Qdrant, OpenSearch |
| Safety | CPU only: tree-sitter command policy, approvals, sandbox egress-deny, Presidio (Aadhaar with Verhoeff check, PAN, GSTIN), Prompt Guard 2 (22M/86M) | No GPU cost | Llama Guard 4 (dropped) |

### Request flow example: an agent edits code, then a scanned drawing arrives

1. The OpenCode session `s1` sends a turn to the gateway, which checks that the
   team may use roles {main, coder, ocr}, attaches `x-session-id: s1`, and writes
   an audit record.
2. The Semantic Router sees a code-heavy prompt with no image, chooses
   `role=main, effort=medium`, and records the decision.
3. The GPU manager finds main hot and renews the lease for `s1`.
4. vLLM Router hashes `s1` to replica 0, where the prefix is already cached, so
   time to first token is low.
5. The user attaches a scanned drawing. The router detects an image, but main is
   a VLM, so the request stays on main and a CPU DXF/tiling tool runs alongside.
   Only bulk OCR jobs go to the OCR role.
6. At night, the GPU manager puts main to sleep at level 1 once no lease is
   active, wakes the OCR model on GPU 1 for the batch queue, and gives the GPU
   back when users return.

### GPU manager: specification

- **States:** `hot` (serving), `warm` (sleep level 1: weights in CPU RAM, fast
  wake), `cold` (sleep level 2 or not loaded: weights on disk).
- **Inputs:** queue depth per role, active leases, recent request rate,
  configured priority, time windows, and free VRAM per GPU.
- **Rules:**
  - `min_hot` per role.
  - `idle_timeout` before moving to warm.
  - A wake on the first request that waits, and a pre-wake when the Semantic
    Router predicts a role.
  - Never sleep a model with an active lease. When memory is needed, first
    offload the lease holder's KV to LMCache and then sleep it.
  - Batch roles only take GPUs that are free in their time window and give them
    back within N seconds.
- **Fallback:** an ordered list per role that is limited to the team's allowed
  roles (for example, coder → main). It never falls back to a cloud provider in
  an air-gapped deployment.
- **API:** `GET /state`, `POST /acquire {role, session}` which returns a replica
  pool, `POST /release`, and Prometheus metrics: swap count, wake latency, and
  seconds spent in each state.
- **Implementation:** TypeScript (Hono), so it matches `ee/apps/inference`.
  Ship it inside the lab image so the code we benchmark is the code we ship.
- **Security:** vLLM `/sleep` and `/wake_up` require `VLLM_SERVER_DEV_MODE=1`.
  Bind them to a private network so that only the GPU manager can reach them.

---

## 4. Models

### Production roles

| Role | Default (S profile) | Larger profiles | Notes |
|---|---|---|---|
| **Main**: agent, coding, vision, drawings | **Inkling 2 Mini**: 26.4B MoE, 3.4B active, Apache-2.0, 1M context, text and image input. SWE-bench Verified 79.2, Terminal-Bench 2.1 71.6, OmniDocBench 92.8, ScreenSpot Pro 76.5 (vendor numbers) | **Inkling 2 Small**: 594B, 17B active; DeepSWE 72.1; vLLM day-0 support, recipe on 8× B200 in NVFP4 | The model card warns it may take destructive actions without confirmation, so app-side approvals are mandatory. Alternative to test: Qwen3.8-27B (dense) |
| **Coder** (M/L only) | — | **GLM-5.3-Flash**: 320B, 18B active, MIT, FP8 ≈ 306 GiB (4× H200 or 8× 80 GB). **DeepSeek V4.1 Flash**: 552B, MIT, ≈ 475 GB | Reached through a `coder` subagent, gated by team |
| **OCR** | A 0.9B document VLM: **PaddleOCR-VL-1.6** (OmniDocBench v1.6 96.34), **GLM-OCR** (MIT, 95.22), **OvisOCR2** (96.58, self-reported) | MinerU2.5-Pro 1.2B, Qianfan-OCR 4B | OmniDocBench is saturating; also test on PureDocBench and our own scans |
| **Embedding** | Qwen3-Embedding-4B (0.6B on S) | — | Served by vLLM in pooling mode **(verify flag)** |
| **Reranker** | Qwen3-Reranker-0.6B | — | Optional; may run on CPU |
| **Drawings** | Main model plus a CPU tool (DXF parsing or image tiling) | — | Not a separate model |
| **Safety** | CPU only (see section 3) | — | — |

**Inkling 2 Mini on H100.** The published fast formats (NVFP4/MXFP8) are
Blackwell-native. On H100, use BF16 (about 53 GB, which leaves roughly 20 GB for
KV) or an FP8/W4A16 checkpoint if one is published **(verify; no Mini recipe
was found on recipes.vllm.ai)**. If no Mini support has been released, use the
`vllm/vllm-openai:inkling-2-*` image.

### Benchmark stand-ins (cheap GPUs; the mechanism is identical)

| Purpose | Model | GPU |
|---|---|---|
| Router and load-balancing lab | Qwen3-4B (BF16) | L4 24 GB per replica |
| Semantic routing pair | Qwen3-0.6B ("cheap"), Qwen3-8B FP8 ("strong / coder stand-in") | 1 GPU shared |
| Vision for swap demos | Qwen3-VL-8B FP8 | Shares the L40S |
| Coder on S profile | Qwen3.8-27B as a stand-in for the GLM/DeepSeek tier | H100 |

Every chart that uses a stand-in model says so on the chart.

### Hardware profiles

| Profile | GPUs | Placement |
|---|---|---|
| Minimum | 1× 48 GB | Main and embedding during the day; main sleeps at night and OCR runs |
| **S (recommended)** | 2× 48 GB | GPU0: main. GPU1: embedding and reranker, with OCR on demand and batch at night |
| M | 4–8 GPUs | Main ×2 behind vLLM Router, coder (GLM-5.3-Flash FP8 on 4× H200), OCR and embedding on one GPU |
| L | 8× Blackwell | Inkling 2 Small (TP8, DSpark speculative decoding), split prefill/decode, coder pool |

---

## 5. Benchmark tool stack

| Need | Tool | Why |
|---|---|---|
| **Load generation (the only source of latency numbers)** | **NVIDIA AIPerf** | Replaces GenAI-Perf. Multi-process, so the client isn't the bottleneck. Replays **AgentX** traces natively (`--scenario inferencex-agentx-mvp`, dataset `semianalysis_cc_traces_weka_with_subagents`, with a `_256k` variant). Supports Mooncake-format traces (`timestamp`, `input_length`, `output_length`, `hash_ids`) on a fixed schedule or at fixed concurrency. Sends a **stable session ID header**, which vLLM Router's `consistent_hash` needs |
| Sweeps and readable reports | GuideLLM | `sweep`, `synchronous`, `concurrent` and `constant` profiles. Use it for #1 only if its time to first token is computed the same way as AIPerf's; otherwise skip it |
| Sanity checks | `vllm bench serve` | Quick smoke test after each server start |
| Our own traces | `bench/traces/record.ts` (new) | Reads the OpenCode sessions database and writes Mooncake-style JSONL. Store **only token lengths and hash IDs**, never prompt text, which keeps it private, as AgentX does |
| Quality | lm-eval-harness (#11, #20), MTEB subset (#23), OmniDocBench v1.7 and PureDocBench (#21), our `evals/specs` agent journeys (#19) | — |
| Server metrics | Scrape vLLM, vLLM Router and Semantic Router `/metrics` every second to JSONL | The same data feeds the charts and Grafana |
| GPU telemetry | `nvidia-smi --query-gpu=utilization.gpu,memory.used,power.draw --format=csv -lms 500` | DCGM isn't available on Modal; label power numbers as approximate |
| Charts | Python (matplotlib for PNG, Plotly for HTML), one shared style | Every chart is stamped with the GPU, the vLLM version, the model and the format |
| Videos | `scenarios/` (Remotion, DocShot) recording a Grafana dashboard and the app | For the demos in section 9 |

**Rules:**
- One load tool, AIPerf, for every latency number.
- Warm up first.
- Three repeats for hero charts, one for the rest.
- Report p50, p95 and p99.
- Publish raw JSON next to each chart.
- Pin every version.
- Always show where a technique stops helping.
- Never compare a synthetic run with a trace-replay run.

---

## 6. Benchmark catalog (49: #1–29 below, #30–32 in section 9.9, #33–49 in 6.1)

The lane letters refer to the Modal plan in section 8. "M2" means month 2
(big-GPU lane). "Local" means a laptop or CPU.

| # | Experiment | Lane | Chart | What it shows |
|---|---|---|---|---|
| 1 | Concurrency sweep 1→256 | A | Latency vs. throughput curve, with the latency target marked | The maximum number of users within the target |
| 2 | Prompt length 1K→256K | A | Time to first token vs. input length | Prefill cost of long agent contexts |
| 3 | Context size vs. concurrent sessions | A (KV size from startup logs) | Bars | KV memory, not compute, is the agent bottleneck |
| 4 | Chunked prefill on/off | A | Per-token timeline with spikes | One long prompt stalls every other user |
| 5 | **Prefix cache on/off on agent traces** (ours and AgentX) | B | Time to first token per step across a session | **Hero chart.** Agents resend the same prefix |
| 6 | **Replica policies**: round-robin, power-of-two, cache-aware, consistent-hash | E | Cache hit bars and p99 time-to-first-token distribution | **Hero chart.** Naive balancing throws the cache away |
| 7 | Tool-pause eviction: dropped vs. LMCache CPU vs. native offload | B | Time to first token after a pause, by pause length | Agents pause while tools run |
| 8 | Scale out 1→3 replicas | E | Hit rate vs. replica count, per policy | More GPUs can make caching worse |
| 9 | Speculative decoding vs. concurrency | C | Speedup crossing 1.0× | Where speculative decoding stops paying |
| 10 | Draft acceptance by task type (code, prose, JSON) | C | Bars | Tool calls are predictable |
| 11 | BF16 / FP8 / W4A16 (AWQ) | C | Accuracy vs. throughput scatter, memory bars | Which format is free and which costs accuracy |
| 12 | Prefill/decode split, 1+1 GPUs | F | p99 time between tokens under mixed load | Long prompts stop hurting decode |
| 13 | **24-hour GPU use: fixed placement vs. GPU manager** (compressed to 30 min) | D | Stacked area of GPU use by model | **Hero chart.** Two GPUs serving five roles |
| 14 | Hot / warm / cold start by model size | B, D | Log-scale bars | Sleep mode turns minutes into about a second |
| 15 | Kill a replica under load | E | Error and latency timeline | Recovery time and fallback |
| 16 | **Effort routing vs. always-high reasoning** | D | Task success vs. GPU-seconds | **Hero chart.** Same quality for less GPU |
| 17 | Semantic Router accuracy | H (CPU) | Confusion matrix and cost of each wrong route | Where it misroutes |
| 18 | Main vs. coder routing | D (stand-in), M2 (real) | Cost per solved task, by category | The big coder only where it earns its cost |
| 19 | Model comparison on `evals/specs` journeys | D, M2 | Radar chart and cost per solved task | Our numbers vs. the vendors' claims |
| 20 | Where quantization loses accuracy | C | Heatmap of task × format | Hidden accuracy loss |
| 21 | OCR by scan quality | G | Grouped bars and side-by-side images | Real-world scans |
| 22 | Drawings: DXF parse vs. full image vs. tiles | G | Dimension extraction accuracy | Why tool plus model wins |
| 23 | Search: BM25 / vector / hybrid / + rerank | G | Recall@k curves | Exact part numbers need BM25 |
| 24 | CPU safety overhead | H | Latency added per check | Safety without a GPU |
| 25 | Prompt injection via planted documents | H | Detection rate | Tested, not assumed |
| 26 | Permission red-team | Local | "0 leaks in N attempts" | What PSUs ask first |
| 27 | Cost per million tokens and per solved task vs. cloud APIs | Derived | Bars | When self-hosting pays |
| 28 | Tokens per watt (nvidia-smi) | Derived | Bars per model and format | Efficiency (approximate) |
| 29 | **Users per profile S/M/L** | Derived from #1; M/L projected | Step chart | **Hero chart.** "How many GPUs do we need?" |

### 6.1 Knowledge base, memory and RAG at scale (#33–49)

#30–32 (ACL revocation, filtered retrieval, cross-permission cache) are in
section 9.9.

**Lanes:**
- **R** (month 2): one L4 embeds the corpus once into a Volume, then a 64 GB
  CPU container runs Postgres with pgvector (and Qdrant for the comparisons).
- **G:** the paid hour's documents lane.
- **D:** the paid hour's small-model lane.
- **Local:** a laptop with 32 GB of RAM or more.

**Data:**
- **Quality:** BEIR/MS MARCO subsets, plus public government circulars and
  tender PDFs (scans, tables, mixed Hindi-English), with about 200 labelled
  questions.
- **Scale:** Wikipedia chunks, or synthetic copies, up to 10M chunks.
- **Permissions:** synthetic departments and access lists with a skewed
  distribution.

Recall is measured only on the labelled subset.

#### Memory

| # | Experiment | Lane | Chart | What it shows |
|---|---|---|---|---|
| 33 | LongMemEval and LoCoMo on **our local models**: memory files vs. Mem0-style extraction vs. the whole conversation in context | D, R | Accuracy vs. tokens per question | Vendor scores (85–97%) aren't comparable; ours are measured on one fixed setup |
| 34 | GPU cost of nightly memory extraction ("dreaming") per 1,000 conversations | D | GPU-minutes and the share of the night batch window used | Memory costs no daytime GPU |
| 35 | Memory leak test: can a fact learned from a restricted document surface for an employee without access? | Local | "0 leaks in N attempts" | Memories inherit their source's classification label |

#### Retrieval approaches compared

| # | Experiment | Lane | Chart | What it shows |
|---|---|---|---|---|
| 36 | **Agent grep vs. RAG**: 200 labelled questions, keyword/grep tools only vs. hybrid + rerank, at 100k / 1M / 10M chunks | R | Accuracy vs. GPU-seconds, with the crossover marked | Grep wins on exact codes and small sets; retrieval wins on paraphrased questions and at scale |
| 37 | **Personalisation lift**: RAG only vs. RAG + nightly-inferred user facts vs. RAG + Honcho updating on every message | D | Answer quality vs. GPU-seconds per day, plus the wrong-inference rate | Nightly inference gets most of the gain at a small fraction of the GPU cost |
| 38 | **Our RAG vs. Supermemory self-hosted**: same documents, same local models | R | Recall@k, cited-answer accuracy, p95 at 1M chunks, RAM and disk, permission-matrix leaks | A fair, published comparison; permissions and citations decide it for PSUs |

#### RAG at scale

| # | Experiment | Lane | Chart | What it shows |
|---|---|---|---|---|
| 39 | Ingestion throughput: pages per minute through parse → OCR → chunk → embed, by GPU and batch size | G | Stacked bars per stage | OCR is the bottleneck, so it goes in the night batch |
| 40 | Embedding serving: vLLM pooling, batch size vs. throughput | G, R | Throughput curve | One L4 embeds about N million chunks a night |
| 41 | Index scale 100k → 1M → 10M: build time, RAM, p95, recall | R | Log-scale lines | Where pgvector stops being enough |
| 42 | **pgvector vs. Qdrant crossover**: same data and filters | R | Two lines crossing | Postgres by default, Qdrant only beyond the measured crossover |
| 43 | Vector compression: float32 vs. `halfvec` vs. binary quantization + re-scoring | R | RAM vs. recall scatter | 10M chunks in a quarter to a half of the RAM for about 1% recall loss |
| 44 | Reranker depth: top 20/50/100, on CPU vs. GPU | G | Latency vs. quality gain | Where reranking stops paying |
| 45 | Churn: re-index 1% of documents per hour plus ACL changes while queries run | R | Query p95 over time, with churn marked | Updates don't hurt users |
| 46 | Partitioning: one table vs. partitions by collection or department | R | p95 and HNSW build time | Partitions follow how the org is structured |
| 47 | Search concurrency 1 → 500 (searches made by agents) | R | Latency vs. throughput | Agents search far more often than people |
| 48 | **RAG vs. long context**: retrieval + 8K context vs. a 200K-token prompt on the main model | A or D | Cost, latency and accuracy bars | A 1M-token window doesn't replace retrieval on cost |
| 49 | Agentic multi-query search vs. a single query | D | Accuracy vs. GPU-seconds (Pareto chart) | When it's worth letting the agent search again |

**Hero charts from this group:** #36 (grep vs. RAG crossover), #42 (pgvector vs.
Qdrant crossover), #43 (compression) and #38 (vs. Supermemory).

---

## 7. Showcase scenarios (the skills demos)

Each scenario is a script that drives traffic and records a timeline (GPU
memory per model, model states, latency, routing decisions) as a chart and a
short video.

| # | Scenario | What happens | Evidence |
|---|---|---|---|
| S1 | **Vision arrives, coder goes idle** | A coding session goes quiet, its lease expires, and an image request arrives. The GPU manager sleeps the coder at level 1 (weights to CPU RAM) and wakes the VLM | GPU-memory swim lane, wake latency, first token of the vision request |
| S2 | **Leases protect active agents** | The same as S1, but the coder session is mid-run. The manager refuses to sleep it and the vision request goes to the fallback (main VLM) instead | Decision log ("lease held by s1"), zero added latency for s1 |
| S3 | **KV survives a swap** | The coder is put to sleep with its session KV saved to LMCache, then woken; the next turn gets a cache hit | Time to first token after wake, with vs. without LMCache |
| S4 | **Semantic routing in action** | Mixed traffic: "hi" goes to the cheap model, a refactor to coder, an image to the VLM, "think step by step" turns reasoning on | Live Sankey diagram of route counts, per-route cost |
| S5 | **Effort routing** | The same model at low vs. high reasoning effort, chosen per request | Tokens and GPU-seconds saved at equal success rate |
| S6 | **Cache-aware load balancing** | Ten agent sessions on 3 replicas, round-robin vs. consistent-hash | Per-replica cache hit heatmap |
| S7 | **Failover** | `kill -9` a replica mid-run; the router ejects it and sessions re-home (one-time cache miss) | Error and latency timeline, recovery seconds |
| S8 | **Burst scale-up** | Queue depth crosses a threshold, so the manager wakes a sleeping second replica | Queue depth vs. replicas, p95 before and after |
| S9 | **Night batch yields to users** | The OCR batch runs on GPU1 at "night"; when users arrive it gives the GPU back within N seconds | Stacked GPU-use area (feeds #13) |
| S10 | **Adaptive speculative decoding** | Speculative decoding is on at low load and off at high load, chosen by the manager | Speedup curve with the switch point marked |
| S11 | **Policy-bounded routing** | Team "interns" is not allowed the coder role; the router never picks it and falls back to main | Audit log rows, 0 forbidden routes in N requests |
| S12 | **Long-context admission** | A 200K-token prompt arrives during chat traffic; chunked prefill (and on L, prefill/decode split) keeps chat smooth | p99 time between tokens with and without |

---

## 8. Running it on Modal for $30

### Constraints

- Starter plan: **$30/month in credits, up to 10 GPUs and 100 containers at
  once**. Extra demand queues rather than failing.
- Per-second prices (third-party sources, **verify** on modal.com/pricing):
  - H100: $3.95/hr
  - A100 80 GB: $2.50/hr
  - L40S: $1.95/hr
  - L4: $0.80/hr
  - B200: $6.25/hr
  - CPU: cents
- Region selection can apply a 1.5–1.75× multiplier, so leave the region
  unpinned.
- Modal has no DCGM and no Docker-in-Docker. Each lane is one container that
  runs vLLM and the other processes as subprocesses.

### Lanes (parallel, 10 GPUs, about 60 minutes)

| Lane | GPU | What runs | Experiments and scenarios | Minutes | ≈ Cost |
|---|---|---|---|---|---|
| A | 1× H100 | Inkling 2 Mini | #1, #2, #3, #4 | 55 | $3.60 |
| B | 1× H100 | Inkling 2 Mini + LMCache, sleep mode on | #5, #7, #14, S3 | 55 | $3.60 |
| C | 1× H100 | Inkling 2 Mini with spec decode; Qwen3-8B BF16/FP8/AWQ for quality | #9, #10, #11, #20, S10 | 55 | $3.60 |
| D | 1× L40S 48 GB | **GPU manager lab:** Qwen3-0.6B (always hot), Qwen3-8B FP8 (coder stand-in), Qwen3-VL-8B FP8 (vision), with Semantic Router in front | #13, #14, #16, #18, #19 (stand-ins), S1, S2, S4, S5, S9, S11 | 55 | $1.80 |
| E | 3× L4 | Qwen3-4B ×3 behind vLLM Router | #6, #8, #15, S6, S7, S8 | 55 | $2.20 |
| F | 2× H100 | Inkling 2 Mini, prefill and decode split (NIXL over NVLink) | #12, S12 | 25 | $3.30 |
| G | 1× L4 | OCR 0.9B model, Qwen3-Embedding-0.6B, reranker, pgvector | #21, #22, #23 | 35 | $0.50 |
| H | CPU | Semantic Router classifiers, Presidio, Prompt Guard 2, injection set | #17, #24, #25 | 40 | $0.30 |
| | **10 GPUs** | | | | **≈ $18.90** |

- **Budget:** about $19 for the paid hour, about $3 of dry runs on L4 with tiny
  models, and about $8 left for one re-run of failed lanes.
- **If money runs short:** drop lane F first, then lane C's quality half.
- **Month 2 ($30):** add lane M2, 8× H100 for 30 minutes (≈ $16), running
  GLM-5.3-Flash FP8 (306 GiB fits in 640 GB) for #18 and #19 on the real coder,
  plus lane B again with the winning settings. Loading the 306 GiB model takes
  about 5–10 minutes, which is part of the 30.
- **Month 2, lane R** (knowledge base, memory and RAG at scale, #33 and
  #36–47):
  - Embed 10M chunks once on an L4 (a few hours, about $2–4) and keep them in a
    Volume.
  - Run Postgres with pgvector, and Qdrant for #42, on a 64 GB CPU container
    (about $1–3).
  - Run #33 and #37 on the lane D models (about $2).
  - That's about $7 in total, which still fits next to lane M2 inside month 2's
    $30.

### Before the paid hour (CPU only, nearly free)

1. **Build every image once** (vLLM pinned, AIPerf, LMCache, vLLM Router,
   Semantic Router, Node for the GPU manager) so the paid hour has no cold image
   builds.
2. **Download all weights to a Modal Volume** from a CPU function using
   `huggingface_hub.snapshot_download`. Mount the HF cache and the vLLM compile
   cache (`/root/.cache/vllm`) as volumes, following Modal's vLLM example.
3. **Record traces.** Export 5–10 of our own OpenCode sessions to Mooncake
   JSONL (lengths and hash IDs only), and pull the AgentX `_256k` trace drop.
4. **Dry-run every lane** on L4 with Qwen3-0.6B. The goal is that every lane
   runs from start to finish and writes results.
5. Write `manifest.json`: model revisions, vLLM version, flags, and expected
   minutes per lane.

### Code layout (proposed)

```
bench/modal/
  app.py              # Modal App, images, volumes, local_entrypoint → spawns lanes
  common/
    vllm_proc.py      # start/stop vllm serve, wait for /health, sleep/wake helpers
    scrape.py         # 1 s /metrics poller → JSONL
    gpu_sampler.py    # nvidia-smi sampler → CSV
    aiperf_run.py     # wrapper: one call = one labelled run, writes raw JSON
  lanes/a_serving.py  b_caching.py  c_speed.py  d_gpu_manager.py
        e_router.py   f_pd.py       g_docs.py   h_cpu.py
  charts/make_charts.py  # reads results volume → PNG/HTML, stamped with manifest
bench/traces/record.ts   # OpenCode DB → Mooncake JSONL (pnpm, no prompt text)
ee/apps/gpu-manager/     # (or a module in ee/apps/inference) TS GPU manager
```

### Modal patterns

```python
import modal

app = modal.App("offlinegpt-inference-lab")
hf = modal.Volume.from_name("lab-hf-cache", create_if_missing=True)
vc = modal.Volume.from_name("lab-vllm-cache", create_if_missing=True)
out = modal.Volume.from_name("lab-results", create_if_missing=True)

vllm_img = (
    modal.Image.from_registry("vllm/vllm-openai:<PINNED>", add_python="3.12")
    .entrypoint([])
    .pip_install("aiperf==<PIN>", "lmcache==<PIN>")
)
VOLS = {"/root/.cache/huggingface": hf, "/root/.cache/vllm": vc, "/results": out}

@app.function(image=vllm_img, gpu="H100", memory=160 * 1024,  # host RAM for sleep L1 / LMCache
              timeout=70 * 60, volumes=VOLS)
def lane_b():
    ...  # start vllm with --enable-sleep-mode + LMCache, run AIPerf replays, write /results/b/*.json

@app.function(image=vllm_img, gpu="L4:3", timeout=70 * 60, volumes=VOLS)
def lane_e():
    ...  # 3 vllm on CUDA_VISIBLE_DEVICES=0/1/2 + vllm-router --policy <p>, loop policies

@app.local_entrypoint()
def main():
    calls = [f.spawn() for f in (lane_a, lane_b, lane_c, lane_d, lane_e, lane_f, lane_g, lane_h)]
    for c in calls:
        c.get()
```

### Tricks for specific lanes

- **#5, cache off without a restart:** call vLLM's `/reset_prefix_cache` before
  each step. This needs `VLLM_SERVER_DEV_MODE=1`. Also run a true
  `--no-enable-prefix-caching` once, to show the two methods agree.
- **Lane D, several models on one GPU:**
  - Start each vLLM with `--enable-sleep-mode`, **one after another**: start
    model 1, sleep it (L1), then start model 2, and so on.
  - Size each server's `--gpu-memory-utilization` for when it is the only one
    awake, and allocate enough host RAM (`memory=`) to hold every sleeping
    model's weights.
  - Use `POST /sleep?level=1` and `POST /wake_up` (optionally
    `?tags=weights`, then KV). The level may need to go in the query string
    rather than the JSON body, depending on the version **(verify)**.
- **Lane E, swapping policies:** restart only vLLM Router between policies,
  which takes seconds. The vLLM replicas stay up. Send the AIPerf session header
  as the `consistent_hash` key **(verify the header name in the router flags)**.
- **Lane D, Semantic Router:** use the project's container image as a second
  process if it composes with the vLLM image. Otherwise, run it in lane H's CPU
  container behind `modal.forward` and subtract the measured network time.
  Router overhead itself is measured in lane H with no network in between.
- **#13, compressed day:** replay a 24-hour synthetic traffic curve (chat
  peaks at 10:00 and 15:00, batch OCR at 22:00–06:00) in 30 minutes. Run it
  twice: fixed placement (each model pinned to a share of the GPU) vs. the GPU
  manager.

---

## 9. Knowledge base and employee-level permissions

PSU users mostly ask about their organisation's own documents: circulars, SOPs,
tenders, contracts, O&M manuals and drawings. The knowledge base must follow
three rules:

1. Nobody sees content they couldn't open in the source system.
2. Every answer cites its source (document, page and version).
3. Nothing leaves the site.

### 9.1 What goes in

| Content | Examples | Handling |
|---|---|---|
| Policies, circulars | HR rules, delegation of powers, office orders | Versioned; old versions marked superseded and excluded by default |
| Procedures, manuals | SOPs, O&M, safety | Mostly scans, so OCR runs in the night batch |
| Engineering | Drawings, specifications, data sheets | DXF metadata plus OCR of the title block, not the whole image |
| Procurement | Tenders, GeM orders, contracts, purchase orders | Restricted by department |
| Records | Inspections, audit observations, minutes | Retention rules apply |

### 9.2 Where it is stored (all on-site, all open source)

| Layer | Choice | Why |
|---|---|---|
| Original files | MinIO, or the PSU's existing file share or document system | The source of truth. The index points to it and never replaces it |
| Text, chunks, metadata, ACLs | **Postgres** | One database to run, back up and audit |
| Vectors | **pgvector** in the same Postgres | Permission filter and vector search in one SQL query |
| Keyword search | Postgres full-text search (`tsvector`, GIN index) | Part numbers, clause numbers and tender IDs need exact matches |
| At scale (tens of millions of chunks) | Qdrant for vectors, with ACL payloads kept in sync | Only when pgvector becomes slow |

Sizing: 100k pages is roughly 300–500k chunks, a few GB of 1024-dimension
vectors. One Postgres server with HNSW indexes handles that.

### 9.3 Ingestion pipeline

```
Source connector (file share / SharePoint / DMS / upload)
  → pull file + source ACL + metadata (owner, dept, classification label)
  → parse: digital → text; scan → OCR model (GPU, night batch via GPU manager)
  → chunk by heading/clause (~500–1000 tokens), keep page numbers + heading path
  → embed (Qwen3-Embedding, batch) → store chunk + vector + ACL + label + version
```

Sync rules:
- Every source is re-scanned on a schedule, and only changed files are
  re-indexed.
- **A permission change in the source updates the stored ACL within minutes,
  even if the content didn't change.**
- A file deleted at the source has its chunks hard-deleted. DPDP erasure
  requests depend on this.
- Changing the embedding model rebuilds into a new index version in the
  background; search switches over once it is complete.

### 9.4 Employee-level permission model

Each employee's access is the **union of their principals**, minus any
**explicit deny**, capped by their **clearance**.

| Building block | Comes from | Example |
|---|---|---|
| User | SSO (AD, LDAP, SAML); provisioned and deprovisioned via SCIM (see `docs/microsoft-entra-sso-scim.md`) | `emp-10432` |
| Groups (nested groups flattened) | Directory | `Finance-Readers`, `Plant3-Ops` |
| Department, location | Directory attributes | `dept:finance`, `loc:plant-3` |
| Role or designation | Directory attributes, or the Den role (owner > super-admin > admin > member) | `role:dgm`, `role:auditor` |
| Clearance | HR or directory attribute | 0 public, 1 internal, 2 restricted, 3 secret |
| Time-bound grant | Den admin, with an expiry | An auditor gets `Procurement-2025` for 30 days |
| Delegation | Den: an officer-in-charge stands in for someone on leave | Gets the absent officer's principals until the delegation ends |

Rules:
- **Inherit source ACLs.** If a file share folder is limited to
  `Finance-Readers`, its chunks are too. Admins never re-enter permissions by
  hand.
- **Deny overrides allow.** Classification is checked separately: an employee
  never sees a chunk with `label > clearance`, even if they are in the ACL.
- **Leavers lose access at once.** A SCIM deprovision removes all principals
  and kills active sessions and API keys.
- **Agents act as the employee.** Subagents and tools inherit exactly the
  caller's principals (the same idea as QM's delegated authorization).
  Scheduled automations run as their owner and **re-check permissions at run
  time**, not at creation time.
- **Beyond documents**, the same principals decide which models or roles an
  employee may use (for example, the coder role only for IT), which tools
  (shell, web, browser upload), which collections, and whether they may export.
  This extends Den desktop policies, which today apply by member, team or role,
  with directory attributes.

### 9.5 Schema (Postgres + pgvector)

```sql
create table principal (
  id uuid primary key,
  kind text not null check (kind in ('user','group','dept','role','location')),
  external_id text not null,          -- AD objectGUID / LDAP DN / Den id
  name text not null,
  unique (kind, external_id)
);

-- flattened, time-bound membership (nested groups resolved at sync time)
create table user_principal (
  user_id uuid not null references principal(id),
  principal_id uuid not null references principal(id),
  source text not null,               -- 'directory' | 'den-grant' | 'delegation'
  valid_from timestamptz not null default now(),
  valid_to timestamptz,               -- null = no expiry
  primary key (user_id, principal_id, source)
);

create table user_attr (
  user_id uuid primary key references principal(id),
  clearance smallint not null default 1,
  status text not null default 'active'   -- 'active' | 'suspended' | 'left'
);

create table kb_collection (
  id uuid primary key,
  name text not null,
  owner_user_id uuid not null references principal(id),
  source_uri text not null,
  sync_cron text not null,
  default_label smallint not null default 1,
  retention_days int
);

create table kb_document (
  id uuid primary key,
  collection_id uuid not null references kb_collection(id),
  source_uri text not null,
  version int not null,
  sha256 text not null,
  label smallint not null,
  superseded_by uuid references kb_document(id),
  deleted_at timestamptz
);

create table kb_chunk (
  id uuid primary key,
  document_id uuid not null references kb_document(id) on delete cascade,
  ord int not null,
  page_from int, page_to int,
  heading_path text,
  body text not null,
  tsv tsvector generated always as (to_tsvector('simple', body)) stored,
  embedding vector(1024) not null,
  label smallint not null,            -- copied from document for one-query filtering
  acl uuid[] not null,                -- principals allowed (copied from source ACL)
  deny_acl uuid[] not null default '{}',
  index_version int not null
);
create index on kb_chunk using hnsw (embedding vector_cosine_ops);
create index on kb_chunk using gin (tsv);
create index on kb_chunk using gin (acl);
```

The permission filter runs **inside** each retrieval query, never after it.
Filtering afterwards leaks information through result counts, snippets and
"N results hidden" messages.

```sql
-- $1 = caller's active principal ids (resolved per request, honouring valid_to)
-- $2 = caller clearance
-- $3 = query embedding, $4 = tsquery
with allowed as (
  select c.* from kb_chunk c join kb_document d on d.id = c.document_id
  where c.acl && $1 and not (c.deny_acl && $1) and c.label <= $2
    and d.deleted_at is null and d.superseded_by is null
    and c.index_version = current_setting('kb.index_version')::int
)
-- vector top-k and keyword top-k from `allowed`, fused with reciprocal rank fusion, then reranked
```

- **Second layer of defence:** Postgres row-level security on `kb_chunk`,
  using the same predicate with the principal set taken from
  `current_setting('app.principals')`, which is set per transaction. A bug in
  the application query then still can't leak data.
- **Filtered HNSW:** with selective filters, HNSW can return fewer than k
  results. Enable pgvector's iterative index scan (0.8+, **verify**), or fall
  back to an exact scan for small allowed sets.

### 9.6 Answering and audit

1. Retrieve with hybrid search plus the reranker, inside the permission filter.
2. Answer only from the retrieved chunks, citing document, page and version.
   If nothing relevant is found, say so instead of guessing.
3. Write an audit row: who asked, the principal set hash, the IDs of the chunks
   returned, document versions, the model, and the routing decision. Retain it
   for 180 days or more inside India (CERT-In); 1 year for DPDP logs.
4. **Caches never cross permission boundaries:**
   - Retrieval caches are keyed by the hash of the principal set.
   - For vLLM's prefix cache, use per-tenant or per-classification
     `cache_salt` **(verify the request field)**, so a cached secret document
     can't speed up, and so reveal itself to, a user without access.

### 9.7 Admin management (Den)

- **Collections:** owner, source, sync schedule, default label, retention.
- **Grants:** time-bound access, delegations, and break-glass access, which
  always requires a reason and is reviewed weekly.
- **Health:** last sync, failed files, OCR queue length, how long ACL changes
  take to propagate, and documents nobody reads.
- **Access review:** each quarter, export "who can read which collection" for
  sign-off by department heads.
- **Feedback:** a flagged answer goes to the collection owner, who fixes the
  source or the chunking.

### 9.8 How it fits OfflineGPT

- **Desktop:** an employee's own files stay local and are searched by the
  agent's file tools, as today.
- **Org knowledge base:** lives in Den and is exposed through `den-gateway` as
  an MCP capability (`search_knowledge`, which returns cited chunks). It works
  in any MCP client with no new client code.
- **GPUs:** embedding uses one small model that is always loaded. Bulk OCR runs
  in the night batch (scenario S9).

### 9.9 Experiments added

| # | Experiment | Chart | What it shows |
|---|---|---|---|
| 23 | Keyword / vector / hybrid / + rerank (now on a PSU-style document set) | Recall@k curves | Exact identifiers need keyword search |
| 26 | Permission red-team: an employee × collection allow/deny matrix, probed through answers, snippets, citations, counts, summaries and agent tools | "0 leaks in N attempts" plus the matrix heatmap | The number PSUs ask for first |
| 30 | ACL change propagation: revoke in the directory, measure until search stops returning the content | Time to revoke, p50 and p99 | Leavers and moved staff lose access within minutes |
| 31 | Filtered retrieval cost: latency and recall as the allowed share falls (100% → 1%) | Line chart | Filtering inside the query stays fast and complete |
| 32 | Cross-permission cache test: whether time to first token differs for a user without access | Two latency distributions | `cache_salt` closes the timing side channel |

Lane G runs #23, #31 and #32. #26 and #30 run locally against Postgres; no GPU
is needed.

Proof per AGENTS.md: a journey spec in `evals/specs/**` that provisions two
employees in different departments through SCIM. It checks that each one gets
only their own collection's citations, then deprovisions one and asserts that
their access ends.

---

## 10. Build order

1. **Base:** images, volumes, weight download, `vllm_proc`, scrapers,
   `aiperf_run`, the results format, and `bench/traces/record.ts`. Dry-run lane A
   on L4.
2. **Lanes A and B:** the first hero chart (#5).
3. **Lane E:** the router lab and the second hero chart (#6).
4. **GPU manager (TS) and lane D:** #13, #16, S1–S5.
5. **Lanes C, F, G, H**, then `charts/make_charts.py`.
6. **Paid run** (one hour, all lanes), then charts, a write-up and videos via
   `scenarios/`.
7. **Knowledge base:** Postgres schema, connector for file shares, ACL sync from the directory, `search_knowledge` MCP capability, red-team (#26, #30).
8. **Product integration:**
   - add a self-hosted upstream to `ee/apps/inference`;
   - add roles to the model catalog;
   - forward `x-session-id`;
   - add per-team allowed roles in Den;
   - add a Helm chart for the inference stack;
   - add a journey spec in `evals/specs/**` that drives a real request through
     gateway → router → vLLM (with a tiny model) and checks the audit row and
     routing decision. That spec is the proof, per AGENTS.md.

Each step is a separate PR. Doing them all at once is too much for one change.

---

## 11. Risks and open questions

- **Inkling 2 Mini on Hopper:** no Mini recipe was found. Confirm which
  checkpoint format exists and that its parser is in the pinned vLLM. Fallback:
  Qwen3.8-27B as main for H100 lanes.
- **Modal Starter's 10-GPU cap** is from third-party sources. Check the
  workspace settings. If the cap is lower, run lane F in month 2.
- **Sleep mode with several models in one container:** the memory accounting
  for `--gpu-memory-utilization` with a sleeping neighbour, and the CPU RAM
  needed for level 1, must be confirmed in the dry run.
- **Semantic Router packaging and config schema** (signal types, `use_reasoning`,
  modality) come from docs and a paper. Confirm against the pinned release.
- **vLLM Router:** confirm how the session header is configured for
  `consistent_hash` and which flags turn on P/D mode.
- **Metric names** change between vLLM versions. Pin the version and read
  `/metrics` once in the dry run.
- **Vendor numbers** (Inkling, llm-d, LMCache, Router) are claims until our runs
  reproduce them; say this in every write-up.
- **Free credit options:** Modal academic credits are not available to
  undergraduates and may be paused. **Modal startup credits** ($500–$50k, with a
  shared workspace and a company under 5 years old) are the best way to fund the
  M2 lane. The NVIDIA Academic Grant needs a faculty sponsor.

---

## 12. Sources

- vLLM sleep mode: https://docs.vllm.ai/en/latest/features/sleep_mode/ ; blog https://vllm.ai/blog/sleep-mode
- vLLM Router: https://vllm.ai/blog/vllm-router-release ; https://deepwiki.com/vllm-project/router ; https://pypi.org/project/vllm-router/
- vLLM Semantic Router: https://vllm-semantic-router.com/docs/overview/architecture/system-architecture/ ; https://arxiv.org/html/2603.04444v4 ; https://arxiv.org/abs/2510.08731 ; https://aibrix.readthedocs.io/latest/features/semantic-router.html ; https://vllm.ai/blog/2025-09-11-semantic-router
- vLLM metrics: https://docs.vllm.ai/en/stable/usage/metrics.html
- LMCache: https://docs.lmcache.ai/kv_cache/cpu_ram.html ; https://arxiv.org/pdf/2510.09665 ; independent comparison https://arxiv.org/pdf/2609.11744
- AIPerf: https://docs.nvidia.com/aiperf/benchmark-modes/trace-replay-with-mooncake-traces ; https://developer.nvidia.com/blog/benchmarking-llm-inference-at-scale-with-aiperf ; AgentX in AIPerf https://docs.nvidia.com/aiperf/tutorials/datasets-inputs/inference-x-agent-x-mvp-benchmark
- AgentX: https://newsletter.semianalysis.com/p/agentx-inferencexv3-does-cuda-moat ; https://vllm-project.github.io/2026/09/08/vllm-agentx.html ; https://inferencex.semianalysis.com/blog/agentic-benchmark-agent-benchmark-guide
- Other agent benchmarks: https://arxiv.org/pdf/2609.34683 (AgentPerfBench) ; https://github.com/AiFeatures/agentic-swarm-bench ; https://arxiv.org/pdf/2606.16824 (CacheWise)
- GuideLLM: https://raw.githubusercontent.com/vllm-project/guidellm/HEAD/README.md
- Routing comparisons: https://developers.redhat.com/articles/2026/01/13/accelerate-multi-turn-workloads-llm-d ; https://www.redhat.com/en/blog/same-16-gpus-twice-users-inference-aware-routing-llm-clusters ; https://deepwiki.com/vllm-project/production-stack/12-benchmarking
- GPU sharing prior art: https://docs.rs/crate/llmux/0.9.0/source/README.md ; https://www.redhat.com/en/blog/running-llms-dynamically-production-limited-resources-hard-we-think-theres-room-another-approach ; https://pypi.org/project/gpustack/
- Inkling 2: https://vllm.ai/blog/2026-11-12-inkling2-small ; https://recipes.vllm.ai/thinkingmachines/Inkling-2-Small.md ; https://thinkingmachines.ai/news/inkling-2-mini/
- OCR models: https://blog.roboflow.com/best-open-source-ocr-models/ ; https://arxiv.org/pdf/2607.13639 (OvisOCR2) ; https://raw.githubusercontent.com/opendatalab/OmniDocBench/HEAD/README.md
- Modal: pricing https://modal.com/pricing ; https://www.morphllm.com/modal-pricing ; limits https://www.activepieces.com/blog/modal-labs-pricing-2026-gpu-rates-plans-and-credits.md ; vLLM example https://modal.com/docs/examples/vllm_gemma ; https://modal.com/blog/how-to-deploy-vllm ; startups https://modal.com/startups ; academics https://modal.com/academics
