'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'jira-l10n-key-extractor.html'), 'utf8');

test('SPA uses bundled browser dependencies only', () => {
    assert.match(html, /href="vendor\/tailwind\.min\.css"/);
    assert.match(html, /src="vendor\/vue\.global\.prod\.js"/);
    assert.match(html, /src="vendor\/jszip\.min\.js"/);
    assert.doesNotMatch(html, /<(?:script|link)\b[^>]+(?:src|href)="https?:\/\//i);
});

test('server exposes every bundled browser dependency', async (t) => {
    const port = 31000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['JQL2Keys.js', String(port), '--no-open'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => child.kill());

    const baseUrl = 'http://127.0.0.1:' + port;
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            const response = await fetch(baseUrl + '/health');
            if (response.ok) { ready = true; break; }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'server did not become ready');

    const expected = [
        ['/vendor/tailwind.min.css', 'text/css'],
        ['/vendor/vue.global.prod.js', 'text/javascript'],
        ['/vendor/jszip.min.js', 'text/javascript'],
    ];
    for (const [assetPath, contentType] of expected) {
        const response = await fetch(baseUrl + assetPath);
        assert.equal(response.status, 200, assetPath);
        assert.match(response.headers.get('content-type') || '', new RegExp('^' + contentType));
        assert.ok((await response.arrayBuffer()).byteLength > 1000, assetPath + ' is unexpectedly small');
    }
});
