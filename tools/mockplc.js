'use strict';

/**
 * tools/mockplc.js
 *
 * In-memory MEWTOCOL-COM mock PLC (TCP and/or UDP) used to exercise the client
 * until a physical Panasonic FP series PLC is available.
 *
 * It implements exactly the subset of the protocol that lib/mewtocol.js uses,
 * with the same frame layout, BCC rule, address encodings and error responses
 * ('%EE!40' BCC error, '%EE!41' format error, '%EE!42' not supported,
 * '%EE!66' address error, see lib/mewtocol.js for the protocol notes/sources).
 *
 * Areas (deliberately small so tests are fast, real CPUs have larger ranges):
 *   DT 0..999   16 bit data registers
 *   R  0..511   internal relays (flat bit numbering)
 *   X  0..127   external inputs  (flat bit numbering)
 *   Y  0..127   external outputs (flat bit numbering)
 *   SD 0..99    special data registers, served by RD/WD at DT(sdBase + n)
 *
 * CLI:    node tools/mockplc.js --port 5007 --transport tcp|udp|both --station 1 [--verbose]
 * Module: const { startMock } = require('./tools/mockplc');
 *         const mock = startMock({ port: 0, transport: 'tcp', station: 1 });
 *         await mock.ready;
 *         mock.areas.dt[0] = 1234;
 *         ... mock.state.requests / mock.state.responses ...
 *         await mock.close();
 */

const net = require('net');
const dgram = require('dgram');

const { xorBcc, bccString, stationText, wordToHex, hexToWord } = require('../lib/mewtocol');

const CR = '\r';
const DEFAULT_SD_BASE = 90000;

const AREA_LIMITS = { DT: 1000, R: 512, X: 128, Y: 128, SD: 100 };

/** The special data registers are the top of the DT space on FP series CPUs. */
function createAreas() {
  return {
    dt: new Uint16Array(AREA_LIMITS.DT),
    r: new Uint8Array(AREA_LIMITS.R),
    x: new Uint8Array(AREA_LIMITS.X),
    y: new Uint8Array(AREA_LIMITS.Y),
    sd: new Uint16Array(AREA_LIMITS.SD),
  };
}

function frameWithBcc(body) {
  return body + bccString(body) + CR;
}

/** '%EE$<payload>' + BCC + CR */
function okFrame(station, payload) {
  return frameWithBcc('%' + station + '$' + payload);
}

/** '%EE!<errorCode>' + BCC + CR */
function errorFrame(station, errorCode) {
  return frameWithBcc('%' + station + '!' + String(errorCode).toUpperCase());
}

/** Replace the BCC with a deliberately wrong one (client must report BAD_BCC). */
function corruptBcc(frame) {
  const body = frame.slice(0, -3); // strip BCC (2) and CR (1)
  const broken = xorBcc(body) ^ 0x01;
  return body + broken.toString(16).toUpperCase().padStart(2, '0') + CR;
}

/* ------------------------------------------------------------------------- */
/* frame processing                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Process one request frame (CR included) and return the response frame, or
 * null when the frame is not addressed to this station (real PLCs stay silent).
 */
function processRequest(rawWithCr, ctx) {
  const { areas, state, stationStr, sdBase } = ctx;
  state.requests.push(rawWithCr);
  let reply = buildReply(rawWithCr, stationsafe(rawWithCr), ctx);
  if (reply == null) return null;
  if (state.badBcc) reply = corruptBcc(reply);
  state.responses.push(reply);
  return reply;
}

function stationsafe(rawWithCr) {
  const raw = rawWithCr.replace(/\r$/, '');
  const st = raw.slice(1, 3);
  return /^[0-9A-Za-z]{2}$/.test(st) ? st : '01';
}

