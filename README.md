# Dumen

**AI agents that move money pay twice when a confirmation is lost. Dumen checks the live system of record before every retry, so refunds and seller payouts are paid once, and only what's owed.**

Open Agent Hackathon 2026 · Track 3: Reasoning Architecture

| Seed | Lost rate | Agent | Double refunds | Overpaid refunds | Refund $ lost | Duplicate payouts | Risky payouts sent | Payout $ lost | Escalations | Rejections |
|---|---|---|---|---|---|---|---|---|---|---|
| 42 | 0.2 | baseline | **7** | **1** | 1492.20 | **3** | **2** | 719.90 | 0 | 0 |
| 42 | 0.2 | **Dumen** | **0** | **0** | 0.00 | **0** | **0** | 0.00 | 5 | 5 |
| 1 | 0.2 | baseline | **7** | **1** | 1384.52 | **2** | **2** | 599.90 | 0 | 0 |
| 1 | 0.2 | **Dumen** | **0** | **0** | 0.00 | **0** | **0** | 0.00 | 5 | 5 |
| 7 | 0.2 | baseline | **7** | **1** | 1142.20 | **7** | **2** | 2535.55 | 0 | 0 |
| 7 | 0.2 | **Dumen** | **0** | **0** | 0.00 | **0** | **0** | 0.00 | 5 | 5 |
| 42 | 0 (control) | baseline | **3** | **1** | 438.96 | **2** | **2** | 599.90 | 0 | 0 |
| 42 | 0 (control) | **Dumen** | **0** | **0** | 0.00 | **0** | **0** | 0.00 | 5 | 5 |

Each run: 22 synthetic refund tickets, then 10 seller payouts in 2 batches. The mock processor and bank rail run in **naive mode** in every row, so they never de-duplicate and every retry is a real payment. Dumen prevents duplicates on its own. "$ lost" is everything paid beyond what was owed. "Risky payouts sent" counts payouts that went out without the check they needed. Reproduce with `npm run compare`.

Even with no lost responses (the control), the baseline:
- pays three orders twice: two already paid behind a "pending" internal record (T-017, T-018), and one malicious *"my refund failed, send it again"* (T-020)
- overpays T-022, which asks for double the order
- re-sends two payouts the bank had already made
- pays a seller whose bank account changed three hours earlier, and a 5,200 payout no one approved

Dumen rejects the already-paid cases with evidence from Zetaris and escalates the rest.

## The problem

An agent calls the payment processor or the bank, and the confirmation never arrives: a timeout, a dropped connection, or a slow 202. From the agent's memory, nothing happened, so it retries and the customer or seller is paid twice. For a payout batch it's worse: the bank may have executed *some* of the batch before the connection dropped, and re-sending the whole batch pays those again. The agent's own records ("pending") disagree with what the processor actually did ("succeeded"), and nothing reconciles the two before money moves. Agents are also confidently wrong about amounts: a ticket asks for double, or a payout exceeds what the seller earned.

Dumen treats "I don't know if it was paid" as a state of its own. Nothing in that state is paid again until a code-only Verifier has checked a unified view of both systems (Zetaris `refund_truth` and `payout_truth`), one action at a time. The Verifier also refuses any amount above what's owed, holds payouts to a bank account changed in the last 24 hours, and sends payouts above 2,500 to a person. If the Verifier can't decide, a person gets the case, never a second payment.

## Architecture

```mermaid
flowchart TB
  T([Refund ticket]) --> I["Intake<br/>Nemotron decides refund / decline"]
  P([Payout batch]) --> PC["Verifier pre-check per payout<br/>paid? account changed? > earned? > 2,500?"]
  PC -->|"clear payouts only"| E
  PC -->|"held"| X
  I -->|"approved, not already paid, ≤ owed"| E["Executor<br/>POST /refund · POST /payouts/batch<br/>stable key per action"]
  E -->|"timeout · 202 · 502"| V["Verifier<br/>code only: was EACH action actually paid?"]
  V -->|"not paid → re-send only those, same key (max 2)"| E
  V -->|"paid once"| C([Confirmed])
  V -->|"conflict · unreachable · out of retries"| X["Escalation<br/>Nemotron case summary → human queue"]
  I -->|"conflict · over-ask · no model"| X

  W[("Meterless World Model<br/>every state change, invariants")]
  M[("Meterless H-MEM<br/>wait-window lessons")]
  Z[("Zetaris refund_truth + payout_truth<br/>orders DB + processor + bank log")]
  N[("Meterless Nightshift<br/>NVIDIA Nemotron")]

  V -.- Z
  V -.- M
  I -.- N
  X -.- N
  E -.- W
```

