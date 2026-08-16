/**
 * Cloudflare Worker: content panel backend.
 *
 * Receives a POST from /panel/ with a new note/project/read-watch entry,
 * and commits it to data/<type>.json in the GitHub repo via the
 * GitHub Contents API — same idea as the existing photo-upload Shortcut,
 * just for text entries instead of images.
 *
 * Deploy this as a Cloudflare Worker and set these three secrets
 * (Workers dashboard -> your worker -> Settings -> Variables):
 *
 *   GITHUB_TOKEN   - a fine-grained GitHub PAT with "Contents: read and
 *                    write" access scoped to ONLY the malii0.github.io repo
 *   GITHUB_REPO    - "malii0/malii0.github.io"
 *   PANEL_SECRET   - a password you choose, entered in the panel on your phone
 */

const ALLOWED_TYPES = {
  notes: "data/notes.json",
  projects: "data/projects.json",
  reading: "data/reading.json",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function slugify(title) {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 48) || "entry"
  );
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64Utf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return jsonResponse({}, 204);
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const { secret, type, title, url, meta, desc, badge } = body;

    if (!env.PANEL_SECRET || secret !== env.PANEL_SECRET) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    if (!ALLOWED_TYPES[type]) {
      return jsonResponse({ error: "Unknown type: " + type }, 400);
    }
    if (!title || !title.trim()) {
      return jsonResponse({ error: "Title is required" }, 400);
    }

    const path = ALLOWED_TYPES[type];
    const apiBase = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
    const ghHeaders = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "content-panel-worker",
      Accept: "application/vnd.github+json",
    };

    // 1. Fetch current file (need its sha to update it)
    const getRes = await fetch(apiBase, { headers: ghHeaders });
    if (!getRes.ok) {
      return jsonResponse(
        { error: "Failed to read current data file", detail: await getRes.text() },
        502
      );
    }
    const getData = await getRes.json();
    const currentEntries = JSON.parse(fromBase64Utf8(getData.content));

    // 2. Build the new entry
    const newEntry = {
      id: `${slugify(title)}-${Date.now().toString(36)}`,
      title: title.trim(),
      url: url && url.trim() ? url.trim() : null,
      meta: meta ? meta.trim() : "",
      desc: desc ? desc.trim() : "",
    };
    if (type === "notes" && badge && badge.trim()) {
      newEntry.badge = badge.trim();
    }

    // 3. Prepend (newest first) and write back
    const updatedEntries = [newEntry, ...currentEntries];
    const updatedContent = JSON.stringify(updatedEntries, null, 2) + "\n";

    const putRes = await fetch(apiBase, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Add ${type} entry via panel: ${newEntry.title}`,
        content: toBase64Utf8(updatedContent),
        sha: getData.sha,
        branch: "main",
      }),
    });

    if (!putRes.ok) {
      return jsonResponse(
        { error: "Failed to commit new entry", detail: await putRes.text() },
        502
      );
    }

    return jsonResponse({ ok: true, entry: newEntry });
  },
};
