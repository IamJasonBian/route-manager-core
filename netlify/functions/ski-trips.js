import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM-safe __dirname replacement for resolving the data file path at runtime.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data', 'ski-trips.json');

let cachedDataset = null;

const loadDataset = async () => {
  if (cachedDataset) return cachedDataset;
  const raw = await readFile(DATA_FILE, 'utf-8');
  cachedDataset = JSON.parse(raw);
  return cachedDataset;
};

const baseHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const jsonResponse = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: {
    ...baseHeaders,
    'Content-Type': 'application/json',
    'X-Processed-At': new Date().toISOString(),
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: baseHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  try {
    const dataset = await loadDataset();
    const params = event.queryStringParameters || {};
    const { id, mode } = params;

    if (id) {
      const trip = dataset.trips.find((t) => t.id === id);
      if (!trip) {
        return jsonResponse(404, { error: 'Trip not found', id });
      }
      console.log(`ski-trips: served 1 trip (id=${id})`);
      return jsonResponse(200, {
        generatedAt: dataset.generatedAt,
        seasonTarget: dataset.seasonTarget,
        weekend: dataset.weekend,
        priceBasis: dataset.priceBasis,
        origin: dataset.origin,
        trip,
      });
    }

    let trips = dataset.trips;
    if (mode === 'bus' || mode === 'flight') {
      trips = trips.filter((t) => t?.transport?.mode === mode);
    } else if (mode) {
      return jsonResponse(400, {
        error: 'Invalid mode',
        allowed: ['bus', 'flight'],
      });
    }

    console.log(`ski-trips: served ${trips.length} trips${mode ? ` (mode=${mode})` : ''}`);
    return jsonResponse(200, { ...dataset, trips });
  } catch (error) {
    console.error('ski-trips handler error:', error);
    return jsonResponse(500, {
      error: 'Failed to load ski trips dataset',
      message: error.message,
    });
  }
};
