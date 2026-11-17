// Scan a /24 for PLC-ish TCP ports (MEWTOCOL 5007, Modbus-TCP 502).
// Usage: node scan.js <basePrefix e.g. 192.168.0> [ports=5007,502] [timeoutMs=250]
const net = require('net');

const prefix = process.argv[2] || '192.168.0';
const ports = (process.argv[3] || '5007,502').split(',').map(Number);
const timeout = Number(process.argv[4] || 250);
const concurrency = 64;

const hosts = [];
for (let i = 1; i <= 254; i++) hosts.push(`${prefix}.${i}`);

function probe(host, port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok, extra) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok ? { host, port, extra } : null);
    };
    s.setTimeout(timeout);
    s.once('connect', () => finish(true, 'open'));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

(async () => {
  const jobs = [];
  for (const h of hosts) for (const p of ports) jobs.push([h, p]);
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < jobs.length) {
      const [h, p] = jobs[idx++];
      const r = await probe(h, p);
      if (r) results.push(r);
    }
  });
  const t0 = Date.now();
  await Promise.all(workers);
  console.log(`scanned ${jobs.length} probes in ${Date.now() - t0} ms`);
  if (!results.length) console.log('no open ports');
  for (const r of results) console.log(`OPEN ${r.host}:${r.port}`);
})();
