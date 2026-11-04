// Runtime for the Booking model in src/types/booking.ts: build a Booking from a
// provider offer, move it through the status state machine, and persist it as
// JSON under .bookings/ (gitignored).

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const BOOKINGS_DIR = process.env.BOOKINGS_DIR || path.resolve('.bookings');

// Allowed status transitions. Terminal states have no outgoing edges.
export const TRANSITIONS = {
  quoted: ['handoff', 'held', 'confirmed', 'cancelled', 'expired', 'failed'],
  handoff: ['confirmed', 'cancelled', 'expired', 'failed'],
  held: ['confirmed', 'cancelled', 'expired', 'failed'],
  confirmed: ['ticketed', 'cancelled'],
  ticketed: ['cancelled'],
  cancelled: [],
  expired: [],
  failed: [],
};

const now = () => new Date().toISOString();

function toSlice(leg) {
  return {
    origin: leg.from ?? leg.route[0],
    destination: leg.to ?? leg.route[leg.route.length - 1],
    departureAt: leg.departureTime,
    arrivalAt: leg.arrivalTime,
    durationSeconds: leg.durationSeconds,
    segments: leg.segments.map((s) => ({
      origin: s.from,
      destination: s.to,
      departureAt: s.departureTime,
      arrivalAt: s.arrivalTime,
      marketingCarrier: s.carrier,
      marketingCarrierName: s.carrierName,
      flightNumber: String(s.flightNumber).replace(/^[A-Z0-9]{2}(?=\d)/, ''),
      cabin: s.cabinClass,
      durationSeconds: s.durationSeconds,
    })),
  };
}

/**
 * Build a `quoted` Booking from a Kiwi itinerary.
 * @param {object} it Kiwi `search-flight` itinerary
 * @param {{ currency: string, adults?: number }} opts
 */
export function bookingFromKiwi(it, { currency, adults = 1 }) {
  const slices = [it.outbound, it.inbound].filter(Boolean).map(toSlice);
  const first = slices[0];
  const id = [
    'bk',
    first.departureAt.slice(0, 10).replaceAll('-', ''),
    first.origin.toLowerCase(),
    first.destination.toLowerCase(),
    randomBytes(2).toString('hex'),
  ].join('_');
  const t = now();
  return {
    id,
    status: 'quoted',
    createdAt: t,
    updatedAt: t,
    tripType: slices.length > 1 ? 'round_trip' : 'one_way',
    slices,
    passengers: Array.from({ length: adults }, (_, i) => ({ id: `pax_${i + 1}`, type: 'adult' })),
    baggage: it.baggage,
    quotedPrice: { amount: Number(it.price), currency },
    channel: {
      kind: 'ota_handoff',
      provider: 'kiwi',
      bookingUrl: it.bookingUrl,
      providerOfferId: it.id,
    },
    payment: { status: 'not_started' },
    history: [{ at: t, from: null, to: 'quoted', note: `kiwi offer ${it.priceFormatted ?? it.price}` }],
  };
}

/**
 * Move a booking to a new status, recording the event. Returns a new object.
 * @throws {Error} when the transition is not allowed
 */
export function transition(booking, to, { note, ...patch } = {}) {
  const allowed = TRANSITIONS[booking.status] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Illegal booking transition ${booking.status} → ${to} (${booking.id})`);
  }
  if (to === 'confirmed' && !(patch.recordLocator ?? booking.recordLocator)) {
    throw new Error(`Booking ${booking.id}: 'confirmed' requires a recordLocator`);
  }
  const t = now();
  return {
    ...booking,
    ...patch,
    status: to,
    updatedAt: t,
    history: [...booking.history, { at: t, from: booking.status, to, ...(note && { note }) }],
  };
}

/** Human-readable one-block summary of a booking. */
export function describe(b) {
  const lines = [`${b.id}  [${b.status}]  ${b.quotedPrice.amount} ${b.quotedPrice.currency}  via ${b.channel.provider}`];
  for (const s of b.slices) {
    lines.push(`  ${s.origin} → ${s.destination}  ${s.departureAt.replace('T', ' ')} → ${s.arrivalAt.replace('T', ' ')}`);
    for (const g of s.segments) {
      lines.push(
        `    ${g.marketingCarrier}${g.flightNumber.padEnd(5)} ${g.origin}-${g.destination}  ` +
          `${g.departureAt.slice(11, 16)}–${g.arrivalAt.slice(11, 16)}  ${g.marketingCarrierName ?? ''}`,
      );
    }
  }
  if (b.recordLocator) lines.push(`  PNR ${b.recordLocator}`);
  if (b.channel.bookingUrl) lines.push(`  checkout: ${b.channel.bookingUrl}`);
  return lines.join('\n');
}

export async function saveBooking(b) {
  await mkdir(BOOKINGS_DIR, { recursive: true });
  const file = path.join(BOOKINGS_DIR, `${b.id}.json`);
  await writeFile(file, JSON.stringify(b, null, 2) + '\n');
  return file;
}

export async function loadBooking(id) {
  return JSON.parse(await readFile(path.join(BOOKINGS_DIR, `${id}.json`), 'utf8'));
}

export async function listBookings() {
  const files = await readdir(BOOKINGS_DIR).catch(() => []);
  return Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => loadBooking(f.slice(0, -5))));
}
