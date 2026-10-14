#!/usr/bin/env node
// Local function runner - runs Netlify functions without Netlify CLI
// Usage: node scripts/local-functions.cjs

const http = require('http');
const path = require('path');
const url = require('url');

// Load .env file
require('dotenv').config();

const PORT = process.env.FUNCTIONS_PORT || 9000;
const { CORS } = require('../netlify/functions/lib/http.cjs');

// Function handlers
const functions = {
  'robinhood-auth': require('../netlify/functions/robinhood-auth.cjs'),
  'robinhood-portfolio': require('../netlify/functions/robinhood-portfolio.cjs'),
  'robinhood-bot': require('../netlify/functions/robinhood-bot.cjs'),
  // Trading DB endpoints — run with TRADING_DB_MEMORY=1 for a no-DB local stand-up
  'db-orders': require('../netlify/functions/db-orders.cjs'),
  'db-bot-activity': require('../netlify/functions/db-bot-activity.cjs'),
  'db-pnl': require('../netlify/functions/db-pnl.cjs'),
  'stop-events-sse': require('../netlify/functions/stop-events-sse.cjs'),
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers (shared with the functions — incl. Authorization for write auth)
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Parse function name from path: /.netlify/functions/{name} or /api/{name} or /{name}
  let functionName = null;
  const patterns = [
    /^\/.netlify\/functions\/([^\/\?]+)/,
    /^\/api\/([^\/\?]+)/,
    /^\/([^\/\?]+)/,
  ];

  for (const pattern of patterns) {
    const match = pathname.match(pattern);
    if (match && functions[match[1]]) {
      functionName = match[1];
      break;
    }
  }

  if (!functionName) {
    // List available functions
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: 'Local Functions Server',
      availableFunctions: Object.keys(functions),
      usage: '/{function-name}?action=...',
      examples: [
        '/robinhood-auth?action=status',
        '/robinhood-auth?action=connect',
        '/robinhood-auth?action=verify',
        '/robinhood-portfolio?action=portfolio',
        '/robinhood-bot?action=status',
      ],
    }, null, 2));
    return;
  }

  // Build event object (mimics Netlify function event)
  let body = '';
  if (req.method === 'POST') {
    for await (const chunk of req) {
      body += chunk;
    }
  }

  const event = {
    httpMethod: req.method,
    path: pathname,
    queryStringParameters: parsedUrl.query || {},
    headers: req.headers,
    body: body || null,
    isBase64Encoded: false,
  };

  const context = {
    functionName,
    functionVersion: '1.0.0',
    invokedFunctionArn: `local:${functionName}`,
    memoryLimitInMB: '128',
    awsRequestId: `local-${Date.now()}`,
    logGroupName: `/local/${functionName}`,
    logStreamName: `${Date.now()}`,
    getRemainingTimeInMillis: () => 30000,
  };

  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  try {
    const handler = functions[functionName].handler;
    const result = await handler(event, context);

    res.writeHead(result.statusCode, result.headers || {});
    res.end(result.body);

    console.log(`  -> ${result.statusCode} (${result.body?.length || 0} bytes)`);
  } catch (error) {
    console.error(`  -> ERROR:`, error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  Local Functions Server                                    ║
╠════════════════════════════════════════════════════════════╣
║  Listening on: http://0.0.0.0:${PORT.toString().padEnd(27)}║
║  Also:         http://localhost:${PORT.toString().padEnd(25)}║
╠════════════════════════════════════════════════════════════╣
║  Available functions:                                      ║
${Object.keys(functions).map(f => `║    - ${f.padEnd(52)}║`).join('\n')}
╠════════════════════════════════════════════════════════════╣
║  Examples:                                                 ║
║    curl http://localhost:${PORT}/robinhood-auth?action=connect    ║
║    curl http://localhost:${PORT}/robinhood-auth?action=status     ║
╚════════════════════════════════════════════════════════════╝
`);
});
