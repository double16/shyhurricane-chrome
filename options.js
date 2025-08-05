const urlField = document.getElementById("mcp-url");
const domField = document.getElementById("domains");
const statusLbl = document.getElementById("status");

chrome.storage.local.get(["mcpServerUrl", "domainsInScope"]).then(({mcpServerUrl, domainsInScope}) => {
    if (mcpServerUrl) urlField.value = mcpServerUrl;
    if (domainsInScope) domField.value = domainsInScope.join(",");
});

document.getElementById("opts").addEventListener("submit", e => {
    e.preventDefault();
    const mcpUrl = urlField.value.trim();
    const domains = domField.value.split(",").map(s => s.trim()).filter(Boolean);

    chrome.storage.local.set({mcpServerUrl: mcpUrl, domainsInScope: domains})
        .then(() => {
            statusLbl.textContent = "Saved!";
            setTimeout(() => statusLbl.textContent = "", 1500);
        });
});
