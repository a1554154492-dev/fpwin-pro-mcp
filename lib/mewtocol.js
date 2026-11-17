'use strict';

/**
 * lib/mewtocol.js
 *
 * MEWTOCOL-COM client for Panasonic FP series PLCs (FP0 / FP0R / FPe / FPZ / FPΣ /
 * FP-X / FP2 / FP2SH / FP3 / FP5 ...), zero third-party dependencies.
 *
 * Implemented strictly against the real ASCII frame format, so the same code can
 * talk to a physical PLC (Ethernet/SCU units listen on TCP 5007 by default;
 * serial links are out of scope for this module).
 *
 * ===========================================================================
 * PROTOCOL FACTS (verified, with sources)
 * ===========================================================================
 *
 * Frame layout (MEWTOCOL-COM):
 *
 *   Request : '%' + EE + '#' + command + data             + BCC + CR
 *   Response: '%' + EE + '$' + command + response data    + BCC + CR   (normal)
 *             '%' + EE + '!' + error code (2 hex digits)  + BCC + CR   (error)
 *
 *   EE  = destination/source station number, 2 DECIMAL ascii digits
 *         ("01".."99"; "EE"/"FF" are special). NOT hexadecimal.
 *   BCC = one byte, XOR of every ascii character from the header '%' through the
 *         last character of the text (the '#'/'$'/'!' and the command code are
 *         included), written as 2 UPPERCASE hex digits. CR (0x0D) is NOT included.
 *         If the host sends "**" instead of a BCC the PLC skips the check
 *         (we always send a real BCC and always validate the response BCC).
 *   CR  = frame terminator (0x0D). Max frame length: 118 chars with '%' header
 *         (2048 chars only with the '<' header, available on high-level link
 *         units only; this client always uses the classic '%' header).
 *
 * Number systems (from the official protocol manual, "Number systems used in
 * MEWTOCOL-COM messages"):
 *   - Register/response DATA is hexadecimal.
 *   - Register ADDRESSES are decimal.
 *   - Relay bit addresses (X/Y/R/L) are a mix: decimal word number + one
 *     hexadecimal digit for the bit, 4 characters total, zero padded
 *     ("X1F" -> "001F", "R10" -> "0010").
 *   - Words are transferred LOW BYTE FIRST ("the programmable controller stores
 *     words in low-byte, high-byte order. Thus, data sent to the programmable
 *     controller must be in that order"). So DT0 = 100 (0x0064) travels as the
 *     ascii text "6400"; DT1 = 200 (0x00C8) travels as "C800".
 *
 * Command codes used by this module:
 *   RD  read data area        : '#RD' + area code (D/L/F) + start(5 dec) + end(5 dec)
 *                               response '$RD' + 4 hex chars/word (low byte first)
 *   WD  write data area       : '#WD' + area code + start(5 dec) + end(5 dec) + data
 *                               response '$WD' (no payload expected)
 *   RCS read contact, 1 point : '#RCS' + area (X/Y/R/L/T/C) + address(4 mixed)
 *                               response '$RC' + 1 ascii bit ('0'/'1')
 *   WCS write contact, 1 point: '#WCS' + area + address(4 mixed) + '0'/'1'
 *                               response '$WC' (no payload expected)
 *   RCC read contact, word    : '#RCC' + area + start word(4 dec) + end word(4 dec)
 *                               response '$RC' + 4 hex chars/word (low byte first)
 *   WCC write contact, word   : '#WCC' + area + start word(4) + end word(4) + data
 *                               response '$WC'
 *   RT  read PLC status       : '#RT' -> CPU type(2), version(2), program
 *                               capacity(2), operation status(2 hex),
 *                               error flag(2 hex), self diagnostic(4 hex, low word first)
 *   RS / RK                   : timer/counter set value / elapsed value (not used here)
 *
 * IMPORTANT: "start" and "end" are INCLUSIVE; the protocol has no "count" field.
 *   - RD/WD  : start + end, 5 decimal digits each. A 118 char frame carries at
 *              most 27 words for read (118 - 9 header/footer = 109 -> 27*4) and
 *              24 words for write (118 - 20 = 98 -> 24*4). Larger counts must be
 *              split into several consecutive request/response frames; this
 *              module does that automatically.
 *   - RCC/WCC: start + end, 4 decimal digits each (word numbers).
 *   - RCS/WCS: a single 4 character contact address.
 *
 * Special data registers (SD):
 *   MEWTOCOL-COM has no separate "SD" command. On FP series PLCs (everything but
 *   FP7) the system/special data registers live at the top of the DT space:
 *   SD0 == DT90000 on FP-X/FP2/FPΣ class CPUs and DT9000 on some older FP0-class
 *   mappings. `sdBase` (default 90000) selects the base; verify it on the real
 *   CPU before trusting readSD(). FP7 uses "system data" and speaks
 *   MEWTOCOL7/COM7 with a different frame (see below), so it is not covered.
 *
 * Sources checked while writing this file:
 *   [1] Panasonic "MEWTOCOL Protocol" (ACGM0125V10END), MEWTOCOL-COM chapter
 *       (frame layout, 118/2048 char limit, number systems, low-byte-first
 *       word order, RD/WD/RC/WC/RT command descriptions):
 *       https://autopack.com/Service/PLC/PLC_soft/Software/FPWIN%20Pro5/Manuals_and_Catalogues/English/Manuals/MEWTOCOL_ACGM0125V10END.pdf
 *   [2] Panasonic "MEWTOCOL Communication User's Manual" (WUME-MEWCP-03):
 *       https://mediap.industry.panasonic.eu/assets/custom-upload/Factory%20&%20Automation/PLC/Manuals/mn_all_plcs_mewtocol_user_pidsx_en.pdf
 *   [3] Panasonic FPΣ User's Manual, MEWTOCOL example frames (page 229):
 *       request "%01#RDD00000 00001**" and response "%01$RD6400C8006F"
 *       (DT0=100, DT1=200 - proves the low-byte-first word order and the BCC):
 *       https://manualslib.com/manual/2154409/Panasonic-Fps-Series.html?page=229
 *   [4] MewtocolNet (C# reference implementation; BCC test vector
 *       "%01#RCSX0000" -> BCC "1D", RDD/WDD/RCC/WCS frame builders, RT layout):
 *       https://github.com/OpenLogics/MewtocolNet
 *   [5] jsmewtocol (Node reference implementation; command / address layout):
 *       https://github.com/oleg31337/node-mewtocol
 *
 * MEWTOCOL7 (FP7 only): FP7 also speaks "MEWTOCOL-COM7", which uses a '>@'
 * header, a 2-byte CRC-16/MCRF4XX instead of the 1-byte XOR BCC, and a
 * different address/length layout. It is NOT implemented here. Classic
 * MEWTOCOL-COM (the mode FPWIN Pro calls "MEWTOCOL-COM", system register
 * wCommunicationMode = 16#0) is the default implementation of this module.
 * ===========================================================================
 */