function buildReply(rawWithCr, fallbackStation, ctx) {
  const { areas, stationStr, sdBase } = ctx;
  const raw = rawWithCr.replace(/\r$/, '');

  if (raw.length < 6) return errorFrame(fallbackStation, '41');
  if (raw[0] !== '%' && raw[0] !== '<') return errorFrame(fallbackStation, '41');

  const st = raw.slice(1, 3);
  // Not addressed to us -> a 1:N PLC does not answer at all.
  if (st.toUpperCase() !== stationStr && st.toUpperCase() !== 'FF') return null;
  // Broadcast ("FF"): no response on the bus.
  if (st.toUpperCase() === 'FF') return null;

  if (raw[3] !== '#') return errorFrame(st, '41');

  const bccText = raw.slice(-2);
  const body = raw.slice(0, -2);
  if (!/^[0-9A-Fa-f]{2}$/.test(bccText)) return errorFrame(st, '41');
  if (xorBcc(body) !== parseInt(bccText, 16)) return errorFrame(st, '40');

  // `body` is everything from the header to the last text character, i.e. the
  // frame without BCC + CR, so the command text starts at body[4].
  const cmd = body.slice(4);
  if (cmd.length < 2) return errorFrame(st, '41');

  /* --------------------------- unit-block commands ------------------- */
  const unit = cmd.slice(0, 3);
  if (unit === 'RCS' || unit === 'WCS') {
    // RCS: "RCS" + area(1) + address(4) = 8 chars
    // WCS: "RCS" + area(1) + address(4) + bit(1) = 9 chars
    const expectedLen = unit === 'RCS' ? 8 : 9;
    if (cmd.length !== expectedLen) return errorFrame(st, '41');
    const area = cmd[3].toUpperCase();
    const addrText = cmd.slice(4, 8);
    if (!/^[0-9]{3}[0-9A-F]$/.test(addrText)) return errorFrame(st, '41');
    const index = parseInt(addrText.slice(0, 3), 10) * 16 + parseInt(addrText.slice(3), 16);
    const bitArea = bitAreaOf(areas, area);
    if (!bitArea) {
      // L / T / C contacts are real MEWTOCOL areas but not modelled by this mock.
      return errorFrame(st, ['L', 'T', 'C'].includes(area) ? '42' : '41');
    }
    if (index >= bitArea.length) return errorFrame(st, '66');
    if (unit === 'RCS') {
      return okFrame(st, 'RC' + (bitArea[index] ? '1' : '0'));
    }
    const dataChar = cmd[8];
    if (dataChar !== '0' && dataChar !== '1') return errorFrame(st, '41');
    bitArea[index] = dataChar === '1' ? 1 : 0;
    return okFrame(st, 'WC');
  }

  if (unit === 'RCC' || unit === 'WCC') {
    if (cmd.length < 11) return errorFrame(st, '41');
    const area = cmd[3].toUpperCase();
    const rest = cmd.slice(4);
    if (!/^[0-9]{4}[0-9]{4}/.test(rest)) return errorFrame(st, '41');
    const startWord = parseInt(rest.slice(0, 4), 10);
    const endWord = parseInt(rest.slice(4, 8), 10);
    if (endWord < startWord) return errorFrame(st, '41');
    const words = endWord - startWord + 1;
    const bitArea = bitAreaOf(areas, area);
    if (!bitArea) return errorFrame(st, ['L', 'T', 'C'].includes(area) ? '42' : '41');
    if ((endWord + 1) * 16 > bitArea.length) return errorFrame(st, '66');
    if (unit === 'WCC') {
      const data = rest.slice(8);
      if (data.length !== words * 4 || !/^[0-9A-Fa-f]+$/.test(data)) return errorFrame(st, '41');
      for (let w = 0; w < words; w++) {
        const value = hexToWord(data.slice(w * 4, w * 4 + 4));
        for (let b = 0; b < 16; b++) bitArea[(startWord + w) * 16 + b] = (value >> b) & 1;
      }
      return okFrame(st, 'WC');
    }
    if (rest.length !== 8) return errorFrame(st, '41');
    let payload = 'RC';
    for (let w = 0; w < words; w++) {
      let value = 0;
      for (let b = 0; b < 16; b++) value |= bitArea[(startWord + w) * 16 + b] << b;
      payload += wordToHex(value);
    }
    return okFrame(st, payload);
  }

  /* --------------------------- data area commands --------------------- */
  const head = cmd.slice(0, 2);
  if (head === 'RD' || head === 'WD') {
    const codeChar = cmd[2] ? cmd[2].toUpperCase() : '';
    const rest = cmd.slice(3);
    if (!/^[0-9]{5}[0-9]{5}/.test(rest)) return errorFrame(st, '41');
    const start = parseInt(rest.slice(0, 5), 10);
    const end = parseInt(rest.slice(5, 10), 10);
    if (end < start) return errorFrame(st, '41');
    const count = end - start + 1;
    const resolved = resolveDataArea(codeChar, start, count, areas, sdBase);
    if (resolved.error) return errorFrame(st, resolved.error);
    if (head === 'RD') {
      if (rest.length !== 10) return errorFrame(st, '41');
      let payload = 'RD';
      for (let i = 0; i < count; i++) payload += wordToHex(resolved.buffer[resolved.offset + i]);
      return okFrame(st, payload);
    }
    const data = rest.slice(10);
    if (data.length !== count * 4 || !/^[0-9A-Fa-f]+$/.test(data)) return errorFrame(st, '41');
    for (let i = 0; i < count; i++) {
      resolved.buffer[resolved.offset + i] = hexToWord(data.slice(i * 4, i * 4 + 4));
    }
    return okFrame(st, 'WD');
  }

  /* --------------------------- PLC status (RT) ------------------------ */
  if (head === 'RT') {
    if (cmd.length !== 2) return errorFrame(st, '41');
    // CPU type(2) version(2) capacity(2) operation status(2 hex)
    // error flag(2 hex) two alignment chars self diagnostic(4 hex, low word first)
    const payload = 'RT' + '20' + '10' + '32' + '01' + '00' + '00' + '0000';
    return okFrame(st, payload);
  }

  /* --------------------------- everything else ------------------------ */
  if (['RS', 'RK', 'RR', 'WR', 'RP', 'WP', 'MC', 'MD', 'MG', 'SC', 'RM', 'EX'].includes(head)) {
    return errorFrame(st, '42'); // not modelled by the mock
  }
  return errorFrame(st, '42');
}

