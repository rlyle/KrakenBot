#!/usr/bin/env node
const _ = require('lodash');
const fs = require('fs');

const args = process.argv;
if (! args[2] ) {
    console.log("Usage:\nkrakenBot <TARGET CURRENCY>");
    process.exit(1);
}

const TARGET_CURRENCY = String(args[2] || 'ADA').toUpperCase();     // target currency to buy/sell
let config = null;
try {
    config = JSON.parse( fs.readFileSync(`config.${TARGET_CURRENCY}.json`) );
} catch( err ) {
    logError("Config load error:", err );
}

if (! config ) {
    logError("Failed to load config!" );
    process.exit(1);
}

const KrakenClient = require('kraken-api');
const kraken = new KrakenClient(config.apiKey, config.privateKey);
const alerts = require('trading-indicator').alerts;
const sma = require('trading-indicator').sma;

const BOT_LOGIC = config.botLogic || 'bull';                        // logic mode for this but (bear or bull)
const SMA_SHORT = Number(config.smaShort || 14);
const SMA_LONG = Number(config.smaLong || 99);
const RSI_LOW = Number(config.rsiLow || 35);                        // when the RSI is below this number, then the bot will try to buy coins
const RSI_HIGH = Number(config.rsiHigh || 65);                      // when the RSI is above this number, then the bot will try to sell the coins
const SLOPE_HISTORY = Number(config.slopeHistory || 300);           // how much history in seconds to calculate our slopes
const STABLE_RESERVE = Number(config.stableReserve || 50);          // how much stable currency to never spend to cover fees
const TARGET_RESERVE = Number(config.targetReserve || 0);           // how much target currency to never sell
const TARGET_CAP = Number(config.targetCap || 10000);             // maximum amount of target currency to buy in stable currency
const MIN_STABLE_AMOUNT = Number(config.minStableAmount || 500);    // minimm amount in stable currency to buy/sell in one transacitons
const MIN_TARGET_AMOUNT = Number(config.minTargetAmount || 0);      // minimum amount of target currency to buy in one transaction
const MIN_SELL_PERCENT = Number(config.minSellPercent || 1.02);     // if the price goes above this percent of the purchase price, then sell
const MAX_BUY_PERCENT = Number(config.maxBuyPercent || 0.98);       // if the price goes below this percent of the sell price, then buy
const STOP_LOSS_PERCENT = Number(config.stopLossPercent);   // if the price drops below this percent (price * number), then sell to stop any further loses
const STABLE_CURRENCY = config.stableCurrency || 'USD';
const UPDATE_RATE = Number(config.updateRate || 10) * 1000;
const MIN_SELL_VALUE = Number(config.minSellValue || 10);           // min amount to sell in the stable currency
const MIN_ELAPSED_TIME = Number(config.minElaspedTime || 300) * 1000; // min amount of time between buy/sell
const ENABLE_DEBUG_LOGS = config.enableDebugLogs || false;
const ENABLE_REAL_TRADES = config.enableRealTrades || true;         // false to just simulate trades, true to actuall issue buy/sell orders via Kraken
const TIMEFRAME = config.timeframe || '1h';
const ORDER_EXPIRE_TIME = Number(config.orderExpireTime || 30);     // the expire time for orders in seconds
const PAIR = config.pair || `${TARGET_CURRENCY}${STABLE_CURRENCY}`;
const SYMBOL = config.symbol || `${TARGET_CURRENCY}/${STABLE_CURRENCY}T`;
const NOTIFY_SMS = config.notifySMS || '';
const AWS_KEY_ID = _.get(config,'aws.keyId') || process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_KEY = _.get(config,'aws.secretKey') || process.env.AWS_SECRET_ACCESS_KEY;
const AWS_REGION = _.get(config,"aws.region") || process.env.AWS_REGION || "us-east-1";

const AWS = require('aws-sdk');

AWS.config.update({
    credentials: new AWS.Credentials(AWS_KEY_ID,AWS_SECRET_KEY),
    region: AWS_REGION
});

const sns = new AWS.SNS();

function logDebug(...args) {
    if ( ENABLE_DEBUG_LOGS ) {
        log(...args);
    }
}

function logError(...args) {
    log( "\x1b[31m ERROR: ", ...args, "\x1b[0m" );
}

