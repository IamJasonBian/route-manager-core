// Returns suggested (unsaved) actions for a trip proposal, given an
// origin/destination pair or an explicit template name. Intended to be
// called from the proposal-creation UI to pre-fill an action checklist.

import {
  ACTION_CATEGORIES,
  ACTION_PHASES,
  listTemplates,
  suggestActions,
} from './lib/proposalActions.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `Method ${event.httpMethod} not allowed` }),
    };
  }

  const params = event.queryStringParameters || {};
  const result = suggestActions({
    origin: params.origin,
    destination: params.destination,
    template: params.template,
  });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      ...result,
      categories: ACTION_CATEGORIES,
      phases: ACTION_PHASES,
      availableTemplates: listTemplates(),
    }),
  };
};
