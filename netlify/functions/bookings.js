import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// GET /.netlify/functions/bookings — the `.bookings/*.json` records written by
// `npm run book`, for route-manager-ios's Trips timetable.
//
// Local only: bookings carry PNRs and checkout links and this function has no
// auth, so it answers 404 unless running under `netlify dev` /
// `netlify functions:serve`. A deployed version needs a real store (Blobs or
// Postgres) and auth first.
const BOOKINGS_DIR = process.env.BOOKINGS_DIR || path.resolve('.bookings');

export const handler = async (event) => {
  if (process.env.NETLIFY_DEV !== 'true') {
    return { statusCode: 404, body: JSON.stringify({ error: 'bookings is local-only' }) };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed', allowed: ['GET'] }) };
  }
  const files = (await readdir(BOOKINGS_DIR).catch(() => [])).filter((f) => f.endsWith('.json'));
  const bookings = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(BOOKINGS_DIR, f), 'utf8'))));
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bookings),
  };
};
