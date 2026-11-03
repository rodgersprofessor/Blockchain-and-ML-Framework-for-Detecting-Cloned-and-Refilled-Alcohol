// Reproduces the regime comparison from the demo's "Compare S1, S2, S3" button, on the command line.
// Usage: node scripts/compare.js [replications=10] [weeks=40] [outlets=300] [inspectionsPerWeek=6] [seed=300]
const E = require('../src/engine.js');
const [reps = 10, weeks = 40, nOutlets = 300, cap = 6, seed0 = 300] = process.argv.slice(2).map(Number);
const regs = ['S1', 'S2', 'S3'], names = { S1: 'S1 stamps only', S2: 'S2 ledger + rules', S3: 'S3 ledger + ML' };
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const M = { S1: [], S2: [], S3: [] };
for (let k = 0; k < reps; k++) for (const r of regs) M[r].push(E.quickRun({ regime: r, seed: seed0 + k, nOutlets, cap }, weeks).metrics());
console.log(`\n${reps} replications, ${weeks} weeks, ${nOutlets} outlets, ${cap} inspections/week, seeds ${seed0}..${seed0 + reps - 1}\n`);
const rows = [
  ['Counterfeit share of sales, last 13 weeks', r => (100 * mean(M[r].map(m => m.shareLast13))).toFixed(2) + '%'],
  ['Counterfeit bottles sold', r => Math.round(mean(M[r].map(m => m.cfBottles))).toLocaleString('en-US')],
  ['Inspection hit rate', r => (100 * mean(M[r].map(m => m.hitRate))).toFixed(0) + '%'],
  ['Counterfeit scans that warn the consumer', r => (100 * mean(M[r].map(m => m.cfWarnShare))).toFixed(0) + '%'],
  ['False warnings per 1,000 genuine scans', r => mean(M[r].map(m => m.falseWarnPer1000)).toFixed(1)],
];
const w0 = 44;
console.log('Outcome'.padEnd(w0) + regs.map(r => names[r].padStart(20)).join(''));
for (const [label, f] of rows) console.log(label.padEnd(w0) + regs.map(r => f(r).padStart(20)).join(''));
const wins = M.S3.filter((m, i) => m.shareLast13 < M.S2[i].shareLast13).length;
console.log(`\nS3 had a lower counterfeit share than S2 in ${wins} of ${reps} replications.\n`);
