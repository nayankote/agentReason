#!/usr/bin/env python3
"""
Stratified sampler for SWE-bench Verified.

Samples N problems proportionally by repo × difficulty, so the sample
mirrors the distribution of the full 500-problem set. This ensures
pass-rate comparisons are representative rather than skewed by easy repos
or easy difficulty tiers.

Usage:
    python sample.py                     # sample 30 problems (default)
    python sample.py --n 50              # sample 50 problems
    python sample.py --n 30 --seed 99    # different random seed
    python sample.py --n 30 --dry-run    # show distribution without saving

Output:
    eval/problems.jsonl   — sampled problems (one JSON object per line)
    eval/sample_stats.txt — distribution report for inspection
"""

import argparse
import json
import random
import sys
from collections import defaultdict
from pathlib import Path


def load_dataset():
    try:
        from datasets import load_dataset as hf_load
    except ImportError:
        print("ERROR: 'datasets' package not installed.")
        print("Run: pip install datasets pandas")
        sys.exit(1)

    print("Loading princeton-nlp/SWE-bench_Verified from HuggingFace...")
    ds = hf_load("princeton-nlp/SWE-bench_Verified")
    # Single 'test' split per dataset card
    split = "test" if "test" in ds else list(ds.keys())[0]
    print(f"  Loaded {len(ds[split])} problems from '{split}' split.")
    return ds[split].to_pandas()


def normalize_difficulty(df):
    """
    Normalize difficulty values. The dataset has a native 'difficulty' field.
    Map whatever values exist to a consistent set of tier labels so
    stratification is stable regardless of exact string values.
    """
    if "difficulty" not in df.columns:
        # Fallback: derive from gold patch length (lines changed)
        print("  No 'difficulty' field found — deriving from patch size.")
        df = df.copy()
        df["patch_lines"] = df["patch"].str.count("\n")
        df["difficulty"] = df["patch_lines"].apply(
            lambda n: "easy" if n < 50 else ("medium" if n < 150 else "hard")
        )
    else:
        # Normalize: lowercase, strip whitespace
        df = df.copy()
        df["difficulty"] = df["difficulty"].str.strip().str.lower()

    return df


def compute_strata(df):
    """Each stratum is a (repo, difficulty) pair."""
    df = df.copy()
    df["stratum"] = df["repo"] + " | " + df["difficulty"]
    return df


def stratified_sample(df, n, seed):
    """
    Proportional stratified sampling.

    Each stratum gets floor(proportion × n) samples. Remaining slots
    are filled by sampling from the strata with the largest remainders
    (largest-remainder method), ensuring total == n.
    """
    random.seed(seed)

    strata_counts = df["stratum"].value_counts()
    total = len(df)

    # Compute exact proportional allocation
    exact_allocs = {s: (count / total) * n for s, count in strata_counts.items()}

    # Floor allocation
    floor_allocs = {s: int(v) for s, v in exact_allocs.items()}
    allocated = sum(floor_allocs.values())
    remainder = n - allocated

    # Fill remainder with largest-remainder method
    remainders = sorted(
        exact_allocs.items(),
        key=lambda x: x[1] - int(x[1]),
        reverse=True
    )
    for stratum, _ in remainders[:remainder]:
        floor_allocs[stratum] += 1

    # Sample from each stratum
    sampled_rows = []
    for stratum, k in floor_allocs.items():
        if k == 0:
            continue
        pool = df[df["stratum"] == stratum]
        k = min(k, len(pool))  # can't sample more than available
        sampled_rows.append(pool.sample(n=k, random_state=seed))

    import pandas as pd
    result = pd.concat(sampled_rows).sample(frac=1, random_state=seed)  # shuffle
    return result.reset_index(drop=True)


