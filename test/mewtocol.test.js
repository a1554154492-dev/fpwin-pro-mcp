'use strict';

/**
 * test/mewtocol.test.js
 *
 * Automated tests for lib/mewtocol.js (MEWTOCOL-COM client) against
 * tools/mockplc.js (in-memory mock PLC). No third-party dependencies.
 *
 * Run:  node test/mewtocol.test.js
 * Exit: 0 = all tests passed, 1 = at least one failure.
 *
 * The suite exercises TCP and UDP, normal reads, write-then-readback, multi
 * frame splitting, out of range addresses, BCC errors in both directions,
 * timeouts, the raw request() escape hatch and a spawned CLI mock server.
 * Every socket / server is closed at the end so the process exits by itself.
 */

const assert = require('assert');
const net = require('net');
const { spawn } = require('child_process');

const {
  createClient,
  buildFrame,
  bccString,
  xorBcc,
  wordToHex,
  bitAddressText,
  parseBitAddress,
} = require('../lib/mewtocol');
const { startMock } = require('../tools/mockplc');

const results = [];
const cleanup = [];

function out(line) {
  process.stdout.write(line + '\n');
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function rdFrame(station, start, end) {
  return buildFrame(station, 'RD', 'D' + pad(start, 5) + pad(end, 5));
}

function wdFrame(station, start, values) {
  const end = start + values.length - 1;
  let payload = 'D' + pad(start, 5) + pad(end, 5);
  for (const v of values) payload += wordToHex(v);
  return buildFrame(station, 'WD', payload);
}

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    out(`PASS  ${name}  (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    out(`FAIL  ${name}  (${Date.now() - t0} ms)`);
    const text = err && err.stack ? err.stack : String(err);
    out(
      text
        .split('\n')
        .slice(0, 8)
        .map((l) => '      ' + l)
        .join('\n')
    );
  }
}

/** Await a call that must fail and return the thrown error. */
async function expectError(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to fail, but it succeeded');
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------------- */

async function main() {
  out('========================================================================');
  out(' MEWTOCOL-COM client tests (mock PLC, no physical device)');
  out('========================================================================');

  /* --------------------------------------------------------------------- */
  await test('01 frame format / BCC / number encodings (protocol constants)', async () => {
    // Official BCC test vector from the MewtocolNet reference implementation:
    // "%01#RCSX0000" -> BCC "1D".
    assert.strictEqual(bccString('%01#RCSX0000'), '1D');
    assert.strictEqual(buildFrame(1, 'RCS', 'X0000'), '%01#RCSX0000' + '1D' + '\r');

    // Independent hand calculation: "%01#RDD0000000001" -> BCC "54".
    assert.strictEqual(buildFrame(1, 'RD', 'D0000000001'), '%01#RDD000000000154\r');
    assert.strictEqual(xorBcc('%'), 0x25);

    // BCC of a real response frame quoted by the Panasonic FPΣ manual
    // (DT0 = 100, DT1 = 200 -> "%01$RD6400C8006F").
    assert.strictEqual(bccString('%01$RD6400C800'), '6F');

    // Word data is transferred low byte first.
    assert.strictEqual(wordToHex(100), '6400');
    assert.strictEqual(wordToHex(200), 'C800');
    assert.strictEqual(wordToHex(0x1234), '3412');
    assert.strictEqual(wordToHex(0xffff), 'FFFF');

    // Contact addresses: 4 chars, decimal word number + 1 hex bit digit.
    assert.strictEqual(bitAddressText(0), '0000');
    assert.strictEqual(bitAddressText(31), '001F');
    assert.strictEqual(bitAddressText(16), '0010');
    assert.deepStrictEqual(parseBitAddress('X1F'), { area: 'X', index: 31 });
    assert.deepStrictEqual(parseBitAddress('R10'), { area: 'R', index: 16 });
    assert.deepStrictEqual(parseBitAddress(31), { area: null, index: 31 });

    // Station numbers are 2 DECIMAL ascii digits.
    assert.strictEqual(buildFrame(1, 'RT', '').slice(0, 4), '%01#');
    assert.strictEqual(buildFrame(32, 'RT', '').slice(0, 4), '%32#');
    assert.strictEqual(buildFrame(255, 'RT', '').slice(0, 4), '%FF#');
  });

  /* --------------------------------------------------------------------- */
  // Shared TCP mock + client for the next tests.
  const tcpMock = startMock({ port: 0, host: '127.0.0.1', transport: 'tcp', station: 1 });
  cleanup.push(() => tcpMock.close());
  await tcpMock.ready;
  const tcp = createClient({ host: '127.0.0.1', port: tcpMock.port, station: 1, transport: 'tcp', timeoutMs: 1000 });
  cleanup.push(() => tcp.close());
  await tcp.open();

  await test('02 TCP readDT: seeded words, exact request/response frames', async () => {
    tcpMock.areas.dt[10] = 0x1234;
    tcpMock.areas.dt[11] = 0xff00;
    tcpMock.areas.dt[12] = 0x0001;
    const reqBefore = tcpMock.state.requests.length;
    const resBefore = tcpMock.state.responses.length;
    const values = await tcp.readDT(10, 3);
    assert.deepStrictEqual(values, [0x1234, 0xff00, 0x0001]);
    const requests = tcpMock.state.requests.slice(reqBefore);
    assert.deepStrictEqual(requests, [rdFrame(1, 10, 12)]);
    assert.strictEqual(requests[0], '%01#RDD0001000012' + bccString('%01#RDD0001000012') + '\r');
    const responses = tcpMock.state.responses.slice(resBefore);
    // low byte first: 0x1234 -> "3412", 0xFF00 -> "00FF", 0x0001 -> "0100"
    assert.strictEqual(responses[0], '%01$RD341200FF0100' + bccString('%01$RD341200FF0100') + '\r');
  });

  await test('03 TCP readDT matches the Panasonic FPΣ manual example frame', async () => {
    // Manual: DT0 = 100, DT1 = 200 -> "%01#RDD00000 00001" / "%01$RD6400C8006F"
    tcpMock.areas.dt[0] = 100;
    tcpMock.areas.dt[1] = 200;
    const resBefore = tcpMock.state.responses.length;
    const values = await tcp.readDT(0, 2);
    assert.deepStrictEqual(values, [100, 200]);
    assert.strictEqual(tcpMock.state.responses[resBefore], '%01$RD6400C8006F\r');
  });

  await test('04 TCP writeDT then read back (values stored at the right address)', async () => {
    const reqBefore = tcpMock.state.requests.length;
    const result = await tcp.writeDT(100, [1, 2, 0x1234, 0xffff]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.responseCode, 'WD');
    assert.strictEqual(result.frames, 1);
    assert.deepStrictEqual(Array.from(tcpMock.areas.dt.slice(100, 104)), [1, 2, 0x1234, 0xffff]);
    assert.deepStrictEqual(tcpMock.state.requests.slice(reqBefore), [wdFrame(1, 100, [1, 2, 0x1234, 0xffff])]);
    assert.deepStrictEqual(await tcp.readDT(100, 4), [1, 2, 0x1234, 0xffff]);
  });

  await test('05 TCP readDT splits counts > 27 words into several frames', async () => {
    for (let i = 0; i < 60; i++) tcpMock.areas.dt[i] = (i * 3) & 0xffff;
    const expected = [];
    for (let i = 0; i < 60; i++) expected.push((i * 3) & 0xffff);
    const reqBefore = tcpMock.state.requests.length;
    const values = await tcp.readDT(0, 60);
    assert.deepStrictEqual(values, expected);
    const requests = tcpMock.state.requests.slice(reqBefore);
    assert.strictEqual(requests.length, 3);
    assert.deepStrictEqual(requests, [rdFrame(1, 0, 26), rdFrame(1, 27, 53), rdFrame(1, 54, 59)]);
  });

  await test('06 TCP writeDT splits counts > 24 words into several frames', async () => {
    const values = [];
    for (let i = 0; i < 50; i++) values.push((i * 7 + 1) & 0xffff);
    const reqBefore = tcpMock.state.requests.length;
    const result = await tcp.writeDT(0, values);
    assert.strictEqual(result.frames, 3);
    assert.strictEqual(result.words, 50);
    const requests = tcpMock.state.requests.slice(reqBefore);
    assert.strictEqual(requests.length, 3);
    assert.deepStrictEqual(requests, [
      wdFrame(1, 0, values.slice(0, 24)),
      wdFrame(1, 24, values.slice(24, 48)),
      wdFrame(1, 48, values.slice(48)),
    ]);
    assert.deepStrictEqual(Array.from(tcpMock.areas.dt.slice(0, 50)), values);
    assert.deepStrictEqual(await tcp.readDT(0, 50), values);
  });

  await test('07 TCP internal relays R: write / read, flat and PLC notation', async () => {
    const before = tcpMock.state.requests.length;
    const result = await tcp.writeR(0, [1, 0, 1, 1]);
    assert.strictEqual(result.frames, 4);
    assert.deepStrictEqual(Array.from(tcpMock.areas.r.slice(0, 4)), [1, 0, 1, 1]);
    assert.deepStrictEqual(await tcp.readR(0, 4), [1, 0, 1, 1]);
    const requests = tcpMock.state.requests.slice(before);
    // RCS/WCS use the 4 character mixed address: R0 -> "0000", R3 -> "0003"
    assert.deepStrictEqual(requests.slice(0, 4), [
      buildFrame(1, 'WCS', 'R00001'),
      buildFrame(1, 'WCS', 'R00010'),
      buildFrame(1, 'WCS', 'R00021'),
      buildFrame(1, 'WCS', 'R00031'),
    ]);
    // PLC notation "R10" is word 1, bit 0 -> flat index 16.
    await tcp.writeR('R10', [1]);
    assert.strictEqual(tcpMock.areas.r[16], 1);
    assert.deepStrictEqual(await tcp.readR('R10', 2), [1, 0]);
  });

  await test('08 TCP X/Y contact areas', async () => {
    tcpMock.areas.x[0] = 1;
    tcpMock.areas.x[1] = 0;
    // numeric address -> X area by default
    assert.deepStrictEqual(await tcp.readXY(0, 2), [1, 0]);
    const res = await tcp.writeXY('Y', 10, [1, 1, 0]);
    assert.strictEqual(res.frames, 3);
    assert.deepStrictEqual(Array.from(tcpMock.areas.y.slice(10, 13)), [1, 1, 0]);
    // flat numeric address with the area as third argument
    assert.deepStrictEqual(await tcp.readXY(10, 3, 'Y'), [1, 1, 0]);
    tcpMock.areas.y[20] = 1;
    assert.deepStrictEqual(await tcp.readXY(20, 1, 'Y'), [1]);
    // PLC notation "Y10" is word 1, bit 0 -> flat index 16 (NOT decimal 10),
    // exactly like the 4 character address encoding used in the frames.
    await tcp.writeXY('Y10', [1]);
    assert.strictEqual(tcpMock.areas.y[16], 1);
    assert.deepStrictEqual(await tcp.readXY('Y10', 1), [1]);
    // explicit area prefix on a single point
    assert.deepStrictEqual(await tcp.readXY('X0', 1), [1]);
  });

  await test('09 TCP SD (special data registers) via DT90000+n', async () => {
    tcpMock.areas.sd[0] = 0x2d00;
    tcpMock.areas.sd[1] = 0x0045;
    const reqBefore = tcpMock.state.requests.length;
    assert.deepStrictEqual(await tcp.readSD(0, 2), [0x2d00, 0x0045]);
    assert.deepStrictEqual(tcpMock.state.requests.slice(reqBefore), [rdFrame(1, 90000, 90001)]);
    const result = await tcp.writeSD(5, [0x1234, 0xabcd]);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(Array.from(tcpMock.areas.sd.slice(5, 7)), [0x1234, 0xabcd]);
    assert.deepStrictEqual(await tcp.readSD(5, 2), [0x1234, 0xabcd]);
  });

  await test('10 TCP RT status via request()/readStatus()', async () => {
    const raw = await tcp.request('RT');
    assert.strictEqual(raw.responseCode, 'RT');
    assert.strictEqual(raw.data.length, 16);
    assert.strictEqual(raw.data.slice(0, 2), '20');
    const status = await tcp.readStatus();
    assert.strictEqual(status.cpuType, '20');
    assert.strictEqual(status.runMode, true);
    assert.strictEqual(status.errorFlag, 0);
    assert.strictEqual(status.selfDiagnosticErrorCode, 0);
  });

  await test('11 TCP raw RCC (word unit contact read) through request()', async () => {
    tcpMock.areas.x[0] = 1;
    const res = await tcp.request('RCC', 'X00000001');
    assert.strictEqual(res.responseCode, 'RC');
    // word 0 = X0..X15, only X0 on -> 0x0001 -> low byte first "0100"
    assert.strictEqual(res.data.slice(0, 4), '0100');
    assert.strictEqual(res.data.length, 8);
  });

  await test('12 TCP out of range address -> PLC_ERROR with code 66', async () => {
    const errDt = await expectError(() => tcp.readDT(5000, 2));
    assert.strictEqual(errDt.code, 'PLC_ERROR');
    assert.strictEqual(errDt.responseCode, '66');
    assert.ok(errDt.raw.includes('!66'), `raw frame should carry !66: ${errDt.raw}`);
    const errR = await expectError(() => tcp.readR(600, 1));
    assert.strictEqual(errR.code, 'PLC_ERROR');
    assert.strictEqual(errR.responseCode, '66');
    const errX = await expectError(() => tcp.readXY('X', 128, 1));
    assert.strictEqual(errX.code, 'PLC_ERROR');
    assert.strictEqual(errX.responseCode, '66');
    const errSd = await expectError(() => tcp.readSD(99, 2));
    assert.strictEqual(errSd.code, 'PLC_ERROR');
    assert.strictEqual(errSd.responseCode, '66');
  });

  await test('13 mock rejects a request with a wrong BCC (error 40)', async () => {
    const response = await new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: tcpMock.port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('no response for the corrupted BCC request'));
      }, 2000);
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sock.once('connect', () => {
        // correct BCC for this body is "55", send "00" instead
        sock.write('%01#RDD0000000000' + '00' + '\r');
      });
      sock.once('data', (chunk) => {
        clearTimeout(timer);
        const text = chunk.toString('latin1');
        sock.destroy();
        resolve(text);
      });
    });
    assert.strictEqual(response, '%01!40' + bccString('%01!40') + '\r');
  });

  await test('14 client reports BAD_BCC when the PLC response BCC is corrupt', async () => {
    tcpMock.state.badBcc = true;
    try {
      const err = await expectError(() => tcp.readDT(0, 1));
      assert.strictEqual(err.code, 'BAD_BCC');
      assert.ok(err.raw.startsWith('%01$RD'), `raw=${err.raw}`);
      assert.ok(err.receivedBcc && err.expectedBcc, 'error should carry both BCC values');
      assert.notStrictEqual(err.receivedBcc, err.expectedBcc);
    } finally {
      tcpMock.state.badBcc = false;
    }
    // the connection must still work afterwards
    tcpMock.areas.dt[0] = 42;
    assert.deepStrictEqual(await tcp.readDT(0, 1), [42]);
  });

  await test('15 client reports TIMEOUT for a closed TCP port', async () => {
    const port = await freeTcpPort();
    const client = createClient({ host: '127.0.0.1', port, transport: 'tcp', timeoutMs: 400 });
    try {
      const err = await expectError(() => client.open());
      assert.strictEqual(err.code, 'TIMEOUT');
      assert.ok(/ECONNREFUSED|timed out|transport failure/i.test(err.message) || err.cause, err.message);
    } finally {
      await client.close();
    }
  });

  await test('16 client reports TIMEOUT for a UDP request nobody answers', async () => {
    const port = await freeTcpPort(); // free port, nothing listening on UDP either
    const client = createClient({ host: '127.0.0.1', port, transport: 'udp', timeoutMs: 400 });
    try {
      await client.open();
      const err = await expectError(() => client.readDT(0, 1));
      assert.strictEqual(err.code, 'TIMEOUT');
    } finally {
      await client.close();
    }
  });

  await test('17 TCP argument validation (no frame is sent on bad input)', async () => {
    const before = tcpMock.state.requests.length;
    const e1 = await expectError(() => tcp.readDT(-1, 1));
    assert.strictEqual(e1.code, 'BAD_ARGUMENT');
    const e2 = await expectError(() => tcp.readDT(0, 0));
    assert.strictEqual(e2.code, 'BAD_ARGUMENT');
    const e3 = await expectError(() => tcp.writeDT(0, [0x10000]));
    assert.strictEqual(e3.code, 'BAD_ARGUMENT');
    const e4 = await expectError(() => tcp.readXY('Q1', 1));
    assert.strictEqual(e4.code, 'BAD_ARGUMENT');
    const e5 = await expectError(() => tcp.request(''));
    assert.strictEqual(e5.code, 'BAD_ARGUMENT');
    assert.throws(() => createClient({ host: '127.0.0.1', station: 1234 }), /invalid station/);
    assert.strictEqual(tcpMock.state.requests.length, before);
  });

  await test('18 TCP not-supported command -> PLC_ERROR 42', async () => {
    const err = await expectError(() => tcp.request('ZZ', ''));
    assert.strictEqual(err.code, 'PLC_ERROR');
    assert.strictEqual(err.responseCode, '42');
  });

  await test('19 TCP close() is idempotent and requests afterwards fail with NOT_OPEN', async () => {
    const client = createClient({ host: '127.0.0.1', port: tcpMock.port, transport: 'tcp', timeoutMs: 500 });
    await client.open();
    await client.close();
    await client.close(); // must not throw
    assert.strictEqual(client.isOpen, false);
    const err = await expectError(() => client.readDT(0, 1));
    assert.strictEqual(err.code, 'NOT_OPEN');
  });

  /* ------------------------------- UDP round ---------------------------- */
  await test('20 UDP: full round trip against the mock', async () => {
    const udpMock = startMock({ port: 0, host: '127.0.0.1', transport: 'udp', station: 1 });
    cleanup.push(() => udpMock.close());
    await udpMock.ready;
    const udp = createClient({
      host: '127.0.0.1',
      port: udpMock.port,
      station: 1,
      transport: 'udp',
      timeoutMs: 1000,
    });
    cleanup.push(() => udp.close());
    try {
      await udp.open();
      const w = await udp.writeDT(20, [5, 6, 7]);
      assert.strictEqual(w.ok, true);
      assert.deepStrictEqual(Array.from(udpMock.areas.dt.slice(20, 23)), [5, 6, 7]);
      assert.deepStrictEqual(await udp.readDT(20, 3), [5, 6, 7]);

      await udp.writeXY('Y', 5, [1, 0, 1]);
      assert.deepStrictEqual(Array.from(udpMock.areas.y.slice(5, 8)), [1, 0, 1]);
      assert.deepStrictEqual(await udp.readXY('Y5', 3), [1, 0, 1]);

      // multi frame read over UDP as well
      for (let i = 0; i < 30; i++) udpMock.areas.dt[i] = i;
      const many = await udp.readDT(0, 30);
      assert.strictEqual(many.length, 30);
      assert.deepStrictEqual(many.slice(0, 3), [0, 1, 2]);
      assert.deepStrictEqual(many.slice(28), [28, 29]);
    } finally {
      await udp.close();
      await udpMock.close();
    }
  });

  /* ------------------------------- CLI ---------------------------------- */
  await test('21 tools/mockplc.js CLI starts a TCP server that answers', async () => {
    const port = await freeTcpPort();
    let child = null;
    let childErr = null;
    try {
      child = spawn(
        process.execPath,
        [require('path').join(__dirname, '..', 'tools', 'mockplc.js'), '--port', String(port), '--transport', 'tcp', '--station', '1'],
        { stdio: 'ignore', windowsHide: true }
      );
      child.once('error', (err) => {
        childErr = err;
      });
      child.once('exit', (code) => {
        if (!childErr) childErr = new Error(`mockplc CLI exited with code ${code}`);
      });
    } catch (err) {
      out(`SKIP  21 CLI test (spawn not permitted here: ${err.message})`);
      return;
    }
    let lastErr = null;
    try {
      let connected = false;
      for (let i = 0; i < 40 && !connected; i++) {
        if (childErr) throw childErr;
        const client = createClient({ host: '127.0.0.1', port, transport: 'tcp', station: 1, timeoutMs: 300 });
        try {
          await client.open();
          const res = await client.readDT(0, 1);
          assert.strictEqual(res.length, 1);
          await client.close();
          connected = true;
        } catch (err) {
          lastErr = err;
          await client.close();
          await delay(100);
        }
      }
      if (!connected) throw lastErr || new Error('could not talk to the mockplc CLI');
    } finally {
      if (child && child.exitCode === null) child.kill();
      if (child) await delay(100);
    }
  });

  /* ------------------------------- teardown ----------------------------- */
  out('');
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch (err) {
      out(`cleanup warning: ${err && err.message ? err.message : err}`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const totalMs = Date.now() - startedAt;
  out('========================================================================');
  out(`Tests: ${passed} passed, ${failed} failed, ${results.length} total`);
  out(`Time : ${totalMs} ms`);
  out('========================================================================');
  if (failed > 0) {
    out('Failed tests:');
    for (const r of results) if (!r.ok) out(`  - ${r.name}`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

const startedAt = Date.now();
// Watchdog: if a socket leaks and the suite hangs, fail loudly instead of hanging forever.
const watchdog = setTimeout(() => {
  out('FAIL: test suite watchdog timeout (a socket or server was left open)');
  process.exit(3);
}, 60000);
watchdog.unref();

main().catch((err) => {
  out('FAIL: test runner crashed');
  out(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
