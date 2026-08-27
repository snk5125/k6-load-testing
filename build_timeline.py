#!/usr/bin/env python3
"""Assemble the scale-event timeline from AWS APIs (t1..t4 per scale event).

t0 (load crossing threshold) comes from your k6 stage plan; this script gives:
  t1  alarm -> ALARM            (CloudWatch alarm history)
  t2  scaling activity start    (Application Auto Scaling)
  t3  task RUNNING/STOPPED      (ECS task timestamps + service events)
  t4~ task startedAt + health-check window (30s x 3 = 90s unless retuned)

Usage:
  python3 build_timeline.py --cluster <cluster> --service <service> \
      --alarms <scale-out-alarm> <scale-in-alarm> \
      --start 2026-08-21T14:00:00Z --end 2026-08-21T16:00:00Z

Requires: boto3, read perms on cloudwatch/application-autoscaling/ecs.
Output: chronological merged timeline (stdout) + timeline.csv
"""
import argparse
import csv
from datetime import datetime, timezone

import boto3


def ts(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cluster", required=True)
    ap.add_argument("--service", required=True)
    ap.add_argument("--alarms", nargs="+", required=True)
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--hc-window", type=int, default=90,
                    help="health-check seconds before target serves (default 90 = 30s x 3)")
    ap.add_argument("--out", default="timeline.csv")
    args = ap.parse_args()

    start = datetime.fromisoformat(args.start.replace("Z", "+00:00"))
    end = datetime.fromisoformat(args.end.replace("Z", "+00:00"))
    rows = []  # (datetime, source, event)

    cw = boto3.client("cloudwatch")
    for alarm in args.alarms:
        pag = cw.get_paginator("describe_alarm_history")
        for page in pag.paginate(AlarmName=alarm, HistoryItemType="StateUpdate",
                                 StartDate=start, EndDate=end):
            for item in page["AlarmHistoryItems"]:
                rows.append((item["Timestamp"], "alarm",
                             f"{alarm}: {item['HistorySummary']}"))

    aas = boto3.client("application-autoscaling")
    resource_id = f"service/{args.cluster}/{args.service}"
    pag = aas.get_paginator("describe_scaling_activities")
    for page in pag.paginate(ServiceNamespace="ecs", ResourceId=resource_id):
        for act in page["ScalingActivities"]:
            st = act["StartTime"]
            if not (start <= st <= end):
                continue
            rows.append((st, "scaling", f"START: {act['Description']} "
                                        f"[{act['Cause'][:120]}]"))
            if "EndTime" in act:
                rows.append((act["EndTime"], "scaling",
                             f"END ({act['StatusCode']}): {act['Description']}"))

    ecs = boto3.client("ecs")
    svc = ecs.describe_services(cluster=args.cluster, services=[args.service])
    for ev in svc["services"][0].get("events", []):
        if start <= ev["createdAt"] <= end:
            rows.append((ev["createdAt"], "ecs-svc", ev["message"][:160]))

    # Task-level timestamps (running + recently stopped)
    task_arns = []
    for status in ("RUNNING", "STOPPED"):
        pag = ecs.get_paginator("list_tasks")
        for page in pag.paginate(cluster=args.cluster, serviceName=args.service,
                                 desiredStatus=status):
            task_arns.extend(page["taskArns"])
    for i in range(0, len(task_arns), 100):
        resp = ecs.describe_tasks(cluster=args.cluster, tasks=task_arns[i:i + 100])
        for t in resp["tasks"]:
            tid = t["taskArn"].split("/")[-1][:8]
            for field, label in (("createdAt", "task PROVISIONING"),
                                 ("startedAt", "task RUNNING"),
                                 ("stoppingAt", "task STOPPING (SIGTERM soon)"),
                                 ("stoppedAt", "task STOPPED")):
                v = t.get(field)
                if v and start <= v <= end:
                    rows.append((v, "ecs-task", f"{label} {tid}"))
            st = t.get("startedAt")
            if st and start <= st <= end:
                serving = st.timestamp() + args.hc_window
                rows.append((datetime.fromtimestamp(serving, tz=timezone.utc),
                             "derived", f"task {tid} ~serving (started + {args.hc_window}s hc)"))

    rows.sort(key=lambda r: r[0])
    with open(args.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["utc_time", "source", "event"])
        for r in rows:
            w.writerow([ts(r[0]), r[1], r[2]])

    width = max((len(r[1]) for r in rows), default=8)
    for r in rows:
        print(f"{ts(r[0])}  {r[1]:<{width}}  {r[2]}")
    print(f"\n{len(rows)} events -> {args.out}")
    print("Read the deltas per scale-out: alarm ALARM -> scaling START -> task "
          "RUNNING -> ~serving. Sum = your real scale-out latency (t1->t4). "
          "Task STOPPED times feed analyze_sequences.py loss-cluster comparison.")


if __name__ == "__main__":
    main()
