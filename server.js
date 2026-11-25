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
const dbPath = path.join(dbDir, 'procinity.db');
const db = new DatabaseSync(dbPath);

// Execute schema.sql to initialize tables
const schemaPath = path.join(__dirname, 'schema.sql');
if (fs.existsSync(schemaPath)) {
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schemaSql);
}

// Cloudflare D1 adapter for Node DatabaseSync
function createD1(sqlite) {
  return {
    prepare(sql) {
      let boundArgs = [];
      return {
        bind(...args) {
          boundArgs = args.map((arg) => (arg === undefined ? null : arg));
          return this;
        },
        async first() {
          const stmt = sqlite.prepare(sql);
          const row = stmt.get(...boundArgs);
          return row || null;
        },
        async all() {
          const stmt = sqlite.prepare(sql);
          const results = stmt.all(...boundArgs);
          return { results: results || [] };
        },
        async run() {
          const stmt = sqlite.prepare(sql);
          const meta = stmt.run(...boundArgs);
          return { success: true, meta };
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
  };
}

const env = {
  DB: createD1(db),
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  MAIL_FROM: process.env.MAIL_FROM || '',
};

const app = express();

// Parse raw body for /api routes to feed into Web Request
app.use('/api', express.raw({ type: '*/*', limit: '10mb' }));

// Forward /api requests to Cloudflare Worker backend
app.use('/api', async (req, res, next) => {
  try {
    const originHeader = req.headers['origin'];
    const hostHeader = req.headers['host'] || `localhost:${PORT}`;
    const protoHeader = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const baseUrl = originHeader || `${protoHeader}://${hostHeader}`;
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
    if (typeof webResponse.headers.getSetCookie === 'function') {
      const setCookies = webResponse.headers.getSetCookie();
      if (setCookies && setCookies.length > 0) {
        res.setHeader('set-cookie', setCookies);
      }
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
}));

// SPA fallback: any unhandled GET request serves public/index.html
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
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
