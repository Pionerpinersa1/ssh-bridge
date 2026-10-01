const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

let machineSocket = null;
const browserSockets = new Set();

wss.on('connection', (ws, req) => {
  const isMachine = req.url === '/machine';

  if (isMachine) {
    machineSocket = ws;
    console.log('[bridge] machine connected');
    browserSockets.forEach(b => b.readyState === 1 && b.send('\r\n\x1b[32m✓ Machine connected\x1b[0m\r\n'));

    ws.on('message', data => {
      browserSockets.forEach(b => b.readyState === 1 && b.send(data));
    });
    ws.on('close', () => {
      machineSocket = null;
      browserSockets.forEach(b => b.readyState === 1 && b.send('\r\n\x1b[31m✗ Machine disconnected\x1b[0m\r\n'));
    });
  } else {
    browserSockets.add(ws);
    console.log('[bridge] browser connected');
    if (!machineSocket) ws.send('\r\n\x1b[33mWaiting for machine to connect...\x1b[0m\r\n');

    ws.on('message', data => {
      if (machineSocket && machineSocket.readyState === 1) machineSocket.send(data);
    });
    ws.on('close', () => browserSockets.delete(ws));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[bridge] listening on :${PORT}`));