const net = require('net');
const dgram = require('dgram');

const HEADER = '%';
const CR = '\r';
const CR_CODE = 0x0d;

/** Max chars of one '%'-header frame, header and CR included. */
const MAX_FRAME_CHARS = 118;
/** response frame = '%EE$RD' (6) + 4*n data + BCC (2) + CR (1) = 9 + 4n <= 118 */
const MAX_READ_WORDS_PER_FRAME = Math.floor((MAX_FRAME_CHARS - 9) / 4); // 27
/** request frame = '%EE#WD' (5) + area(1) + 5 + 5 + 4n + BCC (2) + CR (1) = 20 + 4n <= 118 */
const MAX_WRITE_WORDS_PER_FRAME = Math.floor((MAX_FRAME_CHARS - 20) / 4); // 24

const DEFAULT_PORT = 5007;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_SD_BASE = 90000;

/**
 * PLC error codes returned in a '%EE!xx' response.
 * 40/41/66/67/72/73 appear in the official manual (chapter "Error codes");
 * the rest of the table is the widely used MEWNET/MEWTOCOL error list from
 * reference implementation [5]. Unknown codes are still reported verbatim.
 */
// Keys are the NUMERIC values of the hex codes, i.e. table entry "40" (hex) is key 0x40.
const ERROR_CODE_TEXT = {
  0x21: 'NACK error',
  0x40: 'BCC error (block check code mismatch)',
  0x41: 'Format error (frame does not match the protocol)',
  0x42: 'Not-support error (command not supported)',
  0x43: 'Procedure error',
  0x60: 'Parameter error',
  0x61: 'Data error',
  0x63: 'Mode error',
  0x65: 'Protect error',
  0x66: 'Address error (address out of range / bad address format)',
  0x67: 'No data error',
  0x72: 'Time-out error (waiting for a response)',
  0x73: 'Time-out error (waiting for the send buffer)',
};

