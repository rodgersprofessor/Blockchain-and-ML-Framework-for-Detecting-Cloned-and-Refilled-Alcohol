# Securing Records, Not Products: Code and Demo

Code accompanying the paper *Securing Records, Not Products: A Permissioned Blockchain and Machine-Learning Framework for Detecting Cloned and Refilled Alcohol in Low-Enforcement-Capacity Markets*.

The framework has four layers: tamper-evident NFC closures bound to existing excise stamps, a permissioned ledger signed by several agencies, four **VerifyScan** checks on every consumer scan, and weekly risk-ranked inspections that feed their outcomes back as training labels.

This repository contains two independent parts:

| Part | Folder | What it is | Language |
|---|---|---|---|
| **1. Agent-based simulation** | [`alcohol_abm/`](alcohol_abm/) | The 1,500-outlet, 104-week model whose results are reported in the paper (S0–S3 comparison, sensitivity, ablation) | Python |
| **2. Interactive demo and test suite** | [`bottle-ledger-demo/`](bottle-ledger-demo/) | A browser demo and automated tests showing the ledger, VerifyScan checks, bottle trail and risk targeting working | JavaScript |

> **Which one produces the paper's numbers?** Only Part 1. Part 2 is a smaller illustrative model for seeing and checking the mechanisms; do not quote its effect sizes. See [What the demo does and does not show](#what-the-demo-does-and-does-not-show).

## Contents