function sendNotification(message) {
    if ( NOTIFY_SMS && AWS_KEY_ID && AWS_SECRET_KEY) {
        let params = {
            Message: message,
            PhoneNumber: NOTIFY_SMS,
            MessageStructure: 'string',
        };

        sns.publish(params, (err, result) => {
            if (err) {
                logError("sns.publish error:", err);
            } else {
                logDebug("sns.publish result:", result);
            }
        });
    }
}

// show in local time, not UTC, for logging
function toISOLocal(d) {
    return new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().slice(0, -1);
}

function log(...args) {
    console.log(...args);
    let currentTime = toISOLocal(new Date());
    fs.appendFile(`krakenBot.${TARGET_CURRENCY}.log`, currentTime + ": " + JSON.stringify(args) + "\n", (err) => {
        if ( err ) {
            console.error("Failed to write to log!", err );
        }
    })
}

function formatNumber(n, digits) {
    if ( typeof digits !== 'number' ) {
        if ( n < 1 ) {
            digits = 10;
        } else {
            digits = 4;
        }
    }

    return Number(n).toFixed(digits).replace(/\.?0+$/,"");
}

function formatStable(n) {
    return formatNumber(n,2);
}
function setIntervalImmediate( func, interval ) {
    func();
    return setInterval( func, interval);
}

log(`Starting KrakenBot`, config );
log(`BOT_LOGIC: ${BOT_LOGIC}`);

process.on('unhandledRejection', (err) => {
    logError("Unhandled rejection:", err );
})

class KrakenBot {
    _ledger = { currency: TARGET_CURRENCY, transactions: [], balances: {} };

    getTicker() {
        return new Promise((resolve, reject) => {
            kraken.api('Ticker', { pair: PAIR }).then((res) => {
                logDebug("getTicker result:", res );
                const keys = Object.keys(res.result);
                if ( keys.length !== 1 ) return reject("getTicker did not get an expected number of results!");
                const result = res.result[keys[0]];
                return resolve({
                baseCurrency: TARGET_CURRENCY,
                quoteCurrency: STABLE_CURRENCY,
                bid: parseFloat(result.b[0]),
                ask: parseFloat(result.a[0]),
                lastPrice: parseFloat(result.c[0]),
                high24Hours: parseFloat(result.h[1]),
                low24Hours: parseFloat(result.l[1]),
                vwap24Hours: parseFloat(result.p[1]),
                volume24Hours: parseFloat(result.v[1])
                });
            }).catch((err) => {
                reject(err);
            })
        })
    }

    loadBalances() {
        const CURRENCY_ALIASES = {
            "XXBT": "BTC",
            "XETH": "ETH",
            "XXDG": "DOGE"
        };
        return kraken.api('Balance').then((res) => {
            let balances = {};
            for(let k in res.result) {
                let alias = CURRENCY_ALIASES[k];
                if ( alias !== undefined ) 
                    balances[alias] = Number(res.result[k]);
                else 
                    balances[k] = Number(res.result[k]);
            }
            this._ledger.balances = balances;
            //this._ledger.balances['USD'] = 1000;        // testing buys!
            //log(`Balances loaded:`, this._ledger.balances );
            return this._ledger.balances;
        }).catch((err) => {
            logError("loadBalances error:", err );
            return err;
        })
    }

    loadLedger() {
        return new Promise((resolve, reject) => {
            fs.readFile(`ledger.${TARGET_CURRENCY}.json`, (err, file) => {
                if ( err ) {
                    logError("No ledger file found, starting new one:", err );
                    this._ledger = { transactions: [], target: TARGET_CURRENCY, stable: STABLE_CURRENCY, retryBuy: false, retrySell: false };
                    this.saveLedger().then(resolve).catch(reject);
                } else {
                    this._ledger = JSON.parse(file);
                    log(`Ledger loaded, found ${this._ledger.transactions.length} transaction records!`);
                    resolve();
                }               
            });
        })
    }

