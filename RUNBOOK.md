# Run Mechanics (companion to ASSESSMENT-PLAN.md)

## k6 invocation

```
k6 run --env SCENARIO=<sweep|staircase|spike|sawtooth|plateau> \
       --env TARGET_URL=https://<alb> --env RUN_ID=<unique> \
       --env KNEE_EPS=<measured> k6-vector-assessment.js
```

Env: `BATCH` (default 100), `MSG_BYTES` (512), `PASS_RATIO` (1.0 = all events pass the noteworthy filter; test events are WARN), `PRE_VUS`/`MAX_VUS`.

## Per-run checklist

- [ ] Unique RUN_ID
- [ ] Generator CPU < 80% for whole run
- [ ] `dropped_iterations` = 0 (else void — raise MAX_VUS)
- [ ] EFS-buffered runs: BurstCreditBalance before/after
- [ ] Save `summary-<RUN_ID>.json` + grep k6 output for `FAILED_SEQ` lines

## Cross-checks per run

k6 `splunk_bound_events` ≈ Vector `component_received_events_total` ≈ sink `component_sent_events_total` (sum tasks). Deltas localize the loss layer.

## Useful commands

- Per-task metrics: ECS Exec → `wget -qO- localhost:9598 | grep -E 'buffer_byte_size|received_events|sent_events|discarded'`
- Suspend/resume scaling: `aws application-autoscaling register-scalable-target ... --suspended-state DynamicScalingInSuspended=<bool>,DynamicScalingOutSuspended=<bool>`
- Force alarm (control-plane dry run): `aws cloudwatch set-alarm-state --alarm-name <x> --state-value ALARM --state-reason test`
- Kill test: `aws ecs stop-task --cluster <c> --task <t>` while its buffer is non-empty
- Timeline: `python3 build_timeline.py --cluster <c> --service <s> --alarms <a1> <a2> --start <iso> --end <iso>`
- Sequence analysis (real-sink pass only): `python3 analyze_sequences.py events.jsonl --expected <splunk_bound_events> --known-failed failed.txt`
