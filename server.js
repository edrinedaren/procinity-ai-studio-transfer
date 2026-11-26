import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from './src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const HOST = '0.0.0.0';

// Ensure data directory exists
const dbDir = path.join(__dirname, '.data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize SQLite database
let db = null;
try {
  const dbPath = path.join(dbDir, 'procinity.db');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
} catch (err) {
  console.warn('[AI Studio] File-based SQLite failed, falling back to in-memory SQLite:', err.message);
  try {
    db = new DatabaseSync(':memory:');
  } catch (err2) {
    console.warn('[AI Studio] SQLite unavailable, fallback mock will be used:', err2.message);
  }
}

// Execute schema.sql to initialize tables
if (db) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    try {
      const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
      db.exec(schemaSql);
    } catch (err) {
      console.warn('[AI Studio] schema.sql warning:', err.message);
    }
  }

  // Execute any migrations
  const migrationsDir = path.join(__dirname, 'migrations');
  if (fs.existsSync(migrationsDir)) {
    for (const f of fs.readdirSync(migrationsDir).sort()) {
      if (f.endsWith('.sql')) {
        try {
          db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf-8'));
        } catch (err) {
          console.warn(`[AI Studio] Migration ${f} warning:`, err.message);
        }
      }
    }
  }
}

// Cloudflare D1 adapter for Node DatabaseSync
function createD1(sqlite) {
  if (!sqlite) {
    return {
      prepare() {
        return {
          bind() { return this; },
          async first() { return null; },
          async all() { return { results: [], success: true, meta: {} }; },
          async run() { return { success: true, meta: { changes: 0, last_row_id: 0 } }; },
        };
      },
      async batch() { return []; },
      async exec() {},
    };
  }
  return {
    prepare(sql) {
      let boundArgs = [];
      return {
        bind(...args) {
          boundArgs = args.map((arg) => (arg === undefined ? null : arg));
          return this;
        },
        async first(col) {
          const stmt = sqlite.prepare(sql);
          const row = stmt.get(...boundArgs);
          if (!row) return null;
          return col ? row[col] : row;
        },
        async all() {
          const stmt = sqlite.prepare(sql);
          const results = stmt.all(...boundArgs);
          return { results: results || [], success: true, meta: {} };
        },
        async run() {
          const stmt = sqlite.prepare(sql);
          const meta = stmt.run(...boundArgs);
          return {
            success: true,
            meta: {
              changes: meta.changes,
              last_row_id: Number(meta.lastInsertRowid || 0),
            },
          };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
    async exec(sql) {
      sqlite.exec(sql);
    },
  };
}

const env = {
  DB: createD1(db),
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  MAIL_FROM: process.env.MAIL_FROM || '',
};

const app = express();
app.set('trust proxy', true);

// Parse raw body for /api routes to feed into Web Request
app.use('/api', express.raw({ type: '*/*', limit: '10mb' }));

// Forward /api requests to Cloudflare Worker backend
app.use('/api', async (req, res, next) => {
  try {
    const rawOrigin = req.headers['origin'];
    const validOrigin = typeof rawOrigin === 'string' && rawOrigin !== 'null' && /^https?:\/\//i.test(rawOrigin) ? rawOrigin : '';
    const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string'
      ? req.headers['x-forwarded-host'].split(',')[0].trim()
      : '';
    const hostHeader = forwardedHost || req.headers['host'] || `localhost:${PORT}`;
    const rawProto = typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0].trim()
      : (req.protocol || 'http');
    const protoHeader = rawProto === 'https' || rawProto === 'http' ? rawProto : 'http';
    let validOriginUrl = null;
    try {
      if (validOrigin) validOriginUrl = new URL(validOrigin);
    } catch {}
    const rawReferer = typeof req.headers['referer'] === 'string' ? req.headers['referer'] : '';
    let validRefererUrl = null;
    try {
      if (rawReferer) validRefererUrl = new URL(rawReferer);
    } catch {}

    const originMatchesHost = !!(validOriginUrl && validOriginUrl.host.toLowerCase() === hostHeader.toLowerCase());
    const refererMatchesHost = !!(validRefererUrl && validRefererUrl.host.toLowerCase() === hostHeader.toLowerCase());
    const isForwardedHttps = !!(forwardedHost && !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(hostHeader));

    const effectiveProto = originMatchesHost
      ? validOriginUrl.protocol.slice(0, -1)
      : (refererMatchesHost
        ? validRefererUrl.protocol.slice(0, -1)
        : (isForwardedHttps ? 'https' : protoHeader));

    const isLocalHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(hostHeader);
    const baseUrl = (!forwardedHost && isLocalHost && validOrigin)
      ? validOrigin
      : `${effectiveProto}://${hostHeader}`;
    const fullUrl = new URL(req.originalUrl, baseUrl).href;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
    if (!headers.has('cf-connecting-ip')) {
      const forwardedFor = typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : '';
      headers.set('cf-connecting-ip', forwardedFor || req.ip || '127.0.0.1');
    }

    const init = {
      method: req.method,
      headers,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
      init.body = req.body;
      init.duplex = 'half';
    }

    const webRequest = new Request(fullUrl, init);
    const webResponse = await worker.fetch(webRequest, env);

    res.status(webResponse.status);

    // Forward headers
    let setCookies = [];
    if (typeof webResponse.headers.getSetCookie === 'function') {
      setCookies = webResponse.headers.getSetCookie() || [];
    } else if (webResponse.headers.has('set-cookie')) {
      const single = webResponse.headers.get('set-cookie');
      if (single) setCookies = [single];
    }

    if (setCookies.length > 0) {
      if (effectiveProto === 'https' || isForwardedHttps) {
        setCookies = setCookies.map((cookieStr) => {
          let s = cookieStr;
          if (!/;\s*Secure\b/i.test(s)) {
            s += '; Secure';
          }
          if (/;\s*SameSite=[^;]+/i.test(s)) {
            s = s.replace(/;\s*SameSite=[^;]+/i, '; SameSite=None');
          } else {
            s += '; SameSite=None';
          }
          if (!/;\s*Partitioned\b/i.test(s)) {
            s += '; Partitioned';
          }
          return s;
        });
      }
      res.setHeader('set-cookie', setCookies);
    }

    for (const [key, value] of webResponse.headers.entries()) {
      if (key.toLowerCase() !== 'set-cookie') {
        res.setHeader(key, value);
      }
    }

    const arrayBuffer = await webResponse.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
  } catch (err) {
    next(err);
  }
});

// Serve static assets from public/ directory
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, {
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (!/[\\/](images|icons)[\\/]/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// SPA fallback: any unhandled GET request serves public/index.html
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(path.join(publicDir, 'index.html'));
  }
  next();
});

// Error handling middleware
app.use((err, req, res, _next) => {
  console.error('[Server Error]', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
