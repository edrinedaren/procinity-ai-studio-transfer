// Procinity backend: Cloudflare Worker + Static Assets + D1.
// This is a normal Worker (it has a real entry point, see "main" in wrangler.toml).
// Cloudflare serves the files in /public by itself; only /api/* is sent to this code
// (see run_worker_first in wrangler.toml). Bindings used:
//   DB                D1 database "procinity"        (wrangler.toml)
//   ASSETS            the /public static files       (wrangler.toml)
//   GOOGLE_CLIENT_ID  optional variable   (dashboard > Worker > Settings > Variables and Secrets)
//   RESEND_API_KEY    optional secret     (same place)
//   MAIL_FROM         optional variable   (same place)

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64u = {
  enc(buf) {
    const b = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  },
};

const SESSION_DAYS = 30;
const COOKIE = "pc_session";
const STATE_MAX = 200 * 1024;
const BIZ_MAX_FREE = 1;
const BIZ_MAX_PER_USER = 10;
const BIZ_IMAGE_MAX_COUNT = 4;
const BIZ_CATEGORIES = new Set(["Shops", "Boutiques", "Bakeries", "Restaurants", "Resorts", "Supermarkets", "Butchers", "Services", "Other"]);
const PRODUCT_IMAGE_MAX_COUNT = 4;
const PRODUCT_CURRENCIES = new Set(["USD", "UGX", "EUR", "GBP", "KES"]);
const PRODUCT_CONDITIONS = new Set(["New", "Resale"]);
const PRODUCT_CATEGORIES = new Set(["Apparel", "Tech", "Accessories", "Footwear", "Home", "Vehicles", "Equipment", "Food & Drink", "Beauty", "Books", "Other"]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m, s = 400) => new HttpError(s, m);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

const rand = (n = 32) => b64u.enc(crypto.getRandomValues(new Uint8Array(n)));

async function sha256(data) {
  const buf = typeof data === "string" ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}
const sha256hex = async (s) =>
  [...(await sha256(s))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------- Backblaze B2 S3 storage ----------
const B2_DEFAULT_BUCKET = "procinity-images-2026";
const B2_DEFAULT_ENDPOINT = "https://s3.eu-central-003.backblazeb2.com";
const B2_DEFAULT_REGION = "eu-central-003";
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function getB2Config(env) {
  const keyId = env.B2_APPLICATION_KEY_ID || env.B2_KEY_ID || "";
  const key = env.B2_APPLICATION_KEY || "";
  const bucket = env.B2_BUCKET_NAME || B2_DEFAULT_BUCKET;
  const endpoint = (env.B2_ENDPOINT || B2_DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const region = env.B2_REGION || B2_DEFAULT_REGION;
  return {
    keyId,
    key,
    bucket,
    endpoint,
    region,
    isConfigured: !!(keyId && key),
  };
}

async function hmacSha256(key, data) {
  const k = typeof key === "string" ? enc.encode(key) : key;
  const d = typeof data === "string" ? enc.encode(data) : data;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    k,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, d));
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = await hmacSha256("AWS4" + key, dateStamp);
  const kRegion = await hmacSha256(kDate, regionName);
  const kService = await hmacSha256(kRegion, serviceName);
  const kSigning = await hmacSha256(kService, "aws4_request");
  return kSigning;
}

function isAllowedB2Key(k) {
  if (typeof k !== "string" || !k) return false;
  if (k.includes("..") || k.includes("//") || k.startsWith("/") || k.endsWith("/")) return false;
  return /^(users|businesses|products)\/[a-zA-Z0-9_\-\/.]+\.(jpg|jpeg|png|webp)$/.test(k);
}

function extractB2Key(ref) {
  if (typeof ref !== "string" || !ref) return null;
  const s = ref.trim();
  if (s.startsWith("/api/images/")) {
    const k = s.slice("/api/images/".length).replace(/^\/+/, "");
    return isAllowedB2Key(k) ? k : null;
  }
  return isAllowedB2Key(s) ? s : null;
}

async function b2Fetch({ method, key, body, contentType, env }) {
  const conf = getB2Config(env);
  if (!conf.isConfigured) {
    throw bad("Backblaze B2 storage credentials are not configured. Set B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY.", 503);
  }

  const cleanKey = key.replace(/^\/+/, "");
  const encodedKey = cleanKey.split("/").map(encodeURIComponent).join("/");
  const canonicalUri = `/${encodeURIComponent(conf.bucket)}/${encodedKey}`;
  const url = `${conf.endpoint}${canonicalUri}`;
  const host = new URL(conf.endpoint).host;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const payload = body || new Uint8Array(0);
  const payloadHash = await sha256hex(payload);

  const headersToSign = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) {
    headersToSign["content-type"] = contentType;
  }

  const sortedKeys = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headersToSign[k]}\n`).join("");
  const signedHeaders = sortedKeys.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${conf.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256hex(canonicalRequest),
  ].join("\n");

  const signingKey = await getSignatureKey(conf.key, dateStamp, conf.region, "s3");
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  const authHeader = `AWS4-HMAC-SHA256 Credential=${conf.keyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestHeaders = new Headers();
  requestHeaders.set("Host", host);
  requestHeaders.set("x-amz-date", amzDate);
  requestHeaders.set("x-amz-content-sha256", payloadHash);
  requestHeaders.set("Authorization", authHeader);
  if (contentType) {
    requestHeaders.set("Content-Type", contentType);
  }

  return fetch(url, {
    method,
    headers: requestHeaders,
    body: method !== "GET" && method !== "HEAD" && payload.length > 0 ? payload : undefined,
  });
}

async function b2PutObject(env, key, binaryData, contentType) {
  if (!isAllowedB2Key(key)) throw bad("Invalid storage key.", 400);
  const res = await b2Fetch({
    method: "PUT",
    key,
    body: binaryData,
    contentType,
    env,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`B2 PUT failed (${res.status}):`, errText);
    throw bad("Failed to upload image to Backblaze B2 storage. Check credentials and bucket name.", 502);
  }
  return `/api/images/${key}`;
}

async function b2DeleteObject(env, key) {
  if (!key || !isAllowedB2Key(key)) return;
  const conf = getB2Config(env);
  if (!conf.isConfigured) return;
  try {
    const res = await b2Fetch({ method: "DELETE", key, env });
    if (!res.ok && res.status !== 404) {
      console.warn(`B2 DELETE status ${res.status} for key ${key}`);
    }
  } catch (err) {
    console.warn(`B2 DELETE error for key ${key}:`, err.message);
  }
}

function parseImageDataUrl(str) {
  if (typeof str !== "string") return null;
  const s = str.trim();
  const match = s.match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const contentType = match[1];
  const ext = match[2] === "jpeg" ? "jpg" : match[2];
  const rawBase64 = match[3];
  const binaryLen = Math.floor((rawBase64.length * 3) / 4);
  if (binaryLen > IMAGE_MAX_BYTES) {
    throw bad("Image is too large (maximum 5 MB).");
  }
  const bytes = Uint8Array.from(atob(rawBase64), (c) => c.charCodeAt(0));
  if (bytes.length > IMAGE_MAX_BYTES) {
    throw bad("Image is too large (maximum 5 MB).");
  }
  return { contentType, ext, bytes };
}

async function processImageUpload(env, val, destinationKeyPrefix, label = "Image") {
  if (!val) return "";
  const s = String(val).trim();
  if (s.startsWith("/api/images/")) {
    const k = extractB2Key(s);
    if (!k) throw bad(`${label} has an invalid storage reference.`);
    return `/api/images/${k}`;
  }
  const parsed = parseImageDataUrl(s);
  if (!parsed) {
    throw bad(`${label} is invalid. Pick a valid JPEG, PNG or WebP image.`);
  }
  const key = `${destinationKeyPrefix}-${crypto.randomUUID()}.${parsed.ext}`;
  return await b2PutObject(env, key, parsed.bytes, parsed.contentType);
}

