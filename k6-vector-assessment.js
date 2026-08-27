// ============================================================================
// k6 load-test harness — Vector aggregator autoscale assessment
//
// Sends synthetic OTLP/HTTP JSON log batches to the Vector tier's ALB.
// Five load shapes (scenarios), selected via SCENARIO env var. Every
// filter-passing event carries a dense sequence number so loss/duplication
// can be measured at the sink (see analyze_sequences.py).
//
// Usage:
//   k6 run --env SCENARIO=sweep --env TARGET_URL=https://<alb> \
//          --env RUN_ID=sweep-01 --env KNEE_EPS=5000 k6-vector-assessment.js
//
// Env vars:
//   TARGET_URL  (required) ALB base URL; /v1/logs is appended
//   RUN_ID      (required) unique per run; keys the sequence analysis
//   SCENARIO    (required) sweep | staircase | spike | sawtooth | plateau
//   KNEE_EPS    events/sec at single-task knee (default 5000; set after sweep)
//   BATCH       events per HTTP request (default 100; match prod shippers)
//   MSG_BYTES   log body padding (default 512; match prod event size)
//   PASS_RATIO  fraction of events sent at WARN so they pass the
//               'noteworthy' filter (default 1.0). Non-passing chaff is INFO.
//   PRE_VUS / MAX_VUS  worker-pool sizing (see VU ALLOCATION below)
//
// Invalid-run guards:
//   - dropped_iterations > 0  => generator couldn't hold the offered rate;
//     run is VOID (coordinated omission). Raise MAX_VUS and re-run.
//   - Generator task CPU must stay < 80% (check CloudWatch) or run is VOID.
// ============================================================================

import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// CUSTOM METRICS
// Three counters beyond k6's built-ins, because RPS alone is meaningless for
// a log tier (batch size hides real volume):
//   log_events     every event sent (EPS when divided by duration)
//   splunk_events  only filter-passing events — the number the sink should
//                  eventually hold; compared against Splunk/blackhole counts
//   log_bytes      wire volume (MB/s)
// ack_latency_ms duplicates http_req_duration but only for successful posts.
// ---------------------------------------------------------------------------
const events = new Counter('log_events');
const splunkEvents = new Counter('splunk_events');
const bytes = new Counter('log_bytes');
const ackLatency = new Trend('ack_latency_ms', true);

// ---------------------------------------------------------------------------
// ENV PARSING + DERIVED CONSTANTS
// r(eps) converts an events/sec target into an iterations/sec rate for k6:
// each iteration posts exactly one batch of BATCH events.
// PASS_PER_BATCH: how many events per batch go out at WARN severity (pass
// the noteworthy filter) and carry a sequence number. Floor of 1 so the
// sequence space is never empty.
// ---------------------------------------------------------------------------
const TARGET = `${__ENV.TARGET_URL}/v1/logs`;
const RUN_ID = __ENV.RUN_ID;
const BATCH = parseInt(__ENV.BATCH || '100');
const MSG_BYTES = parseInt(__ENV.MSG_BYTES || '512');
const KNEE = parseInt(__ENV.KNEE_EPS || '5000'); // events/sec
const PASS_RATIO = parseFloat(__ENV.PASS_RATIO || '1.0');
const PASS_PER_BATCH = Math.max(1, Math.round(BATCH * PASS_RATIO));

if (!__ENV.TARGET_URL || !RUN_ID || !__ENV.SCENARIO) {
  throw new Error('TARGET_URL, RUN_ID and SCENARIO are required');
}

const r = (eps) => Math.max(1, Math.round(eps / BATCH));

// ---------------------------------------------------------------------------
// VU ALLOCATION
// All scenarios use the OPEN MODEL (ramping-arrival-rate): k6 starts
// iterations at the requested rate regardless of how slowly the target
// responds. VUs are just the worker pool servicing that rate.
// Needed VUs ≈ rate × avg iteration duration (Little's Law). If the pool
// hits MAX_VUS, k6 drops iterations — which trips the invalid-run guard.
// ---------------------------------------------------------------------------
const PRE_VUS = parseInt(__ENV.PRE_VUS || '200');
const MAX_VUS = parseInt(__ENV.MAX_VUS || String(PRE_VUS * 10));

const base = {
  executor: 'ramping-arrival-rate',
  timeUnit: '1s',
  preAllocatedVUs: PRE_VUS,
  maxVUs: MAX_VUS,
};

