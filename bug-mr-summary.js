'use strict';

// Shared by the offline SPA and Node tests; MR titles are fetched via the
// existing local proxy without forwarding the user's Jira credentials.
(function exposeBugMrSummary(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BugMrSummary = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createBugMrSummary() {
    const GITLAB_ORIGIN = 'https://git.ringcentral.com';
    const DEFAULT_JIRA = 'https://jira.ringcentral.com';

    function parseMrUrl(value) {
        try {
            const url = new URL(value);
            const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\/-\/merge_requests\/([1-9]\d*)\/?$/);
            if (url.origin !== GITLAB_ORIGIN || url.username || url.password || !match) return null;
            return { project: match[1], iid: match[2], url: GITLAB_ORIGIN + '/' + match[1] + '/-/merge_requests/' + match[2] };
        } catch { return null; }
    }

    function collectMrs(groups) {
        const byKey = new Map();
        for (const group of groups) {
            for (const row of group.rows) {
                const iid = String(row.merge_request_iid == null ? '' : row.merge_request_iid).trim();
                if (!iid) continue;
                const parsed = parseMrUrl(row.mrUrl);
                const project = parsed ? parsed.project : String(row.project_id || row.task_name || row.task_id || 'unknown').trim();
                // GitLab IIDs are unique only within a project.
                const key = JSON.stringify([project, iid]);
                const existing = byKey.get(key);
                if (!existing || (!existing.url && parsed)) {
                    byKey.set(key, { key, iid, project, url: parsed ? parsed.url : '' });
                }
            }
        }
        return [...byKey.values()];
    }

    function extractJiraIds(title) {
        // Require complete uppercase ticket keys, not substrings of identifiers
        // such as prefixUIA-123, UIA-123suffix or UIA-123-456.
        const matches = String(title || '').matchAll(/(?:^|[^A-Za-z0-9_-])([A-Z][A-Z0-9_]*-[1-9]\d*)(?![A-Za-z0-9_-])/g);
        return [...new Set([...matches].map(match => match[1]))];
    }

    function jiraUrl(id, domain) {
        let base = DEFAULT_JIRA;
        try {
            const raw = String(domain || '').trim();
            if (raw) {
                const url = new URL(raw.includes('://') ? raw : 'https://' + raw);
                if (/^https?:$/.test(url.protocol) && !url.username && !url.password) {
                    base = url.origin + url.pathname.replace(/\/+$/, '');
                }
            }
        } catch {}
        return base + '/browse/' + encodeURIComponent(id);
    }

    function collectJiraTickets(mrs, details, domain) {
        const tickets = new Map();
        for (const mr of mrs) {
            const detail = details[mr.key];
            if (!detail || detail.status !== 'ready') continue;
            for (const id of extractJiraIds(detail.title)) {
                if (!tickets.has(id)) tickets.set(id, { id, url: jiraUrl(id, domain), sources: [] });
                tickets.get(id).sources.push(mr.project + ' !' + mr.iid + ': ' + detail.title);
            }
        }
        return [...tickets.values()];
    }

    // Keep the associations visible: global deduplication is for the total,
    // while shared tickets appear beside every MR they actually belong to.
    function collectMrJiraRows(mrs, details, domain) {
        const byTicket = new Map(collectJiraTickets(mrs, details, domain).map(ticket => [ticket.id, ticket]));
        return mrs.map(mr => {
            const detail = details[mr.key];
            const status = !mr.url ? 'unsupported' : (detail ? detail.status : 'loading');
            const title = status === 'ready' ? detail.title : '';
            return {
                ...mr, status, title,
                error: status === 'error' ? detail.error : '',
                tickets: extractJiraIds(title).map(id => {
                    const ticket = byTicket.get(id);
                    return { ...ticket, mrCount: ticket.sources.length };
                }),
            };
        });
    }

    function createTitleLoader(fetchImpl, { timeoutMs = 15000, concurrency = 4 } = {}) {
        const cache = new Map();
        const pending = new Map();
        const queue = [];
        let active = 0;

        function drain() {
            while (active < concurrency && queue.length) {
                const { task, resolve, reject } = queue.shift();
                active++;
                task().then(resolve, reject).finally(() => { active--; drain(); });
            }
        }

        return function loadTitle(mr, proxyBase, force = false) {
            const parsed = parseMrUrl(mr.url);
            if (!parsed) return Promise.reject(new Error('No supported GitLab MR link available.'));
            const apiUrl = GITLAB_ORIGIN + '/api/v4/projects/' + encodeURIComponent(parsed.project) + '/merge_requests/' + parsed.iid;
            const requestUrl = String(proxyBase || '').replace(/\/+$/, '') + '/proxy?url=' + encodeURIComponent(apiUrl);
            if (pending.has(requestUrl)) return pending.get(requestUrl);
            if (!force && cache.has(requestUrl)) return Promise.resolve(cache.get(requestUrl));
            if (force) cache.delete(requestUrl);
            const promise = new Promise((resolve, reject) => {
                queue.push({ resolve, reject, task: async () => {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), timeoutMs);
                    try {
                        const response = await fetchImpl(requestUrl, {
                            headers: { Accept: 'application/json' },
                            credentials: 'omit',
                            signal: controller.signal,
                        });
                        if (!response.ok) throw new Error('GitLab request failed (HTTP ' + response.status + ').');
                        let data;
                        try { data = await response.json(); }
                        catch { throw new Error('MR details unavailable. Check GitLab access and the local proxy.'); }
                        if (!data || typeof data.title !== 'string' || !data.title.trim()) {
                            throw new Error('MR title unavailable. Check GitLab access and the local proxy.');
                        }
                        cache.set(requestUrl, data.title);
                        return data.title;
                    } catch (error) {
                        if (controller.signal.aborted) throw new Error('MR request timed out. Check your connection and retry.');
                        throw error;
                    } finally { clearTimeout(timer); }
                } });
            });
            pending.set(requestUrl, promise);
            const cleanup = () => pending.delete(requestUrl);
            promise.then(cleanup, cleanup);
            drain();
            return promise;
        };
    }

    return { parseMrUrl, collectMrs, extractJiraIds, jiraUrl, collectJiraTickets, collectMrJiraRows, createTitleLoader };
}));