function bitAreaOf(areas, area) {
  switch (area) {
    case 'X':
      return areas.x;
    case 'Y':
      return areas.y;
    case 'R':
      return areas.r;
    default:
      return null;
  }
}

/**
 * Map a RD/WD address to a memory buffer.
 * SD0..SD99 of the mock live at DT(sdBase + n), exactly like the special data
 * registers of a real FP series CPU sit at the top of the DT address space.
 * @returns {{buffer:Uint16Array, offset:number}|{error:string}}
 */
function resolveDataArea(codeChar, start, count, areas, sdBase) {
  if (codeChar !== 'D') {
    // LD / FL / SV / EV / IX / IY are valid MEWTOCOL data codes but not modelled
    return { error: ['L', 'F', 'S', 'K'].includes(codeChar) || codeChar === 'I' ? '42' : '41' };
  }
  const end = start + count - 1;
  if (start >= sdBase) {
    if (end <= sdBase + AREA_LIMITS.SD - 1) return { buffer: areas.sd, offset: start - sdBase };
    return { error: '66' };
  }
  if (end <= AREA_LIMITS.DT - 1) return { buffer: areas.dt, offset: start };
  return { error: '66' };
}

/* ------------------------------------------------------------------------- */
/* server                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * startMock({ port = 5007, transport = 'tcp'|'udp'|'both', station = 1,
 *             sdBase = 90000, host = '0.0.0.0', badBcc = false, verbose = false })
 * @returns {{areas, state, ready:Promise, close:Function, port:number, transport:string, station:number}}
 *
 * The object is returned synchronously; await `ready` before talking to it.
 * `state.badBcc = true` makes the server return responses with a wrong BCC
 * (used by the client BAD_BCC test), `state.requests` / `state.responses` keep
 * every raw frame (CR included) for test assertions.
 */
