// utils.js - Shared utilities, XSS escaping, safe URL validation, photo normalization, and page intro loader

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isSafeUrl(url) {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim().toLowerCase();
  return (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("mailto:") ||
    (trimmed.startsWith("/") && !trimmed.startsWith("//"))
  );
}

function normalizePhotoEntry(entry) {
  if (typeof entry === "string") {
    return {
      filename: entry.trim(),
      alt: "",
      location: "",
    };
  }
  if (entry && typeof entry === "object") {
    return {
      filename: typeof entry.filename === "string" ? entry.filename.trim() : "",
      alt: typeof entry.alt === "string" ? entry.alt.trim() : "",
      location: typeof entry.location === "string" ? entry.location.trim() : "",
    };
  }
  return { filename: "", alt: "", location: "" };
}

async function loadPageIntro(pageKey) {
  const introEl = document.querySelector(".page-intro");
  if (!introEl || !pageKey) return;

  try {
    const res = await fetch("/data/pages.json");
    if (!res.ok) return;
    const pages = await res.json();
    if (pages && typeof pages[pageKey] === "string" && pages[pageKey].trim()) {
      introEl.textContent = pages[pageKey].trim();
    }
  } catch (e) {
    // Retain existing HTML text content on failure
  }
}
