// panel/worker.js - Cloudflare Worker arka uç API
//
// ÖNEMLİ DAĞITIM (DEPLOYMENT) VE KISAYOL (iOS SHORTCUT) NOTU:
// - Bu dosya (panel/worker.js) GitHub Pages tarafından otomatik olarak çalıştırılmaz veya dağıtılmaz;
//   yapılan değişikliklerin etkili olması için Cloudflare Workers'a ayrıca deploy edilmesi gerekir.
// - iOS Shortcut fotoğraf yükleme uç noktası yalnızca açık olarak `/upload` yolunu kabul eder
//   (örn. https://photo-uploader.m-alionurlucan.workers.dev/upload). Kısayol (Shortcut) içindeki URL'nin
//   `/upload` olarak güncellenmesi gerekmektedir; bilinmeyen diğer tüm yollar 404 döndürür.
//
// GÜVENLİK VE YAPILANDIRMA NOTLARI:
// 1. GITHUB_TOKEN:
//    Yalnızca bu repoya (malii0/malii0.github.io) sınırlı, "Contents: Read and write"
//    yetkisi verilmiş bir Fine-grained GitHub Personal Access Token (PAT) kullanın.
//
// 2. BRUTE-FORCE & RATE LIMIT:
//    IP bazlı kilit mekanizması için wrangler.toml üzerinde RATE_LIMIT_KV binding'i zorunludur.
//    RATE_LIMIT_KV bağlı değilse kimlik doğrulama fail-closed olarak reddedilir.
//
// 3. VERİ ŞEMASI:
//    data/photos.json içinde hem string hem de { filename, alt, location } formatını destekler.
//    iOS Shortcut yüklemesinde dosya kaydedildikten sonra data/photos.json'ın en başına unshift edilir.

const REPO = "malii0/malii0.github.io";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_PHOTO_DIMENSION = 20000;

const ALLOWED_ORIGINS = [
  "https://malionurlucan.me",
  "https://malionurlucan.com",
  "https://malii0.github.io",
];

const TYPE_PATHS = {
  home: "data/home.json",
  pages: "data/pages.json",
  notes: "data/notes.json",
  projects: "data/projects.json",
  photos: "data/photos.json",
};

const SAFE_FILENAME = /^[a-zA-Z0-9_.-]+\.(jpe?g|png|webp)$/i;
const KNOWN_PAGE_KEYS = ["notes", "projects", "photography"];

function detectImageType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  // JPEG: FF D8 FF
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "jpg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

function uint8ToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunkSize),
    );
  }
  return btoa(binary);
}

