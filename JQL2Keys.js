/**
 * JQL2Keys — All-in-one server
 * Serves the SPA at http://localhost:<port> and proxies Jira API requests.
 * Auto-opens the default browser on start.
 *
 * Usage (development):  node JQL2Keys.js [port]
 * Usage (packaged):     JQL2Keys.exe
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const DEFAULT_PORT = 3001;
const PORT = parseInt(process.argv[2], 10) || DEFAULT_PORT;

// ═══════════════════════════════════════
//  Load HTML asset
// ═══════════════════════════════════════
function loadHTML() {
    const candidates = [
        path.join(__dirname, 'jira-l10n-key-extractor.html'),
        path.join(process.cwd(), 'jira-l10n-key-extractor.html'),
    ];
    for (const p of candidates) {
        try { return fs.readFileSync(p, 'utf8'); } catch {}
    }
    return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">
        <h1>Error</h1><p>Cannot find jira-l10n-key-extractor.html</p>
        <p>Make sure the HTML file is in the same folder as this executable.</p>
    </body></html>`;
}

const HTML_CONTENT = loadHTML();

// ═══════════════════════════════════════
//  HTTP Server
// ═══════════════════════════════════════
const server = http.createServer((req, res) => {
    // CORS headers (needed when HTML opened from file://)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Atlassian-Token');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

    // ── Serve SPA ──
    if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(HTML_CONTENT);
    }

    // ── Favicon (suppress 404) ──
    if (reqUrl.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
    }

    // ── Health check ──
    if (reqUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    }

    // ── Jira Proxy ──
    if (reqUrl.pathname === '/proxy') {
        const targetUrl = reqUrl.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
        }

        let target;
        try {
            target = new URL(targetUrl);
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `Invalid URL: ${e.message}` }));
        }

        const lib = target.protocol === 'https:' ? https : http;
        const forwardHeaders = {};
        for (const h of ['authorization', 'content-type', 'accept', 'x-atlassian-token']) {
            if (req.headers[h]) forwardHeaders[h] = req.headers[h];
        }

        const ts = new Date().toISOString().slice(11, 19);
        console.log(`[${ts}] ${req.method} -> ${target.hostname}${target.pathname}`);

        const proxyReq = lib.request(
            {
                hostname: target.hostname,
                port: target.port || (target.protocol === 'https:' ? 443 : 80),
                path: target.pathname + target.search,
                method: req.method,
                headers: { ...forwardHeaders, Host: target.hostname, 'User-Agent': 'JQL2Keys/1.0' },
            },
            (proxyRes) => {
                if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ redirect: proxyRes.headers.location }));
                }
                const rh = { ...proxyRes.headers };
                delete rh['access-control-allow-origin'];
                delete rh['access-control-allow-methods'];
                delete rh['access-control-allow-headers'];
                res.writeHead(proxyRes.statusCode, { ...rh, 'Access-Control-Allow-Origin': '*' });
                proxyRes.pipe(res);
            }
        );
        proxyReq.on('error', (err) => {
            console.error(`  -> Error: ${err.message}`);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
        });
        proxyReq.setTimeout(30000, () => {
            proxyReq.destroy();
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Timeout (30s)' }));
        });
        req.pipe(proxyReq);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

// ═══════════════════════════════════════
//  Start with auto-retry on port conflict
// ═══════════════════════════════════════
function tryListen(port, retries) {
    server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && retries > 0) {
            console.log(`  Port ${port} in use, trying ${port + 1}...`);
            tryListen(port + 1, retries - 1);
        } else {
            console.error(`  Fatal: ${err.message}`);
            process.exit(1);
        }
    });

    server.listen(port, () => {
        const url = `http://localhost:${port}`;
        console.log('');
        console.log('  ╔═══════════════════════════════════════╗');
        console.log('  ║         JQL2Keys is running           ║');
        console.log(`  ║   ${url}                   ║`);
        console.log('  ╠═══════════════════════════════════════╣');
        console.log('  ║   Browser will open automatically.    ║');
        console.log('  ║   Keep this window open while using.  ║');
        console.log('  ║   Press Ctrl+C to quit.               ║');
        console.log('  ╚═══════════════════════════════════════╝');
        console.log('');

        // Auto-open browser
        const cmd = process.platform === 'win32' ? `start "" "${url}"`
                  : process.platform === 'darwin' ? `open "${url}"`
                  : `xdg-open "${url}"`;
        exec(cmd, () => {});
    });
}

tryListen(PORT, 10);
