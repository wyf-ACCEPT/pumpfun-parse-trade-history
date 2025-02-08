require('dotenv').config();
const bs58 = require('bs58').default;
const LRU = require('lru-cache');
const { Metaplex } = require('@metaplex-foundation/js')
const { Connection, PublicKey, VersionedTransactionResponse } = require('@solana/web3.js');

const batchSize = 20;
const connection = new Connection(process.env.SOLANA_RPC);
const metaplex = Metaplex.make(connection);
const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const PURPLE = '\x1b[35m';
const GRAY = '\x1b[90m';

const tokenNameCache = {}

/**
 * @typedef {Object} PumpfunTxResult
 * @property {string} solAmount
 * @property {string} tokenAmount
 * @property {boolean} isBuy
 * @property {number} timestamp
 * @property {number} slot
 * @property {string} signature
 * @property {boolean} success
 */

/**
 * Fetches signatures for a given address for a given number of days
 * @param {string} address 
 * @param {number} daysAgo 
 * @returns {Promise<string[]>}
 */
async function getSignatures(address, daysAgo) {
  const pubKey = new PublicKey(address);
  const startTime = Math.floor(Date.now() / 1000) - (daysAgo * 24 * 60 * 60);

  try {
    let signatures = [];
    let before = undefined;

    while (true) {
      const signatureObjects = await connection.getSignaturesForAddress(
        pubKey,
        { before, limit: 1000 }
      );

      if (signatureObjects.length === 0) break;
      const filteredSignatures = signatureObjects.filter(
        sig => sig.blockTime >= startTime
      );

      if (filteredSignatures.length === 0 && signatureObjects[0].blockTime < startTime) {
        break;
      }

      signatures = [...signatures, ...filteredSignatures];
      before = signatureObjects[signatureObjects.length - 1].signature;

      console.log(`Fetched ${signatures.length} signatures so far...`);
    }

    return signatures;
  } catch (error) {
    console.error('Error fetching signatures:', error);
    return [];
  }
}

/**
 * Checks if a transaction is a pumpfun transaction
 * @param {VersionedTransactionResponse} tx
 * @returns {number} 0 for not pumpfun, 1 for buy, 2 for sell
 */
function isPumpfunTx(tx) {
  if (
    tx.transaction &&
    tx.transaction.message.instructions &&
    tx.transaction.message.instructions.some(
      instruction => instruction.programId &&
        instruction.programId.equals(PUMPFUN_PROGRAM_ID)
    )) {
    if (tx.meta.logMessages.some(log => log.includes("Program log: Instruction: Buy")))
      return 1;
    if (tx.meta.logMessages.some(log => log.includes("Program log: Instruction: Sell")))
      return 2;
  }
  return 0;
}

/**
 * Get the name of a token
 * @param {PublicKey} mint 
 * @returns {Promise<string>}
 */
async function nameOfToken(mint) {
  const key = mint.toString();
  const cached = tokenNameCache[key];
  if (cached) return cached;
  const metadata = await metaplex.nfts().findByMint({ mintAddress: mint });
  let name = metadata.name;
  if (name.includes(' ')) name = `"${name}"`
  tokenNameCache[key] = name;
  return name;
}

/**
 * Parse a pumpfun transaction
 * @param {VersionedTransactionResponse} tx
 * @returns {{ PumpfunTxResult }}
 */
async function parsePumpfunTx(tx) {
  for (const innerInst of tx.meta?.innerInstructions ?? []) {
    for (const instruction of innerInst.instructions) {
      if (instruction.programId.equals(PUMPFUN_PROGRAM_ID)) {
        const encoded = bs58.decode(instruction.data)
        if (encoded.length != 137) continue;
        const mint = new PublicKey(bs58.encode(Buffer.from(encoded.slice(16, 48), 'hex')))
        const solAmount = Buffer.from(encoded.slice(48, 56)).readBigInt64LE().toString()
        const tokenAmount = Buffer.from(encoded.slice(56, 64)).readBigInt64LE().toString()
        const isBuy = encoded[64] == 1
        const timestamp = Buffer.from(encoded.slice(97, 105)).readBigInt64LE().toString()
        const tokenName = await nameOfToken(mint);
        return {
          mint, solAmount, tokenAmount, isBuy, timestamp,
          slot: tx.slot, signature: tx.transaction.signatures[0], success: tx.meta?.err === null,
          tokenName,
        }
      }
    }
  }
}

