/**********************************************************************
 *  ShyHurricane – Chrome MV-3   (Debugger-API implementation)
 **********************************************************************/

/* ---------- Config & persisted settings ---------- */
let DOMAINS_IN_SCOPE = [];
let MCP_SERVER_URL = "http://localhost:8000";
const INDEX_PATH = "/index";

chrome.storage.local.get(["mcpServerUrl", "domainsInScope"]).then(items => {
    if (items.mcpServerUrl) MCP_SERVER_URL = items.mcpServerUrl;
    if (items.domainsInScope) DOMAINS_IN_SCOPE = items.domainsInScope;
});

chrome.storage.local.onChanged.addListener(changes => {
    if (changes.mcpServerUrl) MCP_SERVER_URL = changes.mcpServerUrl.newValue || MCP_SERVER_URL;
    if (changes.domainsInScope) DOMAINS_IN_SCOPE = changes.domainsInScope.newValue || [];
});

/* ---------- Helpers ---------- */
const SKIP_PREFIXES = ["audio/", "video/", "font/", "binary/"];
const SKIP_TYPES = new Set([
    "application/octet-stream", "application/pdf", "application/x-pdf",
    "application/zip", "application/x-zip-compressed", "application/x-protobuf",
    "application/font-woff", "application/font-woff2", "application/vnd.ms-fontobject"
]);

const urlInScope = url => {
    if (url.startsWith(MCP_SERVER_URL)) return false;
    if (DOMAINS_IN_SCOPE.length === 0) return true;
    try {
        const host = new URL(url).hostname;
        return DOMAINS_IN_SCOPE.some(d => host.endsWith(d));
    } catch {
        return false;
    }
};

const shouldSkip = ct => {
    if (!ct) return false;
    const lower = ct.toLowerCase();
    if (lower.includes("+json") || lower.includes("+xml")) return false;
    if (SKIP_PREFIXES.some(p => lower.startsWith(p))) return true;
    if (lower.startsWith("image/") && !lower.includes("svg")) return true;
    return SKIP_TYPES.has(lower);
};

const toKatanaHeaders = obj => {
    const out = {};
    for (const [name, value] of Object.entries(obj || {})) {
        const k = name.toLowerCase();
        out[k] = out[k] ? `${out[k]};${value}` : value;
    }
    return out;
};

/* ---------- Target management ---------- */
const PROTOCOL_VERSION = "1.3";
const targets = new Map();          // tabId → {attached, requests: Map()}

function attachToTab(tabId) {
    const target = {tabId};
    chrome.debugger.attach(target, PROTOCOL_VERSION, () => {
        if (chrome.runtime.lastError) return;          // tab might have closed meanwhile
        chrome.debugger.sendCommand(target, "Network.enable");
        targets.set(tabId, {target, requests: new Map()});
    });
}

function detachFromTab(tabId) {
    const entry = targets.get(tabId);
    if (entry) {
        chrome.debugger.detach(entry.target, () => {
        });
        targets.delete(tabId);
    }
}

/* attach to all existing + future tabs */
chrome.tabs.query({}, tabs => tabs.forEach(t => attachToTab(t.id)));
chrome.tabs.onCreated.addListener(tab => attachToTab(tab.id));
chrome.tabs.onRemoved.addListener((tabId) => detachFromTab(tabId));

/* ---------- Debugger-event handler ---------- */
chrome.debugger.onEvent.addListener((source, method, params) => {
    const entry = targets.get(source.tabId);
    if (!entry) return;

    const reqs = entry.requests;

    switch (method) {
        /* ---- REQUEST ---- */
        case "Network.requestWillBeSent": {
            const {requestId, request} = params;
            if (!urlInScope(request.url)) return;
            reqs.set(requestId, {
                method: request.method,
                endpoint: request.url,
                reqHeaders: {},        // filled later
                reqBody: request.postData,
                resHeaders: {},
                status: undefined
            });
            break;
        }

        case "Network.requestWillBeSentExtraInfo": {
            const r = reqs.get(params.requestId);
            if (r) r.reqHeaders = params.headers;
            break;
        }

        /* ---- RESPONSE ---- */
        case "Network.responseReceived": {
            const r = reqs.get(params.requestId);
            if (r) {
                r.status = params.response.status;
                r.resHeaders = params.response.headers;
            }
            break;
        }

        case "Network.loadingFinished": {
            const r = reqs.get(params.requestId);
            if (!r) break;

            const ct = r.resHeaders["content-type"] || r.resHeaders["Content-Type"];
            if (shouldSkip(ct)) {
                reqs.delete(params.requestId);
                break;
            }

            chrome.debugger.sendCommand(
                source,
                "Network.getResponseBody",
                {requestId: params.requestId},
                (bodyObj) => {
                    const responseBody = bodyObj
                        ? (bodyObj.base64Encoded
                            ? atob(bodyObj.body)           // decode if base64
                            : bodyObj.body)
                        : undefined;

                    flushEntry(r, responseBody);
                    reqs.delete(params.requestId);
                }
            );
            break;
        }

        /* ---- Error / redirect cleanup ---- */
        case "Network.loadingFailed":
        case "Network.webSocketClosed":
        case "Network.webSocketHandshakeResponseReceived":
            reqs.delete(params.requestId);
            break;
    }
});

/* ---------- Output helper ---------- */
function flushEntry(r, responseBody) {
    const entry = {
        timestamp: new Date().toISOString(),
        request: {
            method: r.method,
            endpoint: r.endpoint,
            headers: toKatanaHeaders(r.reqHeaders),
            body: r.reqBody
        },
        response: {
            status_code: r.status,
            headers: toKatanaHeaders(r.resHeaders),
            body: responseBody
        }
    };

    fetch(MCP_SERVER_URL + INDEX_PATH, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(entry)
    }).catch(err => console.error("[ShyHurricane]", err));
}
