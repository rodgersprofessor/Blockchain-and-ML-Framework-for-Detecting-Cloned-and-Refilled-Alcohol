/* ===== Engine: ledger, VerifyScan, risk model, weekly simulation =====
   Pure JS, no DOM. Works in browsers (Web Crypto) and Node 18+. */
const Engine = (() => {
'use strict';

/* ---------- utilities ---------- */
const enc = new TextEncoder();
const subtle = (globalThis.crypto && globalThis.crypto.subtle) || (typeof require !== 'undefined' ? require('node:crypto').webcrypto.subtle : undefined);
const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256(str) { return hex(await subtle.digest('SHA-256', enc.encode(str))); }
async function hmac(keyHex, msg) {
  const k = await subtle.importKey('raw', enc.encode(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await subtle.sign('HMAC', k, enc.encode(msg)));
}
function hash32(...parts) { // small string hash for sub-seeds
  let h = 2166136261;
  for (const c of parts.join('|')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const subRng = (seed, ...keys) => mulberry32(hash32(seed, ...keys));
function randn(r) { let u = 0, v = 0; while (!u) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function poisson(r, lam) {
  if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * randn(r)));
  const L = Math.exp(-lam); let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

/* ---------- ledger ---------- */
const PEERS = [
  { id: 'KRA', name: 'Kenya Revenue Authority', short: 'KRA' },
  { id: 'ACA', name: 'Anti-Counterfeit Authority', short: 'ACA' },
  { id: 'KEBS', name: 'Kenya Bureau of Standards', short: 'KEBS' },
  { id: 'BRAND', name: 'Brand owner (Kestrel Spirits)', short: 'Brand' },
  { id: 'DIST', name: 'Distributors consortium', short: 'Distrib.' },
];
const QUORUM = 3; // majority of 5 peers must sign every block
const REQUIRED = { MintBatch: ['BRAND', 'KRA'], Transfer: ['DIST'], VerifyScan: ['KRA'], Decommission: ['KEBS'], FlagOutlet: ['ACA', 'KRA'] };

class Chain {
  constructor() { this.blocks = []; this.keys = {}; this.ready = this.init(); }
  async init() {
    for (const p of PEERS) this.keys[p.id] = await sha256('demo-peer-secret/' + p.id);
    this.genesis = '0'.repeat(64);
  }
  signersFor(txs) {
    const s = new Set();
    for (const t of txs) for (const p of (REQUIRED[t.t] || [])) s.add(p);
    for (const p of PEERS) { if (s.size >= QUORUM) break; s.add(p.id); }
    return [...s];
  }
  async append(txs, week) {
    await this.ready;
    const prev = this.blocks.length ? this.blocks[this.blocks.length - 1].hash : this.genesis;
    const header = { index: this.blocks.length, week, prev, txRoot: await sha256(JSON.stringify(txs)) };
    const hash = await sha256(JSON.stringify(header));
    const sigs = {};
    for (const p of this.signersFor(txs)) sigs[p] = await hmac(this.keys[p], hash);
    const block = { ...header, hash, txs, sigs };
    this.blocks.push(block);
    return block;
  }
  async verify() {
    await this.ready;
    let prev = this.genesis;
    for (const b of this.blocks) {
      const header = { index: b.index, week: b.week, prev: b.prev, txRoot: await sha256(JSON.stringify(b.txs)) };
      if (b.prev !== prev) return { ok: false, index: b.index, reason: 'Link to the previous block is broken.' };
      if (header.txRoot !== b.txRoot) return { ok: false, index: b.index, reason: 'Transactions no longer match the signed transaction root.' };
      const h = await sha256(JSON.stringify(header));
      if (h !== b.hash) return { ok: false, index: b.index, reason: 'Block hash does not match its header.' };
      let good = 0;
      for (const p of Object.keys(b.sigs)) if (b.sigs[p] === await hmac(this.keys[p], b.hash)) good++;
      if (good < QUORUM) return { ok: false, index: b.index, reason: `Only ${good} valid peer signatures; ${QUORUM} of ${PEERS.length} are required.` };
      prev = b.hash;
    }
    return { ok: true, index: -1, reason: `${this.blocks.length} blocks checked: hashes link, ${QUORUM}+ valid peer signatures on each.` };
  }
}

/* ---------- world state (derived from transactions) ---------- */
const codeOf = (batch, serial) => `K${batch}-${serial}`;
const caseOf = (batch, serial) => `C${batch}-${Math.floor(serial / 12)}`;
function parseCode(code) {
  const m = /^K(\d+)-(\d+)$/.exec(code);
  return m ? { batch: +m[1], serial: +m[2] } : null;
}
class World {
  constructor() { this.batches = {}; this.cases = {}; this.bottles = {}; this.flags = []; this.deliveries = {}; }
  apply(tx) {
    switch (tx.t) {
      case 'MintBatch': this.batches[tx.batch] = { count: tx.count, brand: tx.brand, week: tx.w }; break;
      case 'Transfer':
        this.cases[tx.case] = { custodian: tx.to, w: tx.w };
        (this.deliveries[tx.to] ||= {})[tx.w] = (this.deliveries[tx.to][tx.w] || 0) + 12;
        break;
      case 'VerifyScan': {
        const b = (this.bottles[tx.code] ||= { scans: [], opened: false, decom: false });
        b.scans.push({ o: tx.o, w: tx.w });
        if (tx.tagOpen) b.opened = true;
        break;
      }
      case 'Decommission': (this.bottles[tx.code] ||= { scans: [], opened: false, decom: false }).decom = true; break;
      case 'FlagOutlet': this.flags.push(tx); break;
    }
  }
  custodian(code) {
    const p = parseCode(code); if (!p) return null;
    const c = this.cases[caseOf(p.batch, p.serial)];
    return c ? c.custodian : 'DIST';
  }
}

/* ---------- VerifyScan: the four checks (plus optional tag authentication) ----------
   scan = { code, outlet, tagOpen, authOK }   opts = { sun, suppressRepeat, dist(a,b) } */
function verifyScan(W, scan, opts) {
  const f = { c0: false, c1: false, c2: false, c2same: false, c3: false, c3same: false, c4: false, dist: 0 };
  const trace = [];
  const done = (verdict, strong, shown, headline) => ({ flags: f, trace, verdict, strong, shown, headline });

  if (opts.sun) {
    if (scan.authOK === false) {
      f.c0 = true;
      trace.push({ n: 0, name: 'Tag authentication (signed rolling counter)', pass: false, detail: 'The tag message failed its signature or counter check. A copied tag cannot produce a fresh signed message.' });
      return done('cloned-tag', true, true, 'Tag failed authentication');
    }
    trace.push({ n: 0, name: 'Tag authentication (signed rolling counter)', pass: true, detail: 'Signature valid and counter is higher than any seen before.' });
  }

  const p = parseCode(scan.code);
  const reg = p && W.batches[p.batch] && p.serial < W.batches[p.batch].count;
  if (!reg) {
    f.c1 = true;
    trace.push({ n: 1, name: 'Is the code registered?', pass: false, detail: 'No MintBatch record contains this code.' });
    return done('fake', true, true, 'Fake code: not registered');
  }
  trace.push({ n: 1, name: 'Is the code registered?', pass: true, detail: `Registered in batch ${p.batch}.` });

  const b = W.bottles[scan.code];
  const custody = W.custodian(scan.code);
  if (b && b.decom) {
    f.c2 = true;
    trace.push({ n: 2, name: 'Opened or decommissioned?', pass: false, detail: 'The ledger records this bottle as an empty that was collected and decommissioned.' });
    return done('refill', true, true, 'Refill suspect: bottle was decommissioned');
  }
  if (scan.tagOpen) {
    f.c2 = true;
    if (custody === scan.outlet && opts.suppressRepeat) {
      f.c2same = true;
      trace.push({ n: 2, name: 'Opened or decommissioned?', pass: false, detail: 'Tag reports opened, but the bottle is at its registered outlet. Treated as a repeat scan: weak signal, no consumer warning.' });
      return done('repeat', false, false, 'Repeat scan of an opened bottle (not shown)');
    }
    trace.push({ n: 2, name: 'Opened or decommissioned?', pass: false, detail: custody === scan.outlet ? 'Tag reports opened.' : `Tag reports opened and the bottle belongs to ${custody}, not here.` });
    return done('refill', true, true, 'Refill suspect: closure already opened');
  }
  trace.push({ n: 2, name: 'Opened or decommissioned?', pass: true, detail: 'Closure sealed; bottle not decommissioned.' });

  const prior = b ? b.scans : [];
  const elsewhere = prior.find(s => s.o !== scan.outlet);
  if (elsewhere) {
    f.c3 = true;
    trace.push({ n: 3, name: 'Scanned before?', pass: false, detail: `Already scanned at ${elsewhere.o} in week ${elsewhere.w}. The same sealed code cannot be in two places.` });
    return done('clone', true, true, 'Clone suspect: code already scanned elsewhere');
  }
  if (prior.length) {
    f.c3same = true;
    trace.push({ n: 3, name: 'Scanned before?', pass: true, detail: 'Scanned before at this same outlet: weak signal only.' });
  } else trace.push({ n: 3, name: 'Scanned before?', pass: true, detail: 'First scan of this code.' });

  if (custody && custody !== scan.outlet) {
    f.c4 = true; f.dist = opts.dist ? opts.dist(custody, scan.outlet) : 0;
    trace.push({ n: 4, name: 'At its custody outlet?', pass: false, detail: `Custody record says ${custody}; scanned at ${scan.outlet}${f.dist ? ` (${f.dist.toFixed(0)} km apart)` : ''}. Weak signal, weighted by distance.` });
    return done('mismatch', false, false, 'Custody mismatch (weak signal, not shown)');
  }
  trace.push({ n: 4, name: 'At its custody outlet?', pass: true, detail: `Custody record says ${custody}.` });
  return done('genuine', false, true, 'Genuine');
}

/* ---------- risk model ---------- */
const FEATURES = ['Opened-tag rate', 'Mismatch distance', 'Invalid codes', 'Delivery ratio', 'Change in mismatch rate', 'Custody-mismatch rate', 'Outlet type (bar)', 'Duplicate rate'];

function cFn(n) { return n > 2 ? 2 * (Math.log(n - 1) + 0.5772156649) - 2 * (n - 1) / n : (n === 2 ? 1 : 0); }
function buildTree(X, idx, depth, limit, r) {
  if (depth >= limit || idx.length <= 1) return { size: idx.length };
  const d = Math.floor(r() * X[0].length);
  let mn = Infinity, mx = -Infinity;
  for (const i of idx) { const v = X[i][d]; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (mx === mn) return { size: idx.length };
  const sp = mn + r() * (mx - mn);
  const L = [], R = [];
  for (const i of idx) (X[i][d] < sp ? L : R).push(i);
  return { d, sp, l: buildTree(X, L, depth + 1, limit, r), r: buildTree(X, R, depth + 1, limit, r) };
}
const pathLen = (nd, x, depth) => nd.size !== undefined ? depth + cFn(nd.size) : pathLen(x[nd.d] < nd.sp ? nd.l : nd.r, x, depth + 1);
function isolationScores(X, r, trees = 100) {
  const n = X.length, psi = Math.min(64, n), limit = Math.ceil(Math.log2(psi));
  const forest = [];
  for (let t = 0; t < trees; t++) {
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    forest.push(buildTree(X, idx.slice(0, psi), 0, limit, r));
  }
  return X.map(x => Math.pow(2, -mean(forest.map(t => pathLen(t, x, 0))) / cFn(psi)));
}
function percentiles(a) {
  const order = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const out = new Array(a.length);
  order.forEach(([, i], rank) => { out[i] = a.length > 1 ? rank / (a.length - 1) : 0.5; });
  return out;
}
function trainLR(data) { // balanced class weights, L2, standardised inputs
  const d = data[0].x.length;
  const mu = Array(d).fill(0), sd = Array(d).fill(0);
  data.forEach(s => s.x.forEach((v, j) => mu[j] += v / data.length));
  data.forEach(s => s.x.forEach((v, j) => sd[j] += (v - mu[j]) ** 2 / data.length));
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const pos = data.filter(s => s.y === 1).length, neg = data.length - pos;
  const wp = data.length / (2 * pos), wn = data.length / (2 * neg);
  const w = Array(d).fill(0); let b0 = 0;
  for (let it = 0; it < 400; it++) {
    const g = Array(d).fill(0); let gb = 0;
    for (const s of data) {
      const z = b0 + s.x.reduce((a, v, j) => a + w[j] * (v - mu[j]) / sd[j], 0);
      const pr = 1 / (1 + Math.exp(-z)), cw = s.y ? wp : wn, e = (pr - s.y) * cw;
      gb += e; for (let j = 0; j < d; j++) g[j] += e * (s.x[j] - mu[j]) / sd[j];
    }
    b0 -= 0.2 * gb / data.length;
    for (let j = 0; j < d; j++) w[j] -= 0.2 * (g[j] / data.length + 0.01 * w[j]);
  }
  return { w, b0, mu, sd };
}
const predictLR = (m, x) => 1 / (1 + Math.exp(-(m.b0 + x.reduce((a, v, j) => a + m.w[j] * (v - m.mu[j]) / m.sd[j], 0))));

/* ---------- weekly simulation ---------- */
const METHODS = ['fake', 'clone', 'refill'];
const DEFAULTS = {
  seed: 7, nOutlets: 120, regime: 'S3', scanRate: 0.08, cap: 3, ledgerTools: true,
  sun: false, suppress: true, closureRel: 0.9, informal: 0.03, warmup: 3, meanBottles: 30,
};

class Sim {
  constructor(opts = {}, chain = null) {
    this.o = Object.assign({}, DEFAULTS, opts);
    this.chain = chain;
    this.W = new World();
    this.week = 0;
    this.serial = {};            // batch -> next serial
    this.soldCodes = [];         // {code, outlet}
    this.scanLog = {};           // outlet -> [{w, f, strong, shown, cf}]
    this.nets = []; this.infs = [];
    this.cool = {};              // outlet -> week until which re-infiltration is blocked
    this.lastInsp = {};
    this.tips = new Set(); this.linked = new Set();
    this.train = []; this.lrModel = null; this.lrWeek = -99;
    this.series = []; this.removed = []; this.totalCfSold = 0;
    this.inspectionsTotal = 0; this.foundTotal = 0;
    this.lastQueue = []; this.lastRisk = {};
    this.pendingTx = [];
    this.blockLog = [];
    this.stats = { cfScans: 0, cfWarned: 0, gScans: 0, gWarned: 0 };
    this.makeOutlets();
  }

  makeOutlets() {
    const r = subRng(this.o.seed, 'outlets'), n = this.o.nOutlets;
    const centers = Array.from({ length: 8 }, () => [40 + r() * 320, 40 + r() * 320]);
    this.outlets = Array.from({ length: n }, (_, i) => {
      const c = centers[i % 8];
      const x = Math.min(395, Math.max(5, c[0] + randn(r) * 22)), y = Math.min(395, Math.max(5, c[1] + randn(r) * 22));
      return {
        id: 'O' + String(i + 1).padStart(3, '0'), i, x, y, county: (i % 8) + 1,
        bar: r() < 0.4, mean: Math.exp(Math.log(this.o.meanBottles) + 0.5 * randn(r) - 0.125),
        scanMult: Math.exp(0.6 * randn(r) - 0.18),
      };
    });
    this.byId = Object.fromEntries(this.outlets.map(o => [o.id, o]));
    this.outlets.forEach(o => {
      o.near = this.outlets.filter(p => p !== o).map(p => [this.d(o, p), p]).sort((a, b) => a[0] - b[0]).slice(0, 4).map(a => a[1]);
      this.scanLog[o.id] = [];
    });
    this.opts_ = { dist: (a, b) => (this.byId[a] && this.byId[b]) ? this.d(this.byId[a], this.byId[b]) : 0 };
  }
  d(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  vopts() { return { sun: this.o.sun, suppressRepeat: this.o.suppress, dist: this.opts_.dist }; }
  emit(tx) { this.W.apply(tx); this.pendingTx.push(tx); }

  /* ----- one week ----- */
  step() {
    const w = this.week, o = this.o, regime = o.regime, ledgerOn = regime !== 'S1';
    const rNet = subRng(o.seed, 'net', w), rInsp = subRng(o.seed, 'insp', w);
    const warm = w < o.warmup;
    this.pendingTx = [];

    /* networks arrive and recruit */
    if (!warm) {
      const arrivals = (w === o.warmup ? 3 : 0) + (rNet() < 0.25 ? 1 : 0);
      for (let k = 0; k < arrivals; k++) this.newNetwork(rNet, w);
      for (const net of this.nets) if (net.alive && rNet() < 0.25) this.recruit(net, rNet, 1, w);
    }

    /* mint + deliveries + sales (genuine) */
    const batch = w + 1;
    const plan = this.outlets.map(ou => {
      const rr = subRng(o.seed, 'sales', w, ou.id);
      const sales = Math.max(4, poisson(rr, ou.mean));
      const infs = this.infs.filter(f => f.outlet === ou.id && f.active);
      let cf = 0;
      for (const f of infs) cf += Math.round(sales * f.share);
      cf = Math.min(cf, sales - 2);
      return { ou, rr, sales, cf, g: sales - cf, infs };
    });
    const cases = plan.map(p => Math.ceil(p.g / 12));
    const minted = cases.reduce((a, b) => a + b, 0) * 12;
    this.serial[batch] = 0;
    this.emit({ t: 'MintBatch', batch, count: minted, brand: 'Kestrel', w });
    let weekCf = 0, weekSales = 0;
    const pendingScans = [];

    plan.forEach((p, k) => {
      const { ou, rr } = p;
      const start = this.serial[batch];
      for (let c = 0; c < cases[k]; c++) this.emit({ t: 'Transfer', case: `C${batch}-${Math.floor((start + c * 12) / 12)}`, to: ou.id, w });
      this.serial[batch] += cases[k] * 12;
      const pScan = Math.min(0.9, o.scanRate * ou.scanMult);
      weekSales += p.sales;

      /* genuine bottles */
      for (let i = 0; i < p.g; i++) {
        const code = codeOf(batch, start + i);
        let where = ou;
        if (rr() < o.informal) where = pick(rr, ou.near);
        if (this.soldCodes.length < 6000) this.soldCodes.push({ code, outlet: ou.id });
        else this.soldCodes[Math.floor(rr() * 6000)] = { code, outlet: ou.id };
        if (rr() < pScan) {
          const garbled = rr() < 0.003;
          pendingScans.push({ code: garbled ? 'K0-0' : code, outlet: where.id, tagOpen: false, cf: false, w });
          const repeat = rr() < (ou.bar ? 0.03 : 0.002);
          if (repeat && !garbled) pendingScans.push({ code, outlet: where.id, tagOpen: rr() < o.closureRel, cf: false, w });
        }
      }
      /* counterfeit bottles */
      for (const f of p.infs) {
        const net = this.nets[f.net], n = Math.round(p.sales * f.share);
        weekCf += n;
        for (let i = 0; i < n; i++) {
          if (rr() >= pScan) continue;
          if (net.method === 'fake') pendingScans.push({ code: codeOf(batch + 500, Math.floor(rr() * 1e6)), outlet: ou.id, tagOpen: false, cf: true, w, authOK: false });
          else if (net.method === 'clone') {
            const src = pick(rr, net.pool);
            pendingScans.push({ code: src.code, outlet: ou.id, tagOpen: false, cf: true, w, authOK: false });
          } else {
            const pool = this.soldCodes.filter(s => s.outlet !== ou.id);
            const same = rr() < 0.3 || !pool.length;
            const src = same ? pick(rr, this.soldCodes.filter(s => s.outlet === ou.id).concat(this.soldCodes.slice(0, 1))) : pick(rr, pool);
            if (!src) continue;
            pendingScans.push({ code: src.code, outlet: ou.id, tagOpen: rr() < o.closureRel, cf: true, w, authOK: true });
          }
        }
      }
    });
    weekCf = Math.min(weekCf, weekSales);
    this.totalCfSold += weekCf;

    /* consumer scans */
    for (const s of pendingScans) this.processScan(s, regime, rNet);

    /* inspections (after warm-up) */
    let found = 0, inspected = 0;
    if (!warm) {
      const q = this.chooseTargets(w, regime, rInsp);
      this.lastQueue = q;
      for (const t of q) {
        inspected++; this.lastInsp[t.id] = w;
        const res = this.inspect(t.id, w, regime, rInsp);
        t.found = !!res;
        if (res) found++;
        const x = this.featureVector(t.id, w);
        if (regime === 'S3') this.train.push({ x, y: res ? 1 : 0 });
        if (ledgerOn) this.emit({ t: 'FlagOutlet', o: t.id, found: !!res, w });
      }
      this.inspectionsTotal += inspected; this.foundTotal += found;
    }
    this.tips = new Set(); // tips regenerate each week
    for (const f of this.infs) if (f.active && rNet() < 0.01) this.tips.add(f.outlet);
    for (const f of this.infs) if (f.active) f.weeks++;

    const cfOutlets = new Set(this.infs.filter(f => f.active).map(f => f.outlet)).size;
    const rec = {
      w, share: weekSales ? weekCf / weekSales : 0, cfOutlets, found, inspected,
      cfScans: this.stats.cfScans, cfWarned: this.stats.cfWarned, gScans: this.stats.gScans, gWarned: this.stats.gWarned,
      txs: this.pendingTx.length,
    };
    this.series.push(rec);
    this.week++;
    return rec;
  }

  newNetwork(r, w) {
    const mix = r(), method = mix < 0.2 ? 'fake' : mix < 0.55 ? 'clone' : 'refill';
    const net = { id: this.nets.length, method, alive: true, base: pick(r, this.outlets), pool: [], born: w };
    if (method === 'clone') {
      const n = 20 + Math.floor(r() * 80), local = this.soldCodes.filter(s => s.outlet === net.base.id);
      for (let i = 0; i < n; i++) {
        const src = (r() < 0.3 && local.length) ? pick(r, local) : pick(r, this.soldCodes);
        net.pool.push({ code: src.code });
      }
    }
    this.nets.push(net);
    this.recruit(net, r, 3, w);
  }
  recruit(net, r, k, w) {
    const taken = new Set(this.infs.filter(f => f.active && f.net === net.id).map(f => f.outlet));
    if (taken.size >= 8) return;
    const cand = this.outlets.filter(ou => !taken.has(ou.id) && this.d(ou, net.base) < 70 && (this.cool[ou.id] || -1) < w);
    for (let i = 0; i < k && cand.length; i++) {
      const wts = cand.map(ou => 1 / (0.15 + ou.scanMult));
      let t = r() * wts.reduce((a, b) => a + b, 0), j = 0;
      while (j < cand.length - 1 && (t -= wts[j]) > 0) j++;
      const ou = cand.splice(j, 1)[0];
      this.infs.push({ net: net.id, outlet: ou.id, share: 0.2 + 0.4 * r(), active: true, start: w, weeks: 0 });
    }
  }

  processScan(s, regime, r) {
    const rec = (res) => this.scanLog[s.outlet].push({ w: s.w, f: res.flags, strong: res.strong, shown: res.shown, cf: s.cf });
    if (regime === 'S1') { // stamp check: code validity only
      const p = parseCode(s.code), reg = p && this.W.batches[p.batch] && p.serial < this.W.batches[p.batch].count;
      const fail = !reg;
      (s.cf ? (this.stats.cfScans++, fail && this.stats.cfWarned++) : (this.stats.gScans++, fail && this.stats.gWarned++));
      if (fail && r() < 0.2) this.tips.add(s.outlet);
      return;
    }
    const res = verifyScan(this.W, s, this.vopts());
    if (res.verdict !== 'cloned-tag') this.emit({ t: 'VerifyScan', code: s.code, o: s.outlet, tagOpen: s.tagOpen, w: s.w });
    rec(res);
    if (s.cf) { this.stats.cfScans++; if (res.shown && res.verdict !== 'genuine') this.stats.cfWarned++; }
    else { this.stats.gScans++; if (res.shown && res.verdict !== 'genuine') this.stats.gWarned++; }
  }

  /* ----- features for an outlet at week t ----- */
  pooled(t) {
    let n = 0, c = { c1: 0, c2: 0, c3: 0, c4: 0 };
    for (const ou of this.outlets) for (const s of this.scanLog[ou.id]) if (s.w > t - 4 && s.w <= t) {
      n++; c.c1 += s.f.c1; c.c2 += s.f.c2; c.c3 += (s.f.c3 || s.f.c3same); c.c4 += s.f.c4;
    }
    n = Math.max(n, 1);
    return { c1: c.c1 / n, c2: c.c2 / n, c3: c.c3 / n, c4: c.c4 / n };
  }
  featureVector(id, t) {
    const ou = this.byId[id], m = 5, P = this._pool && this._poolT === t ? this._pool : (this._pool = this.pooled(t), this._poolT = t, this._pool);
    const win = this.scanLog[id].filter(s => s.w > t - 4 && s.w <= t), n = win.length;
    const cnt = k => win.reduce((a, s) => a + (k === 'c3' ? (s.f.c3 || s.f.c3same) : s.f[k]), 0);
    const sm = (k, pr) => (cnt(k) + m * pr) / (n + m);
    const mis = win.filter(s => s.f.c4);
    const base = this.scanLog[id].filter(s => s.w > t - 16 && s.w <= t - 4);
    const bm = base.length ? base.reduce((a, s) => a + s.f.c4, 0) / base.length : P.c4;
    const dl = this.W.deliveries[id] || {};
    let cur = 0, prev = 0, pc = 0;
    for (let k = t - 3; k <= t; k++) cur += dl[k] || 0;
    for (let k = t - 15; k <= t - 4; k++) if (k >= 0) { prev += dl[k] || 0; pc++; }
    const dr = prev > 0 ? cur / 4 / (prev / Math.max(pc, 1)) : 1;
    return [sm('c2', P.c2), Math.log1p(mis.length ? mean(mis.map(s => s.f.dist)) : 0), Math.log1p(cnt('c1')), dr, sm('c4', P.c4) - bm, sm('c4', P.c4), ou.bar ? 1 : 0, sm('c3', P.c3)];
  }
  strongCount(id, t) {
    return this.scanLog[id].filter(s => s.w > t - 4 && s.w <= t).reduce((a, s) => a + (s.strong ? 1 : 0) + (s.f.c2same ? 1 : 0), 0);
  }

  /* ----- choose inspection targets ----- */
  chooseTargets(t, regime, r) {
    const cap = this.o.cap, picked = [], used = new Set();
    const ok = ou => !used.has(ou.id) && (this.lastInsp[ou.id] === undefined || t - this.lastInsp[ou.id] >= 4);
    const add = (ou, why) => { if (ok(ou) && picked.length < cap) { picked.push({ id: ou.id, why }); used.add(ou.id); } };
    const explore = regime === 'S3' ? Math.max(1, Math.round(0.08 * cap)) : 0;
    const main = cap - explore;
    const addMain = (ou, why) => { if (picked.length < main) add(ou, why); };
    this._pool = null;

    let ranked = null;
    if (regime !== 'S1') {
      const X = this.outlets.map(ou => this.featureVector(ou.id, t));
      if (regime === 'S2') {
        const sc = this.outlets.map((ou, i) => {
          const strong = this.strongCount(ou.id, t), mism = this.scanLog[ou.id].filter(s => s.w > t - 4 && s.w <= t && s.f.c4).length;
          const n = this.scanLog[ou.id].filter(s => s.w > t - 4 && s.w <= t).length || 1;
          const alert = strong > 0 || mism / n > 0.10;
          return { ou, score: alert ? strong + mism : -1, i };
        });
        ranked = sc.filter(s => s.score >= 0).sort((a, b) => b.score - a.score || r() - 0.5);
        ranked.forEach(s => this.lastRisk[s.ou.id] = Math.min(1, s.score / 6));
        this.outlets.forEach(ou => { if (!(ou.id in this.lastRisk) || !ranked.find(s => s.ou === ou)) this.lastRisk[ou.id] = 0; });
      } else {
        const ifs = isolationScores(X, subRng(this.o.seed, 'if', t));
        const pos = this.train.filter(s => s.y).length, neg = this.train.length - pos;
        if (pos >= 10 && neg >= 10 && t - this.lrWeek >= 4) { this.lrModel = trainLR(this.train); this.lrWeek = t; }
        const pi = percentiles(ifs);
        let comb = pi;
        if (this.lrModel) { const pl = percentiles(X.map(x => predictLR(this.lrModel, x))); comb = pi.map((v, i) => (v + pl[i]) / 2); }
        this.outlets.forEach((ou, i) => this.lastRisk[ou.id] = comb[i]);
        ranked = this.outlets.map((ou, i) => ({ ou, score: comb[i] })).sort((a, b) => b.score - a.score);
      }
      this.lastX = X;
    }
    if (regime !== 'S1') for (const id of this.linked) addMain(this.byId[id], 'Linked to confirmed network');
    this.linked = new Set();
    for (const id of this.tips) addMain(this.byId[id], regime === 'S1' ? 'Consumer report / tip-off' : 'Tip-off');
    if (ranked) for (const s of ranked) addMain(s.ou, regime === 'S2' ? 'Rule alert' : 'ML risk rank');
    const rest = this.outlets.filter(ok).sort(() => r() - 0.5);
    for (const ou of rest) { if (picked.length >= main) break; add(ou, 'Random'); }
    for (const ou of rest) { if (picked.length >= cap) break; add(ou, explore ? 'Random exploration' : 'Random'); }
    return picked;
  }

  inspect(id, t, regime, r) {
    const tools = (regime !== 'S1') && this.o.ledgerTools;
    const pd = tools ? { fake: 0.95, clone: 0.85, refill: 0.85 } : { fake: 0.95, clone: 0.20, refill: 0.15 };
    let found = false;
    for (const f of this.infs.filter(f => f.active && f.outlet === id)) {
      const net = this.nets[f.net];
      if (r() < pd[net.method]) {
        found = true; f.active = false; this.cool[id] = t + 12;
        this.removed.push({ outlet: id, weeks: t - f.start, method: net.method });
        if (net.method === 'clone' && regime !== 'S1') for (const g of this.infs) if (g.active && g.net === f.net) this.linked.add(g.outlet);
        if (r() < 0.10) { net.alive = false; for (const g of this.infs) if (g.net === f.net && g.active) { g.active = false; this.removed.push({ outlet: g.outlet, weeks: t - g.start, method: net.method }); } }
      }
    }
    return found;
  }

  metrics() {
    const s = this.series, last = s.slice(-13);
    const sc = this.stats;
    return {
      shareLast13: mean(last.map(x => x.share)),
      cfBottles: this.totalCfSold,
      inspections: this.inspectionsTotal, found: this.foundTotal,
      hitRate: this.inspectionsTotal ? this.foundTotal / this.inspectionsTotal : 0,
      cfWarnShare: sc.cfScans ? sc.cfWarned / sc.cfScans : 0,
      falseWarnPer1000: sc.gScans ? 1000 * sc.gWarned / sc.gScans : 0,
      medianRemoval: (() => { const a = this.removed.map(x => x.weeks).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; })(),
    };
  }

  /* run weeks; if a chain is attached, commit each week's transactions in blocks of up to 150 */
  async run(weeks, onWeek) {
    for (let i = 0; i < weeks; i++) {
      const rec = this.step();
      if (this.chain && this.o.regime !== 'S1') {
        const txs = this.pendingTx;
        for (let k = 0; k < txs.length; k += 150) await this.chain.append(txs.slice(k, k + 150), rec.w);
      }
      if (onWeek) await onWeek(rec, this);
    }
  }
}


/* ---------- follow one bottle ----------
   Replays the chain from the start and collects every event that touches this bottle.
   Scan verdicts are re-derived from ledger data only, using the world state as it stood just before each scan. */
function trail(chain, code, dist, suppressRepeat = true) {
  const p = parseCode(code);
  if (!p) return { valid: false, code, events: [] };
  const cs = caseOf(p.batch, p.serial), W = new World(), events = [];
  const opts = { sun: false, suppressRepeat, dist };
  for (const b of chain.blocks) for (const t of b.txs) {
    if (t.t === 'MintBatch' && t.batch === p.batch) events.push({ kind: 'mint', block: b.index, week: b.week, count: t.count, registered: p.serial < t.count });
    else if (t.t === 'Transfer' && t.case === cs) events.push({ kind: 'transfer', block: b.index, week: b.week, to: t.to });
    else if (t.t === 'Decommission' && t.code === code) events.push({ kind: 'decommission', block: b.index, week: b.week });
    else if (t.t === 'VerifyScan' && t.code === code) {
      const r = verifyScan(W, { code, outlet: t.o, tagOpen: t.tagOpen }, opts);
      events.push({ kind: 'scan', block: b.index, week: b.week, outlet: t.o, tagOpen: t.tagOpen, verdict: r.verdict, headline: r.headline, shown: r.shown, strong: r.strong, flags: r.flags, trace: r.trace });
    }
    W.apply(t);
  }
  const b = W.bottles[code];
  return { valid: true, code, batch: p.batch, serial: p.serial, case: cs, registered: !!(W.batches[p.batch] && p.serial < W.batches[p.batch].count),
    custodian: W.custodian(code), scanCount: b ? b.scans.length : 0, opened: !!(b && b.opened), decommissioned: !!(b && b.decom), events };
}

/* run a fresh sim without a chain (for regime comparison) */
function quickRun(opts, weeks) {
  const s = new Sim(opts, null);
  for (let i = 0; i < weeks; i++) s.step();
  return s;
}

return { PEERS, QUORUM, REQUIRED, Chain, World, Sim, quickRun, verifyScan, trail, codeOf, caseOf, parseCode, FEATURES, DEFAULTS, mulberry32, subRng, sha256, hmac };
})();
if (typeof module !== 'undefined') module.exports = Engine;