// Minimal JPEG segment parser. Returns { bytes, width, height } where bytes is the
// file rebuilt without metadata (APP0 JFIF, ICC APP2 and Adobe APP14 are kept; a
// minimal Orientation-only EXIF APP1 is written back when the orientation is 2-8)
// and width/height match the displayed (post-orientation) image. Returns null when
// the structure cannot be parsed.
function processJpeg(bytes) {
  const len = bytes.length;
  if (len < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  const hasId = (start, end, id) => {
    if (end - start < id.length) return false;
    for (let k = 0; k < id.length; k++) {
      if (bytes[start + k] !== id.charCodeAt(k)) return false;
    }
    return true;
  };

  const chunks = [bytes.subarray(0, 2)];
  let insertAt = 1; // index in chunks where the Orientation APP1 goes
  let kept = 0;
  let width = 0;
  let height = 0;
  let orientation = 1;
  let sawExif = false;
  let sawScan = false;
  let sawEoi = false;
  let pos = 2;

  while (pos < len) {
    if (bytes[pos] !== 0xff) return null;
    while (pos < len && bytes[pos] === 0xff) pos++; // fill bytes
    if (pos >= len) return null;
    const marker = bytes[pos++];

    if (marker === 0xd9) {
      if (!sawScan) return null;
      chunks.push(bytes.subarray(pos - 2, pos));
      sawEoi = true;
      break;
    }
    // Standalone markers without a length field
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      return null;
    }

    if (pos + 2 > len) return null;
    const segLen = (bytes[pos] << 8) | bytes[pos + 1];
    if (segLen < 2 || pos + segLen > len) return null;
    const dataStart = pos + 2;
    const segEnd = pos + segLen;
    const segStart = pos - 2; // includes 0xFF + marker
    pos = segEnd;

    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    let keep = true;

    if (isSof) {
      if (segLen < 8) return null;
      const h = (bytes[dataStart + 1] << 8) | bytes[dataStart + 2];
      const w = (bytes[dataStart + 3] << 8) | bytes[dataStart + 4];
      if (!w || !h) return null;
      if (!width) {
        width = w;
        height = h;
      }
    } else if (marker >= 0xe0 && marker <= 0xef) {
      if (marker === 0xe0) keep = hasId(dataStart, segEnd, "JFIF\0");
      else if (marker === 0xe2) keep = hasId(dataStart, segEnd, "ICC_PROFILE\0");
      else if (marker === 0xee) keep = hasId(dataStart, segEnd, "Adobe");
      else keep = false;

      if (marker === 0xe1 && !sawExif && hasId(dataStart, segEnd, "Exif\0\0")) {
        sawExif = true;
        orientation = readExifOrientation(bytes, dataStart + 6, segEnd);
      }
    } else if (marker === 0xfe) {
      keep = false;
    }

    if (keep) {
      chunks.push(bytes.subarray(segStart, segEnd));
      kept++;
      if (marker === 0xe0 && kept === 1) insertAt = chunks.length;
    }

    if (marker === 0xda) {
      if (!width) return null;
      sawScan = true;
      // Entropy-coded data: runs until the next real marker
      const scanStart = pos;
      while (pos < len) {
        if (bytes[pos] === 0xff) {
          const nxt = bytes[pos + 1];
          if (nxt === undefined) return null;
          if (nxt === 0x00 || (nxt >= 0xd0 && nxt <= 0xd7)) {
            pos += 2;
            continue;
          }
          if (nxt === 0xff) {
            pos++;
            continue;
          }
          break;
        }
        pos++;
      }
      if (pos >= len) return null;
      chunks.push(bytes.subarray(scanStart, pos));
    }
  }

  if (!sawEoi || !width) return null;

  if (orientation > 1) {
    // SOI-adjacent minimal APP1: "Exif\0\0" + big-endian TIFF with a single Orientation tag
    chunks.splice(
      insertAt,
      0,
      new Uint8Array([
        0xff, 0xe1, 0x00, 0x22,
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
        0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
        0x00, 0x01,
        0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
      ]),
    );
  }

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }

  const swap = orientation >= 5 && orientation <= 8;
  return {
    bytes: out,
    width: swap ? height : width,
    height: swap ? width : height,
  };
}

