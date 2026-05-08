/**
 * Jira CORS Proxy Server
 * Zero-dependency Node.js proxy for bypassing browser CORS restrictions.
 *
 * Usage:
 *   node jira-cors-proxy.js
 *   node jira-cors-proxy.js 8080        (custom port)
 *
 * The SPA sends:
 *   GET http://localhost:3001/proxy?url=<encoded_jira_url>
 *   Authorization: Basic <base64>
 *
 * This server forwards the request to Jira and pipes the response back
 * with permissive CORS headers.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = parseInt(process.argv[2], 10) || 3001;

const server = http.createServer((req, res) => {
    const setCORS = () => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Atlassian-Token');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length');
        res.setHeader('Access-Control-Max-Age', '86400');
    };

    setCORS();

    // Preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // Health check
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    if (reqUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    }

    // Proxy endpoint
    if (reqUrl.pathname !== '/proxy') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Use /proxy?url=<target>' }));
    }

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
        return res.end(JSON.stringify({ error: `Invalid target URL: ${e.message}` }));
    }

    // Only allow HTTPS targets (Jira Cloud is always HTTPS)
    const lib = target.protocol === 'https:' ? https : http;

    // Forward selected headers from the browser request
    const forwardHeaders = {};
    for (const h of ['authorization', 'content-type', 'accept', 'x-atlassian-token']) {
        if (req.headers[h]) forwardHeaders[h] = req.headers[h];
    }

    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${req.method} -> ${target.hostname}${target.pathname}${target.search ? '?' + target.search.slice(0, 80) : ''}`);

    const proxyReq = lib.request(
        {
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            method: req.method,
            headers: {
                ...forwardHeaders,
                'Host': target.hostname,
                'User-Agent': 'JiraL10NProxy/1.0',
            },
        },
        (proxyRes) => {
            // Handle redirects (Jira sometimes 301/302)
            if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
                const loc = proxyRes.headers.location;
                console.log(`  -> Redirect ${proxyRes.statusCode} to ${loc.substring(0, 100)}`);
                // Return redirect info to the client to retry
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ redirect: loc }));
            }

            const respHeaders = { ...proxyRes.headers };
            // Override CORS headers from target
            delete respHeaders['access-control-allow-origin'];
            delete respHeaders['access-control-allow-methods'];
            delete respHeaders['access-control-allow-headers'];

            res.writeHead(proxyRes.statusCode, { ...respHeaders, 'Access-Control-Allow-Origin': '*' });
            proxyRes.pipe(res);
        }
    );

    proxyReq.on('error', (err) => {
        console.error(`  -> Proxy error: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Proxy connection failed: ${err.message}` }));
    });

    proxyReq.setTimeout(30000, () => {
        console.error('  -> Proxy timeout');
        proxyReq.destroy();
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy request timed out (30s)' }));
    });

    // Pipe request body (for POST/PUT)
    req.pipe(proxyReq);
});

server.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║   Jira CORS Proxy Server                 ║');
    console.log(`  ║   http://localhost:${PORT}                    ║`);
    console.log('  ╠══════════════════════════════════════════╣');
    console.log('  ║   Endpoints:                             ║');
    console.log('  ║   GET /proxy?url=<encoded_url>           ║');
    console.log('  ║   GET /health                            ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
    console.log('  Waiting for requests...');
    console.log('');
});