// ---------- passwords (PBKDF2-SHA256, 100k iterations is the Workers maximum) ----------
async function hashPw(pw, salt = crypto.getRandomValues(new Uint8Array(16)), iter = 100000) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${b64u.enc(salt)}$${b64u.enc(bits)}`;
}
async function checkPw(pw, stored) {
  if (!stored) return false;
  const [, iter, salt, hash] = stored.split("$");
  const again = await hashPw(pw, b64u.dec(salt), +iter);
  const a = enc.encode(again.split("$")[3]);
  const b = enc.encode(hash);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ---------- validation ----------
const cleanEmail = (e) => {
  e = String(e || "").trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw bad("Enter a valid email address.");
  return e;
};
const cleanPw = (p) => {
  p = String(p || "");
  if (p.length < 8) throw bad("Password must be at least 8 characters.");
  if (p.length > 128) throw bad("Password is too long.");
  return p;
};
const cleanText = (v, max, label) => {
  v = String(v == null ? "" : v).trim();
  if (v.length > max) throw bad(`${label} is too long (max ${max} characters).`);
  return v;
};
const cleanPhone = (v) => {
  const p = cleanText(v, 30, "Phone number");
  if (p && !/^[+\d][\d\s\-().]{5,}$/.test(p)) throw bad("Enter a valid phone number.");
  return p;
};
const cleanOptionalEmail = (v) => {
  const e = String(v == null ? "" : v).trim().toLowerCase();
  return e ? cleanEmail(e) : "";
};
const cleanImageData = (v, label = "Image") => {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  if (s.startsWith("/api/images/")) {
    if (!extractB2Key(s)) throw bad(`${label} has an invalid storage reference.`);
    return s;
  }
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) || s.length > IMAGE_MAX_BYTES * 1.4) {
    throw bad(`${label} is invalid or too large. Pick an image under 5 MB.`);
  }
  return s;
};
const cleanBusinessImages = (arr) => {
  if (arr == null) return [];
  if (!Array.isArray(arr)) throw bad("Business images must be a list.");
  if (arr.length > BIZ_IMAGE_MAX_COUNT) throw bad(`You can upload up to ${BIZ_IMAGE_MAX_COUNT} images per business.`);
  const out = [];
  for (const item of arr) {
    const cleaned = cleanImageData(item, "Business image");
    if (cleaned) out.push(cleaned);
  }
  return out;
};
const cleanPrice = (v) => {
  const n = typeof v === "number" ? v : Number(String(v == null ? "" : v).trim());
  if (!Number.isFinite(n) || n <= 0 || n > 1000000000) throw bad("Enter a valid product price greater than 0.");
  return Math.round(n * 100) / 100;
};
const cleanProductImages = (arr) => {
  if (!Array.isArray(arr)) throw bad("Product images must be a list.");
  if (arr.length > PRODUCT_IMAGE_MAX_COUNT) throw bad(`You can upload up to ${PRODUCT_IMAGE_MAX_COUNT} images per product.`);
  const out = [];
  for (const item of arr) {
    const cleaned = cleanImageData(item, "Product image");
    if (cleaned) out.push(cleaned);
  }
  if (!out.length) throw bad("Add at least 1 product image.");
  return out;
};
const safeParseImages = (raw) => {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => typeof x === "string" && x.startsWith("/api/images/") && isAllowedB2Key(x.slice("/api/images/".length)));
  } catch {
    return [];
  }
};
const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 24);

async function uniqueHandle(env, base) {
  base = slug(base) || "user";
  let h = base;
  for (let i = 0; i < 8; i++) {
    const hit = await env.DB.prepare("SELECT 1 FROM users WHERE handle=?").bind(h).first();
    if (!hit) return h;
    h = base + Math.floor(1000 + Math.random() * 9000);
  }
  return base + rand(4).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

// ---------- rate limiting ----------
async function limit(env, key, max, windowSec) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT n, reset_at FROM rate WHERE k=?").bind(key).first();
  if (!row || row.reset_at < now) {
    await env.DB.prepare("INSERT OR REPLACE INTO rate(k,n,reset_at) VALUES(?,?,?)").bind(key, 1, now + windowSec * 1000).run();
    return;
  }
  if (row.n >= max) throw bad("Too many attempts. Please wait a few minutes and try again.", 429);
  await env.DB.prepare("UPDATE rate SET n=n+1 WHERE k=?").bind(key).run();
}
async function clearLimit(env, key) {
  await env.DB.prepare("DELETE FROM rate WHERE k=?").bind(key).run();
}

// ---------- sessions ----------
function cookies(request) {
  const out = {};
  (request.headers.get("cookie") || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function sessionCookie(request, token, maxAge) {
  let isHttps = false;
  let isCrossSiteOrIframe = false;
  try {
    const u = new URL(request.url);
    isHttps = u.protocol === "https:";
    const secSite = request.headers.get("sec-fetch-site");
    const secDest = request.headers.get("sec-fetch-dest");
    const referer = request.headers.get("referer");
    if (isHttps) {
      if (secSite === "cross-site" || secDest === "iframe") {
        isCrossSiteOrIframe = true;
      } else if (referer) {
        try {
          if (new URL(referer).origin !== u.origin) isCrossSiteOrIframe = true;
        } catch {}
      }
    }
  } catch {}

  let attrs = "Path=/; HttpOnly;";
  if (isHttps) {
    attrs += " Secure;";
    if (isCrossSiteOrIframe) {
      attrs += " SameSite=None; Partitioned;";
    } else {
      attrs += " SameSite=Lax;";
    }
  } else {
    attrs += " SameSite=Lax;";
  }
  attrs += ` Max-Age=${maxAge}`;
  return `${COOKIE}=${token}; ${attrs}`;
}

async function startSession(env, request, userId) {
  const token = rand(32);
  const id = await sha256hex(token);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions(id,user_id,created_at,expires_at,ua) VALUES(?,?,?,?,?)")
    .bind(id, userId, now, now + SESSION_DAYS * 864e5, (request.headers.get("user-agent") || "").slice(0, 200))
    .run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  return sessionCookie(request, token, SESSION_DAYS * 86400);
}
async function currentUser(env, request) {
  const token = cookies(request)[COOKIE];
  if (!token) return null;
  const id = await sha256hex(token);
  const row = await env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?"
  ).bind(id, Date.now()).first();
  return row || null;
}
async function requireUser(env, request) {
  const u = await currentUser(env, request);
  if (!u) throw bad("Please sign in.", 401);
  return u;
}

function isPremiumUser(u) {
  return !!(u && (u.is_premium === 1 || u.is_premium === true || u.plan === "premium"));
}
function userBizLimit(u) {
  return isPremiumUser(u) ? BIZ_MAX_PER_USER : BIZ_MAX_FREE;
}
function publicUser(u) {
  const premium = isPremiumUser(u);
  return {
    id: u.id,
    email: u.email,
    name: u.name || "",
    handle: u.handle || "",
    headline: u.headline || "",
    bio: u.bio || "",
    phone: u.phone || "",
    location: u.location || "",
    avatar: (u.avatar && typeof u.avatar === "string" && u.avatar.startsWith("/api/images/")) ? u.avatar : "",
    hasPassword: !!u.pw_hash,
    google: !!u.google_sub,
    is_premium: premium,
    business_limit: premium ? BIZ_MAX_PER_USER : BIZ_MAX_FREE,
    created_at: u.created_at,
  };
}
function publicBusiness(b, viewer) {
  return {
    id: b.id,
    user_id: b.user_id,
    name: b.name || "",
    category: b.category || "",
    location: b.location || "",
    phone: b.phone || "",
    email: b.email || "",
    description: b.description || "",
    logo: (b.logo && typeof b.logo === "string" && b.logo.startsWith("/api/images/")) ? b.logo : "",
    images: safeParseImages(b.images),
    owner_name: b.owner_name || "",
    owner_handle: b.owner_handle || "",
    is_owner: !!(viewer && viewer.id === b.user_id),
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}
function publicProduct(p, viewer) {
  return {
    id: p.id,
    business_id: p.business_id,
    user_id: p.user_id,
    name: p.name || "",
    description: p.description || "",
    price: Number(p.price),
    currency: p.currency || "USD",
    category: p.category || "",
    condition: p.condition || "New",
    images: safeParseImages(p.images),
    published: !!p.published,
    business_name: p.business_name || "",
    business_category: p.business_category || "",
    business_location: p.business_location || "",
    is_owner: !!(viewer && viewer.id === p.user_id),
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}
function publicBusinessPost(p, viewer) {
  return {
    id: p.id,
    business_id: p.business_id,
    user_id: p.user_id,
    content: p.content || "",
    image: (p.image && typeof p.image === "string" && p.image.startsWith("/api/images/")) ? p.image : "",
    is_owner: !!(viewer && viewer.id === p.user_id),
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}
async function passkeyList(env, userId) {
  const r = await env.DB.prepare("SELECT id,label,created_at FROM passkeys WHERE user_id=? ORDER BY created_at").bind(userId).all();
  return r.results || [];
}

async function createUser(env, { email, name, pw, googleSub }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const display = cleanText(name, 60, "Name") || email.split("@")[0];
  const handle = await uniqueHandle(env, display);
  await env.DB.prepare(
    "INSERT INTO users(id,email,name,handle,pw_hash,google_sub,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)"
  ).bind(id, email, display, handle, pw ? await hashPw(pw) : null, googleSub || null, "{}", now, now).run();
  return id;
}

// ---------- email (Resend) ----------
async function sendMail(env, to, subject, text) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
  });
  return r.ok;
}

// ---------- WebAuthn helpers ----------
function derToRaw(der) {
  // ECDSA signature DER -> r||s (64 bytes) for WebCrypto
  let i = 2;
  if (der[1] & 0x80) i += der[1] & 0x7f;
  if (der[i] !== 0x02) throw new Error("bad sig");
  let rl = der[i + 1];
  let r = der.slice(i + 2, i + 2 + rl);
  i = i + 2 + rl;
  if (der[i] !== 0x02) throw new Error("bad sig");
  let sl = der[i + 1];
  let s = der.slice(i + 2, i + 2 + sl);
  const fix = (x) => {
    while (x.length > 32 && x[0] === 0) x = x.slice(1);
    const o = new Uint8Array(32);
    o.set(x, 32 - x.length);
    return o;
  };
  const out = new Uint8Array(64);
  out.set(fix(r), 0);
  out.set(fix(s), 32);
  return out;
}
async function importPasskey(spki, alg) {
  if (alg === -7) return crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (alg === -257) return crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  throw bad("Unsupported passkey type.");
}
async function takeChallenge(env, challenge, kind) {
  const row = await env.DB.prepare("SELECT * FROM challenges WHERE challenge=?").bind(challenge).first();
  if (row) await env.DB.prepare("DELETE FROM challenges WHERE challenge=?").bind(challenge).run();
  if (!row || row.kind !== kind || row.expires_at < Date.now()) throw bad("That request expired. Please try again.");
  return row;
}
async function saveChallenge(env, kind, userId) {
  const challenge = rand(32);
  const now = Date.now();
  await env.DB.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(now).run();
  await env.DB.prepare("INSERT INTO challenges(challenge,kind,user_id,expires_at) VALUES(?,?,?,?)")
    .bind(challenge, kind, userId || null, now + 5 * 60 * 1000).run();
  return challenge;
}
function checkClientData(cdB64, url, type) {
  let cd;
  try {
    cd = JSON.parse(dec.decode(b64u.dec(cdB64)));
  } catch {
    throw bad("Invalid passkey response.");
  }
  if (cd.type !== type) throw bad("Invalid passkey response.");
  if (cd.origin !== url.origin) throw bad("Passkey origin mismatch.");
  return cd;
}

// ---------- routes ----------
async function handle(request, env, url) {
  if (!env.DB) throw bad("The database is not connected yet. Add the D1 binding named DB.", 503);
  const method = request.method;
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const ip = request.headers.get("cf-connecting-ip") || "0";

  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (origin ? origin !== url.origin : request.headers.get("sec-fetch-site") === "cross-site") throw bad("Blocked request.", 403);
  }
  const body = async () => {
    try {
      return (await request.json()) || {};
    } catch {
      return {};
    }
  };

  if (path === "config" && method === "GET") {
    return json({ googleClientId: env.GOOGLE_CLIENT_ID || "", emailEnabled: !!(env.RESEND_API_KEY && env.MAIL_FROM) });
  }

  // --- sign up / sign in ---
  if (path === "auth/signup" && method === "POST") {
    const b = await body();
    await limit(env, "signup:" + ip, 10, 3600);
    const email = cleanEmail(b.email);
    const pw = cleanPw(b.password);
    if (await env.DB.prepare("SELECT 1 FROM users WHERE email=?").bind(email).first())
      throw bad("An account with this email already exists. Try signing in.", 409);
    const id = await createUser(env, { email, name: b.name, pw });
    const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
    return json({ user: publicUser(user), state: {}, passkeys: [] }, 200, { "set-cookie": await startSession(env, request, id) });
  }

  if (path === "auth/login" && method === "POST") {
    const b = await body();
    const email = cleanEmail(b.email);
    await limit(env, "login:ip:" + ip, 30, 900);
    await limit(env, "login:" + email, 8, 900);
    const user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    // run the hash either way so timing does not reveal whether the account exists
    const ok = await checkPw(String(b.password || ""), user ? user.pw_hash : await hashPw("x"));
    if (!user || !ok) {
      if (user && !user.pw_hash) throw bad("This account has no password. Use Google or a passkey, or reset your password.", 401);
      throw bad("Incorrect email or password.", 401);
    }
    await clearLimit(env, "login:" + email);
    return json(
      { user: publicUser(user), state: JSON.parse(user.state || "{}"), passkeys: await passkeyList(env, user.id) },
      200,
      { "set-cookie": await startSession(env, request, user.id) }
    );
  }

  if (path === "auth/logout" && method === "POST") {
    const token = cookies(request)[COOKIE];
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(await sha256hex(token)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, "", 0) });
  }

  if (path === "auth/google" && method === "POST") {
    const b = await body();
    if (!env.GOOGLE_CLIENT_ID) throw bad("Google sign-in is not set up.", 501);
    await limit(env, "google:" + ip, 30, 900);
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(String(b.credential || "")));
    if (!r.ok) throw bad("Google sign-in failed.", 401);
    const g = await r.json();
    if (g.aud !== env.GOOGLE_CLIENT_ID || !/^(https:\/\/)?accounts\.google\.com$/.test(g.iss) || +g.exp * 1000 < Date.now())
      throw bad("Google sign-in failed.", 401);
    if (String(g.email_verified) !== "true") throw bad("Your Google email is not verified.", 401);
    const email = cleanEmail(g.email);
    let user = await env.DB.prepare("SELECT * FROM users WHERE google_sub=?").bind(g.sub).first();
    if (!user) user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    if (user && !user.google_sub) {
      await env.DB.prepare("UPDATE users SET google_sub=?, updated_at=? WHERE id=?").bind(g.sub, Date.now(), user.id).run();
    }
    if (!user) {
      const id = await createUser(env, { email, name: g.name, googleSub: g.sub });
      user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
    }
    return json(
      { user: publicUser(user), state: JSON.parse(user.state || "{}"), passkeys: await passkeyList(env, user.id) },
      200,
      { "set-cookie": await startSession(env, request, user.id) }
    );
  }

  // --- forgot / reset password (email code) ---
  if (path === "auth/forgot" && method === "POST") {
    const b = await body();
    const email = cleanEmail(b.email);
    await limit(env, "forgot:ip:" + ip, 10, 3600);
    await limit(env, "forgot:" + email, 3, 3600);
    if (!(env.RESEND_API_KEY && env.MAIL_FROM)) throw bad("Password reset email is not set up yet.", 501);
    const user = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (user) {
      const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
      const code = String(n).padStart(6, "0");
      await env.DB.prepare("INSERT OR REPLACE INTO reset_codes(email,code_hash,expires_at,attempts) VALUES(?,?,?,0)")
        .bind(email, await sha256hex(code + ":" + email), Date.now() + 15 * 60 * 1000).run();
      await sendMail(env, email, "Your Procinity reset code", `Your Procinity password reset code is ${code}. It expires in 15 minutes. If you did not ask for this, you can ignore this email.`);
    }
    return json({ ok: true }); // same answer whether or not the account exists
  }

  if (path === "auth/reset" && method === "POST") {
    const b = await body();
    const email = cleanEmail(b.email);
    const pw = cleanPw(b.password);
    await limit(env, "reset:ip:" + ip, 20, 3600);
    const row = await env.DB.prepare("SELECT * FROM reset_codes WHERE email=?").bind(email).first();
    if (!row || row.expires_at < Date.now() || row.attempts >= 5) throw bad("That code is invalid or has expired. Request a new one.");
    await env.DB.prepare("UPDATE reset_codes SET attempts=attempts+1 WHERE email=?").bind(email).run();
    if ((await sha256hex(String(b.code || "").trim() + ":" + email)) !== row.code_hash) throw bad("That code is not correct.");
    const user = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (!user) throw bad("That code is invalid or has expired. Request a new one.");
    await env.DB.prepare("UPDATE users SET pw_hash=?, updated_at=? WHERE id=?").bind(await hashPw(pw), Date.now(), user.id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id).run();
    await env.DB.prepare("DELETE FROM reset_codes WHERE email=?").bind(email).run();
    return json({ ok: true });
  }

  // --- passkey sign-in (no session needed) ---
  if (path === "passkey/login-options" && method === "POST") {
    await limit(env, "pklo:" + ip, 60, 900);
    return json({ challenge: await saveChallenge(env, "login"), rpId: url.hostname });
  }
  if (path === "passkey/login" && method === "POST") {
    const b = await body();
    await limit(env, "pkl:" + ip, 30, 900);
    const r = b.response || {};
    const cd = checkClientData(r.clientDataJSON, url, "webauthn.get");
    await takeChallenge(env, cd.challenge, "login");
    const pk = await env.DB.prepare("SELECT * FROM passkeys WHERE id=?").bind(String(b.id || "")).first();
    if (!pk) throw bad("This passkey is not registered. Sign in another way.", 401);
    const authData = b64u.dec(r.authenticatorData);
    const rpHash = await sha256(url.hostname);
    for (let i = 0; i < 32; i++) if (authData[i] !== rpHash[i]) throw bad("Passkey check failed.", 401);
    if (!(authData[32] & 1)) throw bad("Passkey check failed.", 401);
    const counter = new DataView(authData.buffer, authData.byteOffset).getUint32(33);
    const cdHash = await sha256(b64u.dec(r.clientDataJSON));
    const signed = new Uint8Array(authData.length + 32);
    signed.set(authData, 0);
    signed.set(cdHash, authData.length);
    let sig = b64u.dec(r.signature);
    if (pk.alg === -7) sig = derToRaw(sig);
    const key = await importPasskey(b64u.dec(pk.public_key), pk.alg);
    const alg = pk.alg === -7 ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
    if (!(await crypto.subtle.verify(alg, key, sig, signed))) throw bad("Passkey check failed.", 401);
    if ((counter || pk.counter) && counter <= pk.counter) throw bad("Passkey check failed.", 401);
    await env.DB.prepare("UPDATE passkeys SET counter=? WHERE id=?").bind(counter, pk.id).run();
    const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(pk.user_id).first();
    if (!user) throw bad("Account not found.", 401);
    return json(
      { user: publicUser(user), state: JSON.parse(user.state || "{}"), passkeys: await passkeyList(env, user.id) },
      200,
      { "set-cookie": await startSession(env, request, user.id) }
    );
  }

  // --- public secure image delivery from Backblaze B2 ---
  if (path.startsWith("images/") && (method === "GET" || method === "HEAD")) {
    const key = path.slice("images/".length).replace(/^\/+/, "");
    if (!isAllowedB2Key(key)) throw bad("Invalid image key.", 400);

    const conf = getB2Config(env);
    if (!conf.isConfigured) {
      return json({ error: "Backblaze B2 image storage is not configured yet." }, 503);
    }

    const res = await b2Fetch({ method, key, env });
    if (!res.ok) {
      if (res.status === 404) throw bad("Image not found.", 404);
      const err = await res.text().catch(() => "");
      console.error(`B2 GET failed (${res.status}):`, err);
      throw bad("Could not load image.", 502);
    }

    const ct = res.headers.get("content-type") || (key.endsWith(".png") ? "image/png" : key.endsWith(".webp") ? "image/webp" : "image/jpeg");
    const headers = {
      "content-type": ct,
      "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
    };
    const etag = res.headers.get("etag");
    if (etag) headers["etag"] = etag;
    const cl = res.headers.get("content-length");
    if (cl) headers["content-length"] = cl;

    return new Response(method === "HEAD" ? null : res.body, {
      status: 200,
      headers,
    });
  }

  // --- public business directory & profiles (no session needed) ---
  if (path === "businesses" && method === "GET") {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 80);
    const cat = String(url.searchParams.get("category") || "").trim();
    const where = [];
    const binds = [];
    if (cat && cat !== "All") {
      where.push("b.category=?");
      binds.push(cat);
    }
    if (q) {
      const pat = "%" + q.replace(/[!%_]/g, "!$&") + "%";
      where.push("(LOWER(b.name) LIKE ? ESCAPE '!' OR LOWER(b.category) LIKE ? ESCAPE '!' OR LOWER(b.location) LIKE ? ESCAPE '!' OR LOWER(b.description) LIKE ? ESCAPE '!')");
      binds.push(pat, pat, pat, pat);
    }
    const sql =
      "SELECT b.*, u.name AS owner_name, u.handle AS owner_handle FROM businesses b LEFT JOIN users u ON u.id=b.user_id" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY b.created_at DESC LIMIT 100";
    const r = await env.DB.prepare(sql).bind(...binds).all();
    const viewer = await currentUser(env, request);
    return json({ businesses: (r.results || []).map((b) => publicBusiness(b, viewer)) });
  }

  const bizPublicMatch = path.match(/^businesses\/([^/]+)$/);
  if (bizPublicMatch && bizPublicMatch[1] !== "my" && method === "GET") {
    const id = decodeURIComponent(bizPublicMatch[1]);
    const row = await env.DB.prepare(
      "SELECT b.*, u.name AS owner_name, u.handle AS owner_handle FROM businesses b LEFT JOIN users u ON u.id=b.user_id WHERE b.id=?"
    ).bind(id).first();
    if (!row) throw bad("Business not found.", 404);
    const viewer = await currentUser(env, request);
    return json({ business: publicBusiness(row, viewer) });
  }

  // --- public product listings (published only unless viewer is owner; no session needed) ---
  if (path === "products" && method === "GET") {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 80);
    const cond = String(url.searchParams.get("condition") || "").trim();
    const cat = String(url.searchParams.get("category") || "").trim();
    const bizId = String(url.searchParams.get("business_id") || "").trim();
    const where = ["p.published=1"];
    const binds = [];
    if (cond && cond !== "All") {
      where.push("p.condition=?");
      binds.push(cond);
    }
    if (cat && cat !== "All") {
      where.push("p.category=?");
      binds.push(cat);
    }
    if (bizId) {
      where.push("p.business_id=?");
      binds.push(bizId);
    }
    if (q) {
      const pat = "%" + q.replace(/[!%_]/g, "!$&") + "%";
      where.push("(LOWER(p.name) LIKE ? ESCAPE '!' OR LOWER(p.category) LIKE ? ESCAPE '!' OR LOWER(p.description) LIKE ? ESCAPE '!' OR LOWER(b.name) LIKE ? ESCAPE '!')");
      binds.push(pat, pat, pat, pat);
    }
    const sql =
      "SELECT p.*, b.name AS business_name, b.category AS business_category, b.location AS business_location " +
      "FROM products p INNER JOIN businesses b ON b.id=p.business_id WHERE " +
      where.join(" AND ") +
      " ORDER BY p.created_at DESC LIMIT 200";
    const r = await env.DB.prepare(sql).bind(...binds).all();
    const viewer = await currentUser(env, request);
    return json({ products: (r.results || []).map((p) => publicProduct(p, viewer)) });
  }

  const prodPublicMatch = path.match(/^products\/([^/]+)$/);
  if (prodPublicMatch && prodPublicMatch[1] !== "my" && method === "GET") {
    const id = decodeURIComponent(prodPublicMatch[1]);
    const row = await env.DB.prepare(
      "SELECT p.*, b.name AS business_name, b.category AS business_category, b.location AS business_location " +
      "FROM products p INNER JOIN businesses b ON b.id=p.business_id WHERE p.id=?"
    ).bind(id).first();
    const viewer = await currentUser(env, request);
    if (!row || (!row.published && (!viewer || viewer.id !== row.user_id))) {
      throw bad("Product not found.", 404);
    }
    return json({ product: publicProduct(row, viewer) });
  }

  if (path === "business-posts" && method === "GET") {
    const bizId = String(url.searchParams.get("business_id") || "").trim();
    if (!bizId) throw bad("Missing business_id.");
    const r = await env.DB.prepare(
      "SELECT * FROM business_posts WHERE business_id=? ORDER BY created_at DESC LIMIT 100"
    ).bind(bizId).all();
    const viewer = await currentUser(env, request);
    return json({ posts: (r.results || []).map((p) => publicBusinessPost(p, viewer)) });
  }

  // ===== everything below needs a session =====
  const user = await requireUser(env, request);

  if (path === "me" && method === "GET") {
    return json({ user: publicUser(user), state: JSON.parse(user.state || "{}"), passkeys: await passkeyList(env, user.id) });
  }

  if (path === "me" && method === "PATCH") {
    const b = await body();
    const f = {};
    if ("name" in b) {
      f.name = cleanText(b.name, 60, "Name");
      if (!f.name) throw bad("Name can't be empty.");
    }
    if ("headline" in b) f.headline = cleanText(b.headline, 80, "Headline");
    if ("bio" in b) f.bio = cleanText(b.bio, 300, "Bio");
    if ("phone" in b) {
      f.phone = cleanText(b.phone, 30, "Phone number");
      if (f.phone && !/^[+\d][\d\s\-().]{5,}$/.test(f.phone)) throw bad("Enter a valid phone number.");
    }
    if ("location" in b) f.location = cleanText(b.location, 80, "Location");
    if ("handle" in b) {
      const h = String(b.handle || "").toLowerCase().replace(/^@/, "");
      if (!/^[a-z0-9_.]{3,24}$/.test(h)) throw bad("Username must be 3 to 24 letters, numbers, dots or underscores.");
      if (await env.DB.prepare("SELECT 1 FROM users WHERE handle=? AND id<>?").bind(h, user.id).first()) throw bad("That username is taken.", 409);
      f.handle = h;
    }
    let oldAvatarToDelete = null;
    if ("avatar" in b) {
      const a = String(b.avatar || "").trim();
      if (!a) {
        f.avatar = "";
        if (user.avatar) oldAvatarToDelete = extractB2Key(user.avatar);
      } else if (a.startsWith("/api/images/")) {
        const k = extractB2Key(a);
        if (!k) throw bad("Invalid photo reference.");
        if (!k.startsWith(`users/${user.id}/`) && a !== user.avatar) {
          throw bad("You do not have permission to use this photo reference.", 403);
        }
        f.avatar = `/api/images/${k}`;
        if (user.avatar && user.avatar !== f.avatar) {
          oldAvatarToDelete = extractB2Key(user.avatar);
        }
      } else {
        const uploaded = await processImageUpload(env, a, `users/${user.id}/avatar`, "Profile photo");
        f.avatar = uploaded;
        if (user.avatar && user.avatar !== uploaded) {
          oldAvatarToDelete = extractB2Key(user.avatar);
        }
      }
    }
    const keys = Object.keys(f);
    if (keys.length) {
      await env.DB.prepare(`UPDATE users SET ${keys.map((k) => k + "=?").join(",")}, updated_at=? WHERE id=?`)
        .bind(...keys.map((k) => f[k]), Date.now(), user.id).run();
    }
    if (oldAvatarToDelete) {
      await b2DeleteObject(env, oldAvatarToDelete);
    }
    const fresh = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(user.id).first();
    return json({ user: publicUser(fresh) });
  }

  // --- authenticated image upload & delete endpoints ---
  if (path === "upload" && method === "POST") {
    const b = await body();
    await limit(env, "upload:" + user.id, 60, 3600);
    const targetType = String(b.type || "avatar").toLowerCase();
    const data = b.image || b.file;
    if (!data) throw bad("No image data provided.");
    let prefix = `users/${user.id}/avatar`;
    if (targetType === "logo" || targetType === "business" || targetType === "gallery") {
      if (b.business_id) {
        const bizId = cleanText(b.business_id, 100, "Business");
        const hit = await env.DB.prepare("SELECT 1 FROM businesses WHERE id=? AND user_id=?").bind(bizId, user.id).first();
        if (!hit) throw bad("You do not have permission to upload images for this business.", 403);
        prefix = `businesses/${bizId}/${targetType === "logo" ? "logo" : "gallery"}`;
      } else {
        prefix = `users/${user.id}/${targetType === "logo" ? "biz-logo" : "biz-gallery"}`;
      }
    } else if (targetType === "product") {
      if (b.product_id) {
        const prodId = cleanText(b.product_id, 100, "Product");
        const hit = await env.DB.prepare("SELECT 1 FROM products WHERE id=? AND user_id=?").bind(prodId, user.id).first();
        if (!hit) throw bad("You do not have permission to upload images for this product.", 403);
        prefix = `products/${prodId}/img`;
      } else {
        prefix = `users/${user.id}/prod-img`;
      }
    } else if (targetType !== "avatar") {
      throw bad("Unsupported upload type.");
    }
    const url = await processImageUpload(env, data, prefix, "Upload");
    return json({ url, key: extractB2Key(url) });
  }

  if (path === "upload" && method === "DELETE") {
    const b = await body();
    const cleanKey = extractB2Key(b.key || b.url || "");
    if (!cleanKey) throw bad("Invalid image key.");
    let allowed = false;
    if (cleanKey.startsWith(`users/${user.id}/`)) {
      allowed = true;
    } else if (cleanKey.startsWith("businesses/")) {
      const bizId = cleanKey.split("/")[1];
      const hit = await env.DB.prepare("SELECT 1 FROM businesses WHERE id=? AND user_id=?").bind(bizId, user.id).first();
      if (hit) allowed = true;
    } else if (cleanKey.startsWith("products/")) {
      const prodId = cleanKey.split("/")[1];
      const hit = await env.DB.prepare("SELECT 1 FROM products WHERE id=? AND user_id=?").bind(prodId, user.id).first();
      if (hit) allowed = true;
    }
    if (!allowed) throw bad("You do not have permission to delete this image.", 403);
    await b2DeleteObject(env, cleanKey);
    return json({ ok: true });
  }

  if (path === "me/email" && method === "POST") {
    const b = await body();
    const email = cleanEmail(b.email);
    await limit(env, "email:" + user.id, 5, 3600);
    if (!user.pw_hash) throw bad("Set a password first, then you can change your email.");
    if (!(await checkPw(String(b.password || ""), user.pw_hash))) throw bad("Incorrect password.", 401);
    if (await env.DB.prepare("SELECT 1 FROM users WHERE email=? AND id<>?").bind(email, user.id).first()) throw bad("That email is already in use.", 409);
    await env.DB.prepare("UPDATE users SET email=?, updated_at=? WHERE id=?").bind(email, Date.now(), user.id).run();
    const fresh = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(user.id).first();
    return json({ user: publicUser(fresh) });
  }

  if (path === "me/password" && method === "POST") {
    const b = await body();
    await limit(env, "pw:" + user.id, 8, 900);
    const next = cleanPw(b.next);
    if (user.pw_hash && !(await checkPw(String(b.current || ""), user.pw_hash))) throw bad("Your current password is incorrect.", 401);
    await env.DB.prepare("UPDATE users SET pw_hash=?, updated_at=? WHERE id=?").bind(await hashPw(next), Date.now(), user.id).run();
    // sign out every other device, keep this one
    const token = cookies(request)[COOKIE];
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=? AND id<>?").bind(user.id, await sha256hex(token)).run();
    return json({ ok: true });
  }

  if (path === "state" && method === "PUT") {
    const raw = await request.text();
    if (raw.length > STATE_MAX) throw bad("Saved data is too large.", 413);
    let s;
    try {
      s = JSON.parse(raw).state;
    } catch {
      throw bad("Invalid data.");
    }
    if (!s || typeof s !== "object" || Array.isArray(s)) throw bad("Invalid data.");
    await env.DB.prepare("UPDATE users SET state=?, updated_at=? WHERE id=?").bind(JSON.stringify(s), Date.now(), user.id).run();
    return json({ ok: true });
  }

  if (path === "me" && method === "DELETE") {
    const b = await body();
    await limit(env, "del:" + user.id, 5, 900);
    if (user.pw_hash) {
      if (!(await checkPw(String(b.password || ""), user.pw_hash))) throw bad("Incorrect password.", 401);
    } else if (String(b.confirm || "") !== "DELETE") {
      throw bad('Type DELETE to confirm.');
    }
    const oldAvatarKey = extractB2Key(user.avatar);
    const userBizs = await env.DB.prepare("SELECT logo, images FROM businesses WHERE user_id=?").bind(user.id).all();
    const userProds = await env.DB.prepare("SELECT images FROM products WHERE user_id=?").bind(user.id).all();
    const userPosts = await env.DB.prepare("SELECT image FROM business_posts WHERE user_id=?").bind(user.id).all();

    await env.DB.batch([
      env.DB.prepare("DELETE FROM business_posts WHERE user_id=?").bind(user.id),
      env.DB.prepare("DELETE FROM products WHERE user_id=?").bind(user.id),
      env.DB.prepare("DELETE FROM businesses WHERE user_id=?").bind(user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id),
      env.DB.prepare("DELETE FROM passkeys WHERE user_id=?").bind(user.id),
      env.DB.prepare("DELETE FROM challenges WHERE user_id=?").bind(user.id),
      env.DB.prepare("DELETE FROM reset_codes WHERE email=?").bind(user.email),
      env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.id),
    ]);

    if (oldAvatarKey) await b2DeleteObject(env, oldAvatarKey);
    for (const bRow of (userBizs.results || [])) {
      if (bRow.logo) await b2DeleteObject(env, extractB2Key(bRow.logo));
      for (const imgUrl of safeParseImages(bRow.images)) {
        await b2DeleteObject(env, extractB2Key(imgUrl));
      }
    }
    for (const pRow of (userProds.results || [])) {
      for (const imgUrl of safeParseImages(pRow.images)) {
        await b2DeleteObject(env, extractB2Key(imgUrl));
      }
    }
    for (const bpRow of (userPosts.results || [])) {
      if (bpRow.image) await b2DeleteObject(env, extractB2Key(bpRow.image));
    }

    return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, "", 0) });
  }

  // --- passkey management ---
  if (path === "passkey/register-options" && method === "POST") {
    const existing = await passkeyList(env, user.id);
    return json({
      challenge: await saveChallenge(env, "register", user.id),
      rp: { id: url.hostname, name: "Procinity" },
      user: { id: b64u.enc(enc.encode(user.id)), name: user.email, displayName: user.name || user.email },
      exclude: existing.map((p) => p.id),
    });
  }
  if (path === "passkey/register" && method === "POST") {
    const b = await body();
    const r = b.response || {};
    const cd = checkClientData(r.clientDataJSON, url, "webauthn.create");
    const ch = await takeChallenge(env, cd.challenge, "register");
    if (ch.user_id !== user.id) throw bad("That request expired. Please try again.");
    const alg = +r.alg;
    const spki = b64u.dec(r.publicKey || "");
    await importPasskey(spki, alg); // rejects anything we could not verify later
    const id = String(b.id || "");
    if (!id || id.length > 1024) throw bad("Invalid passkey.");
    const count = (await passkeyList(env, user.id)).length;
    if (count >= 10) throw bad("You already have 10 passkeys. Remove one first.");
    await env.DB.prepare("INSERT INTO passkeys(id,user_id,public_key,alg,counter,label,created_at) VALUES(?,?,?,?,?,?,?)")
      .bind(id, user.id, r.publicKey, alg, 0, cleanText(b.label, 40, "Label") || "Passkey", Date.now()).run();
    return json({ passkeys: await passkeyList(env, user.id) });
  }
  if (path.startsWith("passkey/") && method === "DELETE") {
    const id = decodeURIComponent(path.slice(8));
    await env.DB.prepare("DELETE FROM passkeys WHERE id=? AND user_id=?").bind(id, user.id).run();
    return json({ passkeys: await passkeyList(env, user.id) });
  }

  // --- authenticated business registration & management ---
  if (path === "businesses/my" && method === "GET") {
    const r = await env.DB.prepare(
      "SELECT b.*, u.name AS owner_name, u.handle AS owner_handle FROM businesses b LEFT JOIN users u ON u.id=b.user_id WHERE b.user_id=? ORDER BY b.created_at DESC"
    ).bind(user.id).all();
    const premium = isPremiumUser(user);
    return json({
      businesses: (r.results || []).map((b) => publicBusiness(b, user)),
      limit: userBizLimit(user),
      is_premium: premium,
    });
  }

  if (path === "businesses" && method === "POST") {
    const b = await body();
    await limit(env, "biz:" + user.id, 30, 3600);
    const premium = isPremiumUser(user);
    const maxBiz = userBizLimit(user);
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM businesses WHERE user_id=?").bind(user.id).first();
    if ((cnt && cnt.n) >= maxBiz) {
      if (!premium) {
        throw bad("Free accounts can register 1 business. Registering additional businesses is a Premium-only feature.", 403);
      }
      throw bad(`You can register up to ${maxBiz} businesses per account.`);
    }
    const name = cleanText(b.name, 80, "Business name");
    if (!name) throw bad("Enter a business name.");
    const category = cleanText(b.category, 40, "Category");
    if (!BIZ_CATEGORIES.has(category)) throw bad("Choose a valid business category.");
    const location = cleanText(b.location, 100, "Location");
    if (!location) throw bad("Enter a business location.");
    const description = cleanText(b.description, 500, "Description");
    if (!description) throw bad("Enter a business description.");
    const phone = cleanPhone(b.phone);
    const email = cleanOptionalEmail(b.email);
    if (!phone && !email) throw bad("Add a phone number or email address.");

    const id = crypto.randomUUID();
    const rawImages = cleanBusinessImages(b.images);
    let logoUrl = "";
    const galleryUrls = [];
    const newlyUploadedKeys = [];
    try {
      if (b.logo) {
        const rawLogo = String(b.logo).trim();
        if (rawLogo.startsWith("/api/images/")) {
          const k = extractB2Key(rawLogo);
          if (!k || !k.startsWith(`users/${user.id}/`)) throw bad("You do not have permission to use this logo reference.", 403);
          logoUrl = `/api/images/${k}`;
        } else {
          logoUrl = await processImageUpload(env, rawLogo, `businesses/${id}/logo`, "Logo");
          const lk = extractB2Key(logoUrl);
          if (lk) newlyUploadedKeys.push(lk);
        }
      }

      for (const rawImg of rawImages) {
        if (rawImg.startsWith("/api/images/")) {
          const k = extractB2Key(rawImg);
          if (!k || !k.startsWith(`users/${user.id}/`)) throw bad("You do not have permission to use this image reference.", 403);
          galleryUrls.push(`/api/images/${k}`);
        } else {
          const uploaded = await processImageUpload(env, rawImg, `businesses/${id}/gallery`, "Business image");
          if (uploaded) {
            galleryUrls.push(uploaded);
            const gk = extractB2Key(uploaded);
            if (gk) newlyUploadedKeys.push(gk);
          }
        }
      }

      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO businesses(id,user_id,name,category,location,phone,email,description,logo,images,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(id, user.id, name, category, location, phone, email, description, logoUrl, JSON.stringify(galleryUrls), now, now).run();
    } catch (err) {
      for (const k of newlyUploadedKeys) await b2DeleteObject(env, k);
      throw err;
    }
    const fresh = await env.DB.prepare(
      "SELECT b.*, u.name AS owner_name, u.handle AS owner_handle FROM businesses b LEFT JOIN users u ON u.id=b.user_id WHERE b.id=?"
    ).bind(id).first();
    return json({ business: publicBusiness(fresh, user) }, 201);
  }

  const bizMatch = path.match(/^businesses\/([^/]+)$/);
  if (bizMatch && bizMatch[1] !== "my" && (method === "PATCH" || method === "DELETE")) {
    const id = decodeURIComponent(bizMatch[1]);
    const existing = await env.DB.prepare("SELECT * FROM businesses WHERE id=?").bind(id).first();
    if (!existing) throw bad("Business not found.", 404);
    if (existing.user_id !== user.id) throw bad("You do not have permission to manage this business.", 403);

    if (method === "DELETE") {
      const prodCnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE business_id=?").bind(id).first();
      if ((prodCnt && prodCnt.n) > 0) {
        throw bad("This business still has product listings. Delete its products first before deleting the business.", 409);
      }
      const oldPosts = await env.DB.prepare("SELECT image FROM business_posts WHERE business_id=?").bind(id).all();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM business_posts WHERE business_id=? AND user_id=?").bind(id, user.id),
        env.DB.prepare("DELETE FROM businesses WHERE id=? AND user_id=?").bind(id, user.id),
      ]);

      if (existing.logo) {
        const logoKey = extractB2Key(existing.logo);
        if (logoKey) await b2DeleteObject(env, logoKey);
      }
      const oldGallery = safeParseImages(existing.images);
      for (const imgUrl of oldGallery) {
        const k = extractB2Key(imgUrl);
        if (k) await b2DeleteObject(env, k);
      }
      for (const bpRow of (oldPosts.results || [])) {
        if (bpRow.image) {
          const pk = extractB2Key(bpRow.image);
          if (pk) await b2DeleteObject(env, pk);
        }
      }

      return json({ ok: true });
    }

    const b = await body();
    const f = {};
    if ("name" in b) {
      f.name = cleanText(b.name, 80, "Business name");
      if (!f.name) throw bad("Business name can't be empty.");
    }
    if ("category" in b) {
      f.category = cleanText(b.category, 40, "Category");
      if (!BIZ_CATEGORIES.has(f.category)) throw bad("Choose a valid business category.");
    }
    if ("location" in b) {
      f.location = cleanText(b.location, 100, "Location");
      if (!f.location) throw bad("Location can't be empty.");
    }
    if ("description" in b) {
      f.description = cleanText(b.description, 500, "Description");
      if (!f.description) throw bad("Description can't be empty.");
    }
    if ("phone" in b) f.phone = cleanPhone(b.phone);
    if ("email" in b) f.email = cleanOptionalEmail(b.email);
    const nextPhone = "phone" in f ? f.phone : existing.phone;
    const nextEmail = "email" in f ? f.email : existing.email;
    if (!nextPhone && !nextEmail) throw bad("Keep at least one phone number or email address.");

    let oldLogoKeyToDelete = null;
    if ("logo" in b) {
      const rawLogo = b.logo;
      if (!rawLogo) {
        f.logo = "";
        if (existing.logo) oldLogoKeyToDelete = extractB2Key(existing.logo);
      } else if (typeof rawLogo === "string" && rawLogo.startsWith("/api/images/")) {
        const k = extractB2Key(rawLogo);
        if (!k) throw bad("Invalid logo reference.");
        if (!k.startsWith(`businesses/${id}/`) && !k.startsWith(`users/${user.id}/`) && rawLogo.trim() !== existing.logo) {
          throw bad("You do not have permission to use this logo reference.", 403);
        }
        f.logo = `/api/images/${k}`;
        if (existing.logo && existing.logo !== f.logo) {
          oldLogoKeyToDelete = extractB2Key(existing.logo);
        }
      } else {
        const uploadedLogo = await processImageUpload(env, rawLogo, `businesses/${id}/logo`, "Logo");
        f.logo = uploadedLogo;
        if (existing.logo && existing.logo !== uploadedLogo) {
          oldLogoKeyToDelete = extractB2Key(existing.logo);
        }
      }
    }

    const keysToDeleteFromGallery = [];
    if ("images" in b) {
      const rawList = cleanBusinessImages(b.images);
      const oldGallery = safeParseImages(existing.images);
      const oldGallerySet = new Set(oldGallery.map(extractB2Key).filter(Boolean));
      const newUrls = [];
      for (const item of rawList) {
        if (item.startsWith("/api/images/")) {
          const k = extractB2Key(item);
          if (!k) throw bad("Invalid business image reference.");
          if (!k.startsWith(`businesses/${id}/`) && !k.startsWith(`users/${user.id}/`) && !oldGallerySet.has(k)) {
            throw bad("You do not have permission to use this image reference.", 403);
          }
          newUrls.push(`/api/images/${k}`);
        } else {
          const uploaded = await processImageUpload(env, item, `businesses/${id}/gallery`, "Business image");
          if (uploaded) newUrls.push(uploaded);
        }
      }
      f.images = JSON.stringify(newUrls);

      const newKeySet = new Set(newUrls.map(extractB2Key).filter(Boolean));
      for (const oldUrl of oldGallery) {
        const oldKey = extractB2Key(oldUrl);
        if (oldKey && !newKeySet.has(oldKey)) {
          keysToDeleteFromGallery.push(oldKey);
        }
      }
    }

    const keys = Object.keys(f);
    if (keys.length) {
      await env.DB.prepare(`UPDATE businesses SET ${keys.map((k) => k + "=?").join(",")}, updated_at=? WHERE id=? AND user_id=?`)
        .bind(...keys.map((k) => f[k]), Date.now(), id, user.id).run();
    }

    if (oldLogoKeyToDelete) {
      await b2DeleteObject(env, oldLogoKeyToDelete);
    }
    for (const k of keysToDeleteFromGallery) {
      await b2DeleteObject(env, k);
    }

    const fresh = await env.DB.prepare(
      "SELECT b.*, u.name AS owner_name, u.handle AS owner_handle FROM businesses b LEFT JOIN users u ON u.id=b.user_id WHERE b.id=?"
    ).bind(id).first();
    return json({ business: publicBusiness(fresh, user) });
  }

  // --- authenticated product listings & management ---
  if (path === "products/my" && method === "GET") {
    const bizId = String(url.searchParams.get("business_id") || "").trim();
    const where = ["p.user_id=?"];
    const binds = [user.id];
    if (bizId) {
      where.push("p.business_id=?");
      binds.push(bizId);
    }
    const r = await env.DB.prepare(
      "SELECT p.*, b.name AS business_name, b.category AS business_category, b.location AS business_location " +
      "FROM products p INNER JOIN businesses b ON b.id=p.business_id WHERE " +
      where.join(" AND ") +
      " ORDER BY p.created_at DESC"
    ).bind(...binds).all();
    return json({ products: (r.results || []).map((p) => publicProduct(p, user)) });
  }

  if (path === "products" && method === "POST") {
    const b = await body();
    await limit(env, "prod:" + user.id, 60, 3600);
    const businessId = cleanText(b.business_id, 100, "Business");
    if (!businessId) throw bad("Select one of your registered businesses for this product.");
    const biz = await env.DB.prepare("SELECT id, user_id FROM businesses WHERE id=?").bind(businessId).first();
    if (!biz) throw bad("Business not found.", 404);
    if (biz.user_id !== user.id) throw bad("You do not have permission to add products to this business.", 403);

    const name = cleanText(b.name, 100, "Product name");
    if (!name) throw bad("Enter a product name.");
    const description = cleanText(b.description, 1000, "Description");
    if (!description) throw bad("Enter a product description.");
    const price = cleanPrice(b.price);
    const currency = cleanText(b.currency || "USD", 10, "Currency").toUpperCase();
    if (!PRODUCT_CURRENCIES.has(currency)) throw bad("Choose a valid currency.");
    const category = cleanText(b.category, 40, "Category");
    if (!PRODUCT_CATEGORIES.has(category)) throw bad("Choose a valid product category.");
    const condition = cleanText(b.condition, 20, "Condition");
    if (!PRODUCT_CONDITIONS.has(condition)) throw bad("Choose a valid condition (New or Resale).");
    const rawImages = cleanProductImages(b.images);
    const published = b.published === false || b.published === 0 ? 0 : 1;

    const id = crypto.randomUUID();
    const uploadedImages = [];
    const newlyUploadedKeys = [];
    try {
      for (const rawImg of rawImages) {
        if (rawImg.startsWith("/api/images/")) {
          const k = extractB2Key(rawImg);
          if (!k || !k.startsWith(`users/${user.id}/`)) throw bad("You do not have permission to use this image reference.", 403);
          uploadedImages.push(`/api/images/${k}`);
        } else {
          const uploaded = await processImageUpload(env, rawImg, `products/${id}/img`, "Product image");
          if (uploaded) {
            uploadedImages.push(uploaded);
            const pk = extractB2Key(uploaded);
            if (pk) newlyUploadedKeys.push(pk);
          }
        }
      }
      if (!uploadedImages.length) throw bad("Add at least 1 product image.");

      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO products(id,business_id,user_id,name,description,price,currency,category,condition,images,published,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(id, businessId, user.id, name, description, price, currency, category, condition, JSON.stringify(uploadedImages), published, now, now).run();
    } catch (err) {
      for (const k of newlyUploadedKeys) await b2DeleteObject(env, k);
      throw err;
    }

    const fresh = await env.DB.prepare(
      "SELECT p.*, b.name AS business_name, b.category AS business_category, b.location AS business_location " +
      "FROM products p INNER JOIN businesses b ON b.id=p.business_id WHERE p.id=?"
    ).bind(id).first();
    return json({ product: publicProduct(fresh, user) }, 201);
  }

  const prodMatch = path.match(/^products\/([^/]+)$/);
  if (prodMatch && prodMatch[1] !== "my" && (method === "PATCH" || method === "DELETE")) {
    const id = decodeURIComponent(prodMatch[1]);
    const existing = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(id).first();
    if (!existing) throw bad("Product not found.", 404);
    if (existing.user_id !== user.id) throw bad("You do not have permission to manage this product.", 403);

    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM products WHERE id=? AND user_id=?").bind(id, user.id).run();

      const oldProdImages = safeParseImages(existing.images);
      for (const imgUrl of oldProdImages) {
        const k = extractB2Key(imgUrl);
        if (k) await b2DeleteObject(env, k);
      }

      return json({ ok: true });
    }

    const b = await body();
    const f = {};
    if ("business_id" in b) {
      const nextBizId = cleanText(b.business_id, 100, "Business");
      if (!nextBizId) throw bad("Select a business for this product.");
      const targetBiz = await env.DB.prepare("SELECT id, user_id FROM businesses WHERE id=?").bind(nextBizId).first();
      if (!targetBiz) throw bad("Business not found.", 404);
      if (targetBiz.user_id !== user.id) throw bad("You do not have permission to move this product to that business.", 403);
      f.business_id = nextBizId;
    }
    if ("name" in b) {
      f.name = cleanText(b.name, 100, "Product name");
      if (!f.name) throw bad("Product name can't be empty.");
    }
    if ("description" in b) {
      f.description = cleanText(b.description, 1000, "Description");
      if (!f.description) throw bad("Description can't be empty.");
    }
    if ("price" in b) f.price = cleanPrice(b.price);
    if ("currency" in b) {
      f.currency = cleanText(b.currency, 10, "Currency").toUpperCase();
      if (!PRODUCT_CURRENCIES.has(f.currency)) throw bad("Choose a valid currency.");
    }
    if ("category" in b) {
      f.category = cleanText(b.category, 40, "Category");
      if (!PRODUCT_CATEGORIES.has(f.category)) throw bad("Choose a valid product category.");
    }
    if ("condition" in b) {
      f.condition = cleanText(b.condition, 20, "Condition");
      if (!PRODUCT_CONDITIONS.has(f.condition)) throw bad("Choose a valid condition (New or Resale).");
    }

    const keysToDeleteFromProdImages = [];
    if ("images" in b) {
      const rawList = cleanProductImages(b.images);
      const oldProdImages = safeParseImages(existing.images);
      const oldProdSet = new Set(oldProdImages.map(extractB2Key).filter(Boolean));
      const newUrls = [];
      for (const item of rawList) {
        if (item.startsWith("/api/images/")) {
          const k = extractB2Key(item);
          if (!k) throw bad("Invalid product image reference.");
          if (!k.startsWith(`products/${id}/`) && !k.startsWith(`users/${user.id}/`) && !oldProdSet.has(k)) {
            throw bad("You do not have permission to use this image reference.", 403);
          }
          newUrls.push(`/api/images/${k}`);
        } else {
          const uploaded = await processImageUpload(env, item, `products/${id}/img`, "Product image");
          if (uploaded) newUrls.push(uploaded);
        }
      }
      if (!newUrls.length) throw bad("Add at least 1 product image.");
      f.images = JSON.stringify(newUrls);

      const newKeySet = new Set(newUrls.map(extractB2Key).filter(Boolean));
      for (const oldUrl of oldProdImages) {
        const oldKey = extractB2Key(oldUrl);
        if (oldKey && !newKeySet.has(oldKey)) {
          keysToDeleteFromProdImages.push(oldKey);
        }
      }
    }
    if ("published" in b) {
      f.published = b.published ? 1 : 0;
    }

    const keys = Object.keys(f);
    if (keys.length) {
      await env.DB.prepare(`UPDATE products SET ${keys.map((k) => k + "=?").join(",")}, updated_at=? WHERE id=? AND user_id=?`)
        .bind(...keys.map((k) => f[k]), Date.now(), id, user.id).run();
    }

    for (const k of keysToDeleteFromProdImages) {
      await b2DeleteObject(env, k);
    }

    const fresh = await env.DB.prepare(
      "SELECT p.*, b.name AS business_name, b.category AS business_category, b.location AS business_location " +
      "FROM products p INNER JOIN businesses b ON b.id=p.business_id WHERE p.id=?"
    ).bind(id).first();
    return json({ product: publicProduct(fresh, user) });
  }

  // --- authenticated business posts ---
  if (path === "business-posts" && method === "POST") {
    const b = await body();
    await limit(env, "bpost:" + user.id, 60, 3600);
    const businessId = cleanText(b.business_id, 100, "Business");
    if (!businessId) throw bad("Missing business.");
    const biz = await env.DB.prepare("SELECT id, user_id FROM businesses WHERE id=?").bind(businessId).first();
    if (!biz) throw bad("Business not found.", 404);
    if (biz.user_id !== user.id) throw bad("You do not have permission to post for this business.", 403);

    const content = cleanText(b.content, 1000, "Post");
    if (!content) throw bad("Write something for your post.");

    const id = crypto.randomUUID();
    let imageUrl = "";
    let uploadedKey = null;
    try {
      if (b.image) {
        const rawImg = String(b.image).trim();
        if (rawImg.startsWith("/api/images/")) {
          const k = extractB2Key(rawImg);
          if (!k || !k.startsWith(`users/${user.id}/`)) throw bad("You do not have permission to use this image reference.", 403);
          imageUrl = `/api/images/${k}`;
        } else {
          imageUrl = await processImageUpload(env, rawImg, `businesses/${businessId}/posts/${id}`, "Post image");
          uploadedKey = extractB2Key(imageUrl);
        }
      }
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO business_posts(id,business_id,user_id,content,image,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
      ).bind(id, businessId, user.id, content, imageUrl, now, now).run();
    } catch (err) {
      if (uploadedKey) await b2DeleteObject(env, uploadedKey);
      throw err;
    }

    const fresh = await env.DB.prepare("SELECT * FROM business_posts WHERE id=?").bind(id).first();
    return json({ post: publicBusinessPost(fresh, user) }, 201);
  }

  const bizPostMatch = path.match(/^business-posts\/([^/]+)$/);
  if (bizPostMatch && method === "DELETE") {
    const id = decodeURIComponent(bizPostMatch[1]);
    const existing = await env.DB.prepare("SELECT * FROM business_posts WHERE id=?").bind(id).first();
    if (!existing) throw bad("Post not found.", 404);
    if (existing.user_id !== user.id) throw bad("You do not have permission to delete this post.", 403);
    await env.DB.prepare("DELETE FROM business_posts WHERE id=? AND user_id=?").bind(id, user.id).run();
    if (existing.image) {
      const k = extractB2Key(existing.image);
      if (k) await b2DeleteObject(env, k);
    }
    return json({ ok: true });
  }

  throw bad("Not found.", 404);
}

// ---------- entry point ----------
function plain(status, text, headers = {}) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // API
    if (path === "/api" || path.startsWith("/api/")) {
      try {
        return await handle(request, env, url);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.error(e && e.stack ? e.stack : e);
        return json({ error: "Something went wrong. Please try again." }, 500);
      }
    }

    // Static files. Normally Cloudflare answers these before this Worker runs;
    // this is the safety net for any request that still reaches the Worker.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "Method not allowed", { allow: "GET, HEAD" });
    }
    if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
      return plain(500, "Static files are not available (the ASSETS binding is missing).");
    }
    return env.ASSETS.fetch(request);
  },
};
