const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 5000;
const DIR = __dirname;

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type': 'text/plain'}); res.end('Not found'); return; }
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
  const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = buf.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else { header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
  return Buffer.concat([header, buf]);
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
    if (masked) { for (let j=0;j<payload.length;j++) payload[j] ^= maskKey[j%4]; }
    msgs.push({ opcode, payload });
    i = offset + payloadLen;
  }
  return { msgs, remaining: buf.slice(i) };
}

function wsSend(socket, data) {
  try { if (!socket.destroyed) socket.write(wsFrame(data)); } catch(e) {}
}

let machineSocket = null;
const browserSockets = new Set();

function attachMachine(socket) {
  machineSocket = socket;
  console.log('[bridge] machine connected');
  browserSockets.forEach(b => wsSend(b, '\r\n\x1b[32m✓ Machine connected\x1b[0m\r\n'));
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    const { msgs, remaining } = parseFrames(buf);
    buf = remaining;
    msgs.forEach(m => {
      if (m.opcode === 8) socket.destroy();
      else browserSockets.forEach(b => wsSend(b, m.payload));
    });
  });
  socket.on('close', () => {
    machineSocket = null;
    browserSockets.forEach(b => wsSend(b, '\r\n\x1b[31m✗ Machine disconnected\x1b[0m\r\n'));
  });
  socket.on('error', () => { machineSocket = null; });
}

function attachBrowser(socket) {
  browserSockets.add(socket);
  console.log('[bridge] browser connected');
  if (!machineSocket) wsSend(socket, '\r\n\x1b[33mWaiting for machine...\x1b[0m\r\n');
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    const { msgs, remaining } = parseFrames(buf);
    buf = remaining;
    msgs.forEach(m => {
      if (m.opcode === 8) socket.destroy();
      else if (machineSocket && !machineSocket.destroyed) wsSend(machineSocket, m.payload);
    });
  });
  socket.on('close', () => browserSockets.delete(socket));
  socket.on('error', () => browserSockets.delete(socket));
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.resolve(DIR, '.' + urlPath);
  if (!file.startsWith(DIR)) { res.writeHead(403); res.end(); return; }
  serveFile(res, file);
});

server.on('upgrade', (req, socket) => {
  if ((req.headers['upgrade'] || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  wsHandshake(req, socket);
  if (req.url === '/machine') attachMachine(socket);
  else attachBrowser(socket);
});

server.listen(PORT, '0.0.0.0', () => console.log('[bridge] listening on :' + PORT));
