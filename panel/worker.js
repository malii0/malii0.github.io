// panel/worker.js - Cloudflare Worker arka uç API
//
// GÜVENLİK VE YAPILANDIRMA NOTLARI:
// 1. GITHUB_TOKEN UYARISI:
//    GITHUB_TOKEN olarak kesinlikle 'repo' yetkisine sahip classic PAT KULLANMAYIN.
//    Yalnızca bu repoya (malii0/malii0.github.io) sınırlı, sadece "Contents: Read and write"
//    yetkisi verilmiş bir Fine-grained GitHub Personal Access Token (PAT) kullanın.
//
// 2. BRUTE-FORCE & RATE LIMIT:
//    IP bazlı kilit mekanizması için wrangler.toml üzerinde RATE_LIMIT_KV binding'i tanımlanmalıdır:
//    [[kv_namespaces]]
//    binding = "RATE_LIMIT_KV"
//    id = "<KV_NAMESPACE_ID>"
//    KV eventual consistency nedeniyle tam koruma için Cloudflare Dashboard WAF / Rate Limiting
//    kurallarının da devreye alınması önerilir.
//
// 3. VERİ ŞEMASI:
//    Worker, data/photos.json içindeki { filename, alt } nesne yapısından bağımsız çalışır;
//    gelen veriyi doğrudan JSON formatında işleyip repoya yazar.

const REPO = "malii0/malii0.github.io";

const ALLOWED_ORIGINS = [
  "https://malionurlucan.me",
  "https://malii0.github.io",
];

const TYPE_PATHS = {
  home: "data/home.json",
  notes: "data/notes.json",
  projects: "data/projects.json",
  reading: "data/reading.json",
  photos: "data/photos.json",
};

const SAFE_FILENAME = /^[a-zA-Z0-9_.-]+\.(jpe?g|png|webp)$/i;

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

  // Server-side URL Güvenlik Doğrulaması (Defense in Depth)
  if (body.type === "home") {
    const socials = body.data?.socials;
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
    if (Array.isArray(body.data)) {
      for (let i = 0; i < body.data.length; i++) {
        const item = body.data[i];
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
    }
  }

  try {
    const current = await getContentsFile(path, env);

    let payload = body.data;
    if (
      ["notes", "projects", "reading"].includes(body.type) &&
      Array.isArray(payload)
    ) {
      payload = payload.map((entry) => ({
        ...entry,
        id:
          entry.id ||
          `${slugify(entry.title || "entry")}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      }));
    }

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