def build_stats_report(full_df, sample_df, n):
    lines = []
    lines.append(f"SWE-bench Verified — Stratified Sample Report")
    lines.append(f"{'=' * 60}")
    lines.append(f"Full dataset:  {len(full_df)} problems")
    lines.append(f"Sample size:   {n} problems")
    lines.append(f"")

    # Repo distribution
    lines.append("REPO DISTRIBUTION")
    lines.append(f"{'Repo':<40} {'Full':>6} {'Sample':>8} {'Full%':>7} {'Sample%':>9}")
    lines.append("-" * 74)
    for repo in sorted(full_df["repo"].unique()):
        full_count = len(full_df[full_df["repo"] == repo])
        sample_count = len(sample_df[sample_df["repo"] == repo])
        full_pct = 100 * full_count / len(full_df)
        sample_pct = 100 * sample_count / len(sample_df)
        lines.append(
            f"{repo:<40} {full_count:>6} {sample_count:>8} {full_pct:>6.1f}% {sample_pct:>8.1f}%"
        )
    lines.append("")

    # Difficulty distribution
    lines.append("DIFFICULTY DISTRIBUTION")
    lines.append(f"{'Difficulty':<20} {'Full':>6} {'Sample':>8} {'Full%':>7} {'Sample%':>9}")
    lines.append("-" * 54)
    for diff in sorted(full_df["difficulty"].unique()):
        full_count = len(full_df[full_df["difficulty"] == diff])
        sample_count = len(sample_df[sample_df["difficulty"] == diff])
        full_pct = 100 * full_count / len(full_df)
        sample_pct = 100 * sample_count / len(sample_df) if len(sample_df) > 0 else 0
        lines.append(
            f"{diff:<20} {full_count:>6} {sample_count:>8} {full_pct:>6.1f}% {sample_pct:>8.1f}%"
        )
    lines.append("")

    # Stratum coverage
    covered = len(sample_df["stratum"].unique())
    total_strata = len(full_df["stratum"].unique())
    lines.append(f"Strata covered: {covered}/{total_strata}")
    lines.append("")

    # Problem list
    lines.append("SAMPLED PROBLEMS")
    lines.append(f"{'#':<4} {'instance_id':<45} {'difficulty':<12} {'repo'}")
    lines.append("-" * 90)
    for i, row in sample_df.iterrows():
        lines.append(
            f"{i+1:<4} {row['instance_id']:<45} {row['difficulty']:<12} {row['repo']}"
        )

    return "\n".join(lines)


FIELDS_TO_KEEP = [
    "instance_id",
    "repo",
    "base_commit",
    "problem_statement",
    "patch",           # gold patch (for reference, not fed to agent)
    "test_patch",
    "FAIL_TO_PASS",
    "PASS_TO_PASS",
    "hints_text",
    "difficulty",
    "environment_setup_commit",
    "version",
    "created_at",
]


def main():
    parser = argparse.ArgumentParser(description="Stratified sampler for SWE-bench Verified")
    parser.add_argument("--n", type=int, default=30, help="Number of problems to sample (default: 30)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for reproducibility (default: 42)")
    parser.add_argument("--out", type=str, default="problems.jsonl", help="Output JSONL filename (default: problems.jsonl)")
    parser.add_argument("--dry-run", action="store_true", help="Print distribution report without saving")
    args = parser.parse_args()

    out_dir = Path(__file__).parent
    out_path = out_dir / args.out
    stats_path = out_dir / "sample_stats.txt"

    # Load
    df = load_dataset()

    # Normalize + stratify
    df = normalize_difficulty(df)
    df = compute_strata(df)

    # Sample
    print(f"Sampling {args.n} problems with seed={args.seed}...")
    sample = stratified_sample(df, args.n, args.seed)

    # Build report
    report = build_stats_report(df, sample, args.n)
    print("\n" + report)

    if args.dry_run:
        print("\n[dry-run] Not saving files.")
        return

    # Write problems.jsonl — only keep fields the agent harness needs
    keep = [f for f in FIELDS_TO_KEEP if f in sample.columns]
    with open(out_path, "w") as f:
        for _, row in sample.iterrows():
            record = {col: row[col] for col in keep}
            f.write(json.dumps(record) + "\n")

    # Write stats report
    with open(stats_path, "w") as f:
        f.write(report)

    print(f"\nSaved {args.n} problems → {out_path}")
    print(f"Saved distribution report → {stats_path}")
    print(f"\nNext step: python agent.py --problems {out_path}")


if __name__ == "__main__":
    main()
