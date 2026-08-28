// ============================================================================
// k6 harness — OTLP/gRPC variant (port 4317)
// Vector's from_otel HTTP endpoint requires protobuf encoding, so this
// variant speaks OTLP gRPC; k6 encodes protobuf from the .proto files.
//
// Requires the opentelemetry-proto files in the image at /protos
// (see Dockerfile). Same scenarios/env vars as the HTTP variant.
//   TARGET     e.g. <nlb-dns>:4317  (host:port, NO scheme)
//   TLS=1      if the listener is TLS; default plaintext
// ============================================================================

import grpc from 'k6/net/grpc';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const events = new Counter('log_events');
const splunkEvents = new Counter('splunk_events');
const bytes = new Counter('log_bytes'); // approximate: JSON-side size
const failedReqs = new Counter('failed_reqs');

const TARGET = __ENV.TARGET;           // host:port
const RUN_ID = __ENV.RUN_ID;
const BATCH = parseInt(__ENV.BATCH || '100');
const MSG_BYTES = parseInt(__ENV.MSG_BYTES || '512');
const KNEE = parseInt(__ENV.KNEE_EPS || '5000');
const PASS_RATIO = parseFloat(__ENV.PASS_RATIO || '1.0');
const PASS_PER_BATCH = Math.max(1, Math.round(BATCH * PASS_RATIO));

if (!TARGET || !RUN_ID || !__ENV.SCENARIO) {
  throw new Error('TARGET, RUN_ID and SCENARIO are required');
}

const r = (eps) => Math.max(1, Math.round(eps / BATCH));
const PRE_VUS = parseInt(__ENV.PRE_VUS || '200');
const MAX_VUS = parseInt(__ENV.MAX_VUS || String(PRE_VUS * 10));

const base = {
  executor: 'ramping-arrival-rate',
  timeUnit: '1s',
  preAllocatedVUs: PRE_VUS,
  maxVUs: MAX_VUS,
};

const SCENARIOS = {
  sweep: { ...base, startRate: r(KNEE * 0.1),
    stages: [].concat(...[0.1,0.25,0.5,0.75,1.0,1.25,1.5].map((m)=>[
      { target: r(KNEE*m), duration: '15s' },
      { target: r(KNEE*m), duration: '165s' }])) },
  staircase: { ...base, startRate: r(KNEE * 0.5),
    stages: [].concat(...[0.5,1.0,1.5,2.0,2.5,3.0].map((m)=>[
      { target: r(KNEE*m), duration: '15s' },
      { target: r(KNEE*m), duration: '285s' }])) },
  spike: { ...base, startRate: r(KNEE),
    stages: [
      { target: r(KNEE), duration: '5m' },
      { target: r(KNEE*4), duration: '30s' },
      { target: r(KNEE*4), duration: '10m' },
      { target: r(KNEE), duration: '2m' }] },
  sawtooth: { ...base, startRate: r(KNEE),
    stages: [].concat(...Array.from({length:4},()=>[
      { target: r(KNEE*2.5), duration: '5m' },
      { target: r(KNEE), duration: '5m' }])) },
  plateau: { ...base, startRate: r(KNEE*2),
    stages: [{ target: r(KNEE*2), duration: '15m' }] },
};

export const options = {
  scenarios: { [__ENV.SCENARIO]: SCENARIOS[__ENV.SCENARIO] },
  summaryTrendStats: ['avg','min','med','max','p(90)','p(99)'],
  thresholds: {
    dropped_iterations: ['count<1'],
    failed_reqs: ['count<100000'], // informational; see summary failed count
  },
};

// Load OTLP protos (init context). /protos = opentelemetry-proto repo root.
const client = new grpc.Client();
client.load(['/protos'], 'opentelemetry/proto/collector/logs/v1/logs_service.proto');

const PAD = 'x'.repeat(MSG_BYTES);
let connected = false;

export default function () {
  if (!connected) {
    client.connect(TARGET, { plaintext: __ENV.TLS !== '1', timeout: '10s' });
    connected = true; // one connection per VU (NLB pins flows per connection)
  }

  const iter = exec.scenario.iterationInTest;
  const passSeqBase = iter * PASS_PER_BATCH;
  const now = Date.now();

  const logRecords = [];
  for (let i = 0; i < BATCH; i++) {
    const passes = i < PASS_PER_BATCH;
    const attrs = [
      { key: 'generator_id', value: { stringValue: RUN_ID } },
      { key: 'emit_ts', value: { intValue: String(now) } },
      { key: 'run_id', value: { stringValue: RUN_ID } },
    ];
    if (passes) attrs.push({ key: 'splunk_seq', value: { intValue: String(passSeqBase + i) } });
    logRecords.push({
      timeUnixNano: String(now) + '000000',
      severityNumber: passes ? 13 : 9,   // SEVERITY_NUMBER_WARN / _INFO
      severityText: passes ? 'WARN' : 'INFO',
      body: { stringValue: 'synthetic ' + PAD },
      attributes: attrs,
    });
  }

  const payload = {
    resourceLogs: [{
      resource: { attributes: [
        { key: 'service.name', value: { stringValue: 'k6-loadgen' } }] },
      scopeLogs: [{ scope: { name: 'k6' }, logRecords }],
    }],
  };

  const res = client.invoke(
    'opentelemetry.proto.collector.logs.v1.LogsService/Export',
    payload, { timeout: '10s' });

  const ok = check(res, { 'grpc OK': (r2) => r2 && r2.status === grpc.StatusOK });
  if (ok) {
    events.add(BATCH);
    splunkEvents.add(PASS_PER_BATCH);
    bytes.add(JSON.stringify(payload).length);
  } else {
    failedReqs.add(1);
    console.warn('FAILED_SEQ ' + passSeqBase + '-' + (passSeqBase + PASS_PER_BATCH - 1) +
      ' status=' + (res ? res.status : 'conn-error'));
    connected = false; // force reconnect next iteration
    try { client.close(); } catch (e) { /* ignore */ }
  }
}

export function handleSummary(data) {
  const m = data.metrics;
  const get = (n,k) => (m[n] && m[n].values && m[n].values[k]) || 0;
  const s = {
    run_id: RUN_ID, scenario: __ENV.SCENARIO, transport: 'otlp-grpc',
    knee_eps_assumed: KNEE, batch: BATCH, pass_ratio: PASS_RATIO,
    confirmed_events: get('log_events','count'),
    splunk_bound_events: get('splunk_events','count'),
    failed_requests: get('failed_reqs','count'),
    dropped_iterations: get('dropped_iterations','count'),
    p99_ms: get('grpc_req_duration','p(99)'),
    p50_ms: get('grpc_req_duration','med'),
  };
  return {
    ['summary-' + RUN_ID + '.json']: JSON.stringify(s, null, 2),
    stdout: '\n=== ' + RUN_ID + ' (' + __ENV.SCENARIO + ', gRPC) ===\n' +
      'confirmed events : ' + s.confirmed_events + '\n' +
      'splunk-bound     : ' + s.splunk_bound_events + '\n' +
      'failed requests  : ' + s.failed_requests + '\n' +
      'dropped iters    : ' + s.dropped_iterations + '  <-- MUST be 0\n' +
      'p50/p99 ms       : ' + s.p50_ms.toFixed(1) + ' / ' + s.p99_ms.toFixed(1) + '\n',
  };
}
