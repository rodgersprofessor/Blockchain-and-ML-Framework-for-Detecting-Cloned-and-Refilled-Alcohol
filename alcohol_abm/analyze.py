"""Summarise results/ into tables and publication figures (results/figures/)."""
import os
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

R = "results"
F = os.path.join(R, "figures")
os.makedirs(F, exist_ok=True)

ORDER = ["S0_none", "S1_stamps", "S2_blockchain", "S3_blockchain_ml"]
LABEL = {"S0_none": "S0 No system", "S1_stamps": "S1 Excise stamps",
         "S2_blockchain": "S2 Blockchain (rules)", "S3_blockchain_ml": "S3 Blockchain + ML"}
COLOR = {"S0_none": "#8a8984", "S1_stamps": "#eb6834",
         "S2_blockchain": "#2a78d6", "S3_blockchain_ml": "#1baf7a"}
STYLE = {"S0_none": ":", "S1_stamps": "--", "S2_blockchain": "-.", "S3_blockchain_ml": "-"}
INK, MUTED = "#0b0b0b", "#52514e"

plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 10, "axes.edgecolor": MUTED,
    "axes.labelcolor": INK, "xtick.color": MUTED, "ytick.color": MUTED,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": "#e4e3df", "grid.linewidth": 0.6,
    "axes.axisbelow": True, "figure.dpi": 150, "savefig.dpi": 300,
    "savefig.bbox": "tight", "legend.frameon": False,
})


def ci(x):
    x = np.asarray(x, float)
    x = x[~np.isnan(x)]
    m = x.mean()
    h = 1.96 * x.std(ddof=1) / np.sqrt(len(x)) if len(x) > 1 else 0
    return m, m - h, m + h


METRICS = [
    ("penetration_y2", "Counterfeit share of branded sales, year 2 (%)", 100),
    ("cf_bottles_total", "Counterfeit bottles reaching consumers (2 yrs)", 1),
    ("median_weeks_to_removal", "Median weeks to removal (Kaplan-Meier)", 1),
    ("removed_within_12w", "Counterfeit outlets removed within 12 weeks (%)", 100),
    ("hit_rate", "Inspection hit rate (%)", 100),
    ("networks_dismantled", "Networks dismantled", 1),
    ("consumer_cf_warn_rate", "Counterfeit scans that warn the consumer (%)", 100),
    ("consumer_false_warn_per_1000", "False warnings per 1,000 genuine scans", 1),
]

main = pd.read_csv(f"{R}/main_runs.csv")
rows = []
for s in ORDER:
    d = main[main.scenario == s]
    row = {"Scenario": LABEL[s]}
    for k, name, mult in METRICS:
        m, lo, hi = ci(d[k] * mult)
        row[name] = f"{m:,.1f} ({lo:,.1f}–{hi:,.1f})" if mult != 1 or k != "cf_bottles_total" else f"{m:,.0f} ({lo:,.0f}–{hi:,.0f})"
    rows.append(row)
table = pd.DataFrame(rows).set_index("Scenario").T
table.to_csv(f"{R}/table_main_results.csv")

# paired comparisons (common random numbers: same seed = same market)
piv = {k: main.pivot(index="seed", columns="scenario", values=k) for k, _, _ in METRICS}
pairs = [("S1_stamps", "S0_none"), ("S2_blockchain", "S1_stamps"),
         ("S3_blockchain_ml", "S1_stamps"), ("S3_blockchain_ml", "S2_blockchain")]
comp = []
for a, b in pairs:
    for k in ["penetration_y2", "cf_bottles_total", "median_weeks_to_removal", "hit_rate"]:
        rel = 100 * (piv[k][a] - piv[k][b]) / piv[k][b]
        m, lo, hi = ci(rel)
        wins = (piv[k][a] < piv[k][b]).mean() if k != "hit_rate" else (piv[k][a] > piv[k][b]).mean()
        comp.append(dict(comparison=f"{LABEL[a]} vs {LABEL[b]}", metric=k,
                         relative_change_pct=round(m, 1), ci_low=round(lo, 1), ci_high=round(hi, 1),
                         share_of_replications_better=round(wins, 2)))
pd.DataFrame(comp).to_csv(f"{R}/table_paired_comparisons.csv", index=False)

