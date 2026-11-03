"""
Agent-based model of counterfeit branded alcohol in a stylised Kenyan
retail network, comparing four anti-counterfeiting regimes:

  S0_none           no verification system; random + tip-off inspections
  S1_stamps         excise-stamp style code verification (validity check only)
  S2_blockchain     permissioned-ledger provenance + tamper-evident NFC closure,
                    rule-based alert triage
  S3_blockchain_ml  as S2, but inspections targeted by a machine-learning risk
                    score (Isolation Forest + logistic regression trained on
                    inspection outcomes)

Time step = 1 week. All parameters are illustrative and documented in
the root README.md; they are meant to be varied in sensitivity analysis, not read as
empirical estimates.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.linear_model import LogisticRegression

SCENARIOS = ["S0_none", "S1_stamps", "S2_blockchain", "S3_blockchain_ml"]
FAKE, CLONE, REFILL = 0, 1, 2
TYPE_NAMES = ["fake", "clone", "refill"]


@dataclass
class Params:
    # horizon and geography
    weeks: int = 104
    n_outlets: int = 1500
    region_km: float = 800.0
    n_clusters: int = 47            # stylised "counties"
    cluster_sd_km: float = 15.0
    bar_share: float = 0.40         # share of outlets that are bars (on-trade)

    # legitimate demand (branded bottles per outlet per week)
    sales_mean: float = 120.0
    sales_sigma: float = 0.6
    demand_noise: float = 0.10
    delivery_noise: float = 0.25    # lumpiness of recorded weekly deliveries (lognormal sd)

    # counterfeit networks
    init_networks: int = 25
    entry_rate: float = 0.35        # new networks per week (Poisson)
    type_mix: tuple = (0.20, 0.35, 0.45)   # fake, clone, refill
    init_outlets_mean: float = 4.0
    expand_prob: float = 0.08       # weekly prob a network recruits one more outlet
    share_min: float = 0.20         # counterfeit share of an infiltrated outlet's sales
    share_max: float = 0.60
    network_radius_km: float = 80.0
    clone_pool_min: int = 20        # distinct genuine codes a clone network copies
    clone_pool_max: int = 100
    clone_local_q: float = 0.30     # share of cloned codes harvested at the same outlet
    refill_foreign_prob: float = 0.70   # refilled empties originate from another outlet
    refill_dist_km: float = 30.0
    reinfiltrate_block: int = 12    # weeks an outlet stays clean after a seizure

    # verification behaviour
    scan_rate: float = 0.03         # mean share of bottles a consumer verifies
    scan_sigma: float = 1.0         # outlet heterogeneity in verification (lognormal)
    scan_avoidance: float = 1.0     # counterfeiters' preference for low-scan outlets
    report_rate: float = 0.20       # S1: consumer reports a failed stamp check
    tip_prob_fake: float = 0.0005   # spontaneous complaint per counterfeit bottle
    tip_prob_other: float = 0.0002
    tag_reliability: float = 0.90   # NFC closure correctly reports prior opening

    # noise produced by genuine trade (S2/S3 ledger)
    transfer_mean: float = 0.03     # genuine stock moved informally between outlets
    transfer_conc: float = 10.0
    transfer_dist_km: float = 10.0
    bar_dup_rate: float = 0.03      # same bottle scanned by several patrons
    shop_dup_rate: float = 0.002
    tag_error_rate: float = 0.003
    read_error_rate: float = 0.001

    # enforcement
    capacity: int = 25              # outlet inspections per week (all scenarios)
    reinspect_gap: int = 4
    p_dismantle: float = 0.10       # network dismantled after a confirmed seizure
    queue_expiry: int = 8
    explore_frac: float = 0.10      # S3: share of capacity used for random exploration
    window: int = 4
    baseline_lo: int = 5
    baseline_hi: int = 16
    retrain_every: int = 4
    min_labels: int = 10
    insp_detect: dict = field(default_factory=lambda: {
        # probability an inspection detects a stream of each type [fake, clone, refill]
        "S0_none":          (0.50, 0.20, 0.15),
        "S1_stamps":        (0.95, 0.20, 0.15),
        "S2_blockchain":    (0.95, 0.85, 0.85),
        "S3_blockchain_ml": (0.95, 0.85, 0.85),
    })


# ----------------------------------------------------------------------------
# Environment: outlets, geography and the counterfeit-network entry schedule.
# Generated from the replication seed only, so all scenarios in a replication
# face the same market and the same counterfeiters (common random numbers).
# ----------------------------------------------------------------------------
def make_env(p: Params, seed: int) -> dict:
    rng = np.random.default_rng([seed, 0])
    n = p.n_outlets
    centers = rng.uniform(0, p.region_km, size=(p.n_clusters, 2))
    w = rng.dirichlet(np.ones(p.n_clusters))
    cl = rng.choice(p.n_clusters, size=n, p=w)
    xy = centers[cl] + rng.normal(0, p.cluster_sd_km, size=(n, 2))
    D = np.sqrt(((xy[:, None, :] - xy[None, :, :]) ** 2).sum(-1)).astype(np.float32)

    is_bar = rng.random(n) < p.bar_share
    mu = np.log(p.sales_mean) - p.sales_sigma ** 2 / 2
    base = rng.lognormal(mu, p.sales_sigma, n)
    a = p.transfer_mean * p.transfer_conc
    b = (1 - p.transfer_mean) * p.transfer_conc
    transfer = rng.beta(a, b, n)
    dup = np.where(is_bar, p.bar_dup_rate, p.shop_dup_rate)
    scan_mult = rng.lognormal(-p.scan_sigma ** 2 / 2, p.scan_sigma, n)
    scan_p = np.clip(p.scan_rate * scan_mult, 0, 1)

    nets = []

    def new_net(t):
        typ = int(rng.choice(3, p=p.type_mix))
        home = int(rng.integers(n))
        near = np.where(D[home] <= p.network_radius_km)[0]
        # weighted sampling without replacement: low-scan outlets preferred
        wt = scan_mult[near] ** (-p.scan_avoidance)
        key = rng.random(near.size) ** (1 / wt)
        near = near[np.argsort(-key)]
        return dict(start=t, type=typ, home=home,
                    k=1 + int(rng.poisson(p.init_outlets_mean - 1)),
                    share=float(rng.uniform(p.share_min, p.share_max)),
                    pool=int(rng.integers(p.clone_pool_min, p.clone_pool_max + 1)),
                    cand=near)

    for _ in range(p.init_networks):
        nets.append(new_net(0))
    for t in range(1, p.weeks):
        for _ in range(rng.poisson(p.entry_rate)):
            nets.append(new_net(t))
    return dict(xy=xy, D=D, is_bar=is_bar, base=base, transfer=transfer,
                dup=dup, scan_p=scan_p, nets=nets)


# ----------------------------------------------------------------------------
# Simulation
# ----------------------------------------------------------------------------
def _pct_rank(x):
    r = np.empty(len(x))
    r[np.argsort(x, kind="stable")] = np.arange(len(x))
    return r / max(len(x) - 1, 1)


def run(p: Params, scenario: str, seed: int, env: dict | None = None) -> dict:
    env = env or make_env(p, seed)
    rng = np.random.default_rng([seed, 1 + SCENARIOS.index(scenario)])
    n, T = p.n_outlets, p.weeks
    D, base = env["D"], env["base"]
    ledger = scenario in ("S2_blockchain", "S3_blockchain_ml")
    detect_p = np.array(p.insp_detect[scenario])

    # --- state -------------------------------------------------------------
    nets = [dict(spec, active=False, outlets=[], ptr=0,
                 pool_counts=np.zeros(spec["pool"], dtype=np.int32),
                 last_clone_scan={}) for spec in env["nets"]]
    streams = []                        # one record per (network, outlet) infiltration
    outlet_stream = -np.ones(n, dtype=int)
    block_until = np.zeros(n, dtype=int)
    last_insp = -np.full(n, 10 ** 6)

    H = {k: np.zeros((T, n), dtype=np.float32)
         for k in ("scans", "inv", "dup", "open", "mm", "mmd", "deliv")}
    tip_q, link_q, report_q = {}, {}, {}   # outlet -> week queued

    # ML state (S3)
    X_lab, y_lab = [], []
    iforest, lr, lr_mu, lr_sd = None, None, None, None

    weekly_total = np.zeros(T)
    weekly_cf = np.zeros(T)
    stats = dict(inspections=0, hits=0, gen_scans=0, gen_warn=0,
                 cf_scans=0, cf_warn=0, dismantled=0)

    def recruit(net, t):
        cand = net["cand"]
        while net["ptr"] < len(cand):
            o = int(cand[net["ptr"]])
            net["ptr"] += 1
            if outlet_stream[o] < 0 and block_until[o] <= t:
                sid = len(streams)
                streams.append(dict(outlet=o, net=net["id"],
                                    type=net["type"], share=net["share"],
                                    start=t, end=None))
                outlet_stream[o] = sid
                net["outlets"].append(o)
                return True
        return False

    for i, net in enumerate(nets):
        net["id"] = i

    def close_stream(sid, t):
        s = streams[sid]
        if s["end"] is None:
            s["end"] = t
            outlet_stream[s["outlet"]] = -1
            block_until[s["outlet"]] = t + p.reinfiltrate_block
            net = nets[s["net"]]
            if s["outlet"] in net["outlets"]:
                net["outlets"].remove(s["outlet"])

    for t in range(T):
        # 1. network entry and expansion ------------------------------------
        for net in nets:
            if net["start"] == t and not net["active"]:
                net["active"] = True
                for _ in range(net["k"]):
                    recruit(net, t)
            elif net["active"] and rng.random() < p.expand_prob:
                recruit(net, t)

        # 2. sales -------------------------------------------------------------
        S = rng.poisson(np.clip(base * (1 + rng.normal(0, p.demand_noise, n)), 1, None))
        C = np.zeros((3, n), dtype=np.int64)
        active_sids = np.where(outlet_stream >= 0)[0]
        for o in active_sids:
            s = streams[outlet_stream[o]]
            C[s["type"], o] = rng.binomial(S[o], s["share"])
        Ctot = C.sum(0)
        G = S - Ctot
        weekly_total[t] = S.sum()
        weekly_cf[t] = Ctot.sum()
        # ledger-recorded genuine deliveries (orders are lumpy, not equal to sales)
        lump = rng.lognormal(-p.delivery_noise ** 2 / 2, p.delivery_noise, n)
        H["deliv"][t] = rng.poisson(G * lump)

        # 3. consumer verification scans --------------------------------------
        if scenario != "S0_none":
            gs = rng.binomial(G, env["scan_p"])
            cs = rng.binomial(C, env["scan_p"])
            g_inv = rng.binomial(gs, p.read_error_rate)
            inv = g_inv + cs[FAKE]
            stats["gen_scans"] += gs.sum()
            stats["cf_scans"] += cs.sum()
            H["scans"][t] = gs + cs.sum(0)
            H["inv"][t] = inv

            if scenario == "S1_stamps":
                # stamp checks validity only: clones and refills pass
                stats["gen_warn"] += g_inv.sum()
                stats["cf_warn"] += cs[FAKE].sum()
                rep = rng.binomial(inv, p.report_rate)
                for o in np.where(rep > 0)[0]:
                    report_q.setdefault(int(o), t)
            else:
                g_dup = rng.binomial(gs, env["dup"])
                g_open = rng.binomial(gs, p.tag_error_rate)
                g_mm = rng.binomial(gs, env["transfer"])
                r_open = rng.binomial(cs[REFILL], p.tag_reliability)
                r_mm = rng.binomial(cs[REFILL], p.refill_foreign_prob)
                c_mm = rng.binomial(cs[CLONE], 1 - p.clone_local_q)
                c_dup = np.zeros(n, dtype=np.int64)
                c_mmd = np.zeros(n)
                for o in np.where(cs[CLONE] > 0)[0]:
                    sid = outlet_stream[o]
                    net = nets[streams[sid]["net"]]
                    k = int(cs[CLONE, o])
                    ids = rng.integers(0, net["pool"], size=k)
                    uniq = np.unique(ids)
                    new_unique = int((net["pool_counts"][uniq] == 0).sum())
                    c_dup[o] = k - new_unique
                    np.add.at(net["pool_counts"], ids, 1)
                    net["last_clone_scan"][int(o)] = t
                    if c_mm[o] > 0:   # cloned codes registered to distant outlets
                        c_mmd[o] = D[o, rng.integers(0, n, size=int(c_mm[o]))].sum()
                mmd = (rng.gamma(np.maximum(g_mm, 1e-9), p.transfer_dist_km) * (g_mm > 0)
                       + rng.gamma(np.maximum(r_mm, 1e-9), p.refill_dist_km) * (r_mm > 0)
                       + c_mmd)
                H["dup"][t] = g_dup + c_dup
                H["open"][t] = g_open + r_open
                H["mm"][t] = g_mm + r_mm + c_mm
                H["mmd"][t] = mmd
                # consumer-facing warnings: invalid, duplicate or previously opened
                stats["gen_warn"] += (g_inv + g_dup + g_open).sum()
                cf_warn = cs[FAKE] + c_dup + r_open
                stats["cf_warn"] += np.minimum(cf_warn, cs.sum(0)).sum()

        # 4. spontaneous tip-offs (all scenarios) ------------------------------
        p_none = (1 - p.tip_prob_fake) ** C[FAKE] * (1 - p.tip_prob_other) ** (C[CLONE] + C[REFILL])
        for o in np.where(rng.random(n) > p_none)[0]:
            tip_q.setdefault(int(o), t)

        # 5. choose outlets to inspect ----------------------------------------
        for q in (tip_q, link_q, report_q):
            for o in [o for o, t0 in q.items() if t - t0 > p.queue_expiry]:
                del q[o]
        eligible = (t - last_insp) >= p.reinspect_gap
        chosen, chosen_set = [], set()

        def take(order, limit=None):
            lim = p.capacity if limit is None else limit
            for o in order:
                if len(chosen) >= lim:
                    break
                o = int(o)
                if eligible[o] and o not in chosen_set:
                    chosen.append(o)
                    chosen_set.add(o)

        def queue_order(q):
            return [o for o, _ in sorted(q.items(), key=lambda kv: kv[1])]

        feats = None
        if ledger:
            w0 = max(0, t - p.window + 1)
            win = {k: H[k][w0:t + 1].sum(0) for k in H}
            take(queue_order(link_q))
            take(queue_order(tip_q))
            if scenario == "S2_blockchain":
                hard = win["inv"] + win["dup"] + win["open"]
                mm_rate = win["mm"] / np.maximum(win["scans"], 1)
                score = hard + win["mm"]
                cand = np.where((hard > 0) | (mm_rate > 0.10))[0]
                take(cand[np.argsort(-score[cand], kind="stable")])
                take(rng.permutation(n))
            else:
                feats = _features(H, win, t, p, env)
                if iforest is None or t % p.retrain_every == 0:
                    iforest = IsolationForest(n_estimators=100, random_state=seed + t).fit(feats)
                    pos = sum(y_lab)
                    if pos >= p.min_labels and len(y_lab) - pos >= p.min_labels:
                        Xl = np.array(X_lab)
                        lr_mu, lr_sd = Xl.mean(0), Xl.std(0) + 1e-9
                        lr = LogisticRegression(class_weight="balanced", max_iter=500, C=1.0)
                        lr.fit((Xl - lr_mu) / lr_sd, np.array(y_lab))
                risk = _pct_rank(-iforest.score_samples(feats))
                if lr is not None:
                    prob = lr.predict_proba((feats - lr_mu) / lr_sd)[:, 1]
                    risk = 0.5 * risk + 0.5 * _pct_rank(prob)
                n_explore = int(round(p.explore_frac * p.capacity))
                take(np.argsort(-risk, kind="stable"), limit=p.capacity - n_explore)
                take(rng.permutation(n))
        else:
            take(queue_order(tip_q))
            if scenario == "S1_stamps":
                take(sorted(report_q, key=lambda o: -H["inv"][max(0, t - 3):t + 1, o].sum()))
            take(rng.permutation(n))

        # 6. inspections -------------------------------------------------------
        for o in chosen:
            last_insp[o] = t
            for q in (tip_q, link_q, report_q):
                q.pop(o, None)
            sid = outlet_stream[o]
            hit = sid >= 0 and rng.random() < detect_p[streams[sid]["type"]]
            stats["inspections"] += 1
            if scenario == "S3_blockchain_ml":
                X_lab.append(feats[o])
                y_lab.append(int(hit))
            if not hit:
                continue
            stats["hits"] += 1
            net = nets[streams[sid]["net"]]
            close_stream(sid, t)
            if ledger and net["type"] == CLONE:
                # shared cloned codes link this outlet to the rest of the network
                for o2, ts in net["last_clone_scan"].items():
                    if t - ts <= 8 and outlet_stream[o2] >= 0 and streams[outlet_stream[o2]]["net"] == net["id"]:
                        link_q.setdefault(o2, t)
            if rng.random() < p.p_dismantle:
                for o2 in list(net["outlets"]):
                    close_stream(outlet_stream[o2], t)
                net["active"] = False
                stats["dismantled"] += 1

    out = _summarise(p, scenario, seed, streams, weekly_total, weekly_cf, stats)
    if lr is not None:
        out.update({f"coef_{k}": float(c) for k, c in zip(FEATURE_NAMES, lr.coef_[0])})
    return out


FEATURE_NAMES = ["mismatch_rate", "invalid_codes", "duplicate_rate", "opened_tag_rate",
                 "mismatch_distance", "mismatch_change", "delivery_ratio", "is_bar"]


def _features(H, win, t, p, env):
    """Outlet-level features computed only from data the ledger would hold."""
    n = H["scans"].shape[1]
    sc = win["scans"]
    a = 20.0

    def smooth(x):
        m0 = x.sum() / max(sc.sum(), 1)
        return (x + a * m0) / (sc + a)

    mm_rate = smooth(win["mm"])
    b0, b1 = max(0, t - p.baseline_hi + 1), max(0, t - p.baseline_lo + 1)
    if b1 > b0:
        bsc = H["scans"][b0:b1].sum(0)
        bmm = H["mm"][b0:b1].sum(0)
        m0 = bmm.sum() / max(bsc.sum(), 1)
        base_mm = (bmm + a * m0) / (bsc + a)
        base_del = H["deliv"][b0:b1].mean(0) * p.window
        deliv_ratio = np.clip(win["deliv"] / np.maximum(base_del, 1), 0, 3)
    else:
        base_mm = mm_rate
        deliv_ratio = np.ones(n)
    mean_dist = np.log1p(win["mmd"] / np.maximum(win["mm"], 1))
    return np.column_stack([
        mm_rate,
        np.log1p(win["inv"]),
        smooth(win["dup"]),
        smooth(win["open"]),
        mean_dist,
        mm_rate - base_mm,
        deliv_ratio,
        env["is_bar"].astype(float),
    ])


def _km(durations, observed):
    """Kaplan-Meier survival of counterfeit streams (event = removal)."""
    durations = np.asarray(durations)
    observed = np.asarray(observed, dtype=bool)
    times = np.unique(durations[observed])
    S, surv = 1.0, {}
    for u in times:
        at_risk = (durations >= u).sum()
        d = ((durations == u) & observed).sum()
        S *= 1 - d / at_risk
        surv[int(u)] = S
    return surv


def _summarise(p, scenario, seed, streams, total, cf, stats):
    T = p.weeks
    dur = [((s["end"] if s["end"] is not None else T) - s["start"] + 1) for s in streams]
    obs = [s["end"] is not None for s in streams]
    surv = _km(dur, obs)

    def S_at(w):
        v = 1.0
        for u, s in surv.items():
            if u <= w:
                v = s
        return v

    median = next((u for u, s in sorted(surv.items()) if s <= 0.5), np.nan)
    half = T // 2
    insp = max(stats["inspections"], 1)
    return dict(
        scenario=scenario, seed=seed,
        penetration_y2=cf[half:].sum() / total[half:].sum(),
        cf_bottles_total=cf.sum(),
        median_weeks_to_removal=median,
        removed_within_12w=1 - S_at(12),
        streams=len(streams),
        removed_share=float(np.mean(obs)) if obs else np.nan,
        inspections=stats["inspections"],
        hit_rate=stats["hits"] / insp,
        wasted_inspection_share=1 - stats["hits"] / insp,
        networks_dismantled=stats["dismantled"],
        consumer_false_warn_per_1000=1000 * stats["gen_warn"] / max(stats["gen_scans"], 1),
        consumer_cf_warn_rate=stats["cf_warn"] / max(stats["cf_scans"], 1),
        weekly_penetration=(cf / total).tolist(),
    )
