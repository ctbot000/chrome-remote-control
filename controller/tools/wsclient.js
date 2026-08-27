'use strict';
// Tiny WebSocket client, used by the test tools so they can talk to the
// controller exactly the way the extension does. Node has no built-in client
// that works on older releases, and this repo stays dependency-free.

const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

class Client extends EventEmitter {
  constructor(url) {
    super();
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.open = false;
  }

  connect() {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: this.url.hostname,
      port: this.url.port || 80,
      path: `${this.url.pathname}${this.url.search}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket, head) => {
      this.socket = socket;
      this.open = true;
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('close', () => {
        this.open = false;
        this.emit('close');
      });
      socket.on('error', (err) => this.emit('error', err));
      this.emit('open');
      // `head` holds bytes already read past the handshake — often the first
      // frame the server sent, which would otherwise be lost. Replayed after
      // 'open' so listeners see the events in the order they happened.
      if (head && head.length) this._onData(head);
    });
    req.on('response', (res) => this.emit('error', new Error(`handshake failed: HTTP ${res.statusCode}`)));
    req.on('error', (err) => this.emit('error', err));
    req.end();
    return this;
  }

  send(value) {
    if (!this.open) return false;
    const payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x81; // FIN + text
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    return this.socket.write(Buffer.concat([header, mask, masked]));
  }

  close() {
    if (!this.socket) return;
    this.open = false;
    try {
      this.socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
      this.socket.end();
    } catch {
      /* already gone */
    }
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (masked) offset += 4;
      if (buf.length < offset + len) return;
      const payload = buf.subarray(offset, offset + len);
      this.buffer = buf.subarray(offset + len);
      if (opcode === 0x9) {
        // ping -> pong, masked
        const mask = crypto.randomBytes(4);
        const body = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i += 1) body[i] = payload[i] ^ mask[i & 3];
        this.socket.write(Buffer.concat([Buffer.from([0x8a, 0x80 | payload.length]), mask, body]));
      } else if (opcode === 0x8) {
        this.close();
      } else if (opcode === 0x1) {
        this.emit('message', payload.toString('utf8'));
      }
    }
  }
}

module.exports = { Client };
