## Systematic Asset Trading Service

**Version - 0.1.0**

[![Netlify Status](https://api.netlify.com/api/v1/badges/3d014fc3-e919-4b4d-b374-e8606dee50df/deploy-status)](https://app.netlify.com/projects/5thstreetcapital/deploys)
[![Deploy to Netlify](https://github.com/OptimChain/allocation-manager/actions/workflows/deploy-netlify.yml/badge.svg)](https://github.com/OptimChain/allocation-manager/actions/workflows/deploy-netlify.yml)

![5thStreetCapital](docs/captures/5thstreet.gif)

A real-time asset tracking, market analysis, and trading engine system with hosted metrics, local engine deployments, and broker integration. 

## Features

The trading system is packaged seperately in [allocation-engine-2.0](https://github.com/IamJasonBian/allocation-engine-2.0) with the training system packaged in [allocation-gym](https://github.com/IamJasonBian/allocation-gym/blob/main/docs/7/). The trading system can be hosted using local and managed compute environments to make calls to the allocation-manager service for broker integration. 

Deployed keys and auth will be managed locally and trade using an residential ip and device level tokens. 

Currently, allocation-engine is hosted on render and calls an auth-service hosted an static gcp compute instance for token based access. The auth-service environment refreshes device tokens every 24 hours for all configured brokers and vends pass-through tokens when possible. Allocation-engine can also execute trades within the auth environment or make mcp calls. 

Currently, the system is used to configure trailing stop loss %s for market orders and ensure stops coverage as a risk mechanism. While trades are reviewed executed manually - the system can be directly used to recommend, execute, and fill trades via cli or chat based interfaces (telegram, whatsapp etc). 

Given spreads for options and general execution quality, allocation-engine has been successfully used to price, manage and place limit orders for 14 to 1 month out calls and puts via multiple datafeeds. Helpful use cases have been

* Walking an options order in-front of IV, RV, and momentum.
* Placing options orders outside spot for opportunistic execution
* FIFO, LIFO and fill quality tracking

Site: https://5thstreetcapital.org/

## Example Data Sources (Bring Your Own Datasource for Featurization)

* [CoinGecko API](https://www.coingecko.com/en/api/documentation)
* Twelve Data
* Polygon.io
* TradingView Ecosystem

## Supported Assets

* BTC
* BTC/USD
* Equities (NET)
* Options

## Supported Execution Types

* Pegged to spot
* Aftermarket pegged to spot
* Momentum and static limit spreads
* % Trailing stop market
* Limit orders refreshes

## Refresh Intervals

* 5 second to 1 week

## Supported Brokers

* Alpaca
* Robinhood
* IBKR (gcp or local gateways)
  
* Binance.us (no more)

## License

MIT
