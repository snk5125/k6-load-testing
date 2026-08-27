# Task List with Commands

Placeholders: `<acct>` account ID, `<region>` us-gov-west-1, `<cluster>` Vector's cluster, `<svc>` Vector service, `<gen-cluster>` generator cluster, `<fs-id>` EFS filesystem, `<alb-dns>` ALB endpoint.

## 1. Build generator image

```dockerfile
# Dockerfile
FROM grafana/k6:latest
COPY k6-vector-assessment.js /scripts/
ENTRYPOINT ["k6","run","/scripts/k6-vector-assessment.js"]
```
```bash
aws ecr get-login-password | docker login --username AWS --password-stdin <acct>.dkr.ecr.<region>.amazonaws.com
docker build -t <acct>.dkr.ecr.<region>.amazonaws.com/<existing-repo>:k6-loadgen-v1 .
docker push <acct>.dkr.ecr.<region>.amazonaws.com/<existing-repo>:k6-loadgen-v1
```

## 2. Generator cluster + task def

```bash
aws ecs create-cluster --cluster-name <gen-cluster>
```
Task def (`k6-taskdef.json`): Fargate, `cpu: 4096`, `memory: 8192`, networkMode awsvpc, image from step 1, env vars `TARGET_URL`, `SCENARIO`, `RUN_ID`, `KNEE_EPS` (override per run via `--overrides`). Use Vector's VPC subnets + a security group allowed to reach the ALB.
```bash
aws ecs register-task-definition --cli-input-json file://k6-taskdef.json
```

## 3. Test Vector config

Copy prod config; change only:
```yaml
sinks:
  Splunk:            # name unchanged — keeps component_id=Splunk metrics/alarms
    type: blackhole
    inputs: [<same inputs as prod Splunk sink>]
    # no buffer block for run 2.1
sources:
  internal: { type: internal_metrics }
sinks:
  prom_exporter:
    type: prometheus_exporter
    inputs: [internal]
    address: 0.0.0.0:9598
```
```bash
aws s3 cp vector-test.yaml s3://<bucket>/<prefix>/vector-test.yaml
```

## 4. Deploy test revision

Duplicate current task def; point config env/entrypoint at `vector-test.yaml`; ensure `enableExecuteCommand` on service.
```bash
aws ecs register-task-definition --cli-input-json file://vector-test-taskdef.json
aws ecs update-service --cluster <cluster> --service <svc> \
  --task-definition <family>:<new-rev> --enable-execute-command --force-new-deployment
```

## 5. Pin + suspend scaling

```bash
aws ecs update-service --cluster <cluster> --service <svc> --desired-count 1
aws application-autoscaling register-scalable-target --service-namespace ecs \
  --resource-id service/<cluster>/<svc> --scalable-dimension ecs:service:DesiredCount \
  --suspended-state DynamicScalingInSuspended=true,DynamicScalingOutSuspended=true
```

## 6. Smoke test

```bash
aws ecs run-task --cluster <gen-cluster> --launch-type FARGATE \
  --task-definition k6-loadgen --network-configuration '...' \
  --overrides '{"containerOverrides":[{"name":"k6","command":["run","--iterations","1","/scripts/k6-vector-assessment.js"],"environment":[{"name":"TARGET_URL","value":"https://<alb-dns>"},{"name":"RUN_ID","value":"smoke-1"},{"name":"SCENARIO","value":"sweep"}]}]}'

TASK=$(aws ecs list-tasks --cluster <cluster> --service-name <svc> --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster <cluster> --task $TASK --container vector \
  --interactive --command "sh -c 'wget -qO- localhost:9598 | grep -E \"received_events_total|sent_events_total\"'"
```
Expect: received=100, sent(Splunk)=100 (or ×PASS_RATIO).

## 7. Sweep 2.1 (no buffer)

```bash
aws ecs run-task ... --overrides '... "environment":[...,{"name":"SCENARIO","value":"sweep"},{"name":"RUN_ID","value":"sweep-2.1a"},{"name":"KNEE_EPS","value":"5000"}]'
```
Watch: k6 summary p50/p99; task CPU (`aws cloudwatch get-metric-statistics --namespace ECS/ContainerInsights --metric-name CpuUtilized ...` or console); port-9598 metrics.
Knee = step where p99 ≥ 2× idle p99. If knee at first/last step, halve/double KNEE_EPS, rerun (`sweep-2.1b`...). Record: knee EPS, CPU% at knee.

## 8. Sweep 2.2 (EFS buffer)

