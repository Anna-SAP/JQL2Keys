'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { collectMrs, extractJiraIds, jiraUrl, collectJiraTickets, createTitleLoader } = require('../bug-mr-summary');

function mr(project, iid) {
    return { key: JSON.stringify([project, String(iid)]), project, iid: String(iid), url: 'https://git.ringcentral.com/' + project + '/-/merge_requests/' + iid };
}
function response(title) { return { ok: true, json: async () => ({ title }) }; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('extracts full uppercase Jira IDs anywhere in a title and removes repeated IDs', () => {
    assert.deepEqual(extractJiraIds('UIA-415144: add new banner'), ['UIA-415144']);
    assert.deepEqual(extractJiraIds('Draft: [LOC-12/UIA-415144] LOC-12; PRJ_2-42'), ['LOC-12', 'UIA-415144', 'PRJ_2-42']);
    assert.deepEqual(extractJiraIds('prefixUIA-12 UIA-12suffix UIA-12-34 _UIA-12 7UIA-12 uia-12 version-1'), []);
    assert.deepEqual(extractJiraIds('maintenance without an issue'), []);
    assert.deepEqual(extractJiraIds(null), []);
});

test('deduplicates by project and IID, preserving distinct projects with the same IID', () => {
    const a = mr('web/chc', 3018), b = mr('web/web', 3018);
    const row = m => ({ project_id: m.project, merge_request_iid: m.iid, mrUrl: m.url });
    const result = collectMrs([{ rows: [{ ...row(a), mrUrl: '' }, row(a), row(b)] }, { rows: [row(a), { merge_request_iid: null }] }]);
    assert.deepEqual(result, [a, b]);
    assert.equal(collectMrs([{ rows: [{ merge_request_iid: 44, project_id: 'unknown/repo' }] }])[0].url, '');
});

test('Jira links use the configured domain and preserve a Jira context path', () => {
    assert.equal(jiraUrl('UIA-415144'), 'https://jira.ringcentral.com/browse/UIA-415144');
    assert.equal(jiraUrl('LOC-12', 'jira.example.com/jira/'), 'https://jira.example.com/jira/browse/LOC-12');
    assert.equal(jiraUrl('LOC-12', 'javascript://alert(1)'), 'https://jira.ringcentral.com/browse/LOC-12');
});

test('Jira summary deduplicates across MRs, includes multiple tickets, and follows the current MR list', () => {
    const a = mr('web/chc', 3018), b = mr('web/web', 3018), c = mr('common/uns', 44);
    const details = {
        [a.key]: { status: 'ready', title: 'UIA-415144: banner' },
        [b.key]: { status: 'ready', title: '[UIA-415144, LOC-12] fix' },
        [c.key]: { status: 'error', title: 'IGNORED-1' },
    };
    const result = collectJiraTickets([a, b, c], details);
    assert.deepEqual(result.map(t => t.id), ['UIA-415144', 'LOC-12']);
    assert.equal(result[0].sources.length, 2);
    assert.deepEqual(collectJiraTickets([a], details).map(t => t.id), ['UIA-415144']);
    assert.deepEqual(collectJiraTickets([], details), []);
});

test('loader encodes project paths, shares pending requests and caches successful titles without credentials', async () => {
    const calls = [];
    let finish;
    const load = createTitleLoader((url, options) => {
        calls.push({ url, options });
        return new Promise(resolve => { finish = resolve; });
    });
    const item = mr('web/chc', 3018);
    const first = load(item, 'http://localhost:3001/');
    const duplicate = load(item, 'http://localhost:3001/');
    assert.equal(first, duplicate);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).searchParams.get('url'), 'https://git.ringcentral.com/api/v4/projects/web%2Fchc/merge_requests/3018');
    assert.deepEqual(calls[0].options.headers, { Accept: 'application/json' });
    assert.equal(calls[0].options.credentials, 'omit');
    finish(response('UIA-415144: banner'));
    assert.equal(await first, 'UIA-415144: banner');
    assert.equal(await load(item, 'http://localhost:3001'), 'UIA-415144: banner');
    assert.equal(calls.length, 1);
    const refreshed = load(item, 'http://localhost:3001', true);
    finish(response('LOC-12: changed title'));
    assert.equal(await refreshed, 'LOC-12: changed title');
    assert.equal(calls.length, 2);
});

test('loader limits concurrent requests and separates cache entries by project and proxy', async () => {
    const releases = [];
    let active = 0, peak = 0, calls = 0;
    const load = createTitleLoader(async () => {
        calls++; active++; peak = Math.max(peak, active);
        await new Promise(resolve => releases.push(resolve));
        active--;
        return response('LOC-12');
    }, { concurrency: 2 });
    const results = [load(mr('web/chc', 1), 'http://localhost:3001'), load(mr('web/web', 1), 'http://localhost:3001'), load(mr('web/chc', 1), 'http://localhost:3002')];
    assert.equal(calls, 2);
    releases.shift()();
    await tick();
    assert.equal(calls, 3);
    while (releases.length) releases.shift()();
    await Promise.all(results);
    assert.equal(peak, 2);
});

test('failures and invalid responses are retryable and do not hide successful MRs', async () => {
    const item = mr('web/chc', 3018);
    let tries = 0;
    const load = createTitleLoader(async () => ++tries === 1 ? { ok: false, status: 403 } : response('UIA-415144'));
    await assert.rejects(load(item, ''), /HTTP 403/);
    assert.equal(await load(item, ''), 'UIA-415144');
    for (const invalid of [{ redirect: '/users/sign_in' }, {}, { title: '' }]) {
        await assert.rejects(createTitleLoader(async () => ({ ok: true, json: async () => invalid }))(item, ''), /title unavailable/);
    }
    await assert.rejects(createTitleLoader(async () => ({ ok: true, json: async () => { throw new Error('HTML'); } }))(item, ''), /details unavailable/);
    await assert.rejects(load({ url: 'https://example.com/web/chc/-/merge_requests/3018' }, ''), /supported GitLab/);
});

test('a stalled request times out and releases the queue for the next MR', async () => {
    let calls = 0;
    const load = createTitleLoader((url, options) => {
        if (++calls > 1) return Promise.resolve(response('LOC-12'));
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }, { timeoutMs: 15, concurrency: 1 });
    const stalled = load(mr('web/chc', 1), '');
    const next = load(mr('web/chc', 2), '');
    await assert.rejects(stalled, /timed out/);
    assert.equal(await next, 'LOC-12');
});


test('a failed refresh invalidates the previous title so filtering cannot restore stale tickets', async () => {
    let calls = 0;
    const load = createTitleLoader(async () => {
        calls++;
        if (calls === 2) return { ok: false, status: 503 };
        return response(calls === 1 ? 'OLD-1' : 'NEW-2');
    });
    const item = mr('web/chc', 3018);
    assert.equal(await load(item, ''), 'OLD-1');
    await assert.rejects(load(item, '', true), /HTTP 503/);
    assert.equal(await load(item, ''), 'NEW-2');
    assert.equal(calls, 3);
});
