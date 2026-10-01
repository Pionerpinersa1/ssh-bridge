const http = require('http');

const handler = (port) => (req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('BRIDGE_PORT=' + port + ' ENV_PORT=' + (process.env.PORT || 'unset') + ' url=' + req.url);
};

// Try all common ports — whichever infrlo routes to will respond
[3000, 8080, 5000, 4000, 8000, 1337, 8888].forEach(port => {
  http.createServer(handler(port)).listen(port, '0.0.0.0', () => {
    console.log('listening on ' + port);
  }).on('error', () => {}); // skip if port busy
});

// Keep process alive
setInterval(() => {}, 1e9);
