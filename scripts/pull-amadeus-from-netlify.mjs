#!/usr/bin/env node
/**
 * Pull AMADEUS_* (and optional DB_*) from Netlify site env into .env (merge, no secrets in stdout).
 *
 * Requires:
 *   NETLIFY_AUTH_TOKEN  — personal access token (Netlify UI → User settings → Applications)
 *   NETLIFY_SITE_ID     — optional; defaults to alpha site ID from CI (see deploy-netlify.yml)
 *
 * Usage:
 *   NETLIFY_AUTH_TOKEN=xxx node scripts/pull-amadeus-from-netlify.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');

/** Default: alpha site (public in repo workflow). Override with NETLIFY_SITE_ID or NETLIFY_SITE_ID_GAMMA. */
const DEFAULT_SITE_ID = 'b26b3133-30c1-46f3-b976-59ab7c928b57';

const KEYS = [
  'AMADEUS_API_KEY',
  'AMADEUS_API_SECRET',
  'AMADEUS_HOSTNAME',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'DB_HOST',
  'DB_PORT',
];

function pickValue(entry) {
  const vals = entry.values || [];
  if (!vals.length) return '';
  const order = ['dev', 'development', 'branch-deploy', 'production', 'deploy-preview', 'all'];
  for (const ctx of order) {
    const v = vals.find((x) => x.context === ctx && x.value != null && String(x.value) !== '');
    if (v) return String(v.value);
  }
  const any = vals.find((x) => x.value != null && String(x.value) !== '');
  return any ? String(any.value) : '';
}

async function main() {
  const token = process.env.NETLIFY_AUTH_TOKEN?.trim();
  if (!token) {
    console.error('Missing NETLIFY_AUTH_TOKEN. Create a token at Netlify → User settings → Applications.');
    process.exit(1);
  }

  const siteId =
    process.env.NETLIFY_SITE_ID?.trim() ||
    process.env.NETLIFY_SITE_ID_GAMMA?.trim() ||
    DEFAULT_SITE_ID;

  const url = `https://api.netlify.com/api/v1/sites/${siteId}/env`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Netlify API ${res.status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }

  const list = await res.json();
  if (!Array.isArray(list)) {
    console.error('Unexpected response shape (expected array of env vars)');
    process.exit(1);
  }

  const byKey = new Map(list.map((e) => [e.key, e]));
  const pulled = {};
  for (const key of KEYS) {
    const entry = byKey.get(key);
    if (!entry) continue;
    const value = pickValue(entry);
    if (value) pulled[key] = value;
  }

  if (!pulled.AMADEUS_API_KEY && !pulled.AMADEUS_API_SECRET) {
    console.error('No AMADEUS_API_KEY / AMADEUS_API_SECRET found on this Netlify site.');
    process.exit(1);
  }

  let existing = '';
  if (fs.existsSync(envPath)) {
    existing = fs.readFileSync(envPath, 'utf8');
  }

  const lines = existing.split(/\r?\n/);
  const kept = [];
  const pulledSet = new Set(Object.keys(pulled));
  for (const line of lines) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (m && pulledSet.has(m[1])) continue;
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();

  const block = [
    '',
    '# --- pulled from Netlify (scripts/pull-amadeus-from-netlify.mjs) ---',
    ...Object.entries(pulled).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n');

  const out = (kept.length ? kept.join('\n') + '\n' : '') + block;
  fs.writeFileSync(envPath, out, 'utf8');
  console.log(`Wrote ${Object.keys(pulled).length} variable(s) to .env (site ${siteId}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
