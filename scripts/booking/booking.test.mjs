import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingFromKiwi, transition } from './lib/booking.mjs';
import { toAmadeusOffer, toKiwiDate } from '../../netlify/functions/lib/kiwi.js';

const seg = (from, to, dep, arr, fn) => ({
  from, to, departureTime: dep, arrivalTime: arr, durationSeconds: 3600,
  carrier: 'DL', carrierName: 'Delta Air Lines', flightNumber: fn, cabinClass: 'Economy',
});

const KIWI_IT = {
  id: 'kiwi-offer-1',
  price: 211,
  priceFormatted: '211 USD',
  bookingUrl: 'https://kiwi.com/u/abc',
  baggage: { personalItem: 1, cabinBag: 1, checkedBag: 0 },
  outbound: {
    from: 'LGA', to: 'DTW', route: ['LGA', 'DTW'], stops: 0, durationSeconds: 7200,
    departureTime: '2026-11-13T08:00:00', arrivalTime: '2026-11-13T10:00:00',
    segments: [seg('LGA', 'DTW', '2026-11-13T08:00:00', '2026-11-13T10:00:00', 'DL1234')],
  },
  inbound: null,
};

test('bookingFromKiwi builds a quoted one-way booking', () => {
  const b = bookingFromKiwi(KIWI_IT, { currency: 'USD' });
  assert.match(b.id, /^bk_20261113_lga_dtw_[0-9a-f]{4}$/);
  assert.equal(b.status, 'quoted');
  assert.equal(b.tripType, 'one_way');
  assert.deepEqual(b.quotedPrice, { amount: 211, currency: 'USD' });
  assert.equal(b.slices[0].segments[0].flightNumber, '1234');
  assert.equal(b.channel.provider, 'kiwi');
  assert.equal(b.passengers.length, 1);
});

test('transition walks quoted → handoff → confirmed → ticketed', () => {
  let b = bookingFromKiwi(KIWI_IT, { currency: 'USD' });
  b = transition(b, 'handoff');
  b = transition(b, 'confirmed', { recordLocator: 'ABC123' });
  b = transition(b, 'ticketed', { ticketNumbers: ['0061234567890'] });
  assert.equal(b.status, 'ticketed');
  assert.deepEqual(b.history.map((e) => e.to), ['quoted', 'handoff', 'confirmed', 'ticketed']);
});

test('transition rejects illegal moves and confirm without PNR', () => {
  const b = bookingFromKiwi(KIWI_IT, { currency: 'USD' });
  assert.throws(() => transition(b, 'ticketed'), /Illegal/);
  assert.throws(() => transition(b, 'confirmed'), /recordLocator/);
  const cancelled = transition(b, 'cancelled');
  assert.throws(() => transition(cancelled, 'handoff'), /Illegal/);
});

test('toAmadeusOffer keeps the shape the UI reads', () => {
  const o = toAmadeusOffer(KIWI_IT, 0, 'USD');
  assert.equal(o.price.grandTotal, '211.00');
  assert.equal(o.itineraries[0].duration, 'PT2H');
  assert.equal(o.itineraries[0].segments[0].carrierCode, 'DL');
  assert.equal(o.itineraries[0].segments[0].number, '1234');
  assert.equal(toKiwiDate('2026-11-13'), '13/11/2026');
});
