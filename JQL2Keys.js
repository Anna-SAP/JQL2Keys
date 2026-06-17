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
const { exec, execFile } = require('child_process');

const DEFAULT_PORT = 3001;
const PORT = parseInt(process.argv[2], 10) || DEFAULT_PORT;

// ═══════════════════════════════════════
//  UNS template/partial classifier
// ═══════════════════════════════════════
// The UNS repo (git.ringcentral.com/common/uns) stores email templates as
// top-level folders under uns-app/templateStorage and uns-app/newTemplateStorage,
// and reusable fragments ("partials") as folders under each storage's _partials
// subfolder. This lister reads the LOCAL clone only (no network) and reports
// the two name sets so the SPA can tell, for any extracted TID, whether it is a
// template, a partial, or both. It prefers the `master` tree via `git ls-tree`
// (so the answer reflects master regardless of which branch is checked out) and
// falls back to the working tree on disk when git is unavailable.
const DEFAULT_UNS_ROOT = process.env.UNS_REPO_ROOT || 'C:\\Users\\susu82\\SW\\UNS';
const UNS_STORAGES = ['templateStorage', 'newTemplateStorage'];

function execFileP(cmd, args, opts) {
    return new Promise((resolve) => {
        execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
            resolve({ err, stdout: stdout || '', stderr: stderr || '' });
        });
    });
}

// List immediate sub-directory names of a git tree-ish (e.g. "master:uns-app/
// templateStorage"). Returns basenames; [] when the path is absent on the ref
// or git errors for any reason.
async function gitListDirs(toplevel, treeish) {
    const { err, stdout } = await execFileP('git', ['-C', toplevel, 'ls-tree', '-d', '--name-only', treeish]);
    if (err) return [];
    return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

// List immediate sub-directory names on disk; null if the dir can't be read.
function fsListDirs(absPath) {
    try {
        return fs.readdirSync(absPath, { withFileTypes: true })
            .filter(d => { try { return d.isDirectory(); } catch { return false; } })
            .map(d => d.name);
    } catch { return null; }
}

async function handleUnsTemplates(reqUrl, res) {
    const sendJson = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
    };
    try {
        const rootParam = (reqUrl.searchParams.get('root') || DEFAULT_UNS_ROOT).trim();
        const ref = (reqUrl.searchParams.get('ref') || 'master').trim() || 'master';
        if (!rootParam) return sendJson(400, { ok: false, error: 'Missing "root" (path to the local UNS clone)' });
        if (!fs.existsSync(rootParam)) return sendJson(400, { ok: false, error: `Path not found: ${rootParam}` });

        // Accept either the repo root (…/uns) or the uns-app folder directly.
        let base = rootParam;
        if (fs.existsSync(path.join(rootParam, 'uns-app', 'templateStorage')) ||
            fs.existsSync(path.join(rootParam, 'uns-app', 'newTemplateStorage'))) {
            base = path.join(rootParam, 'uns-app');
        }
        const hasAnyStorage = UNS_STORAGES.some(s => fs.existsSync(path.join(base, s)));
        if (!hasAnyStorage) {
            return sendJson(400, {
                ok: false,
                error: `No templateStorage/newTemplateStorage under "${base}". Point "root" at the UNS repo root (…/uns) or its uns-app folder.`,
            });
        }

        // Establish the git context. `git ls-tree <ref>:<path>` wants a path
        // relative to the repo toplevel, so resolve toplevel + the prefix from
        // toplevel down to `base`, then verify the ref's tree exists.
        let gitOk = false, toplevel = '', prefix = '';
        const tl = await execFileP('git', ['-C', base, 'rev-parse', '--show-toplevel']);
        const pf = await execFileP('git', ['-C', base, 'rev-parse', '--show-prefix']);
        if (!tl.err && !pf.err) {
            toplevel = tl.stdout.trim();
            prefix = pf.stdout.trim(); // "uns-app/" (always forward-slashed) or ""
            const rv = await execFileP('git', ['-C', toplevel, 'rev-parse', '--verify', `${ref}^{tree}`]);
            gitOk = !rv.err;
        }
        const mode = gitOk ? 'git' : 'fs';

        const templates = new Set();
        const partials = new Set();
        const detail = {};

        for (const storage of UNS_STORAGES) {
            const storAbs = path.join(base, storage);
            if (!fs.existsSync(storAbs)) { detail[storage] = { present: false }; continue; }

            let tplNames, parNames;
            if (gitOk) {
                tplNames = await gitListDirs(toplevel, `${ref}:${prefix}${storage}`);
                parNames = await gitListDirs(toplevel, `${ref}:${prefix}${storage}/_partials`);
            } else {
                tplNames = fsListDirs(storAbs) || [];
                parNames = fsListDirs(path.join(storAbs, '_partials')) || [];
            }

            const tplClean = tplNames.filter(n => n !== '_partials');
            tplClean.forEach(n => templates.add(n));
            parNames.forEach(n => partials.add(n));
            detail[storage] = { present: true, templates: tplClean.length, partials: parNames.length };
        }

        const tplArr = [...templates].sort();
        const parArr = [...partials].sort();
        const both = tplArr.filter(n => partials.has(n)).length;

        return sendJson(200, {
            ok: true,
            root: rootParam,
            base,
            ref,
            mode,
            storages: detail,
            templates: tplArr,
            partials: parArr,
            counts: { templates: tplArr.length, partials: parArr.length, both },
            generatedAt: new Date().toISOString(),
        });
    } catch (e) {
        return sendJson(500, { ok: false, error: e.message });
    }
}

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

    // ── Health check ── (also identifies our app for self-detection)
    if (reqUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', app: 'JQL2Keys', uptime: process.uptime() }));
    }

    // ── UNS template/partial lister (reads the local UNS clone) ──
    if (reqUrl.pathname === '/uns-templates') {
        return handleUnsTemplates(reqUrl, res);
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
//  Browser launcher
// ═══════════════════════════════════════
function openInBrowser(url) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
              : process.platform === 'darwin' ? `open "${url}"`
              : `xdg-open "${url}"`;
    exec(cmd, () => {});
}

