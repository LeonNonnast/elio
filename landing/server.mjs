// Tiny dependency-free static server for the elio landing page.
// Serves landing/index.html on Railway's $PORT (default 8080), plus a /healthz probe.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html")); // read once at startup — static page
const port = Number(process.env.PORT) || 8080;

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
  res.end(html);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`elio landing page listening on :${port}`);
});