// ---------------------------------------------------------------------------
// LOAD SHAPES
// All rates are multiples of KNEE_EPS so one measured number calibrates
// every scenario.
// NOTE: ramping-arrival-rate ramps LINEARLY toward each stage target.
// sweep/staircase therefore build each level as a 15s transition followed
// by a flat hold — clean plateaus are required to read the knee. spike and
// sawtooth keep deliberate ramps (the ramp is the test).
// ---------------------------------------------------------------------------
const SCENARIOS = {
  // sweep: knee-finding on ONE pinned task, scaling suspended.
  // 7 flat levels, 10% -> 150% of assumed knee, 3 min each.
  // Knee = level where p99 reaches 2x idle p99.
  sweep: {
    ...base,
    startRate: r(KNEE * 0.1),
    stages: [].concat(
      ...[0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5].map((m) => [
        { target: r(KNEE * m), duration: '15s' },   // transition
        { target: r(KNEE * m), duration: '165s' },  // flat hold
      ])
    ),
  },

  // staircase: scaling ON. 6 levels, 0.5x -> 3x knee, 5 min each.
  // Does task count track load? (Tests the scaling trigger's tracking.)
  staircase: {
    ...base,
    startRate: r(KNEE * 0.5),
    stages: [].concat(
      ...[0.5, 1.0, 1.5, 2.0, 2.5, 3.0].map((m) => [
        { target: r(KNEE * m), duration: '15s' },
        { target: r(KNEE * m), duration: '285s' },
      ])
    ),
  },

  // spike: scaling ON. Settle at 1x, jump to 4x in 30s, hold 10 min.
  // Measures worst-case scale-out lag vs the +1-task-per-cycle ladder.
  spike: {
    ...base,
    startRate: r(KNEE * 1.0),
    stages: [
      { target: r(KNEE * 1.0), duration: '5m' },   // settle
      { target: r(KNEE * 4.0), duration: '30s' },  // the spike
      { target: r(KNEE * 4.0), duration: '10m' },  // hold; watch ladder climb
      { target: r(KNEE * 1.0), duration: '2m' },   // release
    ],
  },

  // sawtooth: scaling ON. 4 cycles of 1x <-> 2.5x, 5 min per leg.
  // Counts scaling actions per hour (flap detection, scale-in threshold).
  sawtooth: {
    ...base,
    startRate: r(KNEE * 1.0),
    stages: [].concat(
      ...Array.from({ length: 4 }, () => [
        { target: r(KNEE * 2.5), duration: '5m' },
        { target: r(KNEE * 1.0), duration: '5m' },
      ])
    ),
  },

  // plateau: scaling ON. Hold 2x knee for 15 min, then the scenario ends
  // (hard stop). Used for the kill test and scale-in observation — keep
  // AWS-side capture running through the scale-in that follows.
  plateau: {
    ...base,
    startRate: r(KNEE * 2.0),
    stages: [{ target: r(KNEE * 2.0), duration: '15m' }],
  },
};

// ---------------------------------------------------------------------------
// OPTIONS
// summaryTrendStats: k6 only computes the percentile stats listed here —
// med and p(99) are read by handleSummary and are NOT in k6's defaults.
// Thresholds are run gates, not aborts: dropped_iterations must be 0 for a
// valid run; http_req_failed 5% is informational (overload phases exceed it
// by design when when_full=block backpressure kicks in).
// discardResponseBodies saves generator memory/CPU (responses are not read).
// ---------------------------------------------------------------------------
export const options = {
  scenarios: { [__ENV.SCENARIO]: SCENARIOS[__ENV.SCENARIO] },
  // NLB routes by flow: existing connections stay pinned to one target, so
  // after scale-out, new tasks only receive NEW flows.
  //   NO_CONN_REUSE unset  -> keep-alive (production-realistic; shows how
  //                           slowly new capacity absorbs load behind NLB)
  //   NO_CONN_REUSE=1      -> new connection per iteration (ideal
  //                           distribution; isolates scaling from pinning)
  noConnectionReuse: __ENV.NO_CONN_REUSE === '1',
  // Set if TLS terminates at Vector with a self-signed cert:
  insecureSkipTLSVerify: __ENV.SKIP_TLS_VERIFY === '1',
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(99)'],
  thresholds: {
    dropped_iterations: ['count<1'],
    http_req_failed: ['rate<0.05'],
  },
  discardResponseBodies: true,
};

// Pre-built padding string so per-iteration work is allocation-light.
const PAD = 'x'.repeat(MSG_BYTES);