// ═══════════════════════════════════════
//  Detect existing JQL2Keys instance
// ═══════════════════════════════════════
//  Probes /health on each candidate port. If a server responds with
//  app:"JQL2Keys", that port is ours and we can reuse it instead of
//  starting a duplicate (which would open a second browser tab).
function probeForOurApp(port) {
    return new Promise((resolve) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 400 }, (res) => {
            let buf = '';
            res.on('data', (c) => { buf += c; if (buf.length > 1024) req.destroy(); });
            res.on('end', () => {
                try { resolve(JSON.parse(buf).app === 'JQL2Keys' ? port : null); }
                catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

async function findExistingInstance(startPort, count) {
    for (let p = startPort; p < startPort + count; p++) {
        const found = await probeForOurApp(p);
        if (found) return found;
    }
    return null;
}

// ═══════════════════════════════════════
//  Start with auto-retry on port conflict
// ═══════════════════════════════════════
function tryListen(port, retries) {
    server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && retries > 0) {
            console.log(`  Port ${port} occupied by another app, trying ${port + 1}...`);
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
        console.log(`  ║   ${url.padEnd(36)}║`);
        console.log('  ╠═══════════════════════════════════════╣');
        console.log('  ║   Browser will open automatically.    ║');
        console.log('  ║   Keep this window open while using.  ║');
        console.log('  ║   Press Ctrl+C to quit.               ║');
        console.log('  ╚═══════════════════════════════════════╝');
        console.log('');
        openInBrowser(url);
    });
}

(async () => {
    // Single-instance guard: if JQL2Keys is already running, just reopen
    // the browser to it and exit — don't start a duplicate server.
    const existing = await findExistingInstance(PORT, 10);
    if (existing) {
        const url = `http://localhost:${existing}`;
        console.log('');
        console.log('  ╔═══════════════════════════════════════╗');
        console.log('  ║   JQL2Keys already running            ║');
        console.log(`  ║   Reusing ${url.padEnd(28)}║`);
        console.log('  ╠═══════════════════════════════════════╣');
        console.log('  ║   Switching browser to that tab...    ║');
        console.log('  ║   This window will close shortly.     ║');
        console.log('  ╚═══════════════════════════════════════╝');
        console.log('');
        openInBrowser(url);
        // Brief delay so the OS hands the URL off before we exit
        setTimeout(() => process.exit(0), 800);
        return;
    }
    tryListen(PORT, 10);
})();
