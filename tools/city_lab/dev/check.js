// One check runner: every headless geometry / clearance check on the given seeds, one pass/fail table.
//   node tools/city_lab/dev/check.js [seeds, default 1,2,3] [--quick] [--only=a,b] [--skip=a,b] [--jobs=N] [--verbose]
//   --quick    first seed only, and skips regress (baseline compare) and access
//   --only / --skip   check ids: zfight, groundfight, traffic, vehicles, access, regress
//   --jobs     parallel child processes (default 1; each build needs ~2-4 GB of heap)
//   --verbose  print the full output of failing checks (default: its last 25 lines)
// Exit code 0 only when every check passed. Each check is its own child process (the original dev script, unchanged).
const { spawn } = require('child_process');
const path = require('path');
const A = require('./lib/args.js');
const QUICK = A.flag('quick'), VERBOSE = A.flag('verbose');
const SEEDS = QUICK ? [A.seeds([1])[0]] : A.seeds([1, 2, 3]);
const only = A.val('only'), skip = A.val('skip');
const JOBS = Math.max(1, A.num('jobs', 1));

// per-seed checks run once per seed; 'once' checks take the whole seed list themselves
const CHECKS = [
  { id: 'zfight',      script: 'zfight.js',         args: (s) => [s, '--props'] },
  { id: 'groundfight', script: 'groundfight.js',    args: (s) => [s, '--self'] },
  { id: 'traffic',     script: 'traffic_check.js',  args: (s) => [s] },
  { id: 'vehicles',    script: 'vehicles_check.js', args: (s) => [s] },
  { id: 'access',      script: 'access.js',         once: (ss) => [ss.join(',')], quickSkip: true },
  { id: 'regress',     script: 'regress.js',        once: (ss) => ['--seeds=' + ss.join(',')], quickSkip: true,
    note: 'compares with dev/baseline_downtown.json; rebaseline only after owner approval (see README)' }
];
const has = (list, id) => list && list.split(',').includes(id);
const wanted = (c) => (!only || has(only, c.id)) && !has(skip, c.id) && !(QUICK && c.quickSkip && !only);

const tasks = [];
for (const c of CHECKS) {
  if (!wanted(c)) continue;
  if (c.once) tasks.push({ id: c.id, seed: SEEDS.join(','), script: c.script, argv: c.once(SEEDS), note: c.note });
  else for (const s of SEEDS) tasks.push({ id: c.id, seed: String(s), script: c.script, argv: c.args(s) });
}

function run(t) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let out = '';
    const p = spawn(process.execPath, ['--max-old-space-size=8000', path.join(__dirname, t.script), ...t.argv.map(String)], { cwd: path.resolve(__dirname, '..') });
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('error', (e) => { t.out = String(e); t.code = 127; t.ms = 0; resolve(t); });
    p.on('close', (code) => { t.out = out; t.code = code; t.ms = Date.now() - t0; resolve(t); });
  });
}
async function main() {
  console.log(`city_lab check: ${tasks.length} runs, seeds ${SEEDS.join(',')}${QUICK ? ' (quick)' : ''}, jobs ${JOBS}`);
  const queue = tasks.slice();
  await Promise.all(Array.from({ length: JOBS }, async () => {
    while (queue.length) { const t = queue.shift(); await run(t); process.stderr.write(`  ${t.code === 0 ? 'ok  ' : 'FAIL'} ${t.id} ${t.seed} (${(t.ms / 1000).toFixed(0)} s)\n`); }
  }));
  const w = Math.max(...tasks.map(t => t.id.length), 5);
  console.log('\n' + 'check'.padEnd(w) + '  seed   result  time    detail');
  let fails = 0;
  for (const t of tasks) {
    const lines = t.out.split('\n').map(s => s.trim()).filter(Boolean);
    const ok = t.code === 0; if (!ok) ++fails;
    const detail = (lines.filter(l => /pass|fail|total|issue|overlap|regress|clear|hits?\b/i.test(l)).pop() || lines[lines.length - 1] || '').slice(0, 90);
    console.log(t.id.padEnd(w) + '  ' + t.seed.padEnd(5) + '  ' + (ok ? 'PASS' : 'FAIL').padEnd(6) + '  ' + (t.ms / 1000).toFixed(0).padStart(3) + ' s  ' + detail);
  }
  for (const t of tasks) if (t.code !== 0) {
    const lines = t.out.split('\n');
    console.log(`\n--- ${t.id} ${t.seed} (exit ${t.code}${t.note ? '; ' + t.note : ''}) ---\n` + (VERBOSE ? lines : lines.slice(-25)).join('\n'));
  }
  console.log(`\n${fails ? 'FAILED' : 'ALL PASSED'}: ${tasks.length - fails}/${tasks.length} runs passed`);
  process.exitCode = fails ? 1 : 0;
}
main();
