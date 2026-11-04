// Provider-agnostic booking client. Quotes from Kiwi's public search, stores a
// Booking (src/types/booking.ts) under .bookings/, and walks it through
// handoff → confirmed → ticketed as the traveller completes checkout.
//
// SAFETY: this never pays for anything. `handoff` only hands back the seller's
// checkout URL; payment happens on the seller's site (or via book-delta-trip /
// book-aa-trip with their own --confirm-purchase gate).
//
// Usage:
//   node scripts/booking/book.mjs quote --from "New York" --to DTW --depart 2026-11-13 \
//        [--return 2026-11-15] [--adults 1] [--nonstop] [--carrier DL] [--pick 1]
//   node scripts/booking/book.mjs handoff  <id>
//   node scripts/booking/book.mjs confirm  <id> --pnr ABC123 [--paid 211]
//   node scripts/booking/book.mjs ticket   <id> --tickets 0062345678901[,...]
//   node scripts/booking/book.mjs cancel   <id> [--note "..."]
//   node scripts/booking/book.mjs list | show <id>

import { searchKiwi } from '../../netlify/functions/lib/kiwi.js';
import {
  bookingFromKiwi,
  describe,
  listBookings,
  loadBooking,
  saveBooking,
  transition,
} from './lib/booking.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--nonstop') args.nonstop = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

const DIRECT_FLOWS = { DL: 'book:delta', AA: 'book:aa' };

async function quote(args) {
  const missing = ['from', 'to', 'depart'].filter((k) => !args[k]);
  if (missing.length) throw new Error(`Missing ${missing.map((m) => '--' + m).join(', ')}`);

  const { currency, itineraries } = await searchKiwi({
    origin: args.from,
    destination: args.to,
    departureDate: args.depart,
    returnDate: args.return,
    adults: Number(args.adults || 1),
    nonStop: args.nonstop,
  });

  const carrier = args.carrier?.toUpperCase();
  const legs = (it) => [it.outbound, it.inbound].filter(Boolean);
  const candidates = itineraries.filter(
    (it) => !carrier || legs(it).every((l) => l.segments.every((s) => s.carrier === carrier)),
  );
  if (!candidates.length) throw new Error(`No offers for ${args.from} → ${args.to} on ${args.depart}`);

  console.log(`\n${candidates.length} offers (${currency}), cheapest first:`);
  candidates.slice(0, 8).forEach((it, i) => {
    const o = it.outbound;
    const carriers = [...new Set(legs(it).flatMap((l) => l.segments.map((s) => s.carrier)))].join('/');
    console.log(
      `  ${String(i + 1).padStart(2)}. ${String(it.price).padStart(5)}  ${o.route.join('→').padEnd(16)} ` +
        `${o.departureTime.slice(5, 16).replace('T', ' ')} → ${o.arrivalTime.slice(11, 16)}  ` +
        `${o.stops ? `${o.stops} stop` : 'nonstop'}  ${carriers}`,
    );
  });

  const pick = Number(args.pick || 1);
  const chosen = candidates[pick - 1];
  if (!chosen) throw new Error(`--pick ${pick} out of range`);

  const booking = bookingFromKiwi(chosen, { currency, adults: Number(args.adults || 1) });
  const file = await saveBooking(booking);
  console.log(`\nQuoted #${pick} → ${file}\n${describe(booking)}`);

  const carriers = new Set(booking.slices.flatMap((s) => s.segments.map((g) => g.marketingCarrier)));
  const direct = carriers.size === 1 && DIRECT_FLOWS[[...carriers][0]];
  console.log(`\nNext: node scripts/booking/book.mjs handoff ${booking.id}   # Kiwi checkout link`);
  if (direct) {
    const s = booking.slices;
    console.log(
      `  or: npm run ${direct} -- --from ${s[0].origin} --to ${s[0].destination} --depart ${args.depart}` +
        `${args.return ? ` --return ${args.return}` : ''}   # airline-direct (dry-run)`,
    );
  }
}

async function update(id, to, patch) {
  const next = transition(await loadBooking(id), to, patch);
  await saveBooking(next);
  console.log(describe(next));
  return next;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd = 'quote', id] = args._;
  switch (cmd) {
    case 'quote':
      return quote(args);
    case 'handoff': {
      const b = await update(id, 'handoff', { note: 'sent to seller checkout' });
      console.log(`\nOpen to pay on ${b.channel.provider}: ${b.channel.bookingUrl}`);
      console.log(`Then: node scripts/booking/book.mjs confirm ${b.id} --pnr <RECORD_LOCATOR>`);
      return;
    }
    case 'confirm': {
      if (!args.pnr) throw new Error('confirm requires --pnr');
      const b = await loadBooking(id);
      const paid = args.paid ? Number(args.paid) : b.quotedPrice.amount;
      return update(id, 'confirmed', {
        recordLocator: args.pnr.toUpperCase(),
        finalPrice: { amount: paid, currency: b.quotedPrice.currency },
        payment: { status: 'paid', paidAmount: { amount: paid, currency: b.quotedPrice.currency } },
        note: args.note,
      });
    }
    case 'ticket':
      if (!args.tickets) throw new Error('ticket requires --tickets');
      return update(id, 'ticketed', { ticketNumbers: args.tickets.split(','), note: args.note });
    case 'cancel':
      return update(id, 'cancelled', { note: args.note });
    case 'show':
      return console.log(JSON.stringify(await loadBooking(id), null, 2));
    case 'list':
      for (const b of await listBookings()) console.log(describe(b) + '\n');
      return;
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