Add to blackhole sink in S3 config, redeploy service (force-new-deployment):
```yaml
    buffer: { type: disk, max_size: 10737418240, when_full: block }
```
Credit snapshot before + after:
```powershell
aws cloudwatch get-metric-statistics --namespace AWS/EFS --metric-name BurstCreditBalance `
  --dimensions Name=FileSystemId,Value=<fs-id> --start-time $start --end-time $end `
  --period 300 --statistics Minimum
```
Run sweep as step 7 (`RUN_ID=sweep-2.2`). Record knee + credit delta.

## 9. Sweep 2.3 (ephemeral buffer)

New task-def revision: remove the EFS volume + mountPoint for `/vector-data-dir`; add `"ephemeralStorage":{"sizeInGiB":40}`. Deploy, run sweep (`RUN_ID=sweep-2.3`).

## 10. (Opt) Sweep 2.4 (mock HEC)

Deploy 1-container Fargate task: nginx with `return 200 '{"text":"Success","code":0}';` on the HEC path. Restore real `splunk_hec_logs` sink config pointed at the mock's IP. Run sweep (`RUN_ID=sweep-2.4`). This knee is the production-realistic one.

## 11. Compute threshold

`threshold = knee_CPU% − (expected load growth over 5 min)`. No growth model → 65.

## 12. CPU alarm + policy

```bash
aws application-autoscaling put-scaling-policy --service-namespace ecs \
  --resource-id service/<cluster>/<svc> --scalable-dimension ecs:service:DesiredCount \
  --policy-name cpu-scale-out --policy-type StepScaling \
  --step-scaling-policy-configuration '{"AdjustmentType":"ChangeInCapacity","Cooldown":60,"MetricAggregationType":"Average","StepAdjustments":[{"MetricIntervalLowerBound":0,"ScalingAdjustment":1}]}'
# note returned PolicyARN
aws cloudwatch put-metric-alarm --alarm-name vector-cpu-high \
  --namespace AWS/ECS --metric-name CPUUtilization \
  --dimensions Name=ClusterName,Value=<cluster> Name=ServiceName,Value=<svc> \
  --statistic Average --period 60 --evaluation-periods 2 \
  --threshold 65 --comparison-operator GreaterThanThreshold \
  --treat-missing-data breaching --alarm-actions <PolicyARN>
```
(Shadow mode: create alarm with no `--alarm-actions` first.)

## 13. (Opt) Cut lag

```bash
aws elbv2 modify-target-group --target-group-arn <tg> \
  --health-check-interval-seconds 10 --healthy-threshold-count 2
# 20s high-res metrics: service Monitoring configuration (console) or update-service --service-connect... (per docs)
```

## 14. Re-arm

```bash
aws application-autoscaling register-scalable-target --service-namespace ecs \
  --resource-id service/<cluster>/<svc> --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 --max-capacity 10 \
  --suspended-state DynamicScalingInSuspended=false,DynamicScalingOutSuspended=false
```

## 15. Rate-limit blackhole

In S3 config: `rate: <0.5–0.7 × knee EPS>` on the blackhole sink (buffer block per the arm under test). Redeploy.

## 16. Spike validation

`SCENARIO=spike`, `KNEE_EPS=<measured>`. Pass: timeline shows new task serving (t4) before k6 p99 breached SLO. Fail: lower threshold 5 pts or apply step 13; rerun.

## 17. Sawtooth

`SCENARIO=sawtooth`. Then:
```bash
aws application-autoscaling describe-scaling-activities --service-namespace ecs \
  --resource-id service/<cluster>/<svc> --max-results 50
```
>~4 actions/hour on steady pattern = flapping.

## 18. Kill test

During plateau (`SCENARIO=plateau`), find loaded task via 9598 `buffer_byte_size`, then:
```bash
aws ecs stop-task --cluster <cluster> --task <task-arn> --reason kill-test
```
Loss = that task's (received − sent) at kill; verify fleet totals vs k6 `splunk_bound_events`.

## 19. Evidence

```bash
python3 build_timeline.py --cluster <cluster> --service <svc> \
  --alarms vector-cpu-high <buffer-alarms> --start <iso> --end <iso>
```
Archive: `summary-<RUN_ID>.json`, timeline.csv, FAILED_SEQ greps, credit snapshots.

## 20. Teardown

```bash
aws ecs update-service --cluster <cluster> --service <svc> --task-definition <family>:<prod-rev> --desired-count 2
# restore original suspended-state; delete test alarms/policy if not keeping
```
Snapshot BurstCreditBalance.

## 21. Correctness pass (later)

Real/mock Splunk sink; run plateau; export from Splunk:
`| search run_id=<RUN_ID> | table _time splunk_seq | outputcsv` → JSONL →
```bash
python3 analyze_sequences.py events.jsonl --expected <splunk_bound_events> --known-failed failed.txt
```
