// Schema, validation, and suggestion templates for trip proposal actions.
//
// An "action" is anything attached to a trip proposal that the traveler
// might do across phases of the trip — pre-departure reading, choosing
// between EWR vs LGA, food near the airport, pickup at arrival, onward
// travel like driving to Mammoth, optional packing, add-on activities, etc.

import crypto from 'crypto';

export const ACTION_CATEGORIES = Object.freeze([
  'reading',     // books / articles / audiobooks for the trip
  'departure',   // departure-airport choice & logistics (EWR vs LGA)
  'food',        // food options near origin or arrival airport
  'pickup',      // arrival pickup / ride coordination
  'transport',   // onward travel (drive to Mammoth, train, rental car)
  'lodging',     // hotel / vacation lodging
  'packing',     // things to bring (skis, gear, optional items)
  'event',       // events / things to do at destination
  'todo',        // generic catch-all
]);

export const ACTION_PHASES = Object.freeze([
  'pre_departure',
  'departure',
  'in_flight',
  'arrival',
  'onward',
  'at_destination',
  'post_trip',
]);

export const ACTION_STATUSES = Object.freeze(['pending', 'planned', 'done', 'skipped']);

export const ACTION_PRIORITIES = Object.freeze(['low', 'medium', 'high']);

const CATEGORY_SET = new Set(ACTION_CATEGORIES);
const PHASE_SET = new Set(ACTION_PHASES);
const STATUS_SET = new Set(ACTION_STATUSES);
const PRIORITY_SET = new Set(ACTION_PRIORITIES);

export class ActionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActionValidationError';
  }
}

export function normalizeAction(input, { allowPartial = false } = {}) {
  if (!input || typeof input !== 'object') {
    throw new ActionValidationError('Action must be an object');
  }

  const now = new Date().toISOString();
  const action = {
    id: input.id || crypto.randomUUID(),
    category: input.category,
    phase: input.phase ?? null,
    title: typeof input.title === 'string' ? input.title.trim() : input.title,
    description: input.description ?? null,
    optional: input.optional === true,
    location: input.location ?? null,
    priority: input.priority ?? null,
    status: input.status ?? 'pending',
    metadata: input.metadata ?? null,
    created_at: input.created_at || now,
    updated_at: now,
  };

  if (!allowPartial) {
    if (!action.title || typeof action.title !== 'string') {
      throw new ActionValidationError('Action title is required');
    }
    if (!CATEGORY_SET.has(action.category)) {
      throw new ActionValidationError(
        `Invalid category "${action.category}". Allowed: ${ACTION_CATEGORIES.join(', ')}`
      );
    }
  }

  if (action.phase !== null && !PHASE_SET.has(action.phase)) {
    throw new ActionValidationError(
      `Invalid phase "${action.phase}". Allowed: ${ACTION_PHASES.join(', ')}`
    );
  }
  if (!STATUS_SET.has(action.status)) {
    throw new ActionValidationError(
      `Invalid status "${action.status}". Allowed: ${ACTION_STATUSES.join(', ')}`
    );
  }
  if (action.priority !== null && !PRIORITY_SET.has(action.priority)) {
    throw new ActionValidationError(
      `Invalid priority "${action.priority}". Allowed: ${ACTION_PRIORITIES.join(', ')}`
    );
  }

  return action;
}

export function normalizeActions(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new ActionValidationError('actions must be an array');
  }
  return input.map((item) => normalizeAction(item));
}

// Suggestion templates. Keyed by trip pattern; each template returns a list
// of suggested (unsaved) actions. Templates are deliberately concrete so the
// UI can drop them into a proposal as starting points.
const TEMPLATES = {
  // EWR/LGA → SFO with onward drive to Mammoth
  'NYC-SFO-MAMMOTH': () => [
    {
      category: 'departure',
      phase: 'departure',
      title: 'Choose departure airport: EWR vs LGA',
      description:
        'Compare price, security wait, and PATH/LIRR access. Default to whichever has the better same-day fare.',
      location: 'EWR / LGA',
      priority: 'high',
    },
    {
      category: 'food',
      phase: 'pre_departure',
      title: 'Chinatown hotpot near LGA',
      description:
        'If departing LGA, grab hotpot in Flushing Chinatown (~10 min from LGA) before security.',
      location: 'Flushing, Queens',
      optional: true,
    },
    {
      category: 'reading',
      phase: 'in_flight',
      title: 'Read "The Will of the Many" (PDF)',
      description: 'Load the PDF onto the tablet before boarding.',
      metadata: { format: 'pdf', title: 'The Will of the Many' },
    },
    {
      category: 'reading',
      phase: 'in_flight',
      title: 'Read "Atlas" (novel)',
      description: 'Backup read in case the PDF gets boring.',
      optional: true,
      metadata: { format: 'novel', title: 'Atlas' },
    },
    {
      category: 'pickup',
      phase: 'arrival',
      title: 'Wait for Ino for SFO pickup',
      description: 'Coordinate pickup curb at SFO arrivals; have backup Lyft estimate ready.',
      location: 'SFO arrivals',
      priority: 'high',
    },
    {
      category: 'transport',
      phase: 'onward',
      title: 'Drive to Mammoth',
      description: '~6 hr drive from SF; plan stop in Bishop. Check 395 conditions before leaving.',
      location: 'Mammoth Lakes, CA',
      priority: 'high',
    },
    {
      category: 'lodging',
      phase: 'at_destination',
      title: 'Vacation in Mammoth',
      description: 'Confirm lodging and lift tickets.',
      location: 'Mammoth Lakes, CA',
    },
    {
      category: 'packing',
      phase: 'pre_departure',
      title: 'Bring skis',
      description: 'Skis + boots + helmet. Confirm airline ski-bag fee.',
      optional: true,
      priority: 'medium',
    },
    {
      category: 'event',
      phase: 'at_destination',
      title: 'Look for events in SF',
      description: 'Check Eventbrite / Resident Advisor / Sofar for the night before driving up.',
      location: 'San Francisco, CA',
      optional: true,
    },
  ],
};

function templateKey(origin, destination) {
  const o = (origin || '').toUpperCase();
  const d = (destination || '').toUpperCase();
  if (['EWR', 'LGA', 'JFK', 'NYC'].includes(o) && d === 'SFO') {
    return 'NYC-SFO-MAMMOTH';
  }
  return null;
}

export function suggestActions({ origin, destination, template } = {}) {
  const key = template || templateKey(origin, destination);
  if (!key || !TEMPLATES[key]) {
    return { template: null, actions: [] };
  }
  return { template: key, actions: TEMPLATES[key]().map((a) => normalizeAction(a)) };
}

export function listTemplates() {
  return Object.keys(TEMPLATES);
}
