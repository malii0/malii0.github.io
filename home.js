// home.js - fills in tagline, about text, and social links from data/home.json
// uses escapeHtml and isSafeUrl from /utils.js

function renderAboutText(text) {
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match;
  let html = "";
  while ((match = linkPattern.exec(text)) !== null) {
    html += escapeHtml(text.slice(lastIndex, match.index));
    const label = escapeHtml(match[1]);
    const rawUrl = match[2].trim();
    if (isSafeUrl(rawUrl)) {
      const isMail = rawUrl.toLowerCase().startsWith("mailto:");
      const extraAttrs = isMail ? "" : ' target="_blank" rel="noopener"';
      html += `<a href="${escapeHtml(rawUrl)}"${extraAttrs} class="inline-link">${label}</a>`;
    } else {
      html += `<a href="#" class="inline-link">${label}</a>`;
    }
    lastIndex = linkPattern.lastIndex;
  }
  html += escapeHtml(text.slice(lastIndex));
  return html;
}

document.addEventListener("DOMContentLoaded", async function () {
  try {
    const res = await fetch("/data/home.json");
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
          const safe = isSafeUrl(s.url);
          const href = safe ? escapeHtml(s.url) : "#";
          const isMail =
            safe && (s.url || "").toLowerCase().startsWith("mailto:");
          const extraAttrs = isMail ? "" : ' target="_blank" rel="noopener"';
          return `<a href="${href}"${extraAttrs} title="${escapeHtml(s.label)}" aria-label="${escapeHtml(s.label)}"><i class="${escapeHtml(s.icon)}"></i></a>`;
        })
        .join("");
    }
  } catch (err) {
    console.error("Failed to load home content, keeping static fallback.", err);
  }
});
