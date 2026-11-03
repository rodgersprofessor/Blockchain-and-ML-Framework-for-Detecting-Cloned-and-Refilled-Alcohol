"""Run the main scenario comparison and one-at-a-time sensitivity analysis.

Usage:  python run_experiments.py [--reps 30] [--sens-reps 10]
Outputs go to results/.
"""
import argparse
import os
from dataclasses import replace
from multiprocessing import Pool

import numpy as np
import pandas as pd

import model as m

SENSITIVITY = {
    "scan_rate":        [0.005, 0.01, 0.03, 0.05, 0.10],
    "capacity":         [10, 25, 50],
    "transfer_mean":    [0.01, 0.03, 0.06, 0.10],
    "scan_avoidance":   [0.0, 1.0, 2.0],
    "tag_reliability":  [0.60, 0.75, 0.90, 0.98],
    "clone_local_q":    [0.0, 0.3, 0.6, 0.9],
    "delivery_noise":   [0.0, 0.25, 0.5, 1.0],
}
SENS_SCENARIOS = ["S1_stamps", "S2_blockchain", "S3_blockchain_ml"]


def _job(args):
    overrides, scenario, seed = args
    p = replace(m.Params(), **overrides)
    env = m.make_env(p, seed)
    r = m.run(p, scenario, seed, env)
    r.update({f"param_{k}": v for k, v in overrides.items()})
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=30)
    ap.add_argument("--sens-reps", type=int, default=10)
    ap.add_argument("--procs", type=int, default=os.cpu_count())
    args = ap.parse_args()
    os.makedirs("results", exist_ok=True)

    with Pool(args.procs) as pool:
        # main experiment ---------------------------------------------------
        jobs = [({}, s, seed) for seed in range(1, args.reps + 1) for s in m.SCENARIOS]
        rows = pool.map(_job, jobs, chunksize=1)
        weekly = pd.DataFrame(
            [dict(scenario=r["scenario"], seed=r["seed"], week=w + 1, penetration=v)
             for r in rows for w, v in enumerate(r.pop("weekly_penetration"))])
        main_df = pd.DataFrame(rows)
        main_df.to_csv("results/main_runs.csv", index=False)
        weekly.to_csv("results/weekly_penetration.csv", index=False)
        print("main experiment done", flush=True)

        # sensitivity -------------------------------------------------------
        jobs = [({k: v}, s, 1000 + seed)
                for k, vals in SENSITIVITY.items() for v in vals
                for s in SENS_SCENARIOS for seed in range(args.sens_reps)]
        rows = pool.map(_job, jobs, chunksize=1)
        for r in rows:
            r.pop("weekly_penetration")
        sens = pd.DataFrame(rows)
        sens["parameter"] = sens.filter(like="param_").notna().idxmax(axis=1).str[6:]
        sens["value"] = sens.filter(like="param_").bfill(axis=1).iloc[:, 0]
        sens = sens.drop(columns=[c for c in sens if c.startswith("param_")])
        sens.to_csv("results/sensitivity.csv", index=False)
        print("sensitivity done", flush=True)


if __name__ == "__main__":
    main()
