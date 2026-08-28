# Task List with Commands

## 0. Prerequisites — gather BEFORE starting

| # | What | Where to get it |
|---|------|-----------------|
| 1 | Private subnet IDs (2) | layer-00 remote state outputs |
| 2 | VPC ID | layer-00 remote state |
| 3 | NLB DNS name | `aws elbv2 describe-load-balancers` |
| 4 | OTLP listener port | `aws elbv2 describe-listeners` |
| 5 | TLS on listener? (https/http) | same as #4 |
| 6 | Vector's security group ID | Vector service `networkConfiguration` |
| 7 | Execution role ARN | `aws iam get-role --role-name ecsTaskExecutionRole` |
| 8 | k6 image URI | ECR push (step 1) |
| 9 | Generator cluster name (your choice) | — |
| 10 | NAT or VPC endpoints in the subnets? | route tables for #1 |

Blockers for first launch: 1, 3, 4, 6, 7. Fill these into the placeholders
below before running any step.

Placeholders: `<acct>` account ID, `<region>` us-gov-west-1, `<vector-cluster>` the EXISTING cluster running Vector, `<vector-svc>` the existing Vector service in it, `<gen-cluster>` generator cluster, `<fs-id>` EFS filesystem, `<nlb-dns>`/`<otlp-port>` from #3/#4, `<vpc-id>`/subnets from #1/#2, `<k6-sg-id>` created in step 2d.

## 1. Build generator image

```dockerfile
# Dockerfile
FROM grafana/k6:latest
COPY k6-vector-assessment.js /scripts/
ENTRYPOINT ["k6","run","/scripts/k6-vector-assessment.js"]
```
```bash
# create the repo (once)
aws ecr create-repository --repository-name k6-loadgen \
  --image-scanning-configuration scanOnPush=true --region <region>
# authenticate docker to ECR, build, push
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <acct>.dkr.ecr.<region>.amazonaws.com
docker build -t <acct>.dkr.ecr.<region>.amazonaws.com/k6-loadgen:v1 .
docker push <acct>.dkr.ecr.<region>.amazonaws.com/k6-loadgen:v1
```

## 2. Generator cluster + task def

**2a. Cluster** (with Container Insights so generator CPU is visible — the <80% guard):
```bash
aws ecs create-cluster --cluster-name <gen-cluster> \
  --settings name=containerInsights,value=enabled
```

**2b. Log group** (k6 output — summaries and FAILED_SEQ lines — lands here):
```bash
aws logs create-log-group --log-group-name /ecs/k6-loadgen
aws logs put-retention-policy --log-group-name /ecs/k6-loadgen --retention-in-days 30
```

**2c. IAM.** Two roles:
- **Execution role** (required): pulls the image + writes logs. Reuse an existing
  `ecsTaskExecutionRole` with the AWS-managed `AmazonECSTaskExecutionRolePolicy`,
  or create one with that policy and trust `ecs-tasks.amazonaws.com`.
- **Task role** (not needed): the k6 container calls no AWS APIs. Omit.

**2d. Security group** for the generator:
```bash
aws ec2 create-security-group --group-name k6-loadgen-sg \
  --description "k6 generator egress to Vector NLB" --vpc-id <vpc-id>
# egress only; no ingress rules. Restrict egress to the Vector listener port:
aws ec2 authorize-security-group-egress --group-id <sg-id> \
  --protocol tcp --port <otlp-port> --cidr <vpc-cidr>
```
If Vector's own security group restricts sources, add an ingress rule there
allowing `<sg-id>` on `<otlp-port>`.

