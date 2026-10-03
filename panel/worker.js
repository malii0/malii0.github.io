// panel/worker.js - Cloudflare Worker arka uç API
//
// GÜVENLİK VE YAPILANDIRMA NOTLARI:
// 1. GITHUB_TOKEN:
//    Yalnızca bu repoya (malii0/malii0.github.io) sınırlı, "Contents: Read and write"
//    yetkisi verilmiş bir Fine-grained GitHub Personal Access Token (PAT) kullanın.
//
// 2. BRUTE-FORCE & RATE LIMIT:
//    IP bazlı kilit mekanizması için wrangler.toml üzerinde RATE_LIMIT_KV binding'i gereklidir.
//
// 3. VERİ ŞEMASI:
//    data/photos.json içinde hem string hem de { filename, alt, location } formatını destekler.
//    iOS Shortcut yüklemesinde dosya kaydedildikten sonra data/photos.json'ın en başına unshift edilir.

const REPO = "malii0/malii0.github.io";

const ALLOWED_ORIGINS = [
  "https://malionurlucan.me",
"https://malii0.github.io",
];

const TYPE_PATHS = {
  home: "data/home.json",
  pages: "data/pages.json",
  notes: "data/notes.json",
  projects: "data/projects.json",
  reading: "data/reading.json",
  photos: "data/photos.json",
};

const SAFE_FILENAME = /^[a-zA-Z0-9_.-]+\.(jpe?g|png|webp)$/i;
const KNOWN_PAGE_KEYS = ["notes", "projects", "reading", "photography"];

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {};
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return headers;
}