- [Repository layout](#repository-layout)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Part 1: Agent-based simulation](#part-1-agent-based-simulation-alcohol_abm)
- [Part 2: Interactive demo and test suite](#part-2-interactive-demo-and-test-suite-bottle-ledger-demo)
- [Licence and citation](#licence-and-citation)

## Repository layout

```
README.md                 this file (documents both parts)
requirements.txt          Python packages for the simulation
package.json              Node scripts for the demo (no npm dependencies)
LICENSE                   MIT licence, covers the whole repository
.github/workflows/        CI: demo tests on Node 18/20/22, simulation import check

alcohol_abm/              PART 1: agent-based simulation
  model.py                  the model (parameters, environment, simulation, metrics)
  run_experiments.py        main 4-scenario comparison and sensitivity analysis
  ablation.py               ablation runs that isolate the source of the gains
  analyze.py                builds all tables and figures in results/
  results/                  outputs used in the paper (CSV tables, figures/)

bottle-ledger-demo/       PART 2: interactive demo
  index.html                the built demo (open this)
  src/engine.js             ledger, VerifyScan, bottle trail, risk model, simulation (no DOM, runs in Node)
  src/template.html         page markup, styles and UI code
  scripts/build.js          inlines the engine into the template -> index.html
  scripts/compare.js        command-line regime comparison
  scripts/serve.js          optional static server
  test/engine.test.js       automated checks
```

## Requirements

| Part | Needs |
|---|---|
| Simulation | Python 3.10 or newer, and the packages in `requirements.txt` (numpy, pandas, scikit-learn, matplotlib) |
| Demo, viewing only | Any current browser. Nothing to install |
| Demo, tests and comparison | [Node.js](https://nodejs.org) 18 or newer. No npm packages to install |

```bash
pip install -r requirements.txt
```

## Quick start

All commands are run from the repository root unless stated.

```bash
# Part 1: simulation (scripts must be run from inside alcohol_abm/)
pip install -r requirements.txt
cd alcohol_abm
python run_experiments.py --reps 30 --sens-reps 10   # ~35 min on 2 cores
python ablation.py                                    # ~6 min
python analyze.py                                     # tables + figures
cd ..

# Part 2: demo
#   open bottle-ledger-demo/index.html in a browser, or:
npm start              # serves the demo at http://localhost:8080
npm test               # 9 automated checks, about 10 seconds
npm run compare        # S1 / S2 / S3 comparison on the command line
```

---

## Part 1: Agent-based simulation (`alcohol_abm/`)

The model compares four anti-counterfeiting regimes in a stylised Kenyan retail
market for branded alcohol and reports how quickly counterfeit supply is found
and removed. It is documented below following the ODD protocol (Overview,
Design concepts, Details; Grimm et al., 2020), which most simulation reviewers
expect.

> **Status of the numbers.** All parameters are illustrative assumptions chosen
> to be plausible, not estimates calibrated to Kenyan data. The results show
> *relative* performance under stated assumptions and how sensitive that is to
> each one. Report them that way in the paper, and replace parameters with
> ACA/KRA/KEBS data where it becomes available.

### How to run

Install the requirements from the repository root, then run the scripts from
inside `alcohol_abm/` (they read and write the relative folder `results/`):

```bash
pip install -r requirements.txt
cd alcohol_abm
python run_experiments.py --reps 30 --sens-reps 10   # ~35 min on 2 cores
python ablation.py                                    # ~6 min
python analyze.py                                     # tables + figures
```

| File | Contents |
|---|---|
| `model.py` | The model (parameters, environment, simulation, metrics) |
| `run_experiments.py` | Main 4-scenario comparison and one-at-a-time sensitivity analysis |
| `ablation.py` | Ablation runs that isolate the source of the gains |
| `analyze.py` | Builds all tables and figures in `results/` |
| `results/table_main_results.csv` | Mean (95% CI) of every outcome, by scenario |
| `results/table_paired_comparisons.csv` | Paired relative changes between scenarios |
| `results/table_sensitivity.csv` | Sensitivity results |
| `results/table_ablation.csv` | Ablation results |
| `results/table_ml_feature_weights.csv` | Learned feature weights of the S3 risk model |
| `results/figures/` | Fig 1 (penetration over time), Fig 2 (key outcomes), Fig 3 (sensitivity), Fig 4 (ablation) |

Runs are fully reproducible: every replication is seeded, and all four
scenarios in a replication share the same market and the same counterfeiters
(common random numbers), so differences come from the regime, not luck.

### 1. Purpose and patterns

**Purpose.** To test whether combining permissioned-blockchain provenance with
machine-learning risk targeting detects counterfeit branded alcohol (fakes, cloned
codes and refilled genuine bottles) faster than an excise-stamp regime that only
checks code validity, given the same enforcement capacity.

**Patterns the model reproduces.**

- Counterfeit supply grows when detection is weak.
- Stamp-validity checks catch crude fakes but not cloned codes or refills.
- Genuine trade produces noise (informal stock transfers, repeat scans in bars)
  that any alerting system must cope with.

### 2. Entities, state variables and scales

| Entity | Key state variables |
|---|---|
| **Outlet** (1,500) | Location; type (bar 40% / shop); baseline weekly branded sales (lognormal, mean 120 bottles); consumer scan propensity; informal-transfer rate; last inspection week |
| **Counterfeit network** | Fraud type (fake 20% / clone 35% / refill 45%); home location; infiltrated outlets; counterfeit share at each outlet (20–60% of sales); cloned-code pool (20–100 codes) |
| **Counterfeit stream** | One network infiltrating one outlet: start week, removal week |
| **Regulator** | Inspection capacity (25 outlet visits/week); alert and tip-off queues; for S3, the risk model |

**Scales.** The time step is one week and the horizon is 104 weeks. Space is an
800 × 800 km region with 47 outlet clusters, standing in for counties.

### 3. Process overview and scheduling

Each week, in this order:

1. **Network entry and expansion.** New networks enter (Poisson, 0.35 per
   week, plus 25 at the start). Active networks recruit an extra outlet with
   probability 0.08.
2. **Sales.** Each outlet sells its weekly demand. Infiltrated outlets sell a
   share of counterfeits, and genuine deliveries recorded on the ledger fall
   accordingly, with ordering noise.
3. **Consumer verification.** Consumers scan a share of bottles. What each scan
   reveals depends on the scenario (see §6).
4. **Tip-offs.** Each counterfeit bottle carries a small chance of triggering a
   consumer complaint.
5. **Targeting.** The regulator chooses up to 25 outlets to inspect (see §6).
6. **Inspection.** Detection probability depends on the fraud type and the
   inspectors' tools. A detected stream is removed, and the outlet cannot be
   re-infiltrated for 12 weeks. With probability 0.10 the whole network is
   dismantled. Under S2 and S3, outlets that shared a cloned-code pool with the
   detected outlet are queued for inspection.

### 4. Design concepts

- **Emergence.** Market penetration and time-to-removal emerge from the
  interaction of counterfeit entry, consumer scanning and the targeting of
  inspections.
- **Adaptation.** Counterfeiters prefer outlets where consumers rarely verify
  (scan avoidance).
- **Sensing.** The regulator sees only what each regime records: complaints,
  stamp-failure reports, or ledger events. It never observes the true state.
- **Learning.** In S3, a logistic-regression model is retrained every 4 weeks
  on past inspection outcomes. Because inspections can miss, these labels
  include false negatives, as in practice.
- **Stochasticity.** All flows are binomial or Poisson draws.
- **Observation.** Each run records weekly penetration, Kaplan–Meier removal
  times of counterfeit streams, inspection outcomes and consumer warnings.

### 5. Initialization and input

The market is generated synthetically from the replication seed. No empirical
input data are used (see the status note above).

### 6. Submodels: the four regimes

| | S0 No system | S1 Excise stamps | S2 Blockchain (rules) | S3 Blockchain + ML |
|---|---|---|---|---|
| **What a consumer scan reveals** | No scanning | Code validity only: fakes fail; clones and refills pass | Invalid code, duplicate scan, previously opened tag (NFC), and custody mismatch (code registered to another outlet) | Same as S2 |
| **What triggers an inspection** | Tip-offs, then random | Tip-offs and consumer reports of failed stamps (20% of failures reported), then random | Linked outlets, tip-offs, then outlets ranked by alert count, then random | Linked outlets, tip-offs, then ML risk ranking (90% of capacity) plus random exploration (10%) |
| **Inspection detection: fake / clone / refill** | 0.50 / 0.20 / 0.15 | 0.95 / 0.20 / 0.15 | 0.95 / 0.85 / 0.85 | 0.95 / 0.85 / 0.85 |

**Ledger signals (S2/S3).** Each signal comes from either counterfeit or genuine activity:

| Signal | From counterfeits | From genuine trade (noise) |
|---|---|---|
| **Custody mismatch** | Clones, when the code was harvested elsewhere (70% of codes); refills, when the empties came from other outlets (70%) | Informal transfers between nearby outlets (mean 3%, about 10 km) |
| **Duplicate** | A cloned code scanned more than once | Repeat scans of the same bottle (3% in bars, 0.2% in shops) |
| **Opened tag** | Refills, when the tamper-evident closure reports a prior opening (reliability 0.90) | Tag errors (0.3%) |

**S3 risk model.** It uses eight outlet-level features computed over a 4-week
window, all from ledger data only:

- custody-mismatch rate (smoothed)
- invalid codes
- duplicate rate
- opened-tag rate
- mean distance to where mismatched codes were registered
- change in mismatch rate against the outlet's own 12-week baseline
- recorded deliveries against baseline
- outlet type (bar or shop)

Two scores are combined:

- **Isolation Forest.** An unsupervised anomaly score, available from week 1.
- **Logistic regression.** Trained on past inspection outcomes once at least
  10 positive and 10 negative labels exist.

The final risk is the average of their percentile ranks.

**Metrics.**

| Metric | Definition |
|---|---|
| Penetration | Counterfeit bottles ÷ all branded bottles sold, in year 2 |
| Median weeks to removal | Kaplan–Meier estimate over counterfeit streams, censored at week 104 |
| Removed within 12 weeks | Share of streams removed within 12 weeks |
| Hit rate | Share of inspections that find counterfeits |
| Consumer protection | Share of counterfeit scans that show the consumer a warning |
| Consumer false alarms | Warnings per 1,000 genuine scans |

### 7. Results

All figures are means over 30 replications with 95% confidence intervals.
Relative changes are paired by replication.

#### 7.1 Main comparison (`table_main_results.csv`, Fig 1, Fig 2)

| Outcome | S0 No system | S1 Excise stamps | S2 Blockchain (rules) | S3 Blockchain + ML |
|---|---|---|---|---|
| Counterfeit share of branded sales, year 2 | 7.2% | 6.5% | 1.0% | 0.4% |
| Counterfeit bottles reaching consumers (2 yrs) | 1.05 M | 0.94 M | 0.20 M | 0.09 M |
| Median weeks to removal | 79.8* | 71.4* | 7.2 | 3.3 |
| Counterfeit outlets removed within 12 weeks | 10.9% | 19.4% | 66.3% | 87.4% |
| Inspection hit rate | 5.1% | 5.9% | 12.3% | 13.2% |
| Counterfeit scans that warn the consumer | — | 2.3% | 70.9% | 66.1% |
| False warnings per 1,000 genuine scans | — | 1.0 | 17.1 | 17.2 |

\* Lower bound. In 2 S0 runs and 4 S1 runs, fewer than half of counterfeit
streams were removed within 104 weeks. Those runs have no defined median and
are excluded, so the true S0/S1 medians are longer than shown.

**Paired relative changes** (`table_paired_comparisons.csv`):

| Comparison | Penetration, year 2 | Counterfeit bottles reaching consumers |
|---|---|---|
| S2 vs S1 | −83.7% (95% CI −85.1 to −82.4) | −77.9% |
| S3 vs S1 | −94.0% (−94.3 to −93.6) | −90.1% |
| S3 vs S2 | −61.9% (−64.4 to −59.4) | −54.2% |

S3 also halved the median time to removal relative to S2 (−53.2%). Every
replication favoured S3 over S2 on penetration.

S1 performs little better than having no system (−9.9% penetration): checking
code validity only catches crude fakes, while clones and refills pass.

#### 7.2 Ablation: where the gains come from (`table_ablation.csv`, Fig 4)

| Variant | Counterfeit share, year 2 | Median weeks to removal |
|---|---|---|
| S1 Excise stamps (reference) | 6.5% | 71.4* |
| S2 targeting, stamp-era inspection tools | 3.7% | 29.7 |
| S2 full | 1.0% | 7.2 |
| S3 targeting, stamp-era inspection tools | 2.2% | 15.2 |
| S3 anomaly detection only (no learning) | 0.5% | 4.0 |
| S3 full | 0.4% | 3.3 |

**Ledger intelligence alone matters.** Even when inspectors keep stamp-era
detection ability, targeting from ledger data cuts penetration by 43% (S2) to
66% (S3) relative to stamps. The rest of the gain comes from inspectors being
able to verify clones and refills on site against the ledger.

**Most of the ML gain comes from multi-signal anomaly scoring.** The
unsupervised Isolation Forest alone reaches 0.5%. Learning from inspection
outcomes adds a smaller further improvement, to 0.4%.

#### 7.3 Learned risk-model weights (`table_ml_feature_weights.csv`)

Standardised logistic-regression coefficients, averaged over runs:

| Feature | Weight |
|---|---|
| Opened-tag rate | +1.15 |
| Distance to where mismatched codes were registered | +1.03 |
| Invalid codes | +0.92 |
| Recorded deliveries against baseline | −0.61 (falling genuine orders signal substitution) |
| Change in mismatch rate | +0.27 |
| Raw mismatch rate | −0.26 |

Raw mismatch rate gets a small negative weight once distance is known. That
means local informal transfers are correctly treated as benign, which is
exactly the noise that misleads the S2 rules.

#### 7.4 Sensitivity (`table_sensitivity.csv`, Fig 3)

- **Consumer scan rate** matters most for S3. Penetration falls from about 0.85%
  when 0.5–1% of bottles are scanned to 0.23% at 10%. S3 beats S2 at every scan
  rate, including very low verification uptake.
- **Genuine informal transfers** are the key weakness of rule-based alerting.
  S2 penetration nearly doubles as transfer noise rises from 1% to 10%
  (0.82% → 2.12%), while S3 stays flat (0.43% → 0.44%).
- **Inspection capacity.** S2 depends heavily on capacity (2.16% at 10
  inspections/week against 0.66% at 50). S3 is nearly flat (0.54% → 0.39%),
  because it spends scarce inspections better.
- **Scan avoidance by counterfeiters** degrades both ledger regimes.
  S3 rises from 0.29% to 0.48%, and S2 from 0.62% to 1.48%.
- **Tamper-tag reliability, local harvesting of cloned codes and delivery
  noise** have little effect, because the other signals cover for each.
  This redundancy is a design argument for combining several signals.

#### 7.5 Design implications

- **Consumer-facing false alarms.** About 17 per 1,000 genuine scans come mainly
  from several bar patrons scanning the same bottle. The consumer app should
  not show a duplicate warning for a bottle scanned at the outlet it was
  delivered to. The back end should still record these scans as weak signals
  for the risk model.
- **Linking outlets through cloned codes.** Detecting one outlet that sells
  cloned codes reveals the others using the same code pool. This turns single
  seizures into network take-downs: S2 and S3 dismantled 31–35 networks,
  against 13–15 under S0/S1.

### 8. Limitations to state in the paper

1. **No calibration.** Parameters are assumptions, and the sensitivity analysis
   bounds how much each one matters. Priority data to obtain:
   - consumer verification rates (EGMS app and SMS checks)
   - the counterfeit type mix
   - inspection capacity and inspection detection rates
2. **Static counterfeiters.** Beyond preferring low-scan outlets, counterfeiters
   do not adapt to the ledger, for example by moving into unbranded illicit brew,
   attacking NFC tags, or corrupting insiders at the point of tagging.
3. **Unbranded illicit brew is out of scope.** Chang'aa and second-generation
   brews never enter a formal supply chain, so neither stamps nor a ledger can
   address them.
4. **The S2 rule set is deliberately simple.** It ranks outlets by alert volume.
   A carefully tuned rule engine would close part of the gap to S3, and the
   ablation shows how much of S3's gain comes from learning.

---

## Part 2: Interactive demo and test suite (`bottle-ledger-demo/`)

An interactive demo and test suite for the layered framework. It lets readers
see each mechanism of the paper working: the quorum-signed ledger, the four
VerifyScan checks, a bottle's trail read back from the chain, and risk-ranked
inspections.

> **Scope.** This is an illustrative model on synthetic data. It is **not** the
> 1,500-outlet agent-based model in Part 1, and it does not run a consensus
> protocol. Use it to see and check the mechanisms, not to quote effect sizes.
> See [What the demo does and does not show](#what-the-demo-does-and-does-not-show).

### Run it

The demo is one self-contained file. No install, no server, no build step.

1. Download or clone this repository.
2. Open `bottle-ledger-demo/index.html` in a current browser (Chrome, Firefox, Safari, Edge).

It works offline. The only external request is the IBM Plex font from Google
Fonts; without it the page falls back to system fonts.

To serve it instead: run `npm start` from the repository root and open <http://localhost:8080>.

### Verify it

You need [Node.js](https://nodejs.org) 18 or newer. There are no dependencies
to install. Run from the repository root:

```bash
npm test               # 9 automated checks, about 10 seconds
npm run compare        # reproduces the S1 / S2 / S3 comparison on the command line
```

#### What `npm test` checks

| Test | What it establishes |
| --- | --- |
| Ledger verifies; a changed transaction is caught | Hash chaining and the signed transaction root work. |
| Re-hash and re-sign with one peer key is rejected | An attacker holding one peer's key cannot rewrite history: each block needs valid signatures from 3 of 5 peers. |
| VerifyScan verdict per scenario | Fake code, clone, refill, repeat scan, custody mismatch and signed-tag clone each give the expected verdict. |
| Repeat-scan suppression | The grading in Section 7.6 of the paper changes whether the consumer is warned. |
| Determinism | The same seed gives identical results, so runs are reproducible. |
| Ledger regimes beat stamps | Averaged over seeds, S2 and S3 each cut counterfeit share by more than half compared with stamps alone. |
| Simulated run writes a valid ledger | Thousands of simulated transactions end up in a chain that verifies. |
| Bottle trail | One bottle's history is read back from the chain in order: registration, delivery, then scans. |
| `index.html` is up to date | The shipped page matches `src/`. |

The same checks run on Node 18, 20 and 22 in GitHub Actions (`.github/workflows/test.yml`).

#### What `npm run compare` prints

```
npm run compare -- 10 40 300 6 300      # replications, weeks, outlets, inspections per week, first seed
```

Expected output on Node 22 (V8):

```
10 replications, 40 weeks, 300 outlets, 6 inspections/week, seeds 300..309

Outcome                                           S1 stamps only   S2 ledger + rules      S3 ledger + ML
Counterfeit share of sales, last 13 weeks                  7.23%               0.93%               0.86%
Counterfeit bottles sold                                  16,119               3,230               3,162
Inspection hit rate                                           6%                 23%                 27%
Counterfeit scans that warn the consumer                      4%                 56%                 60%
False warnings per 1,000 genuine scans                       3.1                 3.5                 3.5

S3 had a lower counterfeit share than S2 in 5 of 10 replications.
```

The last line matters: at this scale ML targeting is about level with a simple
rule-based alert, not clearly better. That is consistent with the paper's
limitation that a tuned rule engine closes part of the gap (see also Part 1,
§8 item 4), and is reported as found. Small differences in the last digit on
other JavaScript engines are possible because the simulation uses
floating-point maths.

### Verify by hand in the browser

**Ledger tab**
1. Press **Verify chain**: it reports every block checked.
2. Press **Alter a recorded transfer**: verification fails at that block, because the transactions no longer match the signed root.
3. Press **Rewrite it and re-sign with one peer key**: the hashes now match, but verification still fails because only 1 of the required 3 peers signed.
4. Press **Restore**.

**Tap lab**: choose a scenario and press **Tap the bottle**. The page shows what the consumer sees, which checks passed or failed, and the block the scan was written to. Cases worth trying:

| Scenario | What to look for |
| --- | --- |
| Clone of an unscanned bottle | Passes with static codes. Tick *Signed rolling-counter tags* and tap again: it now fails authentication. |
| Clone first, honest buyer second | The honest buyer gets the warning, not the person who bought the copy. |
| Refilled bottle at its own outlet | Not warned: it looks like a repeat scan. |
| Genuine bottle lent to a neighbour | Only a weak signal is logged; the consumer sees no warning. |

**Follow a bottle tab**: type a code such as `K1-1788` (case `C1-149` covers `K1-1788` to `K1-1799`) or use the quick picks. You get the bottle's trail read from the chain: the batch that registered it, the case transfer that moved it, and each scan with the verdict it produced at the time and a link to the block that holds it. "Follow this bottle" in the Tap lab opens the same view for the bottle you just tapped. In code, this is `trail(chain, code, dist)` in `bottle-ledger-demo/src/engine.js`.

**Regulator simulation tab**: **Compare S1, S2, S3** runs the three regimes on the same markets and draws the weekly counterfeit share. **Run live** writes a full run to the ledger, shows the inspection queue and map, and, for S3, the weights the logistic regression learned.

### How the demo maps to the paper

| Paper | Where in the code (`bottle-ledger-demo/src/engine.js`) |
| --- | --- |
| Layer 2 ledger, 5 peers, 3-of-5 signatures | `Chain`, `PEERS`, `QUORUM`, `REQUIRED` |
| Smart contracts MintBatch, TransferCustody, VerifyScan, Decommission, FlagOutlet | transaction types applied in `World.apply` |
| Table 4, the four VerifyScan checks and signal grading | `verifyScan` |
| Bottle lifecycle (Figure 2) read back per bottle | `trail` |
| Table 5, eight outlet features over a rolling four-week window | `Sim.featureVector`, `FEATURES` |
| Isolation Forest plus logistic regression, retrained every 4 weeks once 10 positive and 10 negative labels exist | `isolationScores`, `trainLR`, `Sim.chooseTargets` |
| Priority order: linked outlets, tip-offs, risk rank, with 8% random exploration | `Sim.chooseTargets` |
| Scenarios S1, S2, S3 and inspector detection probabilities | `Sim.inspect`, `DEFAULTS` |

### Differences from the paper and from a real deployment

- **Smaller market.** 100 to 600 outlets over 400 km by 400 km, against 1,500 outlets and 30 replications in the paper (Part 1). Cases are 12 bottles and custody is tracked per case.
- **No consensus.** Blocks are signed by a quorum of peers but not ordered by Raft or PBFT, and all peers run in one process. HMAC stands in for the X.509/ECDSA identities a Hyperledger Fabric network uses.
- **Simplified models.** Isolation Forest and logistic regression are small JavaScript versions, not scikit-learn. Parameters are assumptions, not Kenyan estimates.
- **Check 2 follows Section 7.6 of the paper, not Table 4 as written.** An opened bottle scanned again at its own outlet is a weak signal with no consumer warning (toggle *Suppress repeat-scan warnings*). Read literally, Table 4 would warn on it.
- **Extension not in the paper.** *Signed rolling-counter tags* adds a check 0 that rejects a copied tag. It is off by default.
- **Counterfeiters barely adapt**, as in the paper (see Part 1, §8 item 2).

### What the demo does and does not show

It shows that the four checks, the grading and the quorum-signed ledger behave as the framework describes, that tampering is detected, and that targeting inspections from ledger data cuts counterfeit share sharply compared with stamps alone. It also surfaces edge cases (the three tap-lab rows above) that the paper's text does not yet address.

It does not validate the paper's quantitative results (those come from Part 1), benchmark Hyperledger Fabric, model costs or consumer behaviour, or show that the model is calibrated to Kenyan data.

### Editing the demo

After editing anything in `bottle-ledger-demo/src/`, run `npm run build` from the repository root. The test suite fails if `index.html` is stale.

---

## Licence and citation

Both parts are released under the MIT License (see [`LICENSE`](LICENSE)).

If you use this code, please cite the paper:

> *Securing Records, Not Products: A Permissioned Blockchain and Machine-Learning Framework for Detecting Cloned and Refilled Alcohol in Low-Enforcement-Capacity Markets.*