**2e. Task definition** — `k6-taskdef.json`:
```json
{
  "family": "k6-loadgen",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "4096",
  "memory": "8192",
  "executionRoleArn": "arn:aws-us-gov:iam::<acct>:role/ecsTaskExecutionRole",
  "containerDefinitions": [{
    "name": "k6",
    "image": "<acct>.dkr.ecr.<region>.amazonaws.com/k6-loadgen:v1",
    "essential": true,
    "environment": [
      {"name": "TARGET_URL", "value": "https://<nlb-dns>:<otlp-port>"},
      {"name": "SCENARIO",   "value": "sweep"},
      {"name": "RUN_ID",     "value": "override-me"},
      {"name": "KNEE_EPS",   "value": "5000"}
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/k6-loadgen",
        "awslogs-region": "<region>",
        "awslogs-stream-prefix": "k6"
      }
    }
  }]
}
```
```bash
aws ecs register-task-definition --cli-input-json file://k6-taskdef.json
```
Notes: --overrides replaces only the env vars it lists; unlisted ones fall
back to task-def defaults. SCENARIO/RUN_ID/KNEE_EPS are per-run — always
override them (RUN_ID must be unique every run). TARGET_URL is constant —
bake the real value in here and omit it from overrides. The task definition
contains NO networking: subnets/SG (and therefore VPC) are passed at launch
time via --network-configuration — see step 6's NETCFG. GovCloud ARN
partition is `arn:aws-us-gov:`.

## 3. Test Vector config (multi-file layout)

Vector merges every file in its config dir; component names must be unique
across files. The aggregator splits sources/sinks into separate files, so
the test config is per-file edits, not one rewritten file:

**a. Sinks file** — replace ONLY the Splunk sink's body, keeping its name
(preserves the component_id=Splunk metric dimension and the alarms):
```yaml
sinks:
  Splunk:
    type: blackhole
    inputs: [<same inputs as the prod Splunk sink>]
    # no buffer block for run 2.1; add the prod buffer block for 2.2/2.3
```

**b. New file `observability.yaml`** — additive, touches nothing else:
```yaml
sources:
  internal:
    type: internal_metrics
sinks:
  prom_exporter:
    type: prometheus_exporter
    inputs: [internal]
    address: 0.0.0.0:9598
```

**c. All other files (sources, transforms/filter) unchanged** — the
noteworthy filter and the from_otel source stay exactly as prod.

Stage the test set under its own S3 prefix so prod and test configs can
never be confused, and point the test task-def revision at it:
```bash
aws s3 sync ./vector-test-config/ s3://<bucket>/<test-prefix>/
```

## 4. Deploy test revision

Duplicate current task def; point config env/entrypoint at `vector-test.yaml`; ensure `enableExecuteCommand` on service.
```bash
aws ecs register-task-definition --cli-input-json file://vector-test-taskdef.json
aws ecs update-service --cluster <vector-cluster> --service <vector-svc> \
  --task-definition <family>:<new-rev> --enable-execute-command --force-new-deployment
```

## 5. Pin + suspend scaling

```bash
aws ecs update-service --cluster <vector-cluster> --service <vector-svc> --desired-count 1
aws application-autoscaling register-scalable-target --service-namespace ecs \
  --resource-id service/<vector-cluster>/<vector-svc> --scalable-dimension ecs:service:DesiredCount \
  --suspended-state DynamicScalingInSuspended=true,DynamicScalingOutSuspended=true
```

## 6. Smoke test

VPC placement happens HERE, not in the cluster or task definition: the
subnet IDs in --network-configuration decide the VPC. Use Vector's private
subnets so traffic to the NLB stays in-VPC; assignPublicIp=DISABLED means
the image pull needs a NAT route or VPC endpoints (ecr.api, ecr.dkr, S3
gateway, logs) in those subnets. NETCFG is reused for every run:

```bash
NETCFG='awsvpcConfiguration={subnets=[subnet-aaa,subnet-bbb],securityGroups=[<k6-sg-id>],assignPublicIp=DISABLED}'

aws ecs run-task --cluster <gen-cluster> --launch-type FARGATE \
  --task-definition k6-loadgen --network-configuration "$NETCFG" \
  --overrides '{"containerOverrides":[{"name":"k6","command":["run","--iterations","1","/scripts/k6-vector-assessment.js"],"environment":[{"name":"TARGET_URL","value":"https://<nlb-dns>:<otlp-port>"},{"name":"RUN_ID","value":"smoke-1"},{"name":"SCENARIO","value":"sweep"}]}]}'

# per-task metrics: curl the task IP directly from an in-VPC host
# (requires 9598 ingress on Vector's SG from that host's SG)
TASK=$(aws ecs list-tasks --cluster <vector-cluster> --service-name <vector-svc> --query 'taskArns[0]' --output text)
IP=$(aws ecs describe-tasks --cluster <vector-cluster> --tasks $TASK \
  --query "tasks[0].attachments[0].details[?name=='privateIPv4Address'].value" --output text)
curl -s http://$IP:9598/metrics | grep -E 'received_events_total|sent_events_total'
```
Expect: received=100, sent(Splunk)=100 (or ×PASS_RATIO).
(Fallback if no in-VPC host: ECS Exec into the task and wget localhost:9598/metrics.)

## 7. Sweep 2.1 (no buffer)

```bash
aws ecs run-task --cluster <gen-cluster> --launch-type FARGATE \
  --task-definition k6-loadgen --network-configuration "$NETCFG" \
  --overrides '{"containerOverrides":[{"name":"k6","environment":[{"name":"TARGET_URL","value":"https://<nlb-dns>:<otlp-port>"},{"name":"SCENARIO","value":"sweep"},{"name":"RUN_ID","value":"sweep-2.1a"},{"name":"KNEE_EPS","value":"5000"}]}]}'
```
Watch: k6 summary p50/p99; task CPU (`aws cloudwatch get-metric-statistics --namespace ECS/ContainerInsights --metric-name CpuUtilized ...` or console); port-9598 metrics.
Knee = step where p99 ≥ 2× idle p99. If knee at first/last step, halve/double KNEE_EPS, rerun (`sweep-2.1b`...). Record: knee EPS, CPU% at knee.

## 8. Sweep 2.2 (EFS buffer)

In the SINKS file, add to the blackhole sink, re-sync to the test prefix, redeploy (force-new-deployment):
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
  --resource-id service/<vector-cluster>/<vector-svc> --scalable-dimension ecs:service:DesiredCount \
  --policy-name cpu-scale-out --policy-type StepScaling \
  --step-scaling-policy-configuration '{"AdjustmentType":"ChangeInCapacity","Cooldown":60,"MetricAggregationType":"Average","StepAdjustments":[{"MetricIntervalLowerBound":0,"ScalingAdjustment":1}]}'
# note returned PolicyARN
aws cloudwatch put-metric-alarm --alarm-name vector-cpu-high \
  --namespace AWS/ECS --metric-name CPUUtilization \
  --dimensions Name=ClusterName,Value=<vector-cluster> Name=ServiceName,Value=<vector-svc> \
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
  --resource-id service/<vector-cluster>/<vector-svc> --scalable-dimension ecs:service:DesiredCount \
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
  --resource-id service/<vector-cluster>/<vector-svc> --max-results 50
```
>~4 actions/hour on steady pattern = flapping.

## 18. Kill test

During plateau (`SCENARIO=plateau`), curl EACH task's IP for `buffer_byte_size`
(`curl -s http://<task-ip>:9598/metrics | grep buffer_byte_size`), pick the
loaded one, then:
```bash
aws ecs stop-task --cluster <vector-cluster> --task <task-arn> --reason kill-test
```
Loss = that task's (received − sent) at kill; verify fleet totals vs k6 `splunk_bound_events`.

## 19. Evidence

```bash
python3 build_timeline.py --cluster <vector-cluster> --service <vector-svc> \
  --alarms vector-cpu-high <buffer-alarms> --start <iso> --end <iso>
```
Archive: `summary-<RUN_ID>.json`, timeline.csv, FAILED_SEQ greps, credit snapshots.

## 20. Teardown

```bash
aws ecs update-service --cluster <vector-cluster> --service <vector-svc> --task-definition <family>:<prod-rev> --desired-count 2
# restore original suspended-state; delete test alarms/policy if not keeping
```
Snapshot BurstCreditBalance.

## 21. Correctness pass (later)

Real/mock Splunk sink; run plateau; export from Splunk:
`| search run_id=<RUN_ID> | table _time splunk_seq | outputcsv` → JSONL →
```bash
python3 analyze_sequences.py events.jsonl --expected <splunk_bound_events> --known-failed failed.txt
```