/** Error thrown by every failing operation. Always has a `code`. */
class MewtocolError extends Error {
  constructor(code, message, info) {
    super(message);
    this.name = 'MewtocolError';
    this.code = code;
    if (info && typeof info === 'object') Object.assign(this, info);
  }
}

/* ------------------------------------------------------------------------- */
/* low level frame helpers (also exported for the mock server and the tests)  */
/* ------------------------------------------------------------------------- */

/** XOR of every character (byte) of `text`, as an 8 bit integer. */
function xorBcc(text) {
  let bcc = 0;
  for (let i = 0; i < text.length; i++) bcc ^= text.charCodeAt(i) & 0xff;
  return bcc & 0xff;
}

/** XOR BCC of `text` as 2 uppercase hex digits. */
function bccString(text) {
  return xorBcc(text).toString(16).toUpperCase().padStart(2, '0');
}

function padNumber(n, width) {
  return String(n).padStart(width, '0');
}

/** 2 ascii decimal digits; 238 -> "EE", 255 -> "FF". */
function stationText(station) {
  if (station === 238 || station === 'EE') return 'EE';
  if (station === 255 || station === 'FF') return 'FF';
  const n = Number(station);
  if (!Number.isInteger(n) || n < 0 || n > 99) {
    throw new MewtocolError('BAD_ARGUMENT', `invalid station number: ${station} (expect 0..99, 238=EE, 255=FF)`);
  }
  return padNumber(n, 2);
}

/** Build a complete request frame (string, terminated with CR). */
function buildFrame(station, command, data) {
  const body = HEADER + stationText(station) + '#' + String(command) + (data == null ? '' : String(data));
  return body + bccString(body) + CR;
}

/** Low-byte-first 4 hex chars of a 16 bit word (protocol data order). */
function wordToHex(value) {
  const v = Number(value);
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
    throw new MewtocolError('BAD_ARGUMENT', `word value out of range 0..65535: ${value}`);
  }
  return ((v & 0xff).toString(16).padStart(2, '0') + ((v >> 8) & 0xff).toString(16).padStart(2, '0')).toUpperCase();
}

/** Parse 4 hex chars (low byte first) into a 16 bit word. */
function hexToWord(chars) {
  if (!/^[0-9A-Fa-f]{4}$/.test(chars)) {
    throw new MewtocolError('PROTOCOL_ERROR', `bad word data from PLC: "${chars}"`);
  }
  return parseInt(chars.slice(2, 4) + chars.slice(0, 2), 16);
}

/**
 * Resolve an X/Y/R/L contact address.
 *   - number -> flat bit index (X0=0, X1=1, ... X15=15, X16=16 ...); area = defaultArea
 *   - string -> PLC notation, e.g. "X1F", "R10", "Y0". The last character is
 *               hexadecimal, the preceding characters are the DECIMAL word
 *               number ("X1F" = word 1, bit 15 = flat index 31).
 * Returns { area, index }; `area` may be null when the string has no prefix.
 */
function parseBitAddress(value, defaultArea) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new MewtocolError('BAD_ARGUMENT', `invalid bit address: ${value}`);
    }
    return { area: defaultArea || null, index: value };
  }
  if (typeof value !== 'string') {
    throw new MewtocolError('BAD_ARGUMENT', `invalid bit address: ${String(value)}`);
  }
  const m = /^\s*([XYRLxy])?\s*([0-9A-Fa-f]{1,4})\s*$/.exec(value);
  if (!m) {
    throw new MewtocolError('BAD_ARGUMENT', `invalid bit address "${value}" (expect e.g. 31, "X1F", "R10")`);
  }
  const area = m[1] ? m[1].toUpperCase() : defaultArea || null;
  const digits = m[2].toUpperCase();
  const bit = parseInt(digits.slice(-1), 16);
  const head = digits.slice(0, -1);
  if (head !== '' && !/^[0-9]+$/.test(head)) {
    throw new MewtocolError(
      'BAD_ARGUMENT',
      `invalid bit address "${value}" (word number must be decimal, last digit hex)`
    );
  }
  const word = head === '' ? 0 : parseInt(head, 10);
  return { area, index: word * 16 + bit };
}

/** 4 character MEWTOCOL contact address (decimal word + 1 hex bit), e.g. 31 -> "001F". */
function bitAddressText(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new MewtocolError('BAD_ARGUMENT', `invalid bit index: ${index}`);
  }
  const word = Math.floor(index / 16);
  const bit = index % 16;
  return padNumber(word, 3) + bit.toString(16).toUpperCase();
}

