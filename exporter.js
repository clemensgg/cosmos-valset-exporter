const axios = require('axios');
const { Gauge, register } = require('prom-client');
const crypto = require('crypto');
const levelup = require('levelup');
const leveldown = require('leveldown');
const express = require('express');

const providerRpcUrl = process.env.PROVIDER_RPC_URL || 'https://rpc.provider-sentry-01.rs-testnet.polypore.xyz';
const consumerRpcUrl = process.env.CONSUMER_RPC_URL || 'https://rpc.baryon.ntrn.info';
const providerRestUrl = process.env.PROVIDER_REST_URL || 'https://rest.provider-sentry-01.rs-testnet.polypore.xyz';
//const consumerRestUrl = process.env.CONSUMER_REST_URL || 'https://rest.baryon.ntrn.info';
const metricsPort = process.env.METRICS_PORT || 3013;

// Initialize the Gauges
const validatorPowerGauge = new Gauge({
  name: 'validator_voting_power',
  help: 'Voting power of validators',
  labelNames: ['ics_chain', 'chain_id', 'operator_address', 'consensus_pubkey', 'moniker'],
});

const valsetHashGauge = new Gauge({
  name: 'validator_set_hash',
  help: 'deterministic hash of the validator set',
  labelNames: ['ics_chain', 'chain_id', 'height', 'valset_hash'],
});

const validatorPowerUpdatesGauge = new Gauge({
  name: 'validator_power_updates',
  help: 'Validator power updates',
  labelNames: ['ics_chain', 'chain_id', 'height', 'operator_address', 'consensus_pubkey', 'moniker'],
});

const faultyValsetsGauge = new Gauge({
  name: 'faulty_valsets',
  help: 'Faulty valsets found on the consumer chain',
  labelNames: ['chain_id', 'consumer_height', 'valset_hash'],
});

// Initialize the LevelDB database
const db = levelup(leveldown('./valset_hashes'));

// Function to get the validator descriptions
async function getValidators() {
  let validators = [];
  let nextKey = null;

  do {
    const url = `${providerRestUrl}/cosmos/staking/v1beta1/validators?limit=100${nextKey ? `&pagination.key=${encodeURIComponent(nextKey)}` : ''}`;
    const response = await axios.get(url);

    validators = validators.concat(response.data.validators);

    if (response.data.pagination && response.data.pagination.next_key) {
      nextKey = response.data.pagination.next_key;
    } else {
      break;
    }
  } while (nextKey);

  return validators;
}

// Function to get the validator set
async function getValidatorSet(restUrl) {
  let validators = [];
  let currentPage = 0;
  let totalPages = 0;

  do {
    const response = await axios.get(
      `${restUrl}/cosmos/base/tendermint/v1beta1/validatorsets/latest?pagination.offset=${currentPage * 100}&pagination.limit=100`
    );
    const fetchedValidators = response.data.validators;
    totalPages = Math.ceil(response.data.pagination.total / 100);
    validators = [...validators, ...fetchedValidators];
    currentPage++;
  } while (currentPage < totalPages);

  return validators;
}

// Function to generate the deterministic hash of the validator set
function generateValsetHash(validatorSet) {
  const cleanedValidatorSet = validatorSet.map(({ proposer_priority, pub_key, ...validator }) => validator);
  const sortedValidatorSet = cleanedValidatorSet.sort((a, b) => b.address - a.address);
  const serializedValidatorSet = JSON.stringify(sortedValidatorSet);
  const hash = crypto.createHash('sha256').update(serializedValidatorSet).digest('hex');
  return hash;
}

// Function to check if a valset hash already exists in the database
async function checkValsetHashExists(valsetHash) {
  return new Promise((resolve, reject) => {
    const stream = db.createValueStream();

    stream.on('data', (value) => {
      if (value.toString() === valsetHash) {
        resolve(true);
        stream.destroy();
      }
    });

    stream.on('end', () => {
      resolve(false);
    });

    stream.on('error', (error) => {
      reject(error);
    });
  });
}