# ---------------------------------------------------------------- Figure 1
wk = pd.read_csv(f"{R}/weekly_penetration.csv")
fig, ax = plt.subplots(figsize=(7.2, 3.8))
for s in ORDER:
    d = wk[wk.scenario == s].groupby("week").penetration
    m = d.mean() * 100
    sm = m.rolling(4, min_periods=1).mean()
    se = (d.std() / np.sqrt(d.count())).rolling(4, min_periods=1).mean() * 100
    ax.fill_between(sm.index, sm - 1.96 * se, sm + 1.96 * se, color=COLOR[s], alpha=0.15, lw=0)
    ax.plot(sm.index, sm, color=COLOR[s], ls=STYLE[s], lw=2, label=LABEL[s])
    ax.annotate(LABEL[s], (sm.index[-1], sm.iloc[-1]), xytext=(6, 0), textcoords="offset points",
                va="center", fontsize=8.5, color=INK)
ax.set_xlabel("Week")
ax.set_ylabel("Counterfeit share of branded sales (%)")
ax.set_xlim(1, 104)
ax.set_ylim(bottom=0)
ax.legend(loc="upper left", fontsize=8.5)
ax.set_title("Counterfeit market penetration over time (mean of 30 runs, 95% CI)", loc="left",
             fontsize=10.5, color=INK)
fig.savefig(f"{F}/fig1_penetration_over_time.png")
plt.close(fig)

# ---------------------------------------------------------------- Figure 2
panels = [("penetration_y2", "Counterfeit share, year 2 (%)", 100),
          ("median_weeks_to_removal", "Median weeks to removal", 1),
          ("removed_within_12w", "Removed within 12 weeks (%)", 100),
          ("hit_rate", "Inspection hit rate (%)", 100)]
fig, axes = plt.subplots(1, 4, figsize=(11, 3.4))
for ax, (k, title, mult) in zip(axes, panels):
    stats = [ci(main[main.scenario == s][k] * mult) for s in ORDER]
    y = np.arange(len(ORDER))[::-1]
    for yi, s, (m, lo, hi) in zip(y, ORDER, stats):
        ax.barh(yi, m, height=0.6, color=COLOR[s])
        ax.errorbar(m, yi, xerr=[[m - lo], [hi - m]], color=INK, lw=1, capsize=3)
        ax.text(hi, yi, f"  {m:.1f}", va="center", fontsize=8.5, color=INK)
    ax.set_yticks(y)
    ax.set_yticklabels([LABEL[s] for s in ORDER] if ax is axes[0] else [])
    ax.set_title(title, fontsize=9.5, loc="left", color=INK)
    ax.grid(axis="y", visible=False)
    ax.set_xlim(0, max(h for _, _, h in stats) * 1.3)
fig.suptitle("Key outcomes by scenario (mean, 95% CI, 30 runs)", x=0.01, ha="left", fontsize=10.5)
fig.tight_layout()
fig.savefig(f"{F}/fig2_key_outcomes.png")
plt.close(fig)

# ---------------------------------------------------------------- Figure 3
if os.path.exists(f"{R}/sensitivity.csv"):
    sens = pd.read_csv(f"{R}/sensitivity.csv")
    names = {"scan_rate": "Mean consumer scan rate", "capacity": "Inspections per week",
             "transfer_mean": "Genuine informal-transfer rate",
             "scan_avoidance": "Counterfeiter avoidance of scanning outlets",
             "tag_reliability": "NFC tamper-tag reliability",
             "clone_local_q": "Share of cloned codes harvested locally",
             "delivery_noise": "Noise in recorded deliveries"}
    rows = []
    fig, axes = plt.subplots(2, 4, figsize=(13.5, 6.2))
    for ax, (par, nm) in zip(axes.flat, names.items()):
        d = sens[sens.parameter == par]
        for s in ["S1_stamps", "S2_blockchain", "S3_blockchain_ml"]:
            g = d[d.scenario == s].groupby("value").penetration_y2
            m = g.mean() * 100
            se = g.std() / np.sqrt(g.count()) * 100
            ax.fill_between(m.index, m - 1.96 * se, m + 1.96 * se, color=COLOR[s], alpha=0.15, lw=0)
            ax.plot(m.index, m, color=COLOR[s], ls=STYLE[s], lw=2, marker="o", ms=4, label=LABEL[s])
            for v, val in m.items():
                rows.append(dict(parameter=par, value=v, scenario=s, penetration_y2_pct=round(val, 2),
                                 removed_within_12w_pct=round(100 * d[(d.scenario == s) & (d.value == v)].removed_within_12w.mean(), 1),
                                 hit_rate_pct=round(100 * d[(d.scenario == s) & (d.value == v)].hit_rate.mean(), 1)))
        if par == "scan_rate":
            ax.set_xscale("log")
        ax.set_title(nm, fontsize=9.5, loc="left", color=INK)
        ax.set_ylim(bottom=0)
        ax.set_ylabel("Counterfeit share, yr 2 (%)" if ax in axes[:, 0] else "")
    h, l = axes.flat[0].get_legend_handles_labels()
    axes.flat[-1].axis("off")
    axes.flat[-1].legend(h, l, loc="center", fontsize=10, title="Scenario", title_fontsize=10)
    fig.suptitle("Sensitivity analysis: one parameter varied at a time (10 runs per point)",
                 x=0.01, ha="left", fontsize=10.5)
    fig.tight_layout()
    fig.savefig(f"{F}/fig3_sensitivity.png")
    plt.close(fig)
    pd.DataFrame(rows).to_csv(f"{R}/table_sensitivity.csv", index=False)

