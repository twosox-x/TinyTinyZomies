// Tiny argv helpers shared by the headless dev tools.
//   const A = require('./lib/args.js'); const seed = A.seed(1), list = A.num('list', 20), quick = A.flag('quick');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const val = (n) => { const a = argv.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
const num = (n, d) => { const v = val(n); return v === null ? d : +v; };
const seed = (d) => { const a = argv.find(x => /^\d+$/.test(x)); return a ? +a : d; };
const seeds = (d) => { const a = argv.find(x => /^\d+(,\d+)*$/.test(x)); return a ? a.split(',').map(Number) : d; };
module.exports = { argv, flag, val, num, seed, seeds };