function jsonResponse(request, body, status = 200) {
  const corsHeaders = getCorsHeaders(request);
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
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

function ghHeaders(env) {
  return {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    "User-Agent": "photo-uploader-worker",
    Accept: "application/vnd.github+json",
  };
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.byteLength; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

function isSafeUrlServer(url) {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim().toLowerCase();
  return (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("mailto:") ||
    (trimmed.startsWith("/") && !trimmed.startsWith("//"))
  );
}

async function checkAuth(request, body, env) {
  if (!env.PANEL_SECRET)
    return { ok: false, error: "PANEL_SECRET sunucuda yapılandırılmamış." };

  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const kvKey = `ratelimit:${clientIp}`;

  if (env.RATE_LIMIT_KV) {
    const rawState = await env.RATE_LIMIT_KV.get(kvKey);
    if (rawState) {
      try {
        const state = JSON.parse(rawState);
        const now = Date.now();
        if (state.lockedUntil && now < state.lockedUntil) {
          const remainingMins = Math.ceil((state.lockedUntil - now) / 60000);
          return {
            ok: false,
            error: `Çok fazla hatalı deneme yapıldı. Erişim geçici olarak engellendi. Lütfen ${remainingMins} dakika sonra tekrar deneyin.`,
            status: 429,
          };
        }
      } catch (e) {}
    }
  }

  const providedSecret = typeof body.secret === "string" ? body.secret : "";
  const isValid = timingSafeEqual(providedSecret, env.PANEL_SECRET);

  if (!isValid) {
    if (env.RATE_LIMIT_KV) {
      let attempts = 0;
      const rawState = await env.RATE_LIMIT_KV.get(kvKey);
      if (rawState) {
        try {
          const state = JSON.parse(rawState);
          attempts = state.attempts || 0;
        } catch (e) {}
      }
      attempts += 1;

      if (attempts >= 5) {
        const lockDuration = 15 * 60 * 1000;
        await env.RATE_LIMIT_KV.put(
          kvKey,
          JSON.stringify({ attempts, lockedUntil: Date.now() + lockDuration }),
                                    { expirationTtl: 15 * 60 },
        );
      } else {
        await env.RATE_LIMIT_KV.put(
          kvKey,
          JSON.stringify({ attempts, lockedUntil: null }),
                                    { expirationTtl: 10 * 60 },
        );
      }
    }
    return { ok: false, error: "Yetkisiz erişim.", status: 401 };
  }

  if (env.RATE_LIMIT_KV) {
    await env.RATE_LIMIT_KV.delete(kvKey);
  }

  return { ok: true };
}

async function getContentsFile(path, env) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}`,
    {
      headers: ghHeaders(env),
    },
  );
  if (!res.ok) {
    const errorText = await res.text();
    const err = new Error(
      `GitHub GET ${path} failed: ${res.status} ${errorText}`,
    );
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function putContentsFile(path, contentStr, sha, message, env) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: { ...ghHeaders(env), "Content-Type": "application/json" },
                          body: JSON.stringify({
                            message,
                            content: toBase64Utf8(contentStr),
                                               sha,
                                               branch: "main",
                          }),
    },
  );
  if (!res.ok) {
    const errorText = await res.text();
    const err = new Error(
      `GitHub PUT ${path} failed: ${res.status} ${errorText}`,
    );
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function handleGet(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse(request, { error: "Geçersiz JSON gövdesi." }, 400);
  }
  const auth = await checkAuth(request, body, env);
  if (!auth.ok)
    return jsonResponse(request, { error: auth.error }, auth.status || 401);

  const path = TYPE_PATHS[body.type];
  if (!path)
    return jsonResponse(
      request,
      { error: "Bilinmeyen tür: " + body.type },
      400,
    );

  try {
    const file = await getContentsFile(path, env);
    const data = JSON.parse(fromBase64Utf8(file.content));
    return jsonResponse(request, { ok: true, data });
  } catch (err) {
    return jsonResponse(request, { error: err.message }, 502);
  }
}

async function handleSave(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse(request, { error: "Geçersiz JSON gövdesi." }, 400);
  }
  const auth = await checkAuth(request, body, env);
  if (!auth.ok)
    return jsonResponse(request, { error: auth.error }, auth.status || 401);

  const path = TYPE_PATHS[body.type];
  if (!path)
    return jsonResponse(
      request,
      { error: "Bilinmeyen tür: " + body.type },
      400,
    );
  if (body.data === undefined)
    return jsonResponse(
      request,
      { error: "Eksik veri ('data' alanı zorunlu)." },
                        400,
    );

  let payload = body.data;

  // Validation: pages
  if (body.type === "pages") {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return jsonResponse(request, { error: "'pages' nesne (object) formatında olmalıdır." }, 400);
    }
    const cleanPages = {};
    for (const key of Object.keys(payload)) {
      if (!KNOWN_PAGE_KEYS.includes(key)) {
        return jsonResponse(request, { error: `Bilinmeyen sayfa anahtarı: ${key}` }, 400);
      }
      if (typeof payload[key] !== "string") {
        return jsonResponse(request, { error: `${key} açıklaması metin olmalıdır.` }, 400);
      }
      const trimmed = payload[key].trim();
      if (trimmed.length > 300) {
        return jsonResponse(request, { error: `${key} açıklaması en fazla 300 karakter olabilir.` }, 400);
      }
      cleanPages[key] = trimmed;
    }
    for (const key of KNOWN_PAGE_KEYS) {
      if (cleanPages[key] === undefined) {
        cleanPages[key] = "";
      }
    }
    payload = cleanPages;
  }

  // Validation: photos (supports backward compatibility with plain strings & objects)
  if (body.type === "photos") {
    if (!Array.isArray(payload)) {
      return jsonResponse(request, { error: "'photos' verisi bir liste olmalıdır." }, 400);
    }
    const cleanPhotos = [];
    for (let i = 0; i < payload.length; i++) {
      const item = payload[i];
      let filename = "";
      let alt = "";
      let location = "";

      if (typeof item === "string") {
        filename = item.trim();
      } else if (item && typeof item === "object") {
        filename = typeof item.filename === "string" ? item.filename.trim() : "";
        alt = typeof item.alt === "string" ? item.alt.trim().slice(0, 200) : "";
        location = typeof item.location === "string" ? item.location.trim().slice(0, 80) : "";
      } else {
        return jsonResponse(request, { error: `photos[${i}] geçersiz öğe biçimi.` }, 400);
      }

      if (!filename || !SAFE_FILENAME.test(filename)) {
        return jsonResponse(request, { error: `photos[${i}] geçersiz dosya adı: '${filename}'` }, 400);
      }
      cleanPhotos.push({ filename, alt, location });
    }
    payload = cleanPhotos;
  }

  // Validation: home socials URLs
  if (body.type === "home") {
    const socials = payload?.socials;
    if (Array.isArray(socials)) {
      for (let i = 0; i < socials.length; i++) {
        const item = socials[i];
        if (item.url && !isSafeUrlServer(item.url)) {
          return jsonResponse(
            request,
            {
              error: `Güvensiz URL tespit edildi (socials[${i}].url: '${item.url}'). Yalnızca http, https, mailto ve site içi göreli yollara izin verilir.`,
            },
            400,
          );
        }
      }
    }
  } else if (["notes", "projects", "reading"].includes(body.type)) {
    if (Array.isArray(payload)) {
      for (let i = 0; i < payload.length; i++) {
        const item = payload[i];
        if (item.url && !isSafeUrlServer(item.url)) {
          return jsonResponse(
            request,
            {
              error: `Güvensiz URL tespit edildi (${body.type}[${i}].url: '${item.url}'). Yalnızca http, https, mailto ve site içi göreli yollara izin verilir.`,
            },
            400,
          );
        }
      }
      payload = payload.map((entry) => ({
        ...entry,
        id:
        entry.id ||
        `${slugify(entry.title || "entry")}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      }));
    }
  }

  try {
    const current = await getContentsFile(path, env);
    const content = JSON.stringify(payload, null, 2) + "\n";
    await putContentsFile(
      path,
      content,
      current.sha,
      `Update ${body.type} via panel`,
      env,
    );
    return jsonResponse(request, { ok: true });
  } catch (err) {
    if (err.status === 409) {
      return jsonResponse(
        request,
        {
          error:
          "İçerik başka bir yerden güncellenmiş görünüyor (SHA çakışması). Lütfen sayfayı yeniden yükleyip tekrar deneyin.",
        },
        409,
      );
    }
    return jsonResponse(request, { error: err.message }, 502);
  }
}

