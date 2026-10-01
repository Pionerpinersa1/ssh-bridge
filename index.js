const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function wsFrame(data) {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  const len = buf.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
  else { header = Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(len),2); }
  return Buffer.concat([header, buf]);
}

function parseFrames(buf) {
  const msgs = [];
  let i = 0;
  while (i < buf.length) {
    if (buf.length < i + 2) break;
    const fin = (buf[i] & 0x80) !== 0;
    const opcode = buf[i] & 0x0f;
    const masked = (buf[i+1] & 0x80) !== 0;
    let payloadLen = buf[i+1] & 0x7f;
    let offset = i + 2;
    if (payloadLen === 126) { if (buf.length < offset+2) break; payloadLen = buf.readUInt16BE(offset); offset+=2; }
    else if (payloadLen === 127) { if (buf.length < offset+8) break; payloadLen = Number(buf.readBigUInt64BE(offset)); offset+=8; }
    const maskKey = masked ? buf.slice(offset, offset+4) : null;
    if (masked) offset += 4;
    if (buf.length < offset + payloadLen) break;
    let payload = buf.slice(offset, offset + payloadLen);
    if (masked) { payload = Buffer.from(payload); for (let j=0;j<payload.length;j++) payload[j] ^= maskKey[j%4]; }
    if (opcode === 8) { msgs.push({ opcode: 8 }); }
    else if (opcode === 9) { msgs.push({ opcode: 9, payload }); }
    else { msgs.push({ opcode, payload }); }
    i = offset + payloadLen;
  }
  return { msgs, remaining: buf.slice(i) };
}

let machineSocket = null;
const browserSockets = new Set();

function wsSend(socket, data) {
  try { socket.write(wsFrame(data)); } catch(e) {}
}

function broadcast(sockets, data) {
  sockets.forEach(s => { if (!s.destroyed) wsSend(s, data); });
}

function attachMachine(socket) {
  machineSocket = socket;
  console.log('[bridge] machine connected');
  broadcast(browserSockets, '\r\n\x1b[32m✓ Machine connected\x1b[0m\r\n');
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    const { msgs, remaining } = parseFrames(buf);
    buf = remaining;
    msgs.forEach(m => {
      if (m.opcode === 8) { socket.destroy(); }
      else if (m.opcode === 9) { wsSend(socket, Buffer.concat([Buffer.from([0x8a, m.payload.length]), m.payload])); }
      else { broadcast(browserSockets, m.payload); }
    });
  });
  socket.on('close', () => { machineSocket = null; broadcast(browserSockets, '\r\n\x1b[31m✗ Machine disconnected\x1b[0m\r\n'); });
  socket.on('error', () => { machineSocket = null; });
}

function attachBrowser(socket) {
  browserSockets.add(socket);
  console.log('[bridge] browser connected');
  if (!machineSocket) wsSend(socket, '\r\n\x1b[33mWaiting for machine to connect...\x1b[0m\r\n');
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    const { msgs, remaining } = parseFrames(buf);
    buf = remaining;
    msgs.forEach(m => {
      if (m.opcode === 8) { socket.destroy(); }
      else if (m.opcode === 9) { wsSend(socket, Buffer.concat([Buffer.from([0x8a, m.payload.length]), m.payload])); }
      else if (machineSocket && !machineSocket.destroyed) { wsSend(machineSocket, m.payload); }
    });
  });
  socket.on('close', () => browserSockets.delete(socket));
  socket.on('error', () => browserSockets.delete(socket));
}

const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url;
  const file = path.join(DIR, url.split('?')[0]);
  if (!file.startsWith(DIR)) { res.writeHead(403); res.end(); return; }
  serveFile(res, file);
});

server.on('upgrade', (req, socket) => {
  if (!req.headers['upgrade'] || req.headers['upgrade'].toLowerCase() !== 'websocket') {
    socket.destroy(); return;
  }
  wsHandshake(req, socket);
  if (req.url === '/machine') attachMachine(socket);
  else attachBrowser(socket);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[bridge] listening on :${PORT}`));
