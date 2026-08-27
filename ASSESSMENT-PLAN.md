# Vector Autoscale Test Plan (v5)

Objective: find the per-task bottleneck, derive a CPU scale-out threshold, validate it. Splunk replaced by a `blackhole` sink.

## Phase 1 — Prep

1. Test config in S3: Splunk sink → `type: blackhole`. **Keep sink name `Splunk`.** Keep Sink A + noteworthy filter. Add `internal_metrics` → `prometheus_exporter` (overlay Part 1).
2. New task-def revision → deploy.
3. Pin: `desired-count 1`; suspend scaling (`register-scalable-target --suspended-state ...`).
4. Deploy k6 generator (same VPC, separate cluster).
5. Smoke test: `k6 run --iterations 1`; confirm counts via ECS Exec, port 9598.

Every run: unique `RUN_ID`; generator CPU < 80%; `dropped_iterations` = 0.

## Phase 2 — Knee sweeps (1 task, scaling off)

`SCENARIO=sweep` each run. Knee = p99 hits 2× idle. Record EPS, CPU%, buffer metrics at knee.

| Run | Sink | Tells you |
|-----|------|-----------|
| 2.1 | blackhole, no buffer | CPU ceiling. Also proves current alarm can't fire on memory buffer. |
| 2.2 | + prod disk buffer (EFS) | Delta vs 2.1 = EFS tax. Log BurstCreditBalance before/after. |
| 2.3 | same buffer, ephemeral mount | 2.2 − 2.3 = EFS-specific cost. |
| 2.4 opt | mock HEC (HTTP 200) | Adds encoding/HTTP cost. Use this knee for thresholds if run. |

CPU pinned at knee → scale-out helps. Idle CPU + rising latency → storage-bound; scale-out won't help and current alarm never fired either way.

## Phase 3 — Threshold + validation

1. Threshold = knee CPU% − load growth during ~4–5 min scale-out lag. Default 65%. Never scale on memory.
2. Create CPU alarm + step policy (shadow alarm first if cautious). Optional lag cuts: 10 s health checks, 20 s high-res metrics.
3. Restore min 2 / max 10; un-suspend scaling.
4. Set blackhole `rate` = 50–70% of knee (deterministic slow Splunk; per-task, so scale-out adds drain here).
5. `SCENARIO=spike` — pass: new task serving before p99 breaches SLO. Tune, repeat.
6. `SCENARIO=sawtooth` — flap check. Kill test — stop a loaded task; loss = received − sent per task.
7. `build_timeline.py` per scaling event.

## Teardown

Restore prod task-def, desired count, scaling state. Snapshot credit balance.

## Later: correctness pass

One run against real/mock Splunk path; `analyze_sequences.py` vs k6 `splunk_bound_events`. Blackhole runs can't measure end-to-end loss.

---

## Findings (verify/refute during runs)

- **F13 (lead):** write-through buffer on bursting EFS drains credits during healthy ops above ~63 GB/day post-filter (2 TB/day ≈ 21 h; ≥8 TB/day throttles immediately). Zero credits = fleet shares ~1 MiB/s, blocks. Refill ≈ weeks. Break-glass: switch to elastic. Verify real rate via EFS `DataWriteIOBytes`.
- **F1:** buffer-bytes trigger blind to CPU/EFS bottlenecks (Run 2.1 + spike prove it).
- **F2:** killed task's buffer = EFS orphan, never reopened (kill test). Census: none exist today.
- **F3:** acks off → 200 ≠ delivered.
- **F4:** +1/cycle ladder: ~4–5 min first task, 10–16 min full fleet.
- **F5:** Sink A (500-event memory, block) can stall all ingest when CloudWatch throttles.
- **F6/F9:** averaged single-stream metric masks hot tasks; scale-in can kill a loaded task.
- **F7:** scale-out alarm TreatMissingData=missing → silent during overload. Fix: `breaching`.
- **F10/F11:** EFS = shared pool + credit cliff.
- **F12:** closed — per-task dirs, no shared-writer risk.

## Architecture verdicts

- Buffer storage: ephemeral (≤200 GiB/task, free). No Fargate storage is both survivable and recoverable; stop paying for fake durability.
- Durable delivery: S3 sink + SQS pull to Splunk (~$0.3–1.3k/mo at 2–10 TB/day, minutes latency) unless seconds-class SLA → Firehose/HEC (~$2–12k/mo). Sub-second: impossible on Splunk. Severity-split serves both.
- Scaling: composite trigger (CPU OR buffer). Shrinking buffers without changing the trigger disables autoscaling.
- Scale-in: protection while buffer non-empty; stopTimeout 120 s + graceful-shutdown 110 s.