async function handleUploadPhoto(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse(request, { error: "Geçersiz JSON gövdesi." }, 400);
  }
  const auth = await checkAuth(request, body, env);
  if (!auth.ok)
    return jsonResponse(request, { error: auth.error }, auth.status || 401);

  const { filename, base64 } = body;
  if (!filename || !SAFE_FILENAME.test(filename)) {
    return jsonResponse(request, { error: "Geçersiz dosya adı formatı." }, 400);
  }
  if (!base64)
    return jsonResponse(request, { error: "Görsel verisi eksik." }, 400);

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
      },
    );
    if (!res.ok)
      throw new Error(`GitHub PUT failed: ${res.status} ${await res.text()}`);
    return jsonResponse(request, { ok: true, filename });
  } catch (err) {
    return jsonResponse(request, { error: err.message }, 502);
  }
}

async function handleDeletePhoto(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse(request, { error: "Geçersiz JSON gövdesi." }, 400);
  }
  const auth = await checkAuth(request, body, env);
  if (!auth.ok)
    return jsonResponse(request, { error: auth.error }, auth.status || 401);

  const { filename } = body;
  if (!filename || !SAFE_FILENAME.test(filename)) {
    return jsonResponse(request, { error: "Geçersiz dosya adı formatı." }, 400);
  }

  try {
    let current;
    try {
      current = await getContentsFile(`img/photos/${filename}`, env);
    } catch (getErr) {
      if (getErr.status === 404) {
        return jsonResponse(
          request,
          {
            error: `Silinmek istenen fotoğraf GitHub deposunda bulunamadı (${filename}). Zaten silinmiş olabilir.`,
          },
          404,
        );
      }
      throw getErr;
    }

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
      },
    );

    if (!res.ok) {
      if (res.status === 409) {
        return jsonResponse(
          request,
          {
            error:
            "Dosya silinirken çakışma (409) oluştu. Dosya başka bir işlem tarafından değiştirilmiş olabilir.",
          },
          409,
        );
      }
      throw new Error(
        `GitHub DELETE failed: ${res.status} ${await res.text()}`,
      );
    }

    return jsonResponse(request, { ok: true });
  } catch (err) {
    return jsonResponse(request, { error: err.message }, 502);
  }
}

// iOS Shortcut Photo Uploader endpoint
async function handlePhotoUpload(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const providedSecret = request.headers.get("x-upload-secret") || "";
  const expectedSecret = env.UPLOAD_SECRET || "";
  if (!expectedSecret || !timingSafeEqual(providedSecret, expectedSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const buf = new Uint8Array(await request.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  const base64 = btoa(binary);

  const filename = `photo_${Date.now()}.jpg`;

  // 1. Upload raw photo to GitHub repository
  const ghRes = await fetch(
    `https://api.github.com/repos/${REPO}/contents/img/photos/${filename}`,
    {
      method: "PUT",
      headers: {
        Authorization: `token ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "photo-uploader-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `Upload photo ${filename}`,
        content: base64,
        branch: "main",
      }),
    },
  );

  if (!ghRes.ok) {
    return new Response(`GitHub error: ${ghRes.status} ${await ghRes.text()}`, {
      status: 500,
    });
  }

  // 2. Unshift registered entry to data/photos.json
  try {
    const photosFile = await getContentsFile("data/photos.json", env);
    const existingList = JSON.parse(fromBase64Utf8(photosFile.content));
    const normalized = Array.isArray(existingList) ? existingList : [];

    normalized.unshift({
      filename: filename,
      alt: "",
      location: "",
    });

    const updatedContent = JSON.stringify(normalized, null, 2) + "\n";
    await putContentsFile(
      "data/photos.json",
      updatedContent,
      photosFile.sha,
      `Register ${filename} via shortcut upload`,
      env,
    );
  } catch (regErr) {
    return new Response(
      `Photo uploaded as ${filename}, but failed to register in data/photos.json: ${regErr.message}`,
      { status: 207 },
    );
  }

  return new Response(`Uploaded: ${filename}`, { status: 200 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/panel/")) {
      const corsHeaders = getCorsHeaders(request);
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
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
        return handlePhotoUpload(request, env);
    }
  },
};
