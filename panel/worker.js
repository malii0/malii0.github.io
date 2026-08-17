const REPO = "malii0/malii0.github.io";

const TYPE_PATHS = {
  home: "data/home.json",
  notes: "data/notes.json",
  projects: "data/projects.json",
  reading: "data/reading.json",
  photos: "data/photos.json",
};

const SAFE_FILENAME = /^[a-zA-Z0-9_.-]+\.(jpe?g|png|webp)$/i;

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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function ghHeaders(env) {
  return {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    "User-Agent": "photo-uploader-worker",
    Accept: "application/vnd.github+json",
  };
}

function checkAuth(body, env) {
  return !!env.PANEL_SECRET && body.secret === env.PANEL_SECRET;
}

async function getContentsFile(path, env) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: ghHeaders(env),
  });
  if (!res.ok) {
    throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json(); // { content (base64), sha, ... }
}

async function putContentsFile(path, contentStr, sha, message, env) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: toBase64Utf8(contentStr),
      sha,
      branch: "main",
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ---- /panel/get : return current data for a given type ----
async function handleGet(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!checkAuth(body, env)) return jsonResponse({ error: "Unauthorized" }, 401);

  const path = TYPE_PATHS[body.type];
  if (!path) return jsonResponse({ error: "Unknown type: " + body.type }, 400);

  try {
    const file = await getContentsFile(path, env);
    const data = JSON.parse(fromBase64Utf8(file.content));
    return jsonResponse({ ok: true, data });
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }
}

// ---- /panel/save : overwrite a data file with a new array/object ----
async function handleSave(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!checkAuth(body, env)) return jsonResponse({ error: "Unauthorized" }, 401);

  const path = TYPE_PATHS[body.type];
  if (!path) return jsonResponse({ error: "Unknown type: " + body.type }, 400);
  if (body.data === undefined) return jsonResponse({ error: "Missing data" }, 400);

  try {
    const current = await getContentsFile(path, env);

    // Auto-generate ids for any new entries (notes/projects/reading) that
    // don't have one yet, so the panel doesn't have to worry about it.
    let payload = body.data;
    if (["notes", "projects", "reading"].includes(body.type) && Array.isArray(payload)) {
      payload = payload.map((entry) => ({
        ...entry,
        id: entry.id || `${slugify(entry.title || "entry")}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      }));
    }

    const content = JSON.stringify(payload, null, 2) + "\n";
    await putContentsFile(path, content, current.sha, `Update ${body.type} via panel`, env);
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }
}

// ---- /panel/upload-photo : commit a single image file (base64) ----
async function handleUploadPhoto(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!checkAuth(body, env)) return jsonResponse({ error: "Unauthorized" }, 401);

  const { filename, base64 } = body;
  if (!filename || !SAFE_FILENAME.test(filename)) {
    return jsonResponse({ error: "Invalid filename" }, 400);
  }
  if (!base64) return jsonResponse({ error: "Missing image data" }, 400);

  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/contents/img/photos/${filename}`,
      {
        method: "PUT",
        headers: { ...ghHeaders(env), "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Upload photo ${filename} via panel`,
          content: base64,
          branch: "main",
        }),
      }
    );
    if (!res.ok) throw new Error(`GitHub PUT failed: ${res.status} ${await res.text()}`);
    return jsonResponse({ ok: true, filename });
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }
}

// ---- /panel/delete-photo : remove an image file from the repo ----
async function handleDeletePhoto(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!checkAuth(body, env)) return jsonResponse({ error: "Unauthorized" }, 401);

  const { filename } = body;
  if (!filename || !SAFE_FILENAME.test(filename)) {
    return jsonResponse({ error: "Invalid filename" }, 400);
  }

  try {
    const current = await getContentsFile(`img/photos/${filename}`, env);
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/contents/img/photos/${filename}`,
      {
        method: "DELETE",
        headers: { ...ghHeaders(env), "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Delete photo ${filename} via panel`,
          sha: current.sha,
          branch: "main",
        }),
      }
    );
    if (!res.ok) throw new Error(`GitHub DELETE failed: ${res.status} ${await res.text()}`);
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }
}

// Existing photo upload flow (used by the iOS Shortcut), completely unchanged.
async function handlePhotoUpload(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (request.headers.get("x-upload-secret") !== env.UPLOAD_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const buf = new Uint8Array(await request.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  const base64 = btoa(binary);

  const filename = `photo_${Date.now()}.jpg`;
  const ghRes = await fetch(
    `https://api.github.com/repos/${REPO}/contents/img/photos/${filename}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `token ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "photo-uploader-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `Upload photo ${filename}`,
        content: base64,
        branch: "main",
      }),
    }
  );

  if (!ghRes.ok) {
    return new Response(`GitHub error: ${ghRes.status} ${await ghRes.text()}`, { status: 500 });
  }
  return new Response(`Uploaded: ${filename}`, { status: 200 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/panel/")) {
      return jsonResponse({}, 204);
    }

    switch (url.pathname) {
      case "/panel/get":
        return handleGet(request, env);
      case "/panel/save":
        return handleSave(request, env);
      case "/panel/upload-photo":
        return handleUploadPhoto(request, env);
      case "/panel/delete-photo":
        return handleDeletePhoto(request, env);
      default:
        // Anything else (the base URL your Shortcut already posts to)
        // keeps working exactly as before.
        return handlePhotoUpload(request, env);
    }
  },
};
