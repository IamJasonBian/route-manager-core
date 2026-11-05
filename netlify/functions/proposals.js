// Trip proposals endpoint.
//
// Backed by Postgres when DB_HOST is configured; otherwise falls back to a
// per-instance in-memory store so the endpoint stays usable in environments
// (e.g. Netlify alpha) where no database is provisioned. Without this
// fallback the function throws "No database configured. Set DB_HOST for
// Postgres in production." and returns a 502.

import crypto from 'crypto';

import {
  ActionValidationError,
  normalizeActions,
} from './lib/proposalActions.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

const VALID_STATUSES = new Set(['draft', 'active', 'booked', 'archived']);

const memoryStore = (() => {
  const items = new Map();
  return {
    list: () =>
      Array.from(items.values()).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    get: (id) => items.get(id) || null,
    create: (proposal) => {
      items.set(proposal.id, proposal);
      return proposal;
    },
    update: (id, patch) => {
      const existing = items.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch, updated_at: new Date().toISOString() };
      items.set(id, updated);
      return updated;
    },
    delete: (id) => items.delete(id),
  };
})();

let pgPool = null;
let pgInitError = null;

async function getPgPool() {
  if (pgPool || pgInitError) return pgPool;
  if (!process.env.DB_HOST) return null;
  try {
    const { Pool } = await import('pg');
    pgPool = new Pool({
      user: process.env.DB_USER || 'routeuser',
      host: process.env.DB_HOST,
      database: process.env.DB_NAME || 'routedb',
      password: process.env.DB_PASSWORD,
      port: parseInt(process.env.DB_PORT || '5432', 10),
    });
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        origin TEXT,
        destination TEXT,
        depart_date TEXT,
        return_date TEXT,
        price_cents INTEGER,
        currency TEXT DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'draft',
        notes TEXT,
        payload JSONB,
        actions JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Best-effort migration for pre-existing tables.
    await pgPool.query(
      `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS actions JSONB NOT NULL DEFAULT '[]'::jsonb`
    );
    return pgPool;
  } catch (err) {
    pgInitError = err;
    console.error('[proposals] Postgres unavailable, using in-memory store:', err.message);
    pgPool = null;
    return null;
  }
}

function rowToProposal(row) {
  return {
    id: row.id,
    title: row.title,
    origin: row.origin,
    destination: row.destination,
    departDate: row.depart_date,
    returnDate: row.return_date,
    priceCents: row.price_cents,
    currency: row.currency,
    status: row.status,
    notes: row.notes,
    payload: row.payload,
    actions: Array.isArray(row.actions) ? row.actions : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildProposal(input) {
  const now = new Date().toISOString();
  return {
    id: input.id || crypto.randomUUID(),
    title: input.title || `${input.origin || 'TRIP'} → ${input.destination || ''}`.trim(),
    origin: input.origin || null,
    destination: input.destination || null,
    departDate: input.departDate || input.depart_date || null,
    returnDate: input.returnDate || input.return_date || null,
    priceCents: input.priceCents ?? input.price_cents ?? null,
    currency: input.currency || 'USD',
    status: VALID_STATUSES.has(input.status) ? input.status : 'draft',
    notes: input.notes || null,
    payload: input.payload ?? null,
    actions: normalizeActions(input.actions),
    created_at: now,
    updated_at: now,
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function extractIdFromPath(event) {
  // Supports /.netlify/functions/proposals/:id and ?id=...
  const queryId = event.queryStringParameters && event.queryStringParameters.id;
  if (queryId) return queryId;
  const segments = (event.path || '').split('/').filter(Boolean);
  const idx = segments.indexOf('proposals');
  if (idx >= 0 && segments[idx + 1]) return segments[idx + 1];
  return null;
}

function ok(body, statusCode = 200) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function fail(statusCode, message, extra = {}) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: message, ...extra }),
  };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const pool = await getPgPool();
  const usingDb = Boolean(pool);

  try {
    if (event.httpMethod === 'GET') {
      if (usingDb) {
        const result = await pool.query(
          'SELECT * FROM proposals ORDER BY created_at DESC LIMIT 200'
        );
        return ok(result.rows.map(rowToProposal));
      }
      return ok(memoryStore.list());
    }

    if (event.httpMethod === 'POST') {
      const input = parseBody(event);
      const proposal = buildProposal(input);
      if (usingDb) {
        const result = await pool.query(
          `INSERT INTO proposals
            (id, title, origin, destination, depart_date, return_date,
             price_cents, currency, status, notes, payload, actions)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          [
            proposal.id,
            proposal.title,
            proposal.origin,
            proposal.destination,
            proposal.departDate,
            proposal.returnDate,
            proposal.priceCents,
            proposal.currency,
            proposal.status,
            proposal.notes,
            proposal.payload,
            JSON.stringify(proposal.actions),
          ]
        );
        return ok(rowToProposal(result.rows[0]), 201);
      }
      memoryStore.create(proposal);
      return ok(proposal, 201);
    }

    if (event.httpMethod === 'PUT') {
      const input = parseBody(event);
      const id = input.id || extractIdFromPath(event);
      if (!id) return fail(400, 'Missing proposal id');
      const patch = {};
      if (input.status !== undefined) {
        if (!VALID_STATUSES.has(input.status)) {
          return fail(400, `Invalid status. Allowed: ${[...VALID_STATUSES].join(', ')}`);
        }
        patch.status = input.status;
      }
      for (const key of ['title', 'notes', 'priceCents', 'payload']) {
        if (input[key] !== undefined) patch[key] = input[key];
      }
      if (input.actions !== undefined) {
        patch.actions = normalizeActions(input.actions);
      }
      if (usingDb) {
        const result = await pool.query(
          `UPDATE proposals SET
              title = COALESCE($2, title),
              status = COALESCE($3, status),
              notes = COALESCE($4, notes),
              price_cents = COALESCE($5, price_cents),
              payload = COALESCE($6, payload),
              actions = COALESCE($7::jsonb, actions),
              updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            id,
            patch.title ?? null,
            patch.status ?? null,
            patch.notes ?? null,
            patch.priceCents ?? null,
            patch.payload ?? null,
            patch.actions ? JSON.stringify(patch.actions) : null,
          ]
        );
        if (result.rowCount === 0) return fail(404, 'Proposal not found');
        return ok(rowToProposal(result.rows[0]));
      }
      const updated = memoryStore.update(id, patch);
      if (!updated) return fail(404, 'Proposal not found');
      return ok(updated);
    }

    if (event.httpMethod === 'DELETE') {
      const id = extractIdFromPath(event);
      if (!id) return fail(400, 'Missing proposal id');
      if (usingDb) {
        const result = await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
        if (result.rowCount === 0) return fail(404, 'Proposal not found');
      } else if (!memoryStore.delete(id)) {
        return fail(404, 'Proposal not found');
      }
      return ok({ id, deleted: true });
    }

    return fail(405, `Method ${event.httpMethod} not allowed`);
  } catch (err) {
    if (err instanceof ActionValidationError) {
      return fail(400, err.message);
    }
    console.error('[proposals] handler error:', err);
    return fail(500, err.message || 'Internal server error');
  }
};
