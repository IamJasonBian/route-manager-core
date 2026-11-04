#!/usr/bin/env node
/**
 * Invoke search-flights handler in-process (no HTTP). Loads ../.env via dotenv.
 * Run after: NETLIFY_AUTH_TOKEN=... node scripts/pull-amadeus-from-netlify.mjs
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(root, '.env') });

function departureDate() {
  if (process.env.DEPARTURE_DATE) return process.env.DEPARTURE_DATE;
  const d = new Date();
  d.setDate(d.getDate() + 21);
  return d.toISOString().slice(0, 10);
}

const { handler } = await import('../netlify/functions/search-flights.js');

const body = {
  origin: 'JFK',
  destination: 'LAX',
  departureDate: departureDate(),
  maxResults: 5,
  nonStop: false,
};

const event = {
  httpMethod: 'POST',
  path: '/.netlify/functions/search-flights',
  body: JSON.stringify(body),
};

const result = await handler(event, {});

const parsed = JSON.parse(result.body || '{}');
console.log('statusCode', result.statusCode);
if (result.statusCode !== 200) {
  console.error(JSON.stringify(parsed, null, 2));
  process.exit(1);
}
const data = parsed.data;
if (!Array.isArray(data) || data.length === 0) {
  console.error('No offers in response');
  process.exit(2);
}
console.log(`OK: ${data.length} offer(s). First id=${data[0]?.id ?? 'n/a'}`);
process.exit(0);