// Reads EXIF Orientation (1-8) from a TIFF block; returns 1 if missing or malformed.
function readExifOrientation(bytes, tiff, end) {
  if (tiff + 8 > end) return 1;
  const le = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  if (!le && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return 1;
  const u16 = (o) => (le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
  const u32 = (o) =>
    le
      ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
      : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return 1;
    if (u16(e) === 0x0112) {
      if (u16(e + 2) !== 3 || u32(e + 4) !== 1) return 1;
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

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
  return uint8ToBase64(bytes);
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

async function checkAuthWithSecret(request, providedSecret, expectedSecret, env) {
  if (!expectedSecret) {
    console.error("Auth secret is not configured on the server.");
    return {
      ok: false,
      error: "Sunucu kimlik doğrulama yapılandırması eksik.",
      status: 500,
    };
  }

  if (!env.RATE_LIMIT_KV) {
    console.error("RATE_LIMIT_KV binding is missing; failing closed.");
    return {
      ok: false,
      error: "Sunucu güvenlik yapılandırması eksik (rate limit).",
      status: 500,
    };
  }

  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const kvKey = `ratelimit:${clientIp}`;

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

  const secretStr = typeof providedSecret === "string" ? providedSecret : "";
  const isValid = timingSafeEqual(secretStr, expectedSecret);

  if (!isValid) {
    let attempts = 0;
    const currentRawState = await env.RATE_LIMIT_KV.get(kvKey);
    if (currentRawState) {
      try {
        const state = JSON.parse(currentRawState);
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
    return { ok: false, error: "Yetkisiz erişim.", status: 401 };
  }

  await env.RATE_LIMIT_KV.delete(kvKey);

  return { ok: true };
}

async function checkAuth(request, body, env) {
  return checkAuthWithSecret(
    request,
    body ? body.secret : "",
    env.PANEL_SECRET,
    env,
  );
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
    console.error("handleGet error:", err);
    return jsonResponse(
      request,
      { error: "İçerik alınırken sunucu hatası oluştu." },
      502,
    );
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
      let width = null;
      let height = null;

      if (typeof item === "string") {
        filename = item.trim();
      } else if (item && typeof item === "object") {
        filename = typeof item.filename === "string" ? item.filename.trim() : "";
        alt = typeof item.alt === "string" ? item.alt.trim().slice(0, 200) : "";
        location = typeof item.location === "string" ? item.location.trim().slice(0, 80) : "";
        for (const dim of ["width", "height"]) {
          const v = item[dim];
          if (v === undefined || v === null) continue;
          if (!Number.isInteger(v) || v < 1 || v > MAX_PHOTO_DIMENSION) {
            return jsonResponse(request, { error: `photos[${i}].${dim} geçersiz (1-${MAX_PHOTO_DIMENSION} arası tam sayı olmalı).` }, 400);
          }
          if (dim === "width") width = v;
          else height = v;
        }
      } else {
        return jsonResponse(request, { error: `photos[${i}] geçersiz öğe biçimi.` }, 400);
      }

      if (!filename || !SAFE_FILENAME.test(filename)) {
        return jsonResponse(request, { error: `photos[${i}] geçersiz dosya adı: '${filename}'` }, 400);
      }
      const entry = { filename, alt, location };
      if (width !== null && height !== null) {
        entry.width = width;
        entry.height = height;
      }
      cleanPhotos.push(entry);
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
  } else if (["notes", "projects"].includes(body.type)) {
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
    console.error("handleSave error:", err);
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
    return jsonResponse(
      request,
      { error: "İçerik kaydedilirken sunucu hatası oluştu." },
      502,
    );
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
    console.error("handleDeletePhoto error:", err);
    return jsonResponse(
      request,
      { error: "Fotoğraf silinirken sunucu hatası oluştu." },
      502,
    );
  }
}

// iOS Shortcut Photo Uploader endpoint (/upload)
async function handlePhotoUpload(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const providedSecret = request.headers.get("x-upload-secret") || "";
  const auth = await checkAuthWithSecret(
    request,
    providedSecret,
    env.UPLOAD_SECRET,
    env,
  );
  if (!auth.ok) {
    return new Response(auth.error, { status: auth.status || 401 });
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_UPLOAD_BYTES) {
    return new Response("Payload too large (max 10 MB)", { status: 413 });
  }

  let buf = new Uint8Array(await request.arrayBuffer());
  if (buf.byteLength === 0) {
    return new Response("Empty payload", { status: 400 });
  }
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    return new Response("Payload too large (max 10 MB)", { status: 413 });
  }

  const detectedExt = detectImageType(buf);
  if (!detectedExt) {
    return new Response(
      "Invalid file format (only JPEG, PNG, and WebP are allowed)",
      { status: 400 },
    );
  }

  let width = null;
  let height = null;
  if (detectedExt === "jpg") {
    const processed = processJpeg(buf);
    if (!processed) {
      return new Response("Invalid or unparsable JPEG", { status: 400 });
    }
    buf = processed.bytes;
    width = processed.width;
    height = processed.height;
  }

  const base64 = uint8ToBase64(buf);
  const randomSuffix = Math.random().toString(36).slice(2, 6);
  const filename = `photo_${Date.now()}_${randomSuffix}.${detectedExt}`;

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
    console.error(
      "handlePhotoUpload GitHub PUT failed:",
      ghRes.status,
      await ghRes.text(),
    );
    return new Response("Server error while uploading photo", {
      status: 502,
    });
  }

  // 2. Unshift registered entry to data/photos.json
  try {
    const photosFile = await getContentsFile("data/photos.json", env);
    const existingList = JSON.parse(fromBase64Utf8(photosFile.content));
    const normalized = Array.isArray(existingList) ? existingList : [];

    const newEntry = { filename: filename, alt: "", location: "" };
    if (width && height) {
      newEntry.width = width;
      newEntry.height = height;
    }
    normalized.unshift(newEntry);

    const updatedContent = JSON.stringify(normalized, null, 2) + "\n";
    await putContentsFile(
      "data/photos.json",
      updatedContent,
      photosFile.sha,
      `Register ${filename} via shortcut upload`,
      env,
    );
  } catch (regErr) {
    console.error("handlePhotoUpload register failed:", regErr);
    return new Response(
      `Photo uploaded as ${filename}, but failed to register in data/photos.json`,
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
      case "/panel/delete-photo":
        return handleDeletePhoto(request, env);
      case "/upload":
        return handlePhotoUpload(request, env);
      default:
        return new Response("Not found", { status: 404 });
    }
  },
};