/**
 * Show a pumpfun transaction
 * @param {PumpfunTxResult} parsedTx
 */
function showPumpfunTx(parsedTx) {
  const time = (new Date(parseInt(parsedTx.timestamp) * 1e3)).toISOString().slice(0, 19).replace('T', ' ')
  if (parsedTx.isBuy) {
    console.log(`[${YELLOW}${time}${RESET}] Buy ${BLUE}${(parsedTx.solAmount / 1e9).toFixed(5)} $SOL${RESET} ` +
      `-> ${GREEN}${(parsedTx.tokenAmount / 1e6).toFixed(2)} $${parsedTx.tokenName}${RESET}` + 
      `  ${GRAY}https://solscan.io/tx/${parsedTx.signature}${RESET}`)
  } else {
    console.log(`[${YELLOW}${time}${RESET}] Sell ${RED}${(parsedTx.tokenAmount / 1e6).toFixed(2)} $${parsedTx.tokenName}${RESET} ` +
      `-> ${BLUE}${(parsedTx.solAmount / 1e9).toFixed(5)} $SOL${RESET}` + 
      `  ${GRAY}https://solscan.io/tx/${parsedTx.signature}${RESET}`)
  }
}

/**
 * Fetches transaction details for a given list of signatures
 * @param {string[]} signatures 
 * @returns {Promise<Transaction[]>}
 */
async function getTransactionDetails(signatures) {
  console.log('\nFetching transaction details...');
  const transactions = [];
  const inProgress = new Set();
  let completed = 0;

  return new Promise((resolve, reject) => {
    function startNext() {
      while (inProgress.size < batchSize && completed + inProgress.size < signatures.length) {
        const sig = signatures[completed + inProgress.size];
        const promise = connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0
        })
          .then(tx => {
            const pumpfunTxType = isPumpfunTx(tx);
            if (pumpfunTxType != 0) {
              parsePumpfunTx(tx)
                .then(parsed => {
                  showPumpfunTx(parsed);
                  transactions.push(parsed);
                })
            }
          })
          .catch(error => {
            console.error(`Error fetching transaction ${sig.signature}:`, error);
          })
          .finally(() => {
            inProgress.delete(promise);
            completed++;
            // if (completed % batchSize === 0)
            //   console.log(`Processed ${completed}/${signatures.length} transactions`);
            startNext();
            if (completed === signatures.length)
              resolve({
                transactions,
                txCount: signatures.length,
                pumpfunCount: transactions.length,
              });
          });
        inProgress.add(promise);
      }
    }
    startNext();
  });
}

async function getAllTransactions(address, daysAgo) {
  console.log(`\nFetching transactions for ${PURPLE}${address}${RESET} in the last ${YELLOW}${daysAgo}${RESET} days...\n`);
  try {
    const signatures = await getSignatures(address, daysAgo);
    console.log(`\nTotal signatures found: ${PURPLE}${signatures.length}${RESET}.`);
    if (signatures.length === 0) return [];
    return await getTransactionDetails(signatures);
  } catch (error) {
    console.error('Error:', error);
    return [];
  }
}


const walletAddress = 'Gv4mQWaPiWbwXiNT7JtHYN6LuBVbFoKHhDiNYcEVGbdM';

getAllTransactions(walletAddress, 10)
  .then(data => {
    console.log(`Transactions: ${data.pumpfunCount} pumpfun, ${data.txCount} total.`);
    const fs = require('fs');
    fs.writeFileSync(
      './data/transactions.json',
      JSON.stringify(data.transactions, null, 2)
    );
  })
  .catch(console.error);

/**
 * e445a52e51cb9a1dbddb7fd34ee661ee
 * 592a92ab10621a8f8051a9dd15d2229790cf0f98dd61cb91e5ae2f204d20d00f (mint, pubkey)
 * eea3451d00000000 (solAmount, u64-LE, 491103214)
 * 5f644bb8250b0000 (tokenAmount, u64-LE, 12256633644127)
 * 01 (isBuy, false)
 * ec7758355e951381fbc7402db2c543e5f7c7d419d72a3fe7cdf2000cfbde657c (user, pubkey)
 * ef99a46700000000 (timestamp, i64, 1738840559)
 * 939e506b08000000 (virtualSolReserves, 36160183955)
 * df017b27a3290300 (virtualTokenReserves, 890205648912863)
 * 93f22c6f01000000
 * df6968db112b0200
*/
