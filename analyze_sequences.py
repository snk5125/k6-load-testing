#!/usr/bin/env python3
"""Sequence gap/duplicate analyzer — Splunk-side correctness check.

Input: JSONL export from Splunk, one object per line, with at minimum:
    splunk_seq   (int)   the dense sequence number k6 assigned
    _time        (float epoch or ISO8601)  Splunk ingest time
    run_id       (str)   optional if you exported a single run

Export from Splunk (adjust index/sourcetype):
    | search index=<idx> run_id="<RUN_ID>"
    | table _time run_id splunk_seq emit_ts
    | outputcsv  (or REST export as JSON)

Usage:
    python3 analyze_sequences.py events.jsonl --expected <splunk_bound_events from k6 summary>
    python3 analyze_sequences.py events.jsonl --expected 1234567 --bucket 60

Outputs: totals, loss %, dup %, and per-time-bucket loss clusters to correlate
with scale-in events from build_timeline.py. Loss clustered at task-stop
timestamps = the shutdown-race / stranded-buffer defect (findings #2/#9).

NOTE on failed requests: k6 requests that fail (non-2xx/timeout) consume seq
numbers that never reach Splunk — those gaps are VISIBLE failures, not silent
loss. k6 logs them as "FAILED_SEQ <start>-<end>" lines; grep the k6 console
output and pass them via --known-failed to exclude them.
"""
import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone


def parse_time(v):
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file", help="JSONL export from Splunk")
    ap.add_argument("--expected", type=int, required=True,
                    help="splunk_bound_events from the k6 run summary")
    ap.add_argument("--bucket", type=int, default=60,
                    help="loss-cluster bucket seconds (default 60)")
    ap.add_argument("--seq-field", default="splunk_seq")
    ap.add_argument("--time-field", default="_time")
    ap.add_argument("--known-failed", default=None,
                    help="file of 'FAILED_SEQ <start>-<end>' lines grepped from "
                         "k6 output; these gaps are counted separately as "
                         "visible failures, not silent loss")
    args = ap.parse_args()

    known_failed = set()
    if args.known_failed:
        with open(args.known_failed) as f:
            for line in f:
                if "FAILED_SEQ" in line:
                    rng = line.split("FAILED_SEQ", 1)[1].split()[0]
                    a, b = rng.split("-")
                    known_failed.update(range(int(a), int(b) + 1))

    seen = Counter()
    seq_time = {}
    bad_lines = 0
    with open(args.file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                seq = int(rec[args.seq_field])
            except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                bad_lines += 1
                continue
            seen[seq] += 1
            t = parse_time(rec.get(args.time_field))
            if t is not None and seq not in seq_time:
                seq_time[seq] = t

    if not seen:
        sys.exit("no parseable events — check field names (--seq-field)")

    total_rows = sum(seen.values())
    unique = len(seen)
    dups = total_rows - unique
    lo, hi = min(seen), max(seen)

    # Expected space: 0 .. expected-1 (k6 numbers densely from 0)
    expected_set_hi = args.expected - 1
    all_missing = [s for s in range(0, args.expected) if s not in seen]
    visible_failed = [s for s in all_missing if s in known_failed]
    missing = [s for s in all_missing if s not in known_failed]
    lost = len(missing)

    print(f"rows in export        : {total_rows:,}  (bad lines skipped: {bad_lines})")
    print(f"unique sequences      : {unique:,}")
    print(f"expected (from k6)    : {args.expected:,}")
    print(f"seq range observed    : {lo:,} .. {hi:,} (expected 0 .. {expected_set_hi:,})")
    print(f"visible failures      : {len(visible_failed):,}  (k6 saw these fail; not silent)")
    print(f"SILENTLY LOST         : {lost:,}  ({100.0 * lost / args.expected:.4f}%)")
    print(f"DUPLICATED            : {dups:,}  ({100.0 * dups / args.expected:.4f}%)")
    if hi > expected_set_hi:
        print(f"WARNING: sequences above expected range ({hi:,} > {expected_set_hi:,}) — "
              f"wrong --expected value or mixed runs in export")

    if missing and seq_time:
        # Cluster losses in time using neighbors' ingest times as proxy
        print(f"\nLoss clusters ({args.bucket}s buckets, neighbor-time proxy):")
        buckets = Counter()
        for s in missing:
            t = seq_time.get(s - 1) or seq_time.get(s + 1)
            if t is not None:
                buckets[int(t // args.bucket) * args.bucket] += 1
        for b in sorted(buckets):
            ts = datetime.fromtimestamp(b, tz=timezone.utc).isoformat()
            print(f"  {ts}  lost={buckets[b]:,}")
        unplaced = lost - sum(buckets.values())
        if unplaced:
            print(f"  (unplaced in time: {unplaced:,} — contiguous loss blocks with no neighbors)")
        print("\nCompare these timestamps against task STOPPED events from "
              "build_timeline.py — clustering there = stranded-buffer defect.")

    if missing:
        blocks = []
        start = prev = missing[0]
        for s in missing[1:]:
            if s == prev + 1:
                prev = s
                continue
            blocks.append((start, prev))
            start = prev = s
        blocks.append((start, prev))
        print(f"\ncontiguous loss blocks: {len(blocks)} "
              f"(largest: {max(b[1] - b[0] + 1 for b in blocks):,} events)")
        print("first 10 blocks:", blocks[:10])


if __name__ == "__main__":
    main()