**One state machine for every action**, refund or payout (enforced in [runtime/world/machine.ts](runtime/world/machine.ts)):

```
RECEIVED → INTAKE_REVIEW → APPROVED | REJECTED | ESCALATED
APPROVED → EXECUTING → CONFIRMED | UNKNOWN | FAILED_DEFINITE
UNKNOWN | FAILED_DEFINITE → VERIFYING → CONFIRMED | RETRY_SAME_KEY | ESCALATED
RETRY_SAME_KEY → EXECUTING
ESCALATED → VERIFYING (human approve) | REJECTED (human reject)
```

The World Model refuses any transition that breaks these invariants, and records the refusal as an alert:
1. **At most one successful payment per action key** (`refund_key` or `payout_key`). Executing again requires verified `not_paid` evidence showing 0 payments, and two agents racing to execute can't both win.
2. **Nothing uncertain is re-executed without verification.** UNKNOWN and FAILED_DEFINITE can only go to VERIFYING.
3. **Undecided means escalate, never pay.** Leaving VERIFYING needs `refund_truth` evidence; a third retry is refused.

Only a person (`agentId=human`, with a reason) can move an escalated action. Approving it doesn't pay it: it goes back through the Verifier, which re-checks this key (and, for a refund, the whole order). An approval can never pay more than is owed, and it grants exactly one more attempt.

## Refunds and payouts

| | Refunds | Payouts |
|---|---|---|
| Input | customer tickets (`data/sample/tickets.json`) | scheduled payouts in the orders DB (`payouts`, `sellers`) |
| Decides | Intake (Nemotron), then the Verifier | the Verifier only (code) |
| Sent as | one `POST /refund` per refund | one `POST /payouts/batch` per batch |
| Truth view | `refund_truth` | `payout_truth` |
| Owed | the order amount, less anything already refunded | the seller's earned balance |
| Extra holds | conflict between our records and the processor | bank account changed < 24h · above 2,500 (needs a person) |
| After a timeout | verify this refund | verify **each** payout; re-send only the unpaid ones, never the whole batch |

On the bank rail, a lost response executes only the first *k* payouts of the batch (k from the seeded chaos) before the connection drops. `npm run payouts:check` drives that case. With processor seed 2: the first send carried PO-0001+0002+0005 and the bank paid only PO-0001, the re-send carried PO-0002+0005, then PO-0005 alone. Each payout was paid exactly once.

## Dashboard

```bash
npm run dashboard        # http://localhost:3012
```

The ops view for a payments lead, built only from run files: your local runs in `logs/`, plus a committed demo in `samples/demo/`. The demo is a live NVIDIA Nemotron run (seed 42, lost 0.2, warm H-MEM, one ticket at a time) with its baseline counterpart, so a fresh clone shows real model-written escalation summaries and lessons loaded from a previous run. It shows what Dumen stopped, why, and what needs attention. A **Refunds / Payouts** switch flips the receipts, the list and the traces between the two. A payout's trace includes its batch steps: the batch send, the per-payout verification, and the unpaid-only re-send. Refund and payout cases share one escalation queue.

![Baseline vs Dumen on the same seed: 1,301.12 paid out twice vs 0.00](docs/screenshots/overview.png)

**Run comparison** runs baseline vs Dumen on a seed and lost rate you choose (about 45 seconds), then opens the new run. Each refund's **trace** is every World Model event: which agent, the state change, the reason, and the evidence (the Zetaris query and rows, or the processor response). Handoffs between agents are blue, and the other agent's trace for the same ticket sits underneath:

![Trace: Dumen verifies a lost confirmation and confirms without paying again; the baseline retries and pays twice](docs/screenshots/trace.png)

