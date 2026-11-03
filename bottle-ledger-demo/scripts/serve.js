// Optional: serve index.html at http://localhost:8080 (the page also works by double-clicking index.html).
const http = require('http'), fs = require('fs'), path = require('path');
const file = path.join(__dirname, '..', 'index.html'), port = process.env.PORT || 8080;
http.createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(file).pipe(res); })
  .listen(port, () => console.log(`Serving on http://localhost:${port}`));
