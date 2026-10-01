// muse-dial.js — run on the Muse.ai machine to connect it to the bridge
// Usage: node muse-dial.js
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BRIDGE = 'wss://ssh-bridgexgnj.infrlo.com/machine';
const RECONNECT_DELAY = 5000;

function connect() {
  console.log('[dial] connecting to', BRIDGE);

  const url = new URL(BRIDGE);
  const wsKey = crypto.randomBytes(16).toString('base64');

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: 'GET',
    headers: {
      'Host': url.hostname,
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
      'Sec-WebSocket-Key': wsKey,
      'Sec-WebSocket-Version': '13'
    }
  };

  const req = https.request(options);
  req.end();

  req.on('upgrade', (res, socket) => {
    console.log('[dial] bridge connected — spawning shell');

    const shell = spawn('/bin/bash', [], { env: process.env });

    function wsSend(data) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const len = buf.length;
      let header;
      if (len < 126) header = Buffer.from([0x81, len]);
      else { header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
      socket.write(Buffer.concat([header, buf]));
    }

    function parseFrames(buf) {
      const msgs = [];
      let i = 0;
      while (i + 2 <= buf.length) {
        const opcode = buf[i] & 0x0f;
        const masked = (buf[i+1] & 0x80) !== 0;
        let payloadLen = buf[i+1] & 0x7f;
        let offset = i + 2;
        if (payloadLen === 126) { if (buf.length < offset+2) break; payloadLen = buf.readUInt16BE(offset); offset+=2; }
        const maskKey = masked ? buf.slice(offset, offset+4) : null;
        if (masked) offset += 4;
        if (buf.length < offset + payloadLen) break;
        let payload = Buffer.from(buf.slice(offset, offset + payloadLen));
        if (masked) { for (let j=0;j<payload.length;j++) payload[j]^=maskKey[j%4]; }
        msgs.push({ opcode, payload });
        i = offset + payloadLen;
      }
      return { msgs, remaining: buf.slice(i) };
    }

    // shell output → browser
    shell.stdout.on('data', d => wsSend(d));
    shell.stderr.on('data', d => wsSend(d));
    shell.on('close', () => {
      console.log('[dial] shell exited');
      socket.destroy();
    });

    // browser input → shell
    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      const { msgs, remaining } = parseFrames(buf);
      buf = remaining;
      msgs.forEach(m => {
        if (m.opcode === 8) { socket.destroy(); shell.kill(); }
        else if (m.payload.length > 0) shell.stdin.write(m.payload);
      });
    });

    socket.on('close', () => {
      console.log('[dial] socket closed — reconnecting in', RECONNECT_DELAY, 'ms');
      shell.kill();
      setTimeout(connect, RECONNECT_DELAY);
    });

    socket.on('error', err => {
      console.error('[dial] socket error:', err.message);
    });

    wsSend('\r\n\x1b[32m[muse] shell ready\x1b[0m\r\n$ ');
  });

  req.on('error', err => {
    console.error('[dial] connection error:', err.message, '— retry in', RECONNECT_DELAY, 'ms');
    setTimeout(connect, RECONNECT_DELAY);
  });
}

connect();
