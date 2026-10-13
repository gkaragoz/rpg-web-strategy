// Prints the top self-time functions of the newest .cpuprofile in .bench/prof (node --cpu-prof --cpu-prof-dir=.bench/prof ...).
import fs from 'node:fs';
const dir = '.bench/prof';
const f = fs.readdirSync(dir).filter((x) => x.endsWith('.cpuprofile')).map((x) => `${dir}/${x}`).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
const p = JSON.parse(fs.readFileSync(f, 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
p.samples.forEach((id, i) => {
  const c = byId.get(id).callFrame;
  const k = `${c.functionName || '(anon)'}:${c.lineNumber}`;
  self.set(k, (self.get(k) ?? 0) + p.timeDeltas[i]);
});
const tot = [...self.values()].reduce((a, b) => a + b, 0);
console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[2] ?? 18)).map(([k, v]) => `${((v / tot) * 100).toFixed(1)}% ${k}`).join('\n'));
