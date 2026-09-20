'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'jira-l10n-key-extractor.html'), 'utf8');
const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].at(-1)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));

function loadApp(t) {
    const storage = new Map([['jlke_apiToken', 'jira-test-token-must-not-be-forwarded']]);
    const requests = [];
    const context = vm.createContext({
        console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
        location: { origin: 'http://localhost:3011', protocol: 'http:' },
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
        fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    });
    for (const file of ['vendor/vue.global.prod.js', 'key-metadata-parser.js', 'bug-mr-summary.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
    }
    // Exercise the actual Vue refs, computed values and watchers, without a DOM.
    vm.runInContext('Vue.createApp = options => ({mount: () => {globalThis.scope = Vue.effectScope(); globalThis.app = scope.run(options.setup);}})', context);
    vm.runInContext(inline, context);
    t.after(() => context.scope.stop());
    return { app: context.app, requests };
}

function unit(key, iid, project = 'web/chc') {
    return { key, _source: { source: 'MR', merge_request_iid: iid, project_id: project, task_name: 'MR#' + iid + ' ' + project }, translations: { 'en-US': 'Example' } };
}
function finish(request, title) { request.resolve({ ok: true, json: async () => ({ title }) }); }
function ticketIds(app) { return Array.from(app.bugJiraTickets.value, ticket => ticket.id); }

test('real Vue summaries follow filtering, deduplicate tickets and reuse loaded titles', async t => {
    const { app, requests } = loadApp(t);
    app.bugInput.value = JSON.stringify([unit('alpha', 3018), unit('beta', 3018, 'web/web')]);
    await tick();
    assert.equal(requests.length, 0, 'hidden tools should not fetch MR details');
    app.activeTool.value = 'bug-helper';
    await tick();
    assert.equal(requests.length, 2);
    assert.equal(app.bugStats.value.mrs, 2);
    assert.equal(app.bugJiraStatus.value.loading, 2);
    assert.equal(requests[0].options.headers.Authorization, undefined);
    finish(requests[0], 'UIA-415144: banner');
    finish(requests[1], '[UIA-415144 / LOC-12] fix');
    await tick();
    assert.deepEqual(ticketIds(app), ['UIA-415144', 'LOC-12']);
    assert.deepEqual(Array.from(app.bugMrJiraRows.value, row => [row.project, Array.from(row.tickets, ticket => ticket.id)]), [
        ['web/chc', ['UIA-415144']], ['web/web', ['UIA-415144', 'LOC-12']],
    ]);
    assert.equal(app.bugMrJiraRows.value[0].tickets[0].mrCount, 2);
    app.bugFilter.value = 'alpha';
    await tick();
    assert.deepEqual(ticketIds(app), ['UIA-415144']);
    assert.equal(app.bugMrJiraRows.value.length, 1);
    assert.equal(app.bugMrJiraRows.value[0].project, 'web/chc');
    assert.equal(app.bugMrJiraRows.value[0].tickets[0].mrCount, 1);
    app.config.domain = 'https://jira.example.com/jira/';
    assert.equal(app.bugJiraTickets.value[0].url, 'https://jira.example.com/jira/browse/UIA-415144');
    app.bugFilter.value = '';
    await tick();
    assert.deepEqual(ticketIds(app), ['UIA-415144', 'LOC-12']);
    assert.equal(requests.length, 2);
    app.bugFilter.value = 'no matches';
    await tick();
    assert.deepEqual(ticketIds(app), []);
});

test('a delayed response for an old dump cannot add tickets to the current summary', async t => {
    const { app, requests } = loadApp(t);
    app.activeTool.value = 'bug-helper';
    app.bugInput.value = JSON.stringify([unit('old', 1)]);
    await tick();
    app.bugInput.value = JSON.stringify([unit('new', 2)]);
    await tick();
    finish(requests[1], 'NEW-2: latest dump');
    await tick();
    finish(requests[0], 'OLD-1: slow response');
    await tick();
    assert.deepEqual(ticketIds(app), ['NEW-2']);
    assert.equal(app.bugMrJiraRows.value[0].iid, '2');
    assert.equal(app.bugMrJiraRows.value[0].title, 'NEW-2: latest dump');
    assert.equal(app.bugJiraStatus.value.ready, 1);
    app.bugInput.value = '';
    await tick();
    assert.deepEqual(ticketIds(app), []);
    assert.equal(app.bugJiraStatus.value.loading, 0);
});

test('partial failures and unsupported links remain visible, and Retry replaces old titles', async t => {
    const { app, requests } = loadApp(t);
    app.activeTool.value = 'bug-helper';
    app.bugInput.value = JSON.stringify([unit('alpha', 1), unit('beta', 2), unit('unavailable', 3, 'unknown/repo')]);
    await tick();
    finish(requests[0], 'UIA-1: success');
    requests[1].resolve({ ok: false, status: 404 });
    await tick();
    assert.deepEqual(ticketIds(app), ['UIA-1']);
    assert.equal(app.bugJiraStatus.value.failed.length, 1);
    assert.equal(app.bugJiraStatus.value.skipped, 1);
    assert.deepEqual(Array.from(app.bugMrJiraRows.value, row => row.status), ['ready', 'error', 'unsupported']);
    const retry = app.syncBugMrTitles(true);
    await tick();
    finish(requests[2], 'LOC-12: updated title');
    finish(requests[3], 'no issue in this title');
    await retry;
    assert.deepEqual(ticketIds(app), ['LOC-12']);
    assert.equal(app.bugJiraStatus.value.failed.length, 0);
    assert.equal(app.bugJiraStatus.value.ready, 2);
});