function describePlcError(code) {
  return ERROR_CODE_TEXT[parseInt(code, 16) & 0xff] || 'unknown PLC error';
}

function mapSocketError(err) {
  // A refused / unreachable / timed-out connection is reported as TIMEOUT, which
  // is what a lost PLC link looks like to a caller (no usable transport).
  const code = err && err.code ? String(err.code) : '';
  const detail = err && err.message ? err.message : String(err);
  const timeoutLike = ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNRESET', 'EACCES'];
  if (!code || timeoutLike.includes(code)) {
    return new MewtocolError('TIMEOUT', `transport failure${code ? ' (' + code + ')' : ''}: ${detail}`, { cause: err });
  }
  return new MewtocolError('TRANSPORT_ERROR', `transport failure (${code}): ${detail}`, { cause: err });
}

/* ------------------------------------------------------------------------- */
/* client                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * createClient({ host, port = 5007, station = 1, transport = 'tcp'|'udp',
 *                timeoutMs = 2000, sdBase = 90000 })
 *
 * All methods return promises and throw MewtocolError on failure. Codes used:
 *   BAD_ARGUMENT, NOT_OPEN, CLOSED, TIMEOUT, BAD_BCC, BAD_STATION,
 *   PROTOCOL_ERROR, PLC_ERROR (carries .responseCode / .errorCode / .raw / .request),
 *   TRANSPORT_ERROR, INTERNAL
 */
