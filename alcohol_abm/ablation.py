"""Ablation experiments: isolate where the S2/S3 gains come from.

A_S2_stampTools  S2 targeting, but inspectors only have stamp-era detection ability
A_S3_stampTools  S3 targeting, but inspectors only have stamp-era detection ability
A_S3_IFonly      S3 with the unsupervised Isolation Forest only (no learning from
                 inspection outcomes)
"""
import os
from dataclasses import replace
from multiprocessing import Pool
import pandas as pd
import model as m

STAMP = (0.95, 0.20, 0.15)


def variants():
    base = m.Params()
    d = dict(base.insp_detect)
    stamp_tools = dict(d, S2_blockchain=STAMP, S3_blockchain_ml=STAMP)
    return {
        "A_S2_stampTools": (replace(base, insp_detect=stamp_tools), "S2_blockchain"),
        "A_S3_stampTools": (replace(base, insp_detect=stamp_tools), "S3_blockchain_ml"),
        "A_S3_IFonly": (replace(base, min_labels=10 ** 9), "S3_blockchain_ml"),
    }


def _job(args):
    name, seed = args
    p, scen = variants()[name]
    r = m.run(p, scen, seed, m.make_env(p, seed))
    r.pop("weekly_penetration")
    r["variant"] = name
    return r


if __name__ == "__main__":
    jobs = [(v, seed) for v in variants() for seed in range(1, 31)]
    with Pool(os.cpu_count()) as pool:
        rows = pool.map(_job, jobs, chunksize=1)
    pd.DataFrame(rows).to_csv("results/ablation_runs.csv", index=False)
    print("ablation done")
