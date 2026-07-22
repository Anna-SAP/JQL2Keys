# JQL2Keys

A single-page tool that extracts translation keys from Jira L10N bugs. Given a JQL query, it fetches matching issues, parses their descriptions and comments, and outputs structured JSON mapping each issue to its target languages and translation keys.

## Quick Start

### 1. Start the CORS Proxy

```bash
node jira-cors-proxy.js
# or specify a custom port
node jira-cors-proxy.js 3002
```

The application server itself uses only Node.js built-in modules. Vue, JSZip,
and the compiled Tailwind stylesheet are bundled locally, so the UI also starts
without public CDN access.

### 2. Open the SPA

Open `jira-l10n-key-extractor.html` in your browser.

### 3. Configure & Run

| Field | Example |
|-------|---------|
| **Jira Domain** | `https://jira.ringcentral.com` |
| **Auth Mode** | PAT (Server) for Jira Server/Data Center |
| **Token** | Your Personal Access Token |
| **JQL** | `issue in linkedIssues(LOC-24605) AND issuetype in (Bug)` |

Make sure "Use CORS Proxy" is checked in Advanced Settings and points to `http://localhost:3001` (or your chosen port).

Click **Fetch & Parse**.

## Output Format

```json
{
  "LOC-24626": {
    "es-ES": [
      "RingCentral.uns.40f7566f...callQueueManagerLoginInfo__email_html__3460__en_US",
      "RingCentral.uns.7cfe2272...callQueueManagerLoginInfo__email_html__1210__en_US"
    ],
    "pt-BR": [
      "RingCentral.uns.7cfe2272...callQueueManagerLoginInfo__email_html__1210__en_US"
    ]
  }
}
```

## Features

- **Two auth modes** — Bearer token (PAT) for Jira Server/Data Center, Basic Auth for Jira Cloud
- **Paginated fetching** — handles large JQL result sets via `startAt` / `maxResults`
- **Smart language detection** — reads standalone `xx-YY` language headers in comments; falls back to extracting languages from the issue title for single-language bugs
- **ADF support** — handles both Jira wiki markup and Atlassian Document Format
- **3 view modes** — Cards (by issue), JSON preview, By Language (merged)
- **Test Parser** — paste sample text in the sidebar to verify parsing logic
- **Copy / Export** — one-click clipboard copy or JSON file download
- **Config persistence** — domain, email, JQL saved to localStorage

## CORS Handling

Browsers block direct cross-origin requests to Jira. Two options:

1. **Recommended**: Use the included `jira-cors-proxy.js` (zero-dependency Node.js proxy)
2. **Alternative**: Install a browser CORS extension (e.g. [Allow CORS](https://chrome.google.com/webstore/detail/allow-cors-access-control/lhobafahddgcelffkeicbaginigeejlf)) and uncheck "Use CORS Proxy" in Advanced Settings

## How to Get a PAT (Jira Server)

1. Go to your Jira profile → **Personal Access Tokens**
2. Click **Create token**, give it a name
3. Copy the token and paste it into the SPA

## Files

| File | Description |
|------|-------------|
| `jira-l10n-key-extractor.html` | SPA entry point (Vue 3 + precompiled TailwindCSS) |
| `jira-cors-proxy.js` | Zero-dependency Node.js CORS proxy server |

## Build

```bash
npm install -g @yao-pkg/pkg
npm test
npm run build
```

The generated browser dependencies are committed under `vendor/` and packaged
into the EXE, so runtime startup never depends on an external CDN. Their pinned
versions and upstream sources are recorded in `vendor/THIRD_PARTY.md`.