function createClient(options) {
  const opts = options || {};
  if (!opts.host) throw new MewtocolError('BAD_ARGUMENT', 'createClient(): "host" is required');
  const transport = String(opts.transport || 'tcp').toLowerCase();
  if (transport !== 'tcp' && transport !== 'udp') {
    throw new MewtocolError('BAD_ARGUMENT', `createClient(): unsupported transport "${opts.transport}" (tcp|udp)`);
  }
  const port = opts.port === undefined ? DEFAULT_PORT : Number(opts.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new MewtocolError('BAD_ARGUMENT', `createClient(): invalid port ${opts.port}`);
  }
  const station = opts.station === undefined ? 1 : opts.station;
  const stationStr = stationText(station); // validates
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(opts.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new MewtocolError('BAD_ARGUMENT', `createClient(): invalid timeoutMs ${opts.timeoutMs}`);
  }
  const sdBase = opts.sdBase === undefined ? DEFAULT_SD_BASE : Number(opts.sdBase);
  if (!Number.isInteger(sdBase) || sdBase < 0 || sdBase > 99999) {
    throw new MewtocolError('BAD_ARGUMENT', `createClient(): invalid sdBase ${opts.sdBase}`);
  }

  const host = String(opts.host);
  let socket = null; // net.Socket (tcp)
  let udpSocket = null; // dgram.Socket (udp)
  let isOpen = false;
  let rxBuffer = '';
  let pending = null; // { resolve, reject, timer, frame }
  let chain = Promise.resolve();
  let closing = false;

  const self = {
    host,
    port,
    station,
    transport,
    timeoutMs,
    sdBase,
    maxWordsPerReadFrame: MAX_READ_WORDS_PER_FRAME,
    maxWordsPerWriteFrame: MAX_WRITE_WORDS_PER_FRAME,
    get isOpen() {
      return isOpen;
    },
    get lastRequest() {
      return lastRequest;
    },
    get lastResponse() {
      return lastResponse;
    },
  };
  let lastRequest = null;
  let lastResponse = null;

  function serialise(task) {
    const run = () => Promise.resolve().then(task);
    const p = chain.then(run, run);
    chain = p.then(
      () => undefined,
      () => undefined
    );
    return p;
  }

  function failPending(err) {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  function deliverFrame(frameText) {
    if (!pending) return; // unsolicited / late frame: ignore (requests are serialised)
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.resolve(frameText);
  }

  function onTcpData(chunk) {
    rxBuffer += chunk.toString('latin1');
    let idx;
    while ((idx = rxBuffer.indexOf(CR)) !== -1) {
      const frame = rxBuffer.slice(0, idx);
      rxBuffer = rxBuffer.slice(idx + 1);
      if (frame.length) deliverFrame(frame);
    }
  }

  function onSocketFailure(err) {
    isOpen = false;
    failPending(err);
  }

  function detachTcp() {
    if (socket) {
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      socket.destroy();
      socket = null;
    }
    rxBuffer = '';
  }

  function openTcp() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const sock = net.createConnection({ host, port });
      sock.setNoDelay(true);
      const timer = setTimeout(() => finish(new MewtocolError('TIMEOUT', `TCP connect to ${host}:${port} timed out after ${timeoutMs} ms`)), timeoutMs);
      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.removeAllListeners('connect');
        sock.removeAllListeners('error');
        if (err) {
          sock.destroy();
          reject(err);
          return;
        }
        socket = sock;
        isOpen = true;
        sock.on('data', onTcpData);
        sock.on('error', (e) => onSocketFailure(mapSocketError(e)));
        sock.on('close', () => {
          if (isOpen) {
            isOpen = false;
            socket = null;
            failPending(new MewtocolError('CLOSED', 'TCP connection to the PLC was closed'));
          }
        });
        resolve(self);
      }
      sock.once('connect', () => finish(null));
      sock.once('error', (e) => finish(mapSocketError(e)));
    });
  }

  function openUdp() {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg) => {
      let text = msg.toString('latin1');
      while (text.endsWith(CR)) text = text.slice(0, -1);
      while (text.startsWith(CR)) text = text.slice(1);
      if (text.length) deliverFrame(text);
    });
    sock.on('error', (e) => onSocketFailure(mapSocketError(e)));
    udpSocket = sock;
    isOpen = true;
    return Promise.resolve(self);
  }

  function transceive(frame) {
    return new Promise((resolve, reject) => {
      if (pending) {
        reject(new MewtocolError('INTERNAL', 'concurrent request on a single MEWTOCOL-COM channel'));
        return;
      }
      if (transport === 'tcp' && !socket) {
        reject(new MewtocolError('NOT_OPEN', 'client is not open; call open() first'));
        return;
      }
      if (transport === 'udp' && !udpSocket) {
        reject(new MewtocolError('NOT_OPEN', 'client is not open; call open() first'));
        return;
      }
      const timer = setTimeout(() => {
        if (!pending || pending.timer !== timer) return;
        pending = null;
        // A late response on a stream socket would desynchronise the next
        // request, so close the TCP connection after a timeout.
        if (transport === 'tcp') {
          detachTcp();
          isOpen = false;
        }
        reject(new MewtocolError('TIMEOUT', `no response from ${host}:${port} within ${timeoutMs} ms`, { request: frame }));
      }, timeoutMs);
      pending = { resolve, reject, timer, frame };
      try {
        if (transport === 'tcp') {
          socket.write(frame, (err) => {
            if (err) failPending(mapSocketError(err));
          });
        } else {
          udpSocket.send(Buffer.from(frame, 'latin1'), port, host, (err) => {
            if (err) failPending(mapSocketError(err));
          });
        }
      } catch (err) {
        failPending(mapSocketError(err));
      }
    });
  }

  /**
   * Validate + decode one response frame.
   * @returns {{station:string, responseCode:string, data:string, raw:string}}
   */
  function parseResponse(rawFrame, sentCommand) {
    const frame = String(rawFrame).replace(/[\r\n]/g, '');
    if (frame.length < 6) {
      throw new MewtocolError('PROTOCOL_ERROR', `response frame too short: "${frame}"`, { raw: frame, request: lastRequest });
    }
    if (frame[0] !== HEADER && frame[0] !== '<') {
      throw new MewtocolError('PROTOCOL_ERROR', `bad response header "${frame[0]}"`, { raw: frame, request: lastRequest });
    }
    const responseStation = frame.slice(1, 3);
    const marker = frame[3];
    const bccText = frame.slice(-2);
    const body = frame.slice(0, -2);
    if (!/^[0-9A-Fa-f]{2}$/.test(bccText)) {
      throw new MewtocolError('PROTOCOL_ERROR', `bad BCC field "${bccText}"`, { raw: frame, request: lastRequest });
    }
    const expectedBcc = bccString(body);
    if (bccText.toUpperCase() !== expectedBcc) {
      throw new MewtocolError(
        'BAD_BCC',
        `BCC mismatch: frame says ${bccText.toUpperCase()}, computed ${expectedBcc} for "${body}"`,
        { raw: frame, request: lastRequest, receivedBcc: bccText.toUpperCase(), expectedBcc }
      );
    }
    if (stationStr !== 'FF' && responseStation !== stationStr) {
      throw new MewtocolError('BAD_STATION', `response came from station ${responseStation}, expected ${stationStr}`, {
        raw: frame,
        request: lastRequest,
      });
    }
    if (marker === '!') {
      const errCode = frame.slice(4, 6).toUpperCase();
      throw new MewtocolError(
        'PLC_ERROR',
        `PLC returned error ${errCode} (${describePlcError(errCode)}) for command "${sentCommand}"`,
        {
          responseCode: errCode,
          errorCode: parseInt(errCode, 16),
          raw: frame,
          request: lastRequest,
        }
      );
    }
    if (marker !== '$') {
      throw new MewtocolError('PROTOCOL_ERROR', `bad response marker "${marker}"`, { raw: frame, request: lastRequest });
    }
    return {
      station: responseStation,
      responseCode: frame.slice(4, 6),
      data: frame.slice(6, -2),
      raw: frame,
    };
  }

  /** Send one command frame; must be called while holding the serialisation queue. */
  async function sendNow(command, data) {
    if (!isOpen) throw new MewtocolError('NOT_OPEN', 'client is not open; call open() first');
    const frame = buildFrame(station, command, data);
    lastRequest = frame;
    const raw = await transceive(frame);
    lastResponse = raw;
    return parseResponse(raw, command);
  }

  /* --------------------------- generic escape hatch ---------------------- */

  /**
   * Send a raw command code + already formatted data string.
   * @returns {Promise<{station:string,responseCode:string,data:string,raw:string}>}
   */
  function request(command, data) {
    if (typeof command !== 'string' || command.length === 0) {
      return Promise.reject(new MewtocolError('BAD_ARGUMENT', 'request(): command must be a non empty string'));
    }
    if (data !== undefined && data !== null && typeof data !== 'string') {
      return Promise.reject(new MewtocolError('BAD_ARGUMENT', 'request(): data must be a string'));
    }
    return serialise(() => sendNow(command, data || ''));
  }

  /* --------------------------- data area words -------------------------- */

  function normaliseWordStart(address, name) {
    const n = typeof address === 'string' ? Number(address) : address;
    if (!Number.isInteger(n) || n < 0 || n > 99999) {
      throw new MewtocolError('BAD_ARGUMENT', `${name}: invalid address ${JSON.stringify(address)} (5 decimal digits, 0..99999)`);
    }
    return n;
  }

  function normaliseCount(count) {
    const n = typeof count === 'string' ? Number(count) : count;
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new MewtocolError('BAD_ARGUMENT', `invalid count ${JSON.stringify(count)} (1..65535)`);
    }
    return n;
  }

  async function readWordRange(areaCode, start, count, label) {
    const out = [];
    let address = start;
    let remaining = count;
    while (remaining > 0) {
      const n = Math.min(remaining, MAX_READ_WORDS_PER_FRAME);
      const end = address + n - 1;
      const res = await sendNow('RD', areaCode + padNumber(address, 5) + padNumber(end, 5));
      if (res.responseCode !== 'RD') {
        throw new MewtocolError('PROTOCOL_ERROR', `unexpected response code "${res.responseCode}" for RD`, { raw: res.raw });
      }
      if (res.data.length !== n * 4 || !/^[0-9A-Fa-f]+$/.test(res.data)) {
        throw new MewtocolError(
          'PROTOCOL_ERROR',
          `${label}: RD response must carry ${n * 4} hex chars for ${n} word(s), got "${res.data}"`,
          { raw: res.raw }
        );
      }
      for (let i = 0; i < res.data.length; i += 4) out.push(hexToWord(res.data.slice(i, i + 4)));
      address += n;
      remaining -= n;
    }
    return out;
  }

  async function writeWordRange(areaCode, start, values, label) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new MewtocolError('BAD_ARGUMENT', `${label}: values must be a non empty array`);
    }
    for (const v of values) wordToHex(v); // validate everything before sending anything
    let address = start;
    let index = 0;
    let frames = 0;
    let last = null;
    while (index < values.length) {
      const chunk = values.slice(index, index + MAX_WRITE_WORDS_PER_FRAME);
      const end = address + chunk.length - 1;
      let payload = areaCode + padNumber(address, 5) + padNumber(end, 5);
      for (const v of chunk) payload += wordToHex(v);
      last = await sendNow('WD', payload);
      if (last.responseCode !== 'WD') {
        throw new MewtocolError('PROTOCOL_ERROR', `unexpected response code "${last.responseCode}" for WD`, { raw: last.raw });
      }
      frames++;
      index += chunk.length;
      address += chunk.length;
    }
    return {
      ok: true,
      command: 'WD',
      frames,
      words: values.length,
      startAddress: start,
      endAddress: start + values.length - 1,
      station: last.station,
      responseCode: last.responseCode,
      data: last.data,
      raw: last.raw,
    };
  }

  async function readBitRange(area, address, count, label) {
    const { index } = parseBitAddress(address, area);
    const n = normaliseCount(count);
    const out = [];
    for (let i = 0; i < n; i++) {
      const res = await sendNow('RCS', area + bitAddressText(index + i));
      if (res.responseCode !== 'RC') {
        throw new MewtocolError('PROTOCOL_ERROR', `unexpected response code "${res.responseCode}" for RCS`, { raw: res.raw });
      }
      const bitChar = res.data[0];
      if (bitChar !== '0' && bitChar !== '1') {
        throw new MewtocolError('PROTOCOL_ERROR', `${label}: RCS response bit must be '0' or '1', got "${res.data}"`, { raw: res.raw });
      }
      out.push(bitChar === '1' ? 1 : 0);
    }
    return out;
  }

  async function writeBitRange(area, address, values, label) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new MewtocolError('BAD_ARGUMENT', `${label}: values must be a non empty array`);
    }
    const { index } = parseBitAddress(address, area);
    let last = null;
    let frames = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      const on = v === true || v === 1 || v === '1';
      const off = v === false || v === 0 || v === '0';
      if (!on && !off) {
        throw new MewtocolError('BAD_ARGUMENT', `${label}: bit value must be 0/1/true/false, got ${JSON.stringify(v)}`);
      }
      last = await sendNow('WCS', area + bitAddressText(index + i) + (on ? '1' : '0'));
      if (last.responseCode !== 'WC') {
        throw new MewtocolError('PROTOCOL_ERROR', `unexpected response code "${last.responseCode}" for WCS`, { raw: last.raw });
      }
      frames++;
    }
    return {
      ok: true,
      command: 'WCS',
      frames,
      bits: values.length,
      startAddress: index,
      endAddress: index + values.length - 1,
      station: last.station,
      responseCode: last.responseCode,
      data: last.data,
      raw: last.raw,
    };
  }

  /**
   * Accepts all of these for the X/Y area methods:
   *   (address, count/values)               area defaults to X
   *   (address, count/values, 'Y')          area as third argument
   *   ('Y10', count/values)                 PLC notation address with area prefix
   *   ('Y', address, count/values)          area as first argument
   */
  function normaliseXYArgs(args) {
    const [a, b, c] = args;
    if (typeof a === 'string' && /^[XY]$/i.test(a.trim())) {
      return { area: a.trim().toUpperCase(), address: b, payload: c === undefined ? 1 : c };
    }
    if (typeof a === 'string') {
      const parsed = parseBitAddress(a, 'X');
      return { area: parsed.area, address: parsed.index, payload: b === undefined ? 1 : b };
    }
    return { area: c === undefined ? 'X' : String(c).trim().toUpperCase(), address: a, payload: b === undefined ? 1 : b };
  }

  /* ----------------------------- public API ----------------------------- */

  self.open = function open() {
    if (closing) return Promise.reject(new MewtocolError('CLOSED', 'client is closing/closed'));
    if (isOpen) return Promise.resolve(self);
    return transport === 'tcp' ? openTcp() : openUdp();
  };

  self.close = function close() {
    closing = true;
    isOpen = false;
    failPending(new MewtocolError('CLOSED', 'client closed'));
    detachTcp();
    if (udpSocket) {
      const s = udpSocket;
      udpSocket = null;
      try {
        s.close();
      } catch (e) {
        /* already closed */
      }
    }
    return Promise.resolve();
  };

  self.request = request;

  self.readDT = function readDT(address, count) {
    const start = normaliseWordStart(address, 'readDT');
    const n = normaliseCount(count === undefined ? 1 : count);
    return serialise(() => readWordRange('D', start, n, 'readDT'));
  };

  self.writeDT = function writeDT(address, values) {
    const start = normaliseWordStart(address, 'writeDT');
    return serialise(() => writeWordRange('D', start, values, 'writeDT'));
  };

  self.readSD = function readSD(address, count) {
    const start = normaliseWordStart(address, 'readSD');
    const n = normaliseCount(count === undefined ? 1 : count);
    if (sdBase + start + n - 1 > 99999) {
      throw new MewtocolError('BAD_ARGUMENT', `readSD: SD address range exceeds the 5 digit DT address space (sdBase ${sdBase})`);
    }
    return serialise(() => readWordRange('D', sdBase + start, n, 'readSD'));
  };

  self.writeSD = function writeSD(address, values) {
    const start = normaliseWordStart(address, 'writeSD');
    const n = Array.isArray(values) ? values.length : 0;
    if (sdBase + start + Math.max(n, 1) - 1 > 99999) {
      throw new MewtocolError('BAD_ARGUMENT', `writeSD: SD address range exceeds the 5 digit DT address space (sdBase ${sdBase})`);
    }
    return serialise(() => writeWordRange('D', sdBase + start, values, 'writeSD'));
  };

  self.readR = function readR(address, count) {
    return serialise(() => readBitRange('R', address, count === undefined ? 1 : count, 'readR'));
  };

  self.writeR = function writeR(address, values) {
    return serialise(() => writeBitRange('R', address, values, 'writeR'));
  };

  self.readX = function readX(address, count) {
    return serialise(() => readBitRange('X', address, count === undefined ? 1 : count, 'readX'));
  };

  self.writeX = function writeX(address, values) {
    return serialise(() => writeBitRange('X', address, values, 'writeX'));
  };

  self.readY = function readY(address, count) {
    return serialise(() => readBitRange('Y', address, count === undefined ? 1 : count, 'readY'));
  };

  self.writeY = function writeY(address, values) {
    return serialise(() => writeBitRange('Y', address, values, 'writeY'));
  };

  self.readXY = function readXY(...args) {
    const { area, address, payload } = normaliseXYArgs(args);
    if (area !== 'X' && area !== 'Y') {
      return Promise.reject(new MewtocolError('BAD_ARGUMENT', `readXY(): area must be X or Y, got "${area}"`));
    }
    const count = payload === undefined ? 1 : payload;
    return serialise(() => readBitRange(area, address, count, `read${area}`));
  };

  self.writeXY = function writeXY(...args) {
    const { area, address, payload } = normaliseXYArgs(args);
    if (area !== 'X' && area !== 'Y') {
      return Promise.reject(new MewtocolError('BAD_ARGUMENT', `writeXY(): area must be X or Y, got "${area}"`));
    }
    if (!Array.isArray(payload)) {
      return Promise.reject(new MewtocolError('BAD_ARGUMENT', 'writeXY(): values must be an array'));
    }
    return serialise(() => writeBitRange(area, address, payload, `write${area}`));
  };

  /**
   * Read PLC status with the RT command.
   * Layout follows the official RT description: CPU type (2), CPU version (2),
   * program capacity (2), operation status (2 hex, same bits as R9020..R9027),
   * error flag (2 hex, R9000..R9007), self-diagnostic error code (4 hex, low
   * word first). NOTE: the CPU type table and the optional program capacity
   * field differ per series, so verify against a physical PLC before relying
   * on the decoded fields beyond cpuType/runMode/errorFlag.
   */
  self.readStatus = async function readStatus() {
    const res = await request('RT');
    const d = res.data;
    if (d.length < 14) {
      throw new MewtocolError('PROTOCOL_ERROR', `RT response too short: "${d}"`, { raw: res.raw });
    }
    const operationStatus = parseInt(d.slice(6, 8), 16);
    const errorFlag = parseInt(d.slice(10, 12), 16);
    const selfDiagnosticRaw = d.slice(12, 16);
    return {
      cpuType: d.slice(0, 2),
      cpuVersion: d.slice(2, 4),
      programCapacity: d.slice(4, 6),
      operationStatus,
      runMode: (operationStatus & 0x01) === 1,
      errorFlag,
      selfDiagnosticError: selfDiagnosticRaw,
      // words are low-byte-first, so reverse the two byte pairs
      selfDiagnosticErrorCode: parseInt(selfDiagnosticRaw.slice(2, 4) + selfDiagnosticRaw.slice(0, 2), 16),
      data: d,
      raw: res.raw,
    };
  };

  return self;
}

module.exports = {
  createClient,
  MewtocolError,
  // helpers exported for the mock server and the tests
  xorBcc,
  bccString,
  buildFrame,
  stationText,
  wordToHex,
  hexToWord,
  parseBitAddress,
  bitAddressText,
  describePlcError,
  ERROR_CODE_TEXT,
  constants: {
    HEADER,
    CR,
    CR_CODE,
    MAX_FRAME_CHARS,
    MAX_READ_WORDS_PER_FRAME,
    MAX_WRITE_WORDS_PER_FRAME,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_SD_BASE,
  },
};
