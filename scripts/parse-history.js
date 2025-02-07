require('dotenv').config();
const bs58 = require('bs58').default;
const { Connection, PublicKey, VersionedTransactionResponse } = require('@solana/web3.js');

const batchSize = 20;
const connection = new Connection(process.env.SOLANA_RPC);
const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")

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
    console.log(`Fetching signatures for the last ${daysAgo} days...`);
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
 * Parse a pumpfun transaction
 * @param {VersionedTransactionResponse} tx
 * @returns {Object}
 */
function parsePumpfunTx(tx) {
  for (const innerInst of tx.meta?.innerInstructions ?? []) {
    for (const instruction of innerInst.instructions) {
      if (instruction.programId.equals(PUMPFUN_PROGRAM_ID)) {
        const encoded = bs58.decode(instruction.data)
        const solAmount = Buffer.from(encoded.slice(48, 56)).readBigInt64LE().toString()
        const tokenAmount = Buffer.from(encoded.slice(56, 64)).readBigInt64LE().toString()
        const isBuy = encoded[64] == 1
        return {
          solAmount, tokenAmount, isBuy,
        }
      }
    }
  }

}

/**
 * Fetches transaction details for a given list of signatures
 * @param {string[]} signatures 
 * @returns {Promise<Transaction[]>}
 */
async function getTransactionDetails(signatures) {
  console.log('Fetching transaction details...');
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
              parsePumpfunTx(tx);
              transactions.push({
                signature: sig.signature,
                timestamp: tx.blockTime,
                slot: tx.slot,
                success: tx.meta?.err === null,
                ...parsePumpfunTx(tx),
              });
            }
          })
          .catch(error => {
            console.error(`Error fetching transaction ${sig.signature}:`, error);
          })
          .finally(() => {
            inProgress.delete(promise);
            completed++;
            if (completed % batchSize === 0)
              console.log(`Processed ${completed}/${signatures.length} transactions`);
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
  try {
    const signatures = await getSignatures(address, daysAgo);
    console.log(`Total signatures found: ${signatures.length}`);
    if (signatures.length === 0) return [];
    return await getTransactionDetails(signatures);
  } catch (error) {
    console.error('Error:', error);
    return [];
  }
}

// connection.getParsedTransaction(
//   "me1B1ZRr1SqBsAqmhMjqa5hxYtg5hERZ7Pn7zcC1WGQH8UPgfFh78GpZL7XRhVbQk3VXoNAKxWqth3NZiqc8ik1",
//   { maxSupportedTransactionVersion: 0 }
// )
//   .then(tx => {
//     console.log(tx)
//     console.log(isPumpfunTx(tx))
//   })
//   .catch(console.error);


const walletAddress = 'Gv4mQWaPiWbwXiNT7JtHYN6LuBVbFoKHhDiNYcEVGbdM';

getAllTransactions(walletAddress, 7)
  .then(data => {
    console.log(`Transactions: ${data.pumpfunCount} pumpfun, ${data.txCount} total.`);
    const fs = require('fs');
    fs.writeFileSync(
      'transactions.json',
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
