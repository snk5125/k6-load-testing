# Generator Deployment — Command Walkthrough

> Numbering follows TASKS.md. Step 1 (ECR image build/push) precedes this
> document; steps 3–5 (Vector-side test config) sit between 2e and 6.


What each step consumes and why. Dependency chain:
**VPC ID → SG (2d)** · **ECR push → image URI (2e)** · **2b + 2c → 2e** · **2a + 2d + 2e + NLB data → run-task**

## 2a. Cluster
```bash
aws ecs create-cluster --cluster-name <gen-cluster> --settings name=containerInsights,value=enabled
```
- Inputs: name + Insights flag. Cluster = logical grouping only (no VPC, no cost).
- Insights → per-task CPU/mem in CloudWatch → enforces the "generator < 80% CPU" run-validity guard.

## 2b. Log group
```bash
aws logs create-log-group --log-group-name /ecs/k6-loadgen
```
- Name must match the task def's log config (2e).
- Pre-created so the awslogs driver never needs `logs:CreateLogGroup`.
- Receives k6 summaries + FAILED_SEQ lines.

## 2c. IAM (no command if reusing Vector's execution role)
- Record the execution role ARN for 2e.
- Role's only job: pull the ECR image, write logs. Verify it isn't resource-scoped to Vector's repo/log groups.
- Do NOT attach Vector's task role — k6 needs zero AWS permissions.

## 2d. Security group
```bash
aws ec2 create-security-group --group-name k6-loadgen-sg \
  --description "k6 generator egress to Vector NLB" --vpc-id <vpc-id>
# note the returned GroupId -> <k6-sg-id>
aws ec2 authorize-security-group-egress --group-id <k6-sg-id> \
  --protocol tcp --port <otlp-port> --cidr <vpc-cidr>
```
- Consumes the VPC ID (only place it's named explicitly — SGs are VPC-scoped).
- Egress-only rule to `<otlp-port>`; no ingress (generator only initiates).
- Output: SG ID → feeds NETCFG; may need matching ingress rule on Vector's SG.

## 2e. Task definition
```bash
aws ecs register-task-definition --cli-input-json file://k6-taskdef.json
```
JSON consumes: image URI (what to run) · cpu/mem 4096/8192 (generator never the bottleneck) · execution role ARN (2c) · log config (2b) · placeholder env vars (real values per-run). Registers a versioned template; nothing runs.

## 6. Launch (per run)
```bash
aws ecs run-task --cluster <gen-cluster> --task-definition k6-loadgen \
  --network-configuration "$NETCFG" --overrides '{...}'
```
Everything converges:
- cluster (2a) — where it's tracked
- task definition (2e) — what to run
- NETCFG = subnets + SG (2d) — **decides VPC placement** and reachability
- overrides — the only part that changes per run: `TARGET_URL` (NLB DNS:port), `SCENARIO` (load shape), `RUN_ID` (unique per run), `KNEE_EPS` (calibration)

## Teardown (ECR repo stays)

Order matters: running tasks → task definition → SG rules → SG → cluster → logs.

```bash
# 1. Stop any running generator tasks
for t in $(aws ecs list-tasks --cluster <gen-cluster> --query 'taskArns[]' --output text); do
  aws ecs stop-task --cluster <gen-cluster> --task "$t" --reason teardown
done

# 2. Deregister task definition revisions (marks INACTIVE; harmless to keep, tidy to remove)
for td in $(aws ecs list-task-definitions --family-prefix k6-loadgen --query 'taskDefinitionArns[]' --output text); do
  aws ecs deregister-task-definition --task-definition "$td"
done

# 3. Remove the ingress rule added to VECTOR's SG (if you added one in 2d)
aws ec2 revoke-security-group-ingress --group-id <vector-sg-id> \
  --protocol tcp --port <otlp-port> --source-group <k6-sg-id>

# 4. Delete the k6 security group (fails while any ENI still references it — wait ~1 min after task stop)
aws ec2 delete-security-group --group-id <k6-sg-id>

# 5. Delete the cluster (must be empty of tasks/services)
aws ecs delete-cluster --cluster <gen-cluster>

# 6. Log group — keep until the report is written (run evidence lives here), then:
aws logs delete-log-group --log-group-name /ecs/k6-loadgen
```

Also restore the Vector service itself (from TASKS.md step 20): prod task-def revision, desired count 2, original scaling suspended-state, and delete the test CPU alarm/policy if not keeping them. ECR repo + image remain for future runs.
