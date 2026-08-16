// list.js - renders entry-item lists from a JSON data file.
// Used by /notes/, /projects/, /reading/ so new entries can be added
// via the panel without touching HTML.

function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

async function renderEntryList(containerId, jsonPath, opts = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    try {
        const res = await fetch(jsonPath, { cache: "no-store" });
        if (!res.ok) throw new Error("fetch failed: " + res.status);
        const entries = await res.json();

        if (!Array.isArray(entries) || entries.length === 0) {
            container.innerHTML = `<p class="empty-note">${escapeHtml(opts.emptyMessage || "Nothing here yet, check back soon.")}</p>`;
            return;
        }

        container.innerHTML = entries.map(e => {
            const title = escapeHtml(e.title);
            const meta = escapeHtml(e.meta);
            const desc = escapeHtml(e.desc);
            const badge = e.badge ? ` <span class="status-badge">${escapeHtml(e.badge)}</span>` : "";

            const titleHtml = e.url
                ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener" class="entry-title">${title}${badge}</a>`
                : `<span class="entry-title" style="color: var(--heading-color);">${title}${badge}</span>`;

            return `
            <div class="entry-item">
                ${titleHtml}
                ${meta ? `<span class="entry-meta">${meta}</span>` : ""}
                ${desc ? `<p class="entry-desc">${desc}</p>` : ""}
            </div>`;
        }).join("");
    } catch (err) {
        console.error("Failed to load " + jsonPath, err);
        container.innerHTML = `<p class="empty-note">Unable to load content right now.</p>`;
    }
}