function startMock(options) {
  const opts = options || {};
  const transport = String(opts.transport || 'tcp').toLowerCase();
  if (!['tcp', 'udp', 'both'].includes(transport)) {
    throw new Error(`startMock(): unsupported transport "${opts.transport}" (tcp|udp|both)`);
  }
  const host = opts.host === undefined ? '0.0.0.0' : String(opts.host);
  const requestedPort = opts.port === undefined ? 5007 : Number(opts.port);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`startMock(): invalid port ${opts.port}`);
  }
  if (transport === 'both' && requestedPort === 0) {
    throw new Error('startMock(): transport "both" needs an explicit port');
  }

  const areas = createAreas();
  const state = {
    badBcc: !!opts.badBcc,
    verbose: !!opts.verbose,
    requests: [],
    responses: [],
  };
  const stationStr = stationText(opts.station === undefined ? 1 : opts.station);
  const sdBase = opts.sdBase === undefined ? DEFAULT_SD_BASE : Number(opts.sdBase);
  const ctx = { areas, state, stationStr, sdBase };

  let tcpServer = null;
  let udpSocket = null;
  let actualPort = requestedPort;
  const tcpClients = new Set();

  function log(line) {
    if (opts.logger && typeof opts.logger === 'function') opts.logger(line);
    else if (state.verbose) console.log(line);
  }

  function handleTcpSocket(sock) {
    tcpClients.add(sock);
    let buffer = '';
    sock.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let idx;
      while ((idx = buffer.indexOf(CR)) !== -1) {
        const raw = buffer.slice(0, idx + 1);
        buffer = buffer.slice(idx + 1);
        const reply = processRequest(raw, ctx);
        log(`tcp <- ${JSON.stringify(raw)}`);
        if (reply != null) {
          log(`tcp -> ${JSON.stringify(reply)}`);
          sock.write(reply);
        }
      }
    });
    sock.on('error', () => {
      tcpClients.delete(sock);
    });
    sock.on('close', () => {
      tcpClients.delete(sock);
    });
  }

  function startTcp() {
    return new Promise((resolve, reject) => {
      const server = net.createServer(handleTcpSocket);
      server.once('error', reject);
      server.listen(requestedPort, host, () => {
        server.removeListener('error', reject);
        server.on('error', (err) => log(`tcp server error: ${err.message}`));
        tcpServer = server;
        if (transport !== 'both') actualPort = server.address().port;
        log(`mockplc: tcp listening on ${host}:${server.address().port} station ${stationStr}`);
        resolve();
      });
    });
  }

  function startUdp() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      const onError = (err) => reject(err);
      sock.once('error', onError);
      sock.bind(requestedPort, host, () => {
        sock.removeListener('error', onError);
        sock.on('error', (err) => log(`udp server error: ${err.message}`));
        sock.on('message', (msg, rinfo) => {
          let text = msg.toString('latin1');
          let idx;
          while ((idx = text.indexOf(CR)) !== -1) {
            const raw = text.slice(0, idx + 1);
            text = text.slice(idx + 1);
            const reply = processRequest(raw, ctx);
            log(`udp <- ${JSON.stringify(raw)}`);
            if (reply != null) {
              log(`udp -> ${JSON.stringify(reply)}`);
              sock.send(Buffer.from(reply, 'latin1'), rinfo.port, rinfo.address);
            }
          }
        });
        udpSocket = sock;
        if (transport !== 'both') actualPort = sock.address().port;
        log(`mockplc: udp listening on ${host}:${sock.address().port} station ${stationStr}`);
        resolve();
      });
    });
  }

  const servers = [];
  if (transport === 'tcp') servers.push(startTcp());
  else if (transport === 'udp') servers.push(startUdp());
  else servers.push(startTcp().then(startUdp));

  let closed = false;
  const ready = Promise.all(servers).catch((err) => {
    // surface startup failures through ready, and make sure nothing leaks
    close().catch(() => undefined);
    throw err;
  });

  let closePromise = null;
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      for (const sock of tcpClients) {
        try {
          sock.destroy();
        } catch (e) {
          /* ignore */
        }
      }
      tcpClients.clear();
      if (tcpServer) {
        await new Promise((resolve) => tcpServer.close(() => resolve()));
        tcpServer = null;
      }
      if (udpSocket) {
        await new Promise((resolve) => {
          try {
            udpSocket.close(() => resolve());
          } catch (e) {
            resolve();
          }
        });
        udpSocket = null;
      }
    })();
    return closePromise;
  }

  const mock = {
    areas,
    state,
    ready,
    close,
    host,
    transport,
    station: Number(stationStr),
    sdBase,
    get port() {
      return actualPort;
    },
    get isListening() {
      return !closed && ((tcpServer && tcpServer.listening) || (udpSocket && true));
    },
  };
  return mock;
}

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--transport') opts.transport = argv[++i];
    else if (arg === '--station') opts.station = Number(argv[++i]);
    else if (arg === '--host') opts.host = argv[++i];
    else if (arg === '--sd-base') opts.sdBase = Number(argv[++i]);
    else if (arg === '--verbose' || arg === '-v') opts.verbose = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

if (require.main === module) {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`mockplc: ${err.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log('usage: node tools/mockplc.js --port 5007 --transport tcp|udp|both --station 1 [--host 0.0.0.0] [--sd-base 90000] [--verbose]');
    process.exit(0);
  }
  const mock = startMock(opts);
  mock.ready
    .then(() => {
      console.log(
        `mockplc ready: transport=${mock.transport} port=${mock.port} station=${mock.station} ` +
          `areas DT0-999 R0-511 X0-127 Y0-127 SD0-99 (SD mapped to DT${mock.sdBase}+n)`
      );
      console.log('mockplc: Ctrl+C to stop');
    })
    .catch((err) => {
      console.error(`mockplc: failed to start: ${err.message}`);
      process.exit(1);
    });

  const shutdown = () => {
    console.log('\nmockplc: shutting down');
    mock
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  startMock,
  createAreas,
  processRequest,
  AREA_LIMITS,
  DEFAULT_SD_BASE,
  errorFrame,
  okFrame,
};
