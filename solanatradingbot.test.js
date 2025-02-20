require('dotenv').config(); // Load .env file

const axios = require('axios');
const web3 = require('@solana/web3.js');

// Mock setup for axios
jest.mock('axios');

// Mock setup for web3.js
jest.mock('@solana/web3.js', () => {
  const mockSendRawTransaction = jest.fn().mockResolvedValue('MOCK_TX_SIGNATURE');
  return {
    Connection: jest.fn(() => ({
      getLatestBlockhash: jest.fn().mockResolvedValue({
        blockhash: 'MOCK_BLOCKHASH',
        lastValidBlockHeight: 100
      }),
      confirmTransaction: jest.fn().mockResolvedValue(true),
      sendRawTransaction: mockSendRawTransaction
    })),
    Keypair: {
      fromSecretKey: jest.fn(() => ({
        publicKey: { toBase58: jest.fn().mockReturnValue('MOCK_PUBLIC_KEY') }
      }))
    },
    VersionedTransaction: {
      deserialize: jest.fn(() => ({
        sign: jest.fn(),
        serialize: jest.fn().mockReturnValue('mock serialized transaction')
      }))
    },
    clusterApiUrl: jest.fn(() => 'MOCK_CLUSTER_API_URL')
  };
});

// Mock solanatradingbot.js to control getConnection
jest.mock('./solanatradingbot.js', () => {
  const originalModule = jest.requireActual('./solanatradingbot.js');
  return {
    ...originalModule,
    connection: {
      getLatestBlockhash: jest.fn().mockResolvedValue({
        blockhash: 'MOCK_BLOCKHASH',
        lastValidBlockHeight: 100
      }),
      confirmTransaction: jest.fn().mockResolvedValue(true),
      sendRawTransaction: jest.fn().mockResolvedValue('MOCK_TX_SIGNATURE')
    },
    getConnection: jest.fn(() => originalModule.connection)
  };
});

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

// Import all necessary functions here
const { calculateSMA, getPriceFromQuote, executeSwap, getConnection } = require('./solanatradingbot');

describe('calculateSMA', () => {
  test('calculates the Simple Moving Average for a small set of numbers', () => {
    const prices = [1, 2, 3, 4, 5];
    const sma = calculateSMA(prices);
    expect(sma).toBe(3); // (1+2+3+4+5)/5 = 3
  });

  test('works with a single element', () => {
    const prices = [10];
    const sma = calculateSMA(prices);
    expect(sma).toBe(10);
  });

  test('handles an empty array', () => {
    const prices = [];
    const sma = calculateSMA(prices);
    expect(sma).toBeNaN(); // Assuming your function returns NaN for an empty array
  });

  test('works with floating point numbers', () => {
    const prices = [1.5, 2.5, 3.5];
    const sma = calculateSMA(prices);
    expect(sma).toBeCloseTo(2.5, 5); // Use toBeCloseTo for floating point comparison
  });

  test('works with a large set of numbers', () => {
    const prices = Array(100).fill(1).map((_, i) => i + 1); // Creates [1, 2, ..., 100]
    const sma = calculateSMA(prices);
    expect(sma).toBe(50.5); // (1+2+...+100)/100 = 50.5
  });
});

describe('getPriceFromQuote', () => {
  test('should return the correct price when the API call succeeds', async () => {
    const mockQuote = {
      data: {
        outAmount: 2000,
        inAmount: 1000
      }
    };
    axios.get.mockResolvedValue(mockQuote); // Mock a successful response

    const price = await getPriceFromQuote('USDC_MINT', 'SCF_MINT', 1000);
    expect(price).toBe(2); // 2000 / 1000 = 2
  });

  test('should return null on API error', async () => {
    axios.get.mockRejectedValue(new Error('API Error')); // Mock an error response

    const price = await getPriceFromQuote('USDC_MINT', 'SCF_MINT', 1000);
    expect(price).toBeNull();
  });

  test('should handle malformed API response', async () => {
    axios.get.mockResolvedValue({ data: {} }); // Mock an unexpected response
    const price = await getPriceFromQuote('USDC_MINT', 'SCF_MINT', 1000);
    expect(price).toBeNull(); // or whatever you expect for bad data
  });
});

describe('executeSwap', () => {
  test('should execute a swap successfully', async () => {
    // Mock axios post to return a successful swap response
    axios.post.mockResolvedValue({
      data: {
        swapTransaction: 'mockBase64Transaction'
      }
    });

    const mockQuote = { /* mock quote object properties if needed */ };
    
    const result = await executeSwap(mockQuote, 'USDC_MINT', 'SCF_MINT', 1000);

    expect(result).toBe('MOCK_TX_SIGNATURE');
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(getConnection).toHaveBeenCalled(); // Verify getConnection was called
    expect(getConnection().sendRawTransaction).toHaveBeenCalledWith('mock serialized transaction');
    expect(getConnection().confirmTransaction).toHaveBeenCalled(); // Verify confirmTransaction was called
  }, 10000); // Increase timeout to 10 seconds

  test('should handle swap failure after retries', async () => {
    // Mock four attempts, three failures, then one success to simulate retries
    axios.post
      .mockRejectedValueOnce(new Error('First Fail'))
      .mockRejectedValueOnce(new Error('Second Fail'))
      .mockRejectedValueOnce(new Error('Third Fail'))
      .mockResolvedValueOnce({data: {swapTransaction: 'mockBase64Transaction'}}); // Successful attempt

    const mockQuote = { /* mock quote object properties if needed */ };

    const result = await executeSwap(mockQuote, 'USDC_MINT', 'SCF_MINT', 1000);
    
    expect(result).toBe('MOCK_TX_SIGNATURE'); // Expect success after retries
    expect(axios.post).toHaveBeenCalledTimes(4); // Expect 4 attempts
    expect(getConnection).toHaveBeenCalled(); // Verify getConnection was called
    expect(getConnection().confirmTransaction).toHaveBeenCalled(); // Verify confirmTransaction was called
  }, 20000); // Increase timeout if needed

  test('should return null if all swap attempts fail', async () => {
    axios.post.mockRejectedValue(new Error('Failed'));
    const mockQuote = { /* mock quote */ };
    const result = await executeSwap(mockQuote);