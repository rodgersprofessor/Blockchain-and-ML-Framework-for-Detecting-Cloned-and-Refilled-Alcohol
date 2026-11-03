const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');

test('ledger verifies, and a changed transaction is caught', async () => {
  const ch = new E.Chain();
  await ch.append([{ t: 'MintBatch', batch: 1, count: 24, brand: 'K', w: 0 }], 0);
  await ch.append([{ t: 'Transfer', case: 'C1-0', to: 'O001', w: 0 }], 0);
  await ch.append([{ t: 'VerifyScan', code: 'K1-3', o: 'O001', tagOpen: false, w: 0 }], 0);
  assert.equal((await ch.verify()).ok, true);
  ch.blocks[1].txs[0].to = 'O999';
  const v = await ch.verify();
  assert.equal(v.ok, false);
  assert.equal(v.index, 1);
});

test('re-hashing a block and re-signing with one peer key is rejected (quorum 3 of 5)', async () => {
  const ch = new E.Chain();
  await ch.append([{ t: 'Transfer', case: 'C1-0', to: 'O001', w: 0 }], 0);
  const b = ch.blocks[0];
  b.txs[0].to = 'O999';
  b.txRoot = await E.sha256(JSON.stringify(b.txs));
  b.hash = await E.sha256(JSON.stringify({ index: b.index, week: b.week, prev: b.prev, txRoot: b.txRoot }));
  b.sigs = { DIST: await E.hmac(ch.keys.DIST, b.hash) };
  const v = await ch.verify();
  assert.equal(v.ok, false);
  assert.match(v.reason, /3 of 5/);
});

test('VerifyScan returns the expected verdict for each scenario', () => {
  const W = new E.World();
  W.apply({ t: 'MintBatch', batch: 1, count: 48, brand: 'K', w: 0 });
  W.apply({ t: 'Transfer', case: 'C1-0', to: 'O001', w: 0 });
  W.apply({ t: 'Transfer', case: 'C1-1', to: 'O002', w: 0 });
  const o = { sun: false, suppressRepeat: true, dist: () => 50 };
  const run = s => { const r = E.verifyScan(W, s, o); W.apply({ t: 'VerifyScan', code: s.code, o: s.outlet, tagOpen: s.tagOpen, w: 1 }); return r.verdict; };
  assert.equal(run({ code: 'K1-2', outlet: 'O001', tagOpen: false }), 'genuine');
  assert.equal(run({ code: 'K9-9', outlet: 'O001', tagOpen: false }), 'fake');
  assert.equal(run({ code: 'K1-2', outlet: 'O002', tagOpen: false }), 'clone');
  assert.equal(run({ code: 'K1-2', outlet: 'O001', tagOpen: true }), 'repeat');
  assert.equal(run({ code: 'K1-5', outlet: 'O002', tagOpen: true }), 'refill');
  assert.equal(run({ code: 'K1-20', outlet: 'O001', tagOpen: false }), 'mismatch');
  const signed = E.verifyScan(W, { code: 'K1-30', outlet: 'O002', tagOpen: false, authOK: false }, { ...o, sun: true });
  assert.equal(signed.verdict, 'cloned-tag');
});

test('repeat-scan suppression changes the consumer warning, as Section 7.6 describes', () => {
  const W = new E.World();
  W.apply({ t: 'MintBatch', batch: 1, count: 12, brand: 'K', w: 0 });
  W.apply({ t: 'Transfer', case: 'C1-0', to: 'O001', w: 0 });
  const s = { code: 'K1-1', outlet: 'O001', tagOpen: true };
  assert.equal(E.verifyScan(W, s, { suppressRepeat: true }).shown, false);
  assert.equal(E.verifyScan(W, s, { suppressRepeat: false }).shown, true);
});

test('simulation is deterministic for a given seed', () => {
  const a = E.quickRun({ regime: 'S3', seed: 42, nOutlets: 120 }, 20).metrics();
  const b = E.quickRun({ regime: 'S3', seed: 42, nOutlets: 120 }, 20).metrics();
  assert.deepEqual(a, b);
});

test('both ledger regimes beat stamps alone on average across seeds', () => {
  const m = { S1: 0, S2: 0, S3: 0 }, N = 5;
  for (let k = 0; k < N; k++) for (const r of ['S1', 'S2', 'S3']) m[r] += E.quickRun({ regime: r, seed: 500 + k, nOutlets: 200, cap: 5 }, 36).metrics().shareLast13 / N;
  assert.ok(m.S2 < m.S1 * 0.5, `S2 ${m.S2} should be well below S1 ${m.S1}`);
  assert.ok(m.S3 < m.S1 * 0.5, `S3 ${m.S3} should be well below S1 ${m.S1}`);
});

test('a simulated run writes a ledger that verifies', async () => {
  const ch = new E.Chain(), s = new E.Sim({ regime: 'S3', seed: 5, nOutlets: 100 }, ch);
  await s.run(6);
  assert.ok(ch.blocks.length > 5);
  assert.equal((await ch.verify()).ok, true);
});

test('trail follows one bottle: mint, then delivery, then scans, in block order', async () => {
  const ch = new E.Chain(), s = new E.Sim({ regime: 'S3', seed: 9, nOutlets: 100 }, ch);
  await s.run(6);
  const code = Object.keys(s.W.bottles).find(c => /^K\d+-\d+$/.test(c) && s.W.bottles[c].scans.length && s.W.batches[E.parseCode(c).batch] && E.parseCode(c).serial < s.W.batches[E.parseCode(c).batch].count);
  const t = E.trail(ch, code, s.opts_.dist);
  assert.equal(t.valid, true);
  assert.equal(t.registered, true);
  const kinds = t.events.map(e => e.kind);
  assert.equal(kinds[0], 'mint');
  assert.equal(kinds[1], 'transfer');
  assert.ok(kinds.slice(2).every(k => k === 'scan') && kinds.length > 2);
  const blocks = t.events.map(e => e.block);
  assert.deepEqual(blocks, [...blocks].sort((a, b) => a - b));
  assert.equal(t.scanCount, t.events.filter(e => e.kind === 'scan').length);
  assert.equal(t.events[2].verdict, 'genuine');   // first scan of a delivered bottle at its own outlet
  assert.equal(E.trail(ch, 'not-a-code', s.opts_.dist).valid, false);
});

test('index.html is up to date with src/', () => {
  const fs = require('fs'), path = require('path');
  const root = path.join(__dirname, '..');
  const built = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8').replace('/*__ENGINE__*/', () => fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), built, 'run `npm run build`');
});
