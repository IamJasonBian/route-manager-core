// Robinhood Trading Bot Netlify Function
// Handles bot actions and trading decisions
// Uses Netlify Blobs for token persistence

const tokenStore = require('./lib/tokenStore.cjs');
const { CORS, fetchWithTimeout, checkWriteAuth } = require('./lib/http.cjs');

const ROBINHOOD_API_BASE = 'https://api.robinhood.com';

// In-memory bot action log (resets on cold start)
let botActions = [];

const corsHeaders = { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

/** Error carrying an HTTP status for the handler's catch block. */
function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Get authentication token from Blob store.
 */
async function getAuthToken() {
  const token = await tokenStore.getToken();
  if (!token) {
    throw new Error('Not authenticated. Connect to Robinhood first.');
  }
  return token;
}

async function fetchWithAuth(endpoint, options = {}) {
  const token = await getAuthToken();

  const response = await fetchWithTimeout(`${ROBINHOOD_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      await tokenStore.clearToken();
      throw new Error('Session expired. Please reconnect to Robinhood.');
    }
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response.json();
}

function logBotAction(action) {
  const logEntry = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    ...action,
  };
  botActions.unshift(logEntry);
  if (botActions.length > 100) {
    botActions = botActions.slice(0, 100);
  }
  return logEntry;
}

async function getQuote(symbol) {
  try {
    const quote = await fetchWithAuth(`/quotes/${symbol}/`);
    return {
      symbol: symbol,
      price: parseFloat(quote.last_trade_price),
      bidPrice: parseFloat(quote.bid_price),
      askPrice: parseFloat(quote.ask_price),
      previousClose: parseFloat(quote.previous_close),
    };
  } catch (e) {
    throw new Error(`Failed to get quote for ${symbol}: ${e.message}`);
  }
}

async function getInstrumentBySymbol(symbol) {
  const instruments = await fetchWithAuth(`/instruments/?symbol=${symbol}`);
  if (!instruments.results || instruments.results.length === 0) {
    throw new Error(`Instrument not found: ${symbol}`);
  }
  return instruments.results[0];
}

async function getAccount() {
  const accounts = await fetchWithAuth('/accounts/');
  if (!accounts.results || accounts.results.length === 0) {
    throw new Error('No account found');
  }
  return accounts.results[0];
}

async function analyzePortfolio() {
  const account = await getAccount();
  const positions = await fetchWithAuth('/positions/?nonzero=true');
  const buyingPower = parseFloat(account.buying_power || 0);

  const analysis = {
    timestamp: new Date().toISOString(),
    buyingPower: buyingPower,
    suggestions: [],
    holdings: [],
  };

  for (const position of positions.results || []) {
    try {
      const instrumentUrl = position.instrument.replace(ROBINHOOD_API_BASE, '');
      const instrument = await fetchWithAuth(instrumentUrl);
      const quote = await getQuote(instrument.symbol);

      const quantity = parseFloat(position.quantity);
      const averageCost = parseFloat(position.average_buy_price);
      const currentPrice = quote.price;
      const gainPercent = ((currentPrice - averageCost) / averageCost) * 100;

      const holding = {
        symbol: instrument.symbol,
        quantity,
        averageCost,
        currentPrice,
        gainPercent,
        value: quantity * currentPrice,
      };
      analysis.holdings.push(holding);

      if (gainPercent > 20) {
        analysis.suggestions.push({
          type: 'TAKE_PROFIT',
          symbol: instrument.symbol,
          reason: `Up ${gainPercent.toFixed(1)}% - Consider taking profits`,
          priority: 'medium',
        });
      } else if (gainPercent < -15) {
        analysis.suggestions.push({
          type: 'STOP_LOSS',
          symbol: instrument.symbol,
          reason: `Down ${Math.abs(gainPercent).toFixed(1)}% - Consider stop loss`,
          priority: 'high',
        });
      }
    } catch (e) {
      console.error('Error analyzing position:', e);
    }
  }

  logBotAction({
    type: 'ANALYSIS',
    status: 'completed',
    details: `Analyzed ${analysis.holdings.length} positions`,
    suggestions: analysis.suggestions.length,
  });

  return analysis;
}

async function placeOrder(symbol, side, quantity, dryRun = true) {
  const instrument = await getInstrumentBySymbol(symbol);
  const quote = await getQuote(symbol);
  const account = await getAccount();

  const orderInfo = {
    symbol,
    side,
    quantity,
    price: quote.price,
    estimatedTotal: quantity * quote.price,
  };

  if (dryRun) {
    const action = logBotAction({
      type: side === 'buy' ? 'BUY_ORDER' : 'SELL_ORDER',
      status: 'simulated',
      symbol,
      quantity,
      price: quote.price,
      total: quantity * quote.price,
      dryRun: true,
    });

    return {
      status: 'simulated',
      message: `Dry run: Would ${side} ${quantity} shares of ${symbol} at $${quote.price.toFixed(2)}`,
      order: orderInfo,
      action,
    };
  }

  const orderPayload = {
    account: account.url,
    instrument: instrument.url,
    symbol: symbol,
    type: 'market',
    time_in_force: 'gfd',
    trigger: 'immediate',
    quantity: quantity.toString(),
    side: side,
  };

  try {
    const order = await fetchWithAuth('/orders/', {
      method: 'POST',
      body: JSON.stringify(orderPayload),
    });

    const action = logBotAction({
      type: side === 'buy' ? 'BUY_ORDER' : 'SELL_ORDER',
      status: 'submitted',
      orderId: order.id,
      symbol,
      quantity,
      price: quote.price,
      total: quantity * quote.price,
      dryRun: false,
    });

    return {
      status: 'submitted',
      orderId: order.id,
      order: orderInfo,
      action,
    };
  } catch (e) {
    logBotAction({
      type: side === 'buy' ? 'BUY_ORDER' : 'SELL_ORDER',
      status: 'failed',
      symbol,
      quantity,
      error: e.message,
      dryRun: false,
    });

    throw new Error(`Order failed: ${e.message}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: '',
    };
  }

  try {
    const action = event.queryStringParameters?.action || 'status';
    let body = {};

    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        // Ignore parse errors
      }
    }

    let data;
    switch (action) {
      case 'status':
        const authStatus = await tokenStore.getAuthStatus();
        data = {
          status: 'running',
          auth: authStatus,
          actionsCount: botActions.length,
          lastAction: botActions[0] || null,
        };
        break;

      case 'actions':
        const limit = parseInt(event.queryStringParameters?.limit || '50');
        data = {
          actions: botActions.slice(0, limit),
          total: botActions.length,
        };
        break;

      case 'analyze':
        data = await analyzePortfolio();
        break;

      case 'quote':
        const symbol = event.queryStringParameters?.symbol;
        if (!symbol) {
          throw httpError(400, 'Symbol parameter required');
        }
        data = await getQuote(symbol.toUpperCase());
        break;

      case 'order': {
        if (event.httpMethod !== 'POST') {
          throw httpError(405, 'POST method required for orders');
        }
        // Live order placement uses the site's stored Robinhood session, so
        // unlike the trading-DB writes it fails closed without a token set
        if (!process.env.TRADING_DB_TOKEN) {
          throw httpError(403, 'Order placement is disabled: set TRADING_DB_TOKEN on the site to enable it');
        }
        const denied = checkWriteAuth(event);
        if (denied) throw httpError(401, denied);
        const { symbol: orderSymbol, side, quantity, dryRun = true } = body;
        if (!orderSymbol || !side || !quantity) {
          throw httpError(400, 'symbol, side, and quantity are required');
        }
        data = await placeOrder(
          orderSymbol.toUpperCase(),
          side.toLowerCase(),
          parseFloat(quantity),
          dryRun !== false
        );
        break;
      }

      default:
        throw httpError(400, `Unknown action: ${action}. Available: status, actions, analyze, quote, order`);
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    };
  } catch (error) {
    console.error('Bot error:', error);

    logBotAction({
      type: 'ERROR',
      status: 'error',
      message: error.message,
    });

    const isAuthError = error.message.includes('Not authenticated') || error.message.includes('expired');

    return {
      statusCode: error.statusCode || (isAuthError ? 401 : 500),
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        error: error.message || 'An error occurred',
        requiresAuth: isAuthError,
      }),
    };
  }
};
