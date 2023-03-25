const axios = require('axios');
const WebSocket = require('ws');
const { Gauge, register } = require('prom-client');
const crypto = require('crypto');
const levelup = require('levelup');
const leveldown = require('leveldown');
const express = require('express');

const wsUrl = process.env.WEBSOCKET_URL || 'wss://rpc.cosmos.directory:443/cosmoshub/websocket';
const restUrl = process.env.REST_URL || 'https://rest.cosmos.directory:443/cosmoshub';
const metricsPort = process.env.METRICS_PORT || 3013;

// Initialize the Gauges
const validatorPowerGauge = new Gauge({
  name: 'validator_voting_power',
  help: 'Voting power of validators',
  labelNames: ['operator_address', 'consensus_pubkey', 'moniker'],
});

const valsetHashGauge = new Gauge({
  name: 'validator_set_hash',
  help: 'deterministic hash of the validator set',
  labelNames: ['height', 'valset_hash'],
});

const validatorPowerUpdatesGauge = new Gauge({
  name: 'validator_power_updates',
  help: 'Validator power updates',
  labelNames: ['height', 'operator_address', 'consensus_pubkey', 'moniker'],
});

// Initialize the LevelDB database
const db = levelup(leveldown('./valset_hashes'));

// Function to get all validators
async function getValidators() {
  let validators = [];
  let nextKey = null;

  do {
    const url = `${restUrl}/cosmos/staking/v1beta1/validators?limit=100${nextKey ? `&pagination.key=${encodeURIComponent(nextKey)}` : ''}`;
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
async function getValidatorSet() {
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
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(sortedValidatorSet));
  return hash.digest('hex');
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

// Function to handle new block events
async function handleNewBlock(message) {
  const height = message.result.data.value.block.header.height;
  const validators = await getValidators();
  const validatorSet = await getValidatorSet();

  validatorSet.forEach((validator) => {
    const { pub_key, voting_power } = validator;
    const consensusPubkey = pub_key.key;

    const validatorData = validators.find(
      (v) => v.consensus_pubkey.key === consensusPubkey
    );

    if (validatorData) {
      const { operator_address, description } = validatorData;
      validatorPowerGauge
        .labels(operator_address, consensusPubkey, description.moniker)
        .set(parseInt(voting_power));
    }
  });

  // Check and update valset hash
  const valsetHash = generateValsetHash(validatorSet);
  const exists = await checkValsetHashExists(valsetHash);

  if (!exists) {
    valsetHashGauge.labels(height, valsetHash).set(1);
    console.log(`New block height: ${height}, Valset hash: ${valsetHash}`);
    db.put(height, valsetHash, (error) => {
      if (error) {
        console.error(`Error saving valset hash: ${error}`);
      } else {
        console.log(`Saved valset hash for height ${height}`);
      }
    });
  } else {
    console.log(`Valset hash for height ${height} already exists`);
  }

  // Check for validator_updates
  const validatorUpdates = message.result.data.value.result_end_block.validator_updates;
  if (validatorUpdates && validatorUpdates.length > 0) {
    validatorUpdates.forEach((update) => {
      const { pub_key, power } = update;
      const consensusPubkey = pub_key.Sum.value.ed25519;
      const voting_power = parseInt(power);

      const validatorData = validators.find(
        (v) => v.consensus_pubkey.key === consensusPubkey
      );

      if (validatorData) {
        const { operator_address, description } = validatorData;
        validatorPowerUpdatesGauge
          .labels(height, operator_address, consensusPubkey, description.moniker)
          .set(voting_power);
        console.log(`Validator voting_power update: ${operator_address}, New voting_power: ${voting_power}`);
      }
    });
  }
}

// WebSocket connection and event handling
function connect() {
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('Connected to WebSocket');
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscribe',
        params: { query: "tm.event='NewBlock'" },
      }),
    );
  });

  ws.on('message', async (data) => {
    const message = JSON.parse(data);
    if (message.result?.data?.value?.block?.header) {
      await handleNewBlock(message);
    }
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error: ${error}`);
  });

  ws.on('close', () => {
    console.log('WebSocket closed. Reconnecting...');
    setTimeout(connect, 1000);
  });
}

connect();

// Set up the Express server for metrics
const app = express();

app.get('/metrics', async (req, res) => {
  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
});

app.listen(metricsPort, () => {
  console.log(`Metrics server listening on port ${metricsPort}`);
});