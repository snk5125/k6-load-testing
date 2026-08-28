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

Placeholders: `<acct>` account ID, `<region>` us-gov-west-1, `<cluster>` Vector's cluster, `<svc>` Vector service, `<gen-cluster>` generator cluster, `<fs-id>` EFS filesystem, `<nlb-dns>`/`<otlp-port>` from #3/#4, `<vpc-id>`/subnets from #1/#2, `<k6-sg-id>` created in step 2d.

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
Notes: defaults in `environment` are placeholders — every real run overrides
SCENARIO/RUN_ID/KNEE_EPS via `--overrides` (step 6/7). Subnets: use Vector's
private subnets, `assignPublicIp=DISABLED` (image pull needs a NAT or ECR VPC
endpoints — `com.amazonaws.<region>.ecr.api`, `.ecr.dkr`, plus S3 gateway —
if the subnets have no NAT). GovCloud ARN partition is `arn:aws-us-gov:`.

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

VPC placement happens HERE, not in the cluster or task definition: the
subnet IDs in --network-configuration decide the VPC. Use Vector's private
subnets so traffic to the NLB stays in-VPC. Reused for every run:

```bash
NETCFG='awsvpcConfiguration={subnets=[subnet-aaa,subnet-bbb],securityGroups=[<k6-sg-id>],assignPublicIp=DISABLED}'

aws ecs run-task --cluster <gen-cluster> --launch-type FARGATE \
  --task-definition k6-loadgen --network-configuration "$NETCFG" \
  --overrides '{"containerOverrides":[{"name":"k6","command":["run","--iterations","1","/scripts/k6-vector-assessment.js"],"environment":[{"name":"TARGET_URL","value":"https://<nlb-dns>:<otlp-port>"},{"name":"RUN_ID","value":"smoke-1"},{"name":"SCENARIO","value":"sweep"}]}]}'

TASK=$(aws ecs list-tasks --cluster <cluster> --service-name <svc> --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster <cluster> --task $TASK --container vector \
  --interactive --command "sh -c 'wget -qO- localhost:9598 | grep -E \"received_events_total|sent_events_total\"'"
```
Expect: received=100, sent(Splunk)=100 (or ×PASS_RATIO).

## 7. Sweep 2.1 (no buffer)

```bash
aws ecs run-task --cluster <gen-cluster> --launch-type FARGATE \
  --task-definition k6-loadgen --network-configuration "$NETCFG" \
  --overrides '{"containerOverrides":[{"name":"k6","environment":[{"name":"TARGET_URL","value":"https://<nlb-dns>:<otlp-port>"},{"name":"SCENARIO","value":"sweep"},{"name":"RUN_ID","value":"sweep-2.1a"},{"name":"KNEE_EPS","value":"5000"}]}]}'
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
