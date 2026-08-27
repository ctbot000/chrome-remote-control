'use strict';
// Minimal RFC 6455 WebSocket server. No dependencies: Node's http upgrade
// event plus hand-rolled frame parsing. permessage-deflate is never
// negotiated, so every frame on the wire is plain.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 4 * 1024 * 1024;

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WebSocketConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.open = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = null;
    this.isAlive = true;

    // EventEmitter turns an 'error' with no listener into a throw, which would
    // take the whole controller down when a browser tab is closed mid-frame.
    // Callers can still add their own listener on top of this one.
    this.on('error', () => {});

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._teardown());
    socket.on('error', (err) => {
      this.emit('error', err);
      this._teardown();
    });
  }

  send(data) {
    if (!this.open) return false;
    const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
    return this._writeFrame(OP.TEXT, payload);
  }

  ping() {
    return this._writeFrame(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._writeFrame(OP.CLOSE, payload);
    this.open = false;
    this.socket.end();
  }

  _writeFrame(opcode, payload) {
    let header;
    const len = payload.length;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode, server frames are never masked
    try {
      return this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this._teardown();
      return false;
    }
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    // A single read can carry several frames, or half of one.
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
      if (!this.open) return;
    }
  }

  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_PAYLOAD)) {
        this.close(1009, 'payload too large');
        return null;
      }
      len = Number(big);
      offset += 8;
    }
    if (len > MAX_PAYLOAD) {
      this.close(1009, 'payload too large');
      return null;
    }
    if (!masked) {
      // Clients must mask; an unmasked client frame is a protocol error.
      this.close(1002, 'unmasked frame');
      return null;
    }
    if (buf.length < offset + 4 + len) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(len);
    buf.copy(payload, 0, offset, offset + len);
    for (let i = 0; i < len; i += 1) payload[i] ^= mask[i & 3];
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.CLOSE:
        this.open = false;
        this._writeFrame(OP.CLOSE, payload.subarray(0, 2));
        this.socket.end();
        return;
      case OP.PING:
        this._writeFrame(OP.PONG, payload);
        return;
      case OP.PONG:
        this.isAlive = true;
        this.emit('pong');
        return;
      case OP.TEXT:
      case OP.BINARY:
        this.fragmentOp = opcode;
        this.fragments = [payload];
        break;
      case OP.CONT:
        this.fragments.push(payload);
        break;
      default:
        this.close(1002, 'bad opcode');
        return;
    }
    if (!fin) return;
    const full = Buffer.concat(this.fragments);
    this.fragments = [];
    this.isAlive = true;
    if (this.fragmentOp === OP.TEXT) this.emit('message', full.toString('utf8'));
    else this.emit('binary', full);
  }

  _teardown() {
    if (!this.open && this._closedEmitted) return;
    this.open = false;
    this._closedEmitted = true;
    this.emit('close');
  }
}

// Attaches to an http.Server and hands accepted connections to onConnection.
// verify(req) may return false to reject the upgrade with 401.
function attach(server, { verify, onConnection }) {
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => socket.destroy()); // a reset before the handshake finishes
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (upgrade !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (verify && !verify(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    onConnection(new WebSocketConnection(socket, req), req);
  });
}

module.exports = { attach, WebSocketConnection };