    saveLedger() {
        return new Promise((resolve, reject) => {
            return fs.writeFile(`ledger.${TARGET_CURRENCY}.json`, JSON.stringify(this._ledger, null, 4), (err) => {
                if ( err ) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        })
    }

    addOrder( price, type, volume ) {
        let addOrder = {
            ordertype: 'market',
            type,
            volume,          
            pair: PAIR,
            expiretm: `+${ORDER_EXPIRE_TIME}`
        };
        logDebug("AddOrder request:", addOrder );
        return kraken.api('AddOrder', addOrder).then((order) => {
            logDebug(`AddOrder result:`, order );
            return order;
        });
    }

    sellCoins(state) {
        let sellAmount = state.balance - TARGET_RESERVE;
        return this.addOrder(state.price, 'sell', sellAmount).then((order) => {
            if ( ENABLE_REAL_TRADES && !Array.isArray(order.result.txid) && order.result.txid.length !== 1 ) throw new Error("no txid in result!");
            let transaction = { ...state, balance: 0, action: 'SELL', amount: sellAmount, value: sellAmount * state.price, txid: order.result.txid[0], status: "open" };
            this._ledger.balances[TARGET_CURRENCY] = state.balance - sellAmount;
            this._ledger.balances['Z'+STABLE_CURRENCY] = state.stableBalance + transaction.value;
            this._ledger.transactions.push(transaction);
            this._ledger.lastSell = transaction;
            delete this._ledger.lastBuy;

            sendNotification(`KrakenBot Selling ${formatNumber(sellAmount)} ${TARGET_CURRENCY} @ ${formatNumber(transaction.price)} ${STABLE_CURRENCY}, Value: ${formatStable(transaction.value)} ${STABLE_CURRENCY}`);            
            log("Selling coins:", transaction);
            return this.saveLedger();
        }).catch((err) => {
            logError("sellCoins error:", err );
            return err;
        })
    }

    buyCoins(state) {
        let maxBuy = TARGET_CAP - (state.balance * state.price);
        let stableAvailable = state.stableBalance - STABLE_RESERVE;
        if ( stableAvailable > maxBuy )
            stableAvailable = maxBuy;
        let buyAmount = stableAvailable / state.price;

        return this.addOrder(state.price, 'buy', buyAmount).then((order) => {
            if ( ENABLE_REAL_TRADES && !Array.isArray(order.result.txid) && order.result.txid.length !== 1 ) throw new Error("no txid in result!");
            let transaction = { ...state, balance: state.balance + buyAmount, action: 'BUY', amount: buyAmount, value: buyAmount * state.price, txid: order.result.txid[0], status: "open"  };
            this._ledger.balances[TARGET_CURRENCY] = state.balance + buyAmount;
            this._ledger.balances['Z'+STABLE_CURRENCY] = state.stableBalance - transaction.value;
            this._ledger.transactions.push(transaction);
            this._ledger.lastBuy = transaction;
            delete this._ledger.lastSell;

            sendNotification(`KrakenBot Buying ${formatNumber(buyAmount)} ${TARGET_CURRENCY} @ ${formatNumber(transaction.price)} ${STABLE_CURRENCY}, Value: ${formatStable(transaction.value)} ${STABLE_CURRENCY}`);            
            log("Buying coins:" ,transaction);
            return this.saveLedger();
        }).catch((err) => {
            logError("buyCoins error:", err );
            return err;
        })
    }

    isTransactionOpen() {
        return this._ledger.transactions.find((e) => e.status === "open");
    }

    considerBuy(state) {
        logDebug(`considerBuy triggered:`, state );
        // firstly, we need stable currency to buy..
        let stableAvailable = state.stableBalance - STABLE_RESERVE;
        let maxBuy = TARGET_CAP - (state.balance * state.price);
        if ( stableAvailable > maxBuy )
            stableAvailable = maxBuy;
        let buyAmount = stableAvailable / state.price;
        
        logDebug(`buyAmount: ${buyAmount}, stableAvailable: ${stableAvailable}, maxBuy: ${maxBuy}`);
        if ( buyAmount >= MIN_TARGET_AMOUNT && stableAvailable >= MIN_STABLE_AMOUNT && maxBuy >= MIN_STABLE_AMOUNT ) {
            // check that we don't have any currently open orders
            if (!this.isTransactionOpen()) {    
                let lastSell = this._ledger.lastSell;
                let elapsed = lastSell ? state.timestamp - lastSell.timestamp : MIN_ELAPSED_TIME + 1;
                logDebug(`considerBuy: Elapsed ${elapsed} < ${MIN_ELAPSED_TIME}`)
                if ( elapsed > MIN_ELAPSED_TIME ) {
                    return this.buyCoins(state);
                }
            }
        }
    }

    considerSell(state) {
        logDebug(`considerSell triggered:`, state );
        // firstly, we need coins to sell and we need enough to actually sell
        let sellValue = state.balance * state.price;
        if (state.balance > TARGET_RESERVE && sellValue > MIN_SELL_VALUE) {
            // check that we don't have any currently open orders
            if (!this.isTransactionOpen()) {    
                let lastBuy = this._ledger.lastBuy;
                let elapsed = lastBuy ? state.timestamp - lastBuy.timestamp : MIN_ELAPSED_TIME + 1;
                logDebug(`considerSell:, Elapsed ${elapsed} > ${MIN_ELAPSED_TIME}`);
                if (elapsed > MIN_ELAPSED_TIME) {
                    return this.sellCoins(state);
                }
            } 
        }
    }

    checkTransactions() {
        return new Promise((resolve, reject) => {
            let txIds = this._ledger.transactions.filter((j) => j.txid && j.status === 'open').map((e) => e.txid);
            if ( txIds.length === 0 ) return resolve();     // no open txIds

            kraken.api("QueryOrders", { txid: txIds.join(',')}).then((results) => {
                logDebug("Query Orders results:", results );

                for(let txid in results.result) {
                    let result = results.result[txid];
                    let transaction = this._ledger.transactions.find((e) => e.txid === txid);
                    if (! transaction ) {
                        logError("Failed to find transaction:", result);
                        continue;
                    }
                    log(`Updating transaction ${txid}:`, transaction, result );
                    transaction.status = result.status;

                    // if this transaction expired, then retry the action..
                    if ( result.status === 'expired') {
                        log("Transaction expired, retrying:", transaction );
                        if ( transaction.action === 'BUY' ) {
                            delete this._ledger.lastBuy;
                            this._ledger.retryBuy = true;
                        } else if ( transaction.action === 'SELL') {
                            delete this._ledger.lastSell;
                            this._ledger.retrySell = true;
                        }
                    } else if ( result.status === 'closed') {
                        transaction.price = result.price;
                    }
                }

                resolve();
            }).catch((err) => {
                logError("checkTransactions error:", err );
                reject(err);
            })
        })
    }

    getSlope(values_x, values_y) {
        if (values_x.length != values_y.length) {
            throw new Error('The parameters values_x and values_y need to have same size!');
        }
    
        if (values_x.length === 0) {
            return 0;
        }
    
        let x_sum = 0;
        let y_sum = 0;
        let xy_sum = 0;
        let xx_sum = 0;
        let count = 0;
    
        for (let i = 0; i < values_x.length; i++) {
            let x = values_x[i];
            let y = values_y[i];
            x_sum += x;
            y_sum += y;
            xx_sum += x * x;
            xy_sum += x * y;
            count++;
        }
    
        return (count * xy_sum - x_sum * y_sum) / (count * xx_sum - x_sum * x_sum);
    }
    
    checkData() {
        return Promise.all( [ 
            this.getTicker(), 
            this.loadBalances()
        ]).then(([ticker]) => {
            let timestamp = Date.now();

            let price = ticker.lastPrice;
            let stableBalance = this._ledger.balances['Z'+STABLE_CURRENCY] || 0;
            let balance = this._ledger.balances[TARGET_CURRENCY] || 0;
            let value = balance * price;
            let { rsi, rsiSlope, smaShort, smaLong, smaShortSlope, smaLongSlope, lastBuy, lastSell, smaState, smaCrossed, retryBuy, retrySell, lastSellLoss} = this._ledger;
            let state = {
                timestamp,
                time: toISOLocal(new Date(timestamp)),
                balance,
                stableBalance,
                totalBalance: (balance * price) + stableBalance,
                value,
                price,
                rsi,
                smaShort,
                smaLong,
                smaState,
                smaCrossed
            };
            // use the history to determine if it was overSold or overBought, this way if we were either within the history window, we 
            // will still consider the coin as recently overBought or overSold.
            let overSold = this._ledger.rsiHistory.reduce((a,v) => a || v.rsi.overSold, false);     
            let overBought = this._ledger.rsiHistory.reduce((a,v) => a || v.rsi.overBought, false );
            // calculate our minimum sell price based on the price we paid 
            let lastBuyPrice = lastBuy ? lastBuy.price : 0;         
            let lastSellPrice = lastSell ? lastSell.price : 0;
            let stopLossPrice = lastBuyPrice * STOP_LOSS_PERCENT;                
            let minSellPrice = lastBuyPrice * MIN_SELL_PERCENT;
            let maxBuyPrice = lastSell ? lastSellPrice * MAX_BUY_PERCENT : price;
            let rebuyPrice = lastSell ? lastSellPrice * STOP_LOSS_PERCENT : 0;

            let buy = false;
            let sell = false;
            let limit = '';
            switch( BOT_LOGIC ) {
                case 'bull':
                    {
                        // BULL MODE: buy when oversold, the price is above the short term moving average and below the long term
                        // sell when overBought, and price is above the minSellPrice which is based off the last buy price.
                        buy =  retryBuy                                                  // retry previous buy attempt
                            || (overSold && price > smaShort && price < smaLong);        // buy when oversold and price is increasing by testing against the SMA
                        sell = (retrySell && price >= minSellPrice)                       // retry the previous sell attempt, so long as the price is still > minSellPrice
                            || (overBought && price >= minSellPrice && price < smaShort)     // sell when overbought, price is enough to profit, and price is dropped below the sma so we sell on the decline
                        limit = ` MIN: ${formatNumber(minSellPrice)},`;
                    }
                    break;
                case 'bear': 
                    {
                        // BEAR MODE: we will sell when the the coin was overbought, and the price falls below the short term simple moving average
                        // we will buy back in when it's oversold, the price is above the short term moving average, and when the price is below our
                        // minBuyPrice which is based on the last sell price.
                        buy = retryBuy
                            || (overSold && price > smaShort && price <= maxBuyPrice);
                        sell = retrySell 
                            || (overBought && price < smaShort);
                        limit = ` MAX: ${formatNumber(maxBuyPrice)},`
                    }
                    break;
                case 'rsi':
                    {
                        // RSI MODE: Buy when coin is oversold and the price falls below the short term simple moving average
                        // Sell when coin is overbought and the price goes above the short term simply moving average
                        buy = retryBuy 
                            || (overSold && price > smaShort);
                        sell = retrySell 
                            || (overBought && price < smaShort);
                    }
                    break;
                case 'smart':
                    {
                        // SMART MODE: Combined bull & bear logic
                        buy = retryBuy 
                            || (overSold && price > smaShort && price < smaLong)
                            || (lastSellLoss && price > smaShort && price <= maxBuyPrice)
                            || (lastSellLoss && price <= rebuyPrice);         // make up the percent loss due to stop loss
                        sell = retrySell 
                            || (overBought && price < smaShort && price > smaLong && price >= minSellPrice);
                        if ( lastSellLoss )
                            limit += ` MAX: ${formatNumber(maxBuyPrice)}, REBUY: ${formatNumber(rebuyPrice)},`
                        if ( lastBuy )
                            limit += ` MIN: ${formatNumber(minSellPrice)},`;
                    }
                    break;
                }

            if ( price < stopLossPrice ) {
                log(`.......... STOP LOSS TRIGGERED @ ${price} < ${stopLossPrice}`);
                sell = true;
            }

            if (sell && price < minSellPrice ) {
                log(`......... SOLD FOR LOSS @ ${price} < ${minSellPrice}`);
                this._ledger.lastSellLoss = true;
            } else if ( buy ) {
                this._ledger.lastSellLoss = false;      // clear the flag when buying only
            }

            // clear all the flags..
            this._ledger.smaCrossed = false;        
            this._ledger.retryBuy = false;
            this._ledger.retrySell = false;

            log(`${TARGET_CURRENCY} @ ${formatNumber(state.price)}, BAL: ${formatNumber(state.balance)} ${TARGET_CURRENCY}/${formatStable(state.price * state.balance)} ${STABLE_CURRENCY},`
                + limit
                + (lastBuy ? ` STOP: ${formatNumber(stopLossPrice)},` : '')
                + ` RSI: ${formatNumber(rsi.rsiVal)}${rsiSlope > 0 ? "\u2191" : "\u2193"},`
                + ` SMA: ${formatNumber(smaShort)}${smaShortSlope > 0 ? "\u2191" : "\u2193"}/${formatNumber(smaLong)}${smaLongSlope > 0 ? "\u2191" : "\u2193"}`
                + (overSold ? ", OS" : "")
                + (overBought ? ", OB" : "")
                + (buy ? ", BUY" : "")
                + (sell ? ", SELL" : "") );

            if ( buy && !lastBuy) {
                return this.considerBuy(state);
            } else if (sell) {
                return this.considerSell(state);
            }
        }).then(() => {
            // if we have any unclosed transactions, query for their resolution so we can update our balances correctly..
            return this.checkTransactions();
        }).then(() => {
            return this.saveLedger();
        }).catch((err) => {
            logError("checkData error:", err );
            return err;
        })
    }

    updateRSI() {
        alerts.rsiCheck( 14, RSI_HIGH, RSI_LOW, 'kraken', SYMBOL, TIMEFRAME, false ).then((rsi) => {
            if (! Array.isArray(this._ledger.rsiHistory)) this._ledger.rsiHistory = [];
            let timestamp = Date.now();

            logDebug("updateRSI:", rsi );
            this._ledger.rsi = rsi;
            this._ledger.rsiHistory.push({ timestamp, rsi });
            let expire = Date.now() - (SLOPE_HISTORY * 1000);
            while( this._ledger.rsiHistory.length > 0 && this._ledger.rsiHistory[0].timestamp < expire )
                this._ledger.rsiHistory.shift();

            let rsi_start = this._ledger.rsiHistory[0].timestamp;
            let rsi_x = this._ledger.rsiHistory.map((e) => (e.timestamp - rsi_start) / 1000);
            let rsi_y = this._ledger.rsiHistory.map((e) => e.rsi.rsiVal);
            this._ledger.rsiSlope = this.getSlope(rsi_x,rsi_y);

            //return this.saveLedger();
        }).catch((err) => {
            logError("updateRSI error:", err );
        })

    }
    updateShortSMA() {
        sma(SMA_SHORT, 'close', 'kraken', SYMBOL, TIMEFRAME, false ).then((smaShort) => {
            if (! Array.isArray(this._ledger.smaHistory)) this._ledger.smaHistory = [];
            let timestamp = Date.now();

            smaShort = smaShort[smaShort.length - 1];
            this._ledger.smaShort = smaShort;
            logDebug("updateShortSMA:", smaShort );

            let smaLong = this._ledger.smaLong;
            this._ledger.smaHistory.push({ timestamp, sma: { smaShort, smaLong } });
            let expire = Date.now() - (SLOPE_HISTORY * 1000);
            while( this._ledger.smaHistory.length > 0 && this._ledger.smaHistory[0].timestamp < expire )
                this._ledger.smaHistory.shift();
            let rsi_start = this._ledger.smaHistory[0].timestamp;
            let rsi_x = this._ledger.smaHistory.map((e) => (e.timestamp - rsi_start) / 1000);
            let rsi_y = this._ledger.smaHistory.map((e) => e.sma.smaShort);
            this._ledger.smaShortSlope = this.getSlope(rsi_x,rsi_y);
            rsi_y = this._ledger.smaHistory.map((e) => e.sma.smaLong);
            this._ledger.smaLongSlope = this.getSlope(rsi_x,rsi_y);
            
            let previousState = this._ledger.smaState || (smaShort < smaLong ? 'down' : 'up');
            this._ledger.smaState = smaShort < smaLong ? 'down' : 'up';
            this._ledger.smaCrossed = previousState !== this._ledger.smaState;
            if ( this._ledger.smaCrossed) {
                log(`smaCrossed: true, smaState: ${this._ledger.smaState}, smaShort: ${smaShort}, smaLong: ${smaLong}`);
            }
            //this.saveLedger();
        }).catch((err) => {
            logError("updateShortSMA error:", err );
        })
    }

    updateLongSMA() {
        sma(SMA_LONG, 'close', 'kraken', SYMBOL, TIMEFRAME, false ).then((smaLong) => {
            smaLong = smaLong[smaLong.length - 1];
            logDebug("updateLongSMA:", smaLong );
            this._ledger.smaLong = smaLong;
            //this.saveLedger();
        }).catch((err) => {
            logError("updateShortSMA error:", err );
        })
    }

    runBot() {
        this.loadLedger().then(() => {
            this._timer = setInterval( this.checkData.bind(this), UPDATE_RATE );
            this._sma_short_timer = setIntervalImmediate( this.updateShortSMA.bind(this), UPDATE_RATE );
            this._sma_long_timer = setIntervalImmediate( this.updateLongSMA.bind(this), UPDATE_RATE * 5 );
            this._rsi_timer = setIntervalImmediate( this.updateRSI.bind(this), UPDATE_RATE * 2 );
        }).catch((err) => {
            logError("runBot error:", err );
        })
    }
}

let bot = new KrakenBot();
bot.runBot();

