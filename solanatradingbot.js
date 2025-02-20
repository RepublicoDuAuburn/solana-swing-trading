const axios = require('axios');
const web3 = require('@solana/web3.js');
const winston = require('winston');
require('dotenv').config();

console.log('This should log if the file is loaded'); // New log to check if the file is being loaded

// Create a logger with a more readable format for debugging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ]
});

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC on Solana
const SCF_MINT = 'GiG7Hr61RVm4CSUxJmgiCoySFQtdiwxtqf64MsRppump'; // Replace with actual SCF mint address

// Now, use process.env to access your secret key
const wallet = web3.Keypair.fromSecretKey(Uint8Array.from(process.env.WALLET_SECRET_KEY.split(',').map(Number)));

// Initialize the connection once when the script starts
const connection = new web3.Connection(web3.clusterApiUrl('mainnet-beta'));

const initialInvestment = 200 * 1000000; // 200 USDC in lamports, adjust as needed

// Adjust the window size based on your strategy
const smaWindowSize = 216; // 18 hours in 5-minute intervals
let priceHistory = [];

async function getPriceFromQuote(inputMint, outputMint, amount) {
  try {
    const quote = await axios.get(JUPITER_QUOTE_API, {
      params: {
        inputMint: inputMint,
        outputMint: outputMint,
        amount: amount,
        slippageBps: 50
      }
    });
    return quote.data.outAmount / quote.data.inAmount;
  } catch (error) {
    logger.error('Error fetching quote:', error);
    return null;
  }
}

function calculateSMA(prices) {
  return prices.reduce((sum, price) => sum + price, 0) / prices.length;
}

const MAX_RETRIES = 3;
const INITIAL_DELAY = 5000; // 5 seconds
const DELAY_MULTIPLIER = 2;

async function executeSwap(quote, inputMint, outputMint, amount) {
  console.log('executeSwap called'); // New log to check if function is entered
  let retries = 0;
  let delay = INITIAL_DELAY;

  while (retries < MAX_RETRIES) {
    try {
      console.log('Attempting swap:', retries + 1);
      const swapResponse = await axios.post(JUPITER_SWAP_API, {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58()
      });
      console.log('Swap response received');
      const serializedTransaction = swapResponse.data.swapTransaction;
      const transaction = web3.VersionedTransaction.deserialize(Buffer.from(serializedTransaction, 'base64'));
      transaction.sign([wallet]);
      console.log('Transaction signed');
      const signature = await connection.sendRawTransaction(transaction.serialize());
      console.log('Transaction sent, signature:', signature);

      const latestBlockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        signature: signature
      });
      console.log('Transaction confirmed');
      
      logger.info('Swap executed with signature:', signature);
      return signature;
    } catch (error) {
      console.log('Caught error:', error.message);
      retries++;
      logger.error(`Failed to execute swap (Attempt ${retries}):`, error);
      
      if (retries === MAX_RETRIES) {
        console.log('Max retries reached, swap failed.');
        logger.error('Max retries reached, swap failed.');
        return null;
      }

      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= DELAY_MULTIPLIER;
    }
  }
  console.log('Exiting executeSwap'); // New log to see if we exit the function
}

async function main() {
  let currentHolding = 'USDC';
  let lastTradePrice = null;

  logger.info('Bot started with initial investment:', initialInvestment / 1000000, 'USDC');

  while (true) {
    const price = await getPriceFromQuote(USDC_MINT, SCF_MINT, initialInvestment);
    if (price === null) {
      logger.warn('Failed to fetch price');
      continue;
    }

    priceHistory.push(price);
    if (priceHistory.length > smaWindowSize) priceHistory.shift();

    const currentSMA = calculateSMA(priceHistory);

    logger.info(`Current Price: ${price}, SMA: ${currentSMA}`);

    if (currentHolding === 'USDC' && price > currentSMA && price !== lastTradePrice) {
      logger.info('Buying SCF');
      const quote = await getPriceFromQuote(USDC_MINT, SCF_MINT, initialInvestment);
      if (quote) {
        const result = await executeSwap(quote, USDC_MINT, SCF_MINT, initialInvestment);
        if (result) {
          currentHolding = 'SCF';
          lastTradePrice = price;
          logger.info('Successfully bought SCF');
        } else {
          logger.error('Failed to buy SCF');
        }
      }
    } else if (currentHolding === 'SCF' && price < currentSMA && price !== lastTradePrice) {
      logger.info('Selling SCF');
      const quote = await getPriceFromQuote(SCF_MINT, USDC_MINT, initialInvestment); // Adjust this based on your last buy
      if (quote) {
        const result = await executeSwap(quote, SCF_MINT, USDC_MINT, quote.data.outAmount);
        if (result) {
          currentHolding = 'USDC';
          lastTradePrice = price;
          logger.info('Successfully sold SCF');
        } else {
          logger.error('Failed to sell SCF');
        }
      }
    }

    // Wait for 5 minutes
    await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
  }
}

// Ensure main() is only called when this script is run directly
if (require.main === module) {
  main().catch(error => {
    logger.error('An unexpected error occurred:', error);
  });
}

// Export functions for testing
module.exports = {
  calculateSMA,
  getPriceFromQuote,
  executeSwap,
  getConnection: () => connection  // Now returning the already initialized connection
};