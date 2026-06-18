/**
 * Netlify Function to submit passenger data to Google Sheets.
 *
 * Uses Google Sheets API v4 with Service Account authentication via JWT.
 */

import crypto from 'crypto';

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

// Create a JWT for Google API authentication
async function createJWT(clientEmail, privateKey) {
  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600 // 1 hour
  };

  const base64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signatureInput = `${base64Header}.${base64Payload}`;

  // Sign with RSA-SHA256
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signatureInput);
  const signature = sign.sign(privateKey, 'base64url');

  return `${signatureInput}.${signature}`;
}

// Exchange JWT for access token
async function getAccessToken(clientEmail, privateKey) {
  const jwt = await createJWT(clientEmail, privateKey);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get access token: ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

// Build credentials from environment variables
const getCredentials = () => {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    return null;
  }

  return {
    client_email: clientEmail,
    // Handle escaped newlines in the private key
    private_key: privateKey.replace(/\\n/g, '\n'),
  };
};

export const handler = async (event) => {
  // Set CORS headers
  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  const headers = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed', allowed: ['POST'] })
    };
  }

  try {
    const data = JSON.parse(event.body);

    // Validate required fields
    const requiredFields = ['firstName', 'lastName', 'dateOfBirth', 'gender', 'countryCode', 'phone', 'email'];
    const missingFields = requiredFields.filter(field => !data[field]);

    if (missingFields.length > 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Missing required fields',
          missingFields
        })
      };
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid email format' })
      };
    }

    // Validate phone number (basic validation)
    const phoneRegex = /^\+?[\d\s\-()]{10,}$/;
    if (!phoneRegex.test(data.phone)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid phone number format' })
      };
    }

    if (!SPREADSHEET_ID) {
      console.error('GOOGLE_SPREADSHEET_ID environment variable not set');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Server configuration error: Spreadsheet ID not configured' })
      };
    }

    const credentials = getCredentials();
    if (!credentials) {
      console.error('Google service account credentials not configured');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Server configuration error: Service account not configured' })
      };
    }

    // Prepare the row data
    const timestamp = data.submittedAt || new Date().toISOString();
    const excludedAirlines = Array.isArray(data.excludedAirlines) ? data.excludedAirlines.join(', ') : '';
    const rowData = [
      timestamp,
      data.origin || '',
      data.destination || '',
      data.firstName,
      data.middleName || '',
      data.lastName,
      data.dateOfBirth,
      data.gender,
      data.countryCode,
      data.phone,
      data.email,
      data.farePreference || '',
      excludedAirlines
    ];

    // Get access token using JWT
    const accessToken = await getAccessToken(credentials.client_email, credentials.private_key);

    // Google Sheets API endpoint for appending data
    // Columns: Timestamp, From, To, First Name, Middle Name, Last Name, DOB, Gender, Country Code, Phone, Email, Fare Preference, Excluded Airlines
    const sheetName = 'Passengers';
    const range = `${sheetName}!A:M`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        values: [rowData]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Google Sheets API error:', response.status, errorText);

      if (response.status === 403 || response.status === 401) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({
            error: 'Unable to write to spreadsheet. Please ensure the spreadsheet is shared with the service account email as Editor.',
            details: process.env.NODE_ENV === 'development' ? errorText : undefined
          })
        };
      }

      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Failed to submit data to Google Sheets',
          details: process.env.NODE_ENV === 'development' ? errorText : undefined
        })
      };
    }

    const result = await response.json();
    console.log('Successfully appended row to Google Sheets:', result.updates?.updatedRange);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Passenger information submitted successfully',
        updatedRange: result.updates?.updatedRange
      })
    };
  } catch (error) {
    console.error('Error submitting passenger data:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to process request',
        message: error.message
      })
    };
  }
};