# ---------------------------------------------------------------- ML features
coef_cols = [c for c in main.columns if c.startswith("coef_")]
if coef_cols:
    c = main[main.scenario == "S3_blockchain_ml"][coef_cols]
    feat = pd.DataFrame({"mean_coef": c.mean(), "sd": c.std()}).round(2)
    feat.index = feat.index.str[5:]
    feat = feat.reindex(feat.mean_coef.abs().sort_values(ascending=False).index)
    feat.to_csv(f"{R}/table_ml_feature_weights.csv")
    print(feat.to_string()); print()

# ---------------------------------------------------------------- ablation
if os.path.exists(f"{R}/ablation_runs.csv"):
    ab = pd.read_csv(f"{R}/ablation_runs.csv")
    ref = main[main.scenario.isin(["S1_stamps", "S2_blockchain", "S3_blockchain_ml"])].assign(variant=lambda d: d.scenario)
    allv = pd.concat([ref, ab])
    order = ["S1_stamps", "A_S2_stampTools", "S2_blockchain", "A_S3_stampTools", "A_S3_IFonly", "S3_blockchain_ml"]
    desc = {"S1_stamps": "S1 Excise stamps (reference)",
            "A_S2_stampTools": "S2 targeting, stamp-era inspection tools",
            "S2_blockchain": "S2 full",
            "A_S3_stampTools": "S3 targeting, stamp-era inspection tools",
            "A_S3_IFonly": "S3 anomaly detection only (no learning)",
            "S3_blockchain_ml": "S3 full"}
    rows = []
    for v in order:
        d = allv[allv.variant == v]
        r = {"Variant": desc[v]}
        for k, nm, mult in [("penetration_y2", "Counterfeit share yr 2 (%)", 100),
                            ("median_weeks_to_removal", "Median weeks to removal", 1),
                            ("removed_within_12w", "Removed within 12 wks (%)", 100),
                            ("hit_rate", "Hit rate (%)", 100)]:
            m_, lo, hi = ci(d[k] * mult)
            r[nm] = f"{m_:.1f} ({lo:.1f}–{hi:.1f})"
        rows.append(r)
    abt = pd.DataFrame(rows)
    abt.to_csv(f"{R}/table_ablation.csv", index=False)
    vcol = {"S1_stamps": COLOR["S1_stamps"], "A_S2_stampTools": COLOR["S2_blockchain"],
            "S2_blockchain": COLOR["S2_blockchain"], "A_S3_stampTools": COLOR["S3_blockchain_ml"],
            "A_S3_IFonly": COLOR["S3_blockchain_ml"], "S3_blockchain_ml": COLOR["S3_blockchain_ml"]}
    hatch = {"A_S2_stampTools": "///", "A_S3_stampTools": "///", "A_S3_IFonly": "..."}
    fig, ax = plt.subplots(figsize=(7.5, 3.4))
    y = np.arange(len(order))[::-1]
    for yi, v in zip(y, order):
        m_, lo, hi = ci(allv[allv.variant == v].penetration_y2 * 100)
        ax.barh(yi, m_, height=0.6, color=vcol[v], alpha=0.45 if v in hatch else 1,
                hatch=hatch.get(v), edgecolor=vcol[v], lw=0)
        ax.errorbar(m_, yi, xerr=[[m_ - lo], [hi - m_]], color=INK, lw=1, capsize=3)
        ax.text(hi, yi, f"  {m_:.1f}%", va="center", fontsize=8.5, color=INK)
    ax.set_yticks(y)
    ax.set_yticklabels([desc[v] for v in order], fontsize=8.5)
    ax.grid(axis="y", visible=False)
    ax.set_xlabel("Counterfeit share of branded sales, year 2 (%)")
    ax.set_xlim(0, 8)
    ax.set_title("Ablation: where the gains come from (mean, 95% CI, 30 runs)", loc="left",
                 fontsize=10.5, color=INK)
    fig.savefig(f"{F}/fig4_ablation.png")
    plt.close(fig)
    print(abt.to_string(index=False)); print()

print(table.to_string())
print()
print(pd.DataFrame(comp).to_string(index=False))
