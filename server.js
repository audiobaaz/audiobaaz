// Coming-soon server. Zero dependencies: Node built-ins only.
// Serves index.html for every page, files from ./public, and /healthz for checks.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT, 10) || 3000;
const PUBLIC = path.join(__dirname, "public");
const PAGE = fs.readFileSync(path.join(__dirname, "index.html"));
const TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
const BASE = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
};

http
  .createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...BASE, Allow: "GET, HEAD" });
      return res.end();
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      res.writeHead(400, BASE);
      return res.end();
    }
    if (pathname === "/healthz") {
      res.writeHead(200, { ...BASE, "Content-Type": "text/plain" });
      return res.end("ok");
    }
    if (pathname === "/robots.txt") {
      res.writeHead(200, { ...BASE, "Content-Type": "text/plain; charset=utf-8" });
      return res.end("User-agent: *\nAllow: /\n");
    }
    const file = path.normalize(path.join(PUBLIC, pathname));
    const type = TYPES[path.extname(file).toLowerCase()];
    if (type && file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { ...BASE, "Content-Type": type, "Cache-Control": "public, max-age=86400" });
      return req.method === "HEAD" ? res.end() : fs.createReadStream(file).pipe(res);
    }
    res.writeHead(200, { ...BASE, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(req.method === "HEAD" ? undefined : PAGE);
  })
  .listen(PORT, "0.0.0.0", () => console.log(`coming soon page on port ${PORT}`));