// ---------------------------------------------------------------------------
// ITERATION BODY — runs once per batch at the scheduled arrival rate.
//
// Sequence numbering: iterationInTest is globally unique and monotonic
// across all VUs, so passSeqBase = iteration × PASS_PER_BATCH yields a
// DENSE, gap-free sequence space over all filter-passing events. Any gap
// observed at the sink is therefore loss (or a logged visible failure);
// any repeat is duplication.
//
// Filter handling: the aggregator's 'noteworthy' filter keeps
// warn/error/critical/fatal + auth/audit/security. The first PASS_PER_BATCH
// events go out at WARN (severityNumber 13) so they pass; the remainder are
// INFO chaff — Vector pays to parse-and-drop them (realistic CPU load) but
// they carry no sequence number, so they never look like loss.
// ---------------------------------------------------------------------------
export default function () {
  const gen = `${RUN_ID}`; // one sequence space per run
  const iter = exec.scenario.iterationInTest;
  const passSeqBase = iter * PASS_PER_BATCH;
  const now = Date.now();

  // Build one batch of OTLP logRecords.
  const logRecords = [];
  for (let i = 0; i < BATCH; i++) {
    const passes = i < PASS_PER_BATCH;
    const attrs = [
      { key: 'generator_id', value: { stringValue: gen } },
      { key: 'emit_ts', value: { intValue: String(now) } },
      { key: 'run_id', value: { stringValue: RUN_ID } },
    ];
    if (passes) {
      // Only filter-passing events get a sequence number.
      attrs.push({ key: 'splunk_seq', value: { intValue: String(passSeqBase + i) } });
    }
    logRecords.push({
      timeUnixNano: `${now}000000`,           // ms -> ns as string
      severityNumber: passes ? 13 : 9,        // 13=WARN (passes), 9=INFO (chaff)
      severityText: passes ? 'WARN' : 'INFO',
      body: { stringValue: `synthetic ${PAD}` },
      attributes: attrs,
    });
  }

  // Wrap in the OTLP/HTTP JSON envelope (ExportLogsServiceRequest).
  const body = JSON.stringify({
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'k6-loadgen' } },
        ],
      },
      scopeLogs: [{ scope: { name: 'k6' }, logRecords }],
    }],
  });

  // POST to Vector's OTLP HTTP endpoint. 10s timeout: a Vector blocked by
  // backpressure must produce a countable failure, not hang for k6's
  // default 60s and distort the latency picture.
  const res = http.post(TARGET, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '10s',
    tags: { scenario: __ENV.SCENARIO },
  });

  const ok = check(res, { 'status 2xx': (r2) => r2.status >= 200 && r2.status < 300 });

  if (!ok) {
    // Failed requests still consumed their sequence range. Log it so the
    // analyzer can classify these gaps as VISIBLE failures (client saw the
    // error) rather than SILENT loss (client got 200, data vanished).
    // Grep k6 output for FAILED_SEQ -> feed analyze_sequences.py --known-failed.
    console.warn(`FAILED_SEQ ${passSeqBase}-${passSeqBase + PASS_PER_BATCH - 1} status=${res.status}`);
  }

  if (ok) {
    events.add(BATCH);
    splunkEvents.add(PASS_PER_BATCH);
    bytes.add(body.length);
    ackLatency.add(res.timings.duration);
  }
}

// ---------------------------------------------------------------------------
// SUMMARY — runs once at test end.
// Writes summary-<RUN_ID>.json (machine-readable, archived per run) and a
// short stdout block. splunk_bound_events is the expected sink-side count:
// the --expected input to analyze_sequences.py and the number to compare
// against Vector's component_sent_events_total.
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const m = data.metrics;
  const get = (n, k) => (m[n] && m[n].values && m[n].values[k]) || 0;
  const summary = {
    run_id: RUN_ID,
    scenario: __ENV.SCENARIO,
    knee_eps_assumed: KNEE,
    batch: BATCH,
    confirmed_events: get('log_events', 'count'),
    splunk_bound_events: get('splunk_events', 'count'),
    pass_ratio: PASS_RATIO,
    sent_bytes: get('log_bytes', 'count'),
    requests: get('http_reqs', 'count'),
    failed_rate: get('http_req_failed', 'rate'),
    dropped_iterations: get('dropped_iterations', 'count'),
    p99_ms: get('http_req_duration', 'p(99)'),
    p50_ms: get('http_req_duration', 'med'),
  };
  return {
    [`summary-${RUN_ID}.json`]: JSON.stringify(summary, null, 2),
    stdout: `\n=== ${RUN_ID} (${__ENV.SCENARIO}) ===\n` +
      `confirmed events : ${summary.confirmed_events}\n` +
      `splunk-bound     : ${summary.splunk_bound_events}\n` +
      `failed rate      : ${(summary.failed_rate * 100).toFixed(2)}%\n` +
      `dropped iters    : ${summary.dropped_iterations}  <-- MUST be 0\n` +
      `p50/p99 ms       : ${summary.p50_ms.toFixed(1)} / ${summary.p99_ms.toFixed(1)}\n`,
  };
}
