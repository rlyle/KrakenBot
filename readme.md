# KrakenBot 
This is my implementation of a trading bot that I use with the Kraken Exchange. I've seen a bit of success with it, please feel free to download and have fun!

# Installing 
You can install as a command line tool by running the following commmand. On some systems you might need to run the command line as administrator or use sudo to install this script globally.
```
npm install -g .
```

# Configuring
For each crypto you want to target, you'll need to create a config.{TARGET}.json file. Here is an example one, with the apiKey & apiSecret removed.

```
{
    "botLogic": "smart",
    "apiKey": "{Put your api key here}",
    "privateKey": "{Put your private key here}",
    "stableCurrency": "USD",
    "smaShort": 9,
    "smaLong": 120,
    "rsiLow": 30,
    "rsiHigh": 70,
    "stableReserve": 50,
    "targetReserve": 0,
    "targetCap": 2000,
    "minStableAmount": 50,
    "minTargetAmount": 0,
    "minSellPercent": 1.01,
    "maxBuyPercent": 0.99,
    "stopLossPercent": 0.95,
    "updateRate": 15,
    "minElaspedTime": 300,
    "enableRealTrades": true,
    "enableDebugLogs": false,
    "timeframe": "15m",
    "slopeHistory": 3600,
    "orderExpireTime": 30,
    "notifySMS": "{Put your phone number here}"
}
```

* botLogic - This is which logic to run internally for trading, the options are bull, bear, rsi, and smart.
* apiKey,privateKey - Your keys from the Kraken exchange. Click on your profile in the upper right Securty->API to create keys. It's recommended to have a different keys for each bot you want to run, as they might throttle your requests if you try to use the same keys for multiple bots.
* smaShort,smaLong - Short term and long term moving average in days.
* rsiLow,rsiHigh - Threshold for the RSI for over sold when rsi < rsiLow or over bought when rsi > rsiHigh.
* stableReserve - How much stable currency to always leave alone in the account. 
* targetReserve - How much target currency to never sell.
* targetCap - Maximum amount of target currency to buy in stable currency.
* minStableAmount - Minimm amount in stable currency to buy/sell in one transacitons.
* minTargetAmount - Minium amount of target currency to buy/sell in one transaction.
* minSellPercent - Only consider selling if the price is above this multiplied by the original purchase price.
* maxBuyPercent - If target is sold for a loss, the bot will attempt to buy back in if the price falls below the original purchase price multiplied by this number.
* stopLossPercent - Sell the target if it falls below the original price multiplied by this number.
* updateRate - How often to run the logic of this bot in seconds.
* enableRealTrades - Set to false to just simulate trading.
* enableDebugLogs - Set to true to enable debug logs.
* timeFrame - Timeframe for RSI and SMA requests. 
* slopeHistory - Time in seconds to calculate the slopes for RSI & short/long SMAs.
* orderExpireTime - Time in seconds before a placed order expires. The bot will retry the order as many times as needed to buy or sell.
* notifySMS - If you have AWS_SECRET_KEY & AWS_KEY_ID in your enivornment, the bot will use SNS to send a notification to this phone number when it buys or sells.

# Explicit Pair or Symbols
In some cases, the auto-generation of the pair or symbol doesn't work, you can add the following to your config to explicitly set the pair and symbol used when talking with the kraken API. For example:

```
    "pair": "SOLUSD",
    "symbol": "SOL/USD"
```

# Running
If you installed as a command line tool, then you can just run it from your command line:
```
kraken_bot <TARGET>
```

Optionally, you can run it directly from the directory:
```
node . <TARGET>
```

