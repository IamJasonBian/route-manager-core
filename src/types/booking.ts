/**
 * Booking domain model.
 *
 * Shaped after public airline-retailing models so any provider can map into it:
 * - IATA NDC: an immutable priced *Offer* becomes a stateful *Order* once accepted.
 * - Duffel Order: slices → segments, passengers, payment_status, documents, conditions.
 * - schema.org FlightReservation: reservationStatus, reservationId (PNR), underName.
 *
 * Runtime helpers (factory, state machine, local store) live in
 * scripts/booking/lib/booking.mjs and must stay in sync with these types.
 */

export type BookingStatus =
  | 'quoted' // priced offer captured, nothing reserved
  | 'handoff' // traveller sent to the seller's checkout (OTA / airline site)
  | 'held' // seats reserved, payment still due (hold / pay-later)
  | 'confirmed' // seller issued a record locator (PNR)
  | 'ticketed' // e-ticket numbers issued
  | 'cancelled'
  | 'expired' // offer or hold lapsed before payment
  | 'failed';

/** How the booking is fulfilled. */
export type ChannelKind =
  | 'ota_handoff' // public metasearch / OTA deep link (Kiwi, Google Flights)
  | 'airline_direct' // our own airline account via browser automation (delta.com, aa.com)
  | 'aggregator_api'; // order-creation API (e.g. Duffel, NDC aggregator)

export interface BookingChannel {
  kind: ChannelKind;
  provider: string; // 'kiwi' | 'delta.com' | 'aa.com' | 'duffel' | ...
  bookingUrl?: string;
  providerOfferId?: string;
  providerOrderId?: string;
}

export interface Money {
  amount: number;
  currency: string; // ISO 4217
}

export interface BookingSegment {
  origin: string; // IATA airport
  destination: string;
  departureAt: string; // local ISO datetime, no offset (as published by carriers)
  arrivalAt: string;
  marketingCarrier: string; // IATA airline code
  marketingCarrierName?: string;
  flightNumber: string; // numeric part only, e.g. '2008'
  cabin: string;
  durationSeconds?: number;
}

/** One directional journey (outbound or return), per NDC/Duffel "slice". */
export interface BookingSlice {
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
  durationSeconds: number;
  segments: BookingSegment[];
}

export interface Passenger {
  id: string;
  type: 'adult' | 'child' | 'infant';
  givenName?: string;
  familyName?: string;
  bornOn?: string; // YYYY-MM-DD
  loyalty?: { airline: string; number: string }[];
}

export interface BaggageAllowance {
  personalItem: number;
  cabinBag: number;
  checkedBag: number;
}

export interface PaymentState {
  status: 'not_started' | 'awaiting_payment' | 'paid' | 'refunded';
  paidAmount?: Money;
  paymentRequiredBy?: string; // ISO datetime, for holds
}

export interface BookingEvent {
  at: string; // ISO datetime
  from: BookingStatus | null;
  to: BookingStatus;
  note?: string;
}

export interface Booking {
  id: string; // our id, e.g. bk_20261113_lga_dtw_x7k2
  status: BookingStatus;
  createdAt: string;
  updatedAt: string;

  tripType: 'one_way' | 'round_trip';
  slices: BookingSlice[];
  passengers: Passenger[];
  baggage?: BaggageAllowance;

  /** Price at quote time; the seller may reprice at checkout. */
  quotedPrice: Money;
  finalPrice?: Money;
  offerExpiresAt?: string;

  channel: BookingChannel;
  payment: PaymentState;

  /** Seller record locator, set on `confirmed`. */
  recordLocator?: string;
  ticketNumbers?: string[];

  history: BookingEvent[];
}