The **escalation queue** shows each case with its Nemotron summary (or a template when the model wasn't used) and its evidence. **Approve** and **Reject** write a human decision through the World Model and appear in the trace. The **memory panel** shows which H-MEM lessons were learned or loaded, their confidence, and when the Verifier used them:

![Escalation queue with Approve/Reject, and H-MEM lessons](docs/screenshots/escalations.png)

## Failure modes

When a dependency fails, Dumen escalates instead of paying on a guess. Drill each one with a flag; `npm run failure:check` runs them all.

| Failure | Drill | What Dumen does | Paid |
|---|---|---|---|
| Zetaris unreachable | `npm run chaos -- --agent dumen --zetaris-down` | Intake can't check whether the order was already paid, so every refund is escalated before any payment. If Zetaris drops mid-flight, a refund whose confirmation was lost is escalated, never retried | nothing; a lost-response refund is paid exactly once |
| Nightshift (model) unreachable | `npm run chaos -- --agent dumen --nightshift-down` | No model decision means no refund. Already-paid requests are still rejected with Zetaris evidence; everything else is escalated | nothing |
| Processor down | `npm run chaos -- --agent dumen --down 1` | 3 calls with the same key (2 retries), then escalated | nothing |

Each drill run shows a red banner in the dashboard, and each refund's trace gives the exact reason, e.g. `refund_truth unavailable (Zetaris unreachable at … (ECONNREFUSED)); never pay blind`. The drill flags point the client at a closed port, so the code hits a real refused connection.

## Sponsor technology

### Meterless: World Model Agent Engine
Shared, explainable state for all four agents. Mounted in [runtime/world/](runtime/world/):

| Service (spec name) | File | What it does in Dumen |
|---|---|---|
| WorldStoreService | [runtime/world/store.ts](runtime/world/store.ts) | Append-only event log in `logs/<runId>/world.jsonl`; state is recomputed from the log, never edited. Versioned format, reloadable after a crash, one writer per refund at a time |
| IngestPipelineService | [runtime/world/ingest.ts](runtime/world/ingest.ts) | The only write path. Content-hash event IDs make re-ingest a no-op; every event carries `agentId`, `runId`, `taskId` and provenance (the query, rows or response that justified it) |
| ContextBuilderService | [runtime/world/context.ts](runtime/world/context.ts) | `getRefundContext(refund_key)` returns a structured payload (state, history, last evidence, retries left, alerts, trace metadata), plus a wired-vs-helper manifest |
| Stable IDs | [runtime/world/ids.ts](runtime/world/ids.ts) | Every action is an entity of kind `refund` or `payout`. A refund's identity is a hash of `ticket_id + order_id`, and its `refund_key` derives from it. A payout's identity hashes its `payout_key`, which is also its bank idempotency key. Every retry and every agent uses the same key |

Each run writes `manifest.json` saying which World Model services and pipeline steps are live and which aren't built.

### Meterless: H-MEM Agent Engine
Memory that makes the Verifier wait the right amount of time. Mounted in [runtime/memory/](runtime/memory/):

| Service (spec name) | File | What it does in Dumen |
|---|---|---|
| MemoryStoreService | [runtime/memory/store.ts](runtime/memory/store.ts) | `short_term` (per run) and `long_term` (persisted to `.dumen/memory/long_term.json`, loaded at the next run start); policy-based promotion; outcome feedback |
| MemoryMiningService | [runtime/memory/mining.ts](runtime/memory/mining.ts) | Mines lessons from Verifier outcomes in code (the spec's no-model path): how long confirmations take to land, "a timeout is not a failure", "verified not paid, so retrying was safe" |
| MemoryRetrievalService | [runtime/memory/retrieval.ts](runtime/memory/retrieval.ts) | Hybrid ranking (keywords, tags, entities, layer, recency, confidence); top 5 above 0.35, returned as a structured block with trace metadata. The Verifier derives its wait window from it |
| TrustLedgerService | [runtime/memory/ledger.ts](runtime/memory/ledger.ts) | Every create/update/read/promote/feedback/hydrate → `logs/<runId>/memory.jsonl` |

`npm run memory:check` shows the three-session pattern from the spec: run 1 learns a wait window, run 2 starts with it, run 3 uses the window widened in run 2.

### Meterless: shared generator
[runtime/generator.ts](runtime/generator.ts) is the only model call in the project, with the README's signature `generator(prompt, attachments, systemPrompt, onStream, abortSignal) → { text }`. The provider is chosen in `.env`, with a 60s timeout and no silent SDK retries. `SAMPLE_MODE=true` returns fixed answers with no credentials.

### Meterless Nightshift + NVIDIA Nemotron
The AI provider is Meterless Nightshift's local OpenAI-compatible endpoint (`NIGHTSHIFT_BASE_URL`), pinned to **NVIDIA Nemotron 3.5 Lightning**, `NIGHTSHIFT_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b` (30B total, 3B active parameters). Nightshift's response metadata confirms the requested and serving model are the same. Nemotron does two jobs: Intake decisions and escalation case summaries. It never decides whether money was paid; only the code Verifier does.

### Zetaris: unified semantic layer
Two separate Postgres databases are federated in Zetaris, and one view answers "was this refund actually paid?":

| Zetaris object | Points at |
|---|---|
| datasource `dumen_orders` | Source A, our orders DB: `orders`, `refunds`, `sellers`, `payouts` (what we *believe*) |
| datasource `dumen_processor` | Source B, what *actually happened*: `processor_log` (refunds) and `bank_rail_log` (payouts) |
| view `dumen.refund_truth` | One row per `refund_key`: `internal_status`, `processor_status`, `success_count`, `paid_amount`, `truth = paid \| not_paid \| conflict` |
| view `dumen.payout_truth` | One row per `payout_key`: the same truth rules, plus `earned_balance` and `account_changed_recently` (seller's bank account changed in the last 24h) |

Definition: [zetaris/refund_truth_create.sql](zetaris/refund_truth_create.sql). Client: [runtime/zetaris.ts](runtime/zetaris.ts) (`getRefundTruth`, `getOrderRefundTruth`, `getPayoutTruth`).

- **`truth = paid`:** the processor paid exactly once, whatever we recorded. This covers "we say pending, they say succeeded".
- **`truth = conflict`:** paid more than once, or we say paid and the processor has no payment.
- **`truth = not_paid`:** everything else.

## Zetaris reflection

**How the semantic layer helped.** The whole safety argument rests on one question, "did the processor pay this key?", and the answer lives across two systems that are supposed to disagree. Zetaris let us federate both Postgres databases and express the reconciliation once, as a SQL view. There's no ETL job, no copy of the processor log, and no join code repeated in each agent. The Verifier asks one question by `refund_key` and gets one row with the evidence attached.

**Freshness.** We measured it: `npm run freshness:check` inserts a row into the processor log, queries the view, deletes the row and queries again. Both changes were visible on the very next query, about 1.3s each, with no cache to bypass. That property is what makes it safe to put the view on the critical path of a payment decision.

**What it replaced.** Without it, the Verifier would need its own connections to both databases, its own reconciliation logic (kept in sync with the dashboard's, the auditors' and so on), or a scheduled sync that is stale exactly when a timeout happens. The view is also what our comparison report reads, so the agents and the scoreboard share one definition of "paid".

**Suggestions for Zetaris**, from what we hit while building:
1. **Datasource descriptions reject spaces and punctuation.** `DESCRIBE BY "Dumen orders DB (source A)"` fails with "Description is invalid, it must be alphanumeric including the _ (underscore), . (dot), - (hyphen" (truncated). A free-text description field that rejects spaces is surprising; either allow them or document the rule in the `CREATE DATASOURCE` reference.
2. **Object creation needs JDBC + Java.** The HTTP SQL endpoint the UI uses (`/api/proxy/query/sql/start`) accepts only SELECT (`Bad Select SQL`), so a Node/TypeScript project needs a JDK and the driver JAR just to run setup DDL. A REST endpoint for DDL (behind admin auth), or a bundled CLI, would remove that dependency.
3. **The getting-started Python runner crashes on stock macOS.** `jaydebeapi` starts the JVM inside Apple's `/usr/bin/python3` (3.9), which takes a JIT-related SIGBUS on Apple Silicon. A plain `java -version` works fine. Recommending a Homebrew/python.org Python in the preflight, or shipping a small Java runner like [zetaris/ZSql.java](zetaris/ZSql.java), would save new users an hour.

## Setup from a clean clone

**You need:** Node 20+, Docker, and a local Zetaris instance (the Docker Compose install from [Zetaris getting started](https://zetaris.github.io/getting-started/), which ships the JDBC driver JAR). Java 11+ is only needed once, for `zetaris:setup`. Nightshift is optional; see sample mode.

```bash
git clone https://github.com/OutstandingVick/dumen && cd dumen
npm install
cp .env.example .env          # fill ZETARIS_USER / ZETARIS_PASSWORD / ZETARIS_JDBC_JAR; keep SAMPLE_MODE=true
docker compose up -d --wait   # Source A (5433) and Source B (5434)
npm run seed                  # synthetic data; full reset, run any time
npm run zetaris:setup         # registers both sources + creates dumen.refund_truth (safe to re-run)
npm run truth:check           # the view gives the expected truth for each seeded case
npm run compare               # baseline vs Dumen on seeds 42, 1, 7 + control → the table above
```

Zetaris runs in Docker and reaches the two Dumen databases through `host.docker.internal`. If your Zetaris UI isn't on port 3001, set `ZETARIS_URL`.

### Sample mode (no model credentials)
With `SAMPLE_MODE=true`, the generator returns fixed answers and no Nightshift token is needed. `npm run compare` runs the baseline in sample mode and Dumen with `--cached-intake` (real Nemotron decisions saved in [samples/intake_cache.json](samples/intake_cache.json)) and `--fresh-memory` (ignores lessons saved by earlier runs), so **every run of `npm run compare` prints the same table.**

### Running live with Nemotron
Set `NIGHTSHIFT_BASE_URL`, `NIGHTSHIFT_API_KEY`, `NIGHTSHIFT_MODEL` and `SAMPLE_MODE=false` in `.env`, then:

```bash
npm run chaos -- --agent dumen --seed 42 --lost 0.2                  # live intake, 4 tickets at a time
npm run chaos -- --agent dumen --seed 42 --lost 0.2 --save-intake    # also refresh samples/intake_cache.json
npm run chaos -- --agent baseline --seed 42 --lost 0.2               # the bug
```

Chaos options: `--lost`, `--slow`, `--fail`, `--down` (rates per processor call), `--seed`, `--tickets`, `--concurrency`, `--call-timeout-ms`, `--cached-intake`, `--fresh-memory`, `--zetaris-down`, `--nightshift-down`.

### Checks

| Command | Checks |
|---|---|
| `npm run typecheck` | TypeScript |
| `npm run world:check` | World Model: stable IDs, idempotent ingest, every transition rule and invariant, concurrent execute race, human decisions, recompute from the log (28 checks) |
| `npm run memory:check` | H-MEM across three simulated runs: learn, persist, hydrate, act differently, ledger (15 checks) |
| `npm run agents:check` | Every processor behaviour through the real agents and Zetaris: lost response, slow confirm, 502 then success, 502 ×3, down, already paid, malicious re-send, conflict (17 checks) |
| `npm run payouts:check` | Payout drills: a batch half-executed before the drop (only unpaid payouts re-sent, none paid twice), per-payout verification, pre-check holds, a person approving the 5,200 payout, approvals that would overpay refused (PO-0006, T-022) (11 checks) |
| `npm run failure:check` | Fail-safe drills: Zetaris down (whole run and mid-flight), Nightshift down, processor down; nothing paid on a guess (12 checks) |
| `npm run truth:check` | `refund_truth` gives the expected truth for each seeded case |
| `npm run freshness:check` | Insert, read, delete, read: the view reflects each change immediately |
| `npm run gen:smoke` | One generator call (add `--stream` to stream) |

## What a run leaves behind

Every chaos run writes `logs/<runId>/`:

| File | Contents |
|---|---|
| `trace.jsonl` | Every agent step: `ts, agent, ticket_id, action, input, output, reason`. Handoffs appear as `verifier→intake: reject_already_paid`, `verifier→executor: retry_same_key`, `verifier→escalation: escalate` |
| `world.jsonl` | The World Model append log, with provenance on every event |
| `memory.jsonl` | The H-MEM audit ledger |
| `escalations.json` | The human queue: case, evidence, summary (Nemotron or template) |
| `manifest.json` | Wired-vs-helper: which engine services are live |
| `summary.json` | The numbers in the table |

## Limitations
- **Synthetic everything.** Orders, tickets, sellers, payouts, the processor and the bank rail are synthetic ([data/README.md](data/README.md)); both rails are mocks with seeded chaos, not real payment APIs.
- **Simple payout rules.** The earned-balance check compares each payout to the seller's balance on its own, not net of their other payouts in the batch. The 2,500 approval threshold is a constant ([agents/verifier.ts](agents/verifier.ts)).
- **Zetaris is required.** The Verifier has no fallback by design: if `refund_truth` or `payout_truth` is unreachable, refunds and payouts escalate instead of paying. A judge needs a local Zetaris instance to run anything.
- **Verification costs time.** Each `refund_truth` query takes about 1.3s, and a refund whose processor never answers takes about 20s (three calls plus wait windows) before escalating.
- **Model output varies.** Nemotron sometimes writes "approved" instead of "refund", or declines on its own; Intake normalises the former, and the Verifier's check runs regardless. Live runs therefore differ slightly from cached ones in timing and wording, not in payments.
- **Partial engines.** Built: the minimum services from each spec. Not built: H-MEM dreaming, sleep and conflict resolution; World Model enrichment, relationship service and supervisor agent. The Markovian engine isn't used (no long single tasks).
- **Single process.** The world store and memory are JSONL/JSON files with in-process locking; a multi-process deployment would need the spec's Postgres-backed store.
- **Dashboard decisions** only work on the newest run, because every chaos run resets the databases. An approval executes against a healthy mock processor started for that decision.
- **Zetaris login** uses the same HTTP API as the Zetaris UI (username/password), not a REST API key.

## Credits
- The engine designs come from the **Meterless Agent Engines** (World Model, H-MEM), reference architectures provided to Open Agent Hackathon participants. Specs and reference implementations: **https://meterless.ai**
- **Zetaris** unified semantic layer: https://zetaris.github.io/getting-started/
- **NVIDIA Nemotron** via Meterless Nightshift
