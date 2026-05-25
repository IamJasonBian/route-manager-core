import { useState } from 'react';
import axios from 'axios';

interface Traveler {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: 'MALE' | 'FEMALE';
  email: string;
  phone: string;
  phoneCountryCode: string;
}

interface FlightOfferPayload {
  itineraries?: Array<{
    segments?: Array<{
      departure: { iataCode: string; at: string };
      arrival: { iataCode: string; at: string };
    }>;
  }>;
  price?: { currency?: string; total?: string; grandTotal?: string };
}

interface BookingFormProps {
  flightOffer: FlightOfferPayload;
  onClose: () => void;
  onBooked: (confirmation: { orderId?: string; pnr?: string; environment?: string }) => void;
}

interface ApiErrorShape {
  response?: { data?: { message?: string } };
  message?: string;
}

const errorMessage = (err: unknown, fallback: string): string => {
  const e = err as ApiErrorShape;
  return e.response?.data?.message || e.message || fallback;
};

const blankTraveler = (): Traveler => ({
  firstName: '',
  lastName: '',
  dateOfBirth: '',
  gender: 'MALE',
  email: '',
  phone: '',
  phoneCountryCode: '1'
});

type Stage = 'form' | 'pricing' | 'booking' | 'done' | 'error';

export default function BookingForm({ flightOffer, onClose, onBooked }: BookingFormProps) {
  const [traveler, setTraveler] = useState<Traveler>(blankTraveler());
  const [stage, setStage] = useState<Stage>('form');
  const [pricedOffer, setPricedOffer] = useState<FlightOfferPayload | null>(null);
  const [confirmedPrice, setConfirmedPrice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const setField = <K extends keyof Traveler>(key: K, value: Traveler[K]) =>
    setTraveler((t) => ({ ...t, [key]: value }));

  const handleConfirmPrice = async () => {
    setErrorMsg(null);
    if (!traveler.firstName || !traveler.lastName || !traveler.dateOfBirth || !traveler.email || !traveler.phone) {
      setErrorMsg('Please complete all traveler fields.');
      return;
    }
    setStage('pricing');
    try {
      const res = await axios.post('/.netlify/functions/price-offer', { flightOffer });
      const offer = res.data?.data?.flightOffers?.[0] as FlightOfferPayload | undefined;
      if (!offer) throw new Error('No priced offer returned');
      setPricedOffer(offer);
      setConfirmedPrice(offer.price?.grandTotal || offer.price?.total || null);
      setStage('form');
    } catch (err: unknown) {
      console.error('price-offer failed', err);
      setErrorMsg(errorMessage(err, 'Pricing failed'));
      setStage('error');
    }
  };

  const handleBook = async () => {
    if (!pricedOffer) {
      setErrorMsg('Confirm price before booking.');
      return;
    }
    setErrorMsg(null);
    setStage('booking');
    try {
      const res = await axios.post('/.netlify/functions/create-order', {
        pricedOffer,
        travelers: [traveler]
      });
      const confirmation = res.data?.confirmation || {};
      setStage('done');
      onBooked(confirmation);
    } catch (err: unknown) {
      console.error('create-order failed', err);
      setErrorMsg(errorMessage(err, 'Booking failed'));
      setStage('error');
    }
  };

  const segments = flightOffer?.itineraries?.[0]?.segments || [];
  const first = segments[0];
  const last = segments[segments.length - 1];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Book this flight</h3>
            {first && last && (
              <p className="text-sm text-gray-500">
                {first.departure.iataCode} → {last.arrival.iataCode} •{' '}
                {new Date(first.departure.at).toLocaleString()} • {flightOffer.price?.currency}{' '}
                {confirmedPrice || flightOffer.price?.total}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {stage === 'done' ? (
            <div className="rounded-md bg-green-50 p-4 text-sm text-green-800">
              Booking confirmed. PNR will appear in the parent view.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="First name" value={traveler.firstName} onChange={(v) => setField('firstName', v)} />
                <Field label="Last name" value={traveler.lastName} onChange={(v) => setField('lastName', v)} />
                <Field
                  label="Date of birth"
                  type="date"
                  value={traveler.dateOfBirth}
                  onChange={(v) => setField('dateOfBirth', v)}
                />
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Gender</label>
                  <select
                    value={traveler.gender}
                    onChange={(e) => setField('gender', e.target.value as Traveler['gender'])}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500 text-sm"
                  >
                    <option value="MALE">Male</option>
                    <option value="FEMALE">Female</option>
                  </select>
                </div>
                <Field label="Email" type="email" value={traveler.email} onChange={(v) => setField('email', v)} />
                <div className="grid grid-cols-3 gap-2">
                  <Field
                    label="Country code"
                    value={traveler.phoneCountryCode}
                    onChange={(v) => setField('phoneCountryCode', v.replace(/\D/g, ''))}
                  />
                  <div className="col-span-2">
                    <Field
                      label="Phone"
                      value={traveler.phone}
                      onChange={(v) => setField('phone', v.replace(/\D/g, ''))}
                    />
                  </div>
                </div>
              </div>

              {errorMsg && (
                <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{errorMsg}</div>
              )}

              {confirmedPrice && (
                <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Price confirmed at {flightOffer.price?.currency} {confirmedPrice}. Click "Confirm booking" to ticket.
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                {!pricedOffer ? (
                  <button
                    type="button"
                    onClick={handleConfirmPrice}
                    disabled={stage === 'pricing'}
                    className="rounded-md bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
                  >
                    {stage === 'pricing' ? 'Confirming price…' : 'Confirm price'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleBook}
                    disabled={stage === 'booking'}
                    className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {stage === 'booking' ? 'Booking…' : 'Confirm booking'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}

function Field({ label, value, onChange, type = 'text' }: FieldProps) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500 text-sm"
      />
    </div>
  );
}