async function processNewBlock(chain, rpcUrl, chainId, prevHeight) {
  try {
    const blockResponse = await axios.get(`${rpcUrl}/block`);
    const block = blockResponse.data.result;
    const height = parseInt(block.block.header.height);

    if (height > prevHeight) {
      console.log(`[${chain}] New block detected. Height: ${height}`);
      const validators = await getValidators();
      const validatorSetResponse = await axios.get(`${rpcUrl}/validators`);
      const validatorSet = validatorSetResponse.data.result.validators;

      validatorSet.forEach((validator) => {
        const { address, pub_key, voting_power } = validator;
        const consensusPubkey = pub_key.value;

        const validatorData = validators.find(
          (v) => v.consensus_pubkey.key === consensusPubkey
        );

        if (validatorData) {
          const { operator_address, description } = validatorData;
          validatorPowerGauge
            .labels(chain, chainId, operator_address, consensusPubkey, description.moniker)
            .set(parseInt(voting_power));
        }
      });

      const valsetHash = generateValsetHash(validatorSet);

      if (chain === 'provider') {
        const exists = await checkValsetHashExists(valsetHash);

        if (!exists) {
          valsetHashGauge.labels(chain, chainId, height, valsetHash).set(1);
          console.log(`[${chain}] New block height: ${height}, Valset hash: ${valsetHash}`);
          db.put(height, valsetHash, (error) => {
            if (error) {
              console.error(`Error saving valset hash: ${error}`);
            } else {
              console.log(`Saved valset hash for height ${height}`);
            }
          });
        } else {
          console.log(`[${chain}] Valset hash for height ${height} already exists`);
        }

        // Check for validator_updates
        const validatorUpdates = block.block.last_commit.signatures;
        if (validatorUpdates && validatorUpdates.length > 0) {
          validatorUpdates.forEach((update) => {
            const { validator_address } = update;
            const validatorData = validators.find(
              (v) => v.operator_address === validator_address
            );

            if (validatorData) {
              const { operator_address, consensus_pubkey, description } = validatorData;
              validatorPowerUpdatesGauge
                .labels(chain, chainId, height, operator_address, consensus_pubkey.key, description.moniker)
                .set(parseInt(validatorData.tokens));
              console.log(`Validator voting_power update: ${operator_address}, New voting_power: ${validatorData.tokens}`);
            }
          });
        }
      } else if (chain === 'consumer') {
        if (prevHeight === 0) {
          db.put(height, valsetHash, (error) => {
            if (error) {
              console.error(`Error saving valset hash: ${error}`);
            } else {
              console.log(`[STARTUP] Saved first consumer valset hash for startup, height ${height}`);
            }
          });
        }
        const exists = await checkValsetHashExists(valsetHash);

        if (!exists) {
          faultyValsetsGauge.labels(chainId, height, valsetHash).set(1);
          console.log(`[${chain}] Faulty valset detected at height ${height}, Valset hash: ${valsetHash}`);
        } else {
          console.log(`[${chain}] Valset hash for height ${height} is valid`);
        }
      }

      return height;
    }
  } catch (error) {
    console.error(`[${chain}] Error processing new block: ${error}`);
  }

  return prevHeight;
}

// Main function to start the script
async function main() {
  let providerPrevHeight = 0;
  let consumerPrevHeight = 0;

  // Get chain IDs for the provider and consumer chains
  const providerChainId = (await axios.get(`${providerRpcUrl}/status`)).data.result.node_info.network;
  const consumerChainId = (await axios.get(`${consumerRpcUrl}/status`)).data.result.node_info.network;

  console.log(`Provider chain ID: ${providerChainId}`);
  console.log(`Consumer chain ID: ${consumerChainId}`);

  // Start polling both chains for new blocks
  setInterval(async () => {
    providerPrevHeight = await processNewBlock('provider', providerRpcUrl, providerChainId, providerPrevHeight);
  }, 1500);

  setInterval(async () => {
    consumerPrevHeight = await processNewBlock('consumer', consumerRpcUrl, consumerChainId, consumerPrevHeight);
  }, 1500);

  // Set up the Express server for metrics
  const app = express();

  app.get('/metrics', async (req, res) => {
    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
  });

  app.listen(metricsPort, () => {
    console.log(`Metrics server listening on port ${metricsPort}`);
  });
}

main();