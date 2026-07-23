'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('inline SPA script is valid JavaScript', () => {
    const html = fs.readFileSync(path.join(root, 'jira-l10n-key-extractor.html'), 'utf8');
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length > 0, 'no inline script found');
    const inlineSource = scripts[scripts.length - 1][1];
    assert.doesNotThrow(() => new Function(inlineSource));
});
