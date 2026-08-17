// home.js - fills in tagline, about text, and social links from data/home.json
// so they can be edited via the panel without touching index.html.

function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function renderAboutText(text) {
    // Plain text with a lightweight [label](url) link syntax — everything
    // else is escaped, so no raw HTML is ever needed when editing.
    const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
    let lastIndex = 0;
    let match;
    let html = "";
    while ((match = linkPattern.exec(text)) !== null) {
        html += escapeHtml(text.slice(lastIndex, match.index));
        const label = escapeHtml(match[1]);
        const url = match[2];
        const isMail = url.startsWith("mailto:");
        const extraAttrs = isMail ? "" : ' target="_blank" rel="noopener"';
        html += `<a href="${escapeHtml(url)}"${extraAttrs} class="inline-link">${label}</a>`;
        lastIndex = linkPattern.lastIndex;
    }
    html += escapeHtml(text.slice(lastIndex));
    return html;
}

document.addEventListener("DOMContentLoaded", async function () {
    try {
        const res = await fetch("/data/home.json", { cache: "no-store" });
        if (!res.ok) throw new Error("fetch failed: " + res.status);
        const data = await res.json();

        const taglineEl = document.getElementById("js-tagline");
        if (taglineEl && data.tagline) taglineEl.textContent = data.tagline;

        const aboutEl = document.getElementById("js-about");
        if (aboutEl && data.about) {
            aboutEl.innerHTML = `<p>${renderAboutText(data.about)}</p>`;
        }

        const socialEl = document.getElementById("js-social");
        if (socialEl && Array.isArray(data.socials)) {
            socialEl.innerHTML = data.socials
                .map((s) => {
                    const isMail = (s.url || "").startsWith("mailto:");
                    const extraAttrs = isMail ? "" : ' target="_blank" rel="noopener"';
                    return `<a href="${escapeHtml(s.url)}"${extraAttrs} title="${escapeHtml(s.label)}" aria-label="${escapeHtml(s.label)}"><i class="${escapeHtml(s.icon)}"></i></a>`;
                })
                .join("");
        }
    } catch (err) {
        console.error("Failed to load home content, keeping static fallback.", err);
    }
});
