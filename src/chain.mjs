import axios from 'axios';
import { interchain_security } from 'interchain-security';
import { db } from './database.mjs';
import {
  generateValsetHash,
  checkValsetHashExists,
  pubKeyToValcons
} from './utils.mjs';
import {
  validatorPowerGauge,
  valsetHashGauge,
  validatorPowerUpdatesGauge,
  faultyValsetsGauge
} from './metrics.mjs';

async function getValidators(restUrl) {
  let validators = [];
  let nextKey = null;
  try {
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
  } catch (error) {
    console.error(`Error fetching validators from ${providerRestUrl}: ${error.message}`);
  }
  return validators;
}

async function getValidatorSet(restUrl) {
  let validators = [];
  let currentPage = 0;
  let totalPages = 0;
  try {
    do {
      const response = await axios.get(
        `${restUrl}/cosmos/base/tendermint/v1beta1/validatorsets/latest?pagination.offset=${currentPage * 100}&pagination.limit=100`
      );
      const fetchedValidators = response.data.validators;
      totalPages = Math.ceil(response.data.pagination.total / 100);
      validators = [...validators, ...fetchedValidators];
      currentPage++;
    } while (currentPage < totalPages);
  } catch (error) {
    console.error(`Error fetching validator set from ${restUrl}: ${error.message}`);
  }
  return validators;
}

async function processNewBlock(chain, rpcUrl, chainId, prevHeight, providerRpcUrl, providerRestUrl) {
  try {
    const blockResponse = await axios.get(`${rpcUrl}/block`);
    const block = blockResponse.data.result;
    const height = parseInt(block.block.header.height);

    if (height > prevHeight) {
      console.log(`[${chainId}] New block detected. Height: ${height}`);
      const validators = await getValidators(providerRestUrl);
      const validatorSetResponse = await axios.get(`${rpcUrl}/validators`);
      const validatorSet = validatorSetResponse.data.result.validators;

      // LCD Client doesn't expose queryValidatorConsumerAddr
      /* 
      const icsClient = await interchain_security.ClientFactory.createLCDClient({
        restEndpoint: providerRestUrl
      })
    */

      async function processValidators() {
        if (chain === 'consumer') {
          const icsClient = await interchain_security.ClientFactory.createRPCQueryClient({
            rpcEndpoint: providerRpcUrl
          });
          for (const validator of validators) {
            if (!validator.hasOwnProperty('consumerSigningKeys')) {
              validator.consumerSigningKeys = {};
            }
            let consumerSigningKey = null;
            let valconsAddress = null
            try {
              valconsAddress = pubKeyToValcons(validator.consensus_pubkey.key, 'cosmos');
              consumerSigningKey = await icsClient.interchain_security.ccv.provider.v1.queryValidatorConsumerAddr({
                chainId: chainId,
                providerAddress: valconsAddress
              });
              consumerSigningKey = consumerSigningKey.consumerAddress;
            } catch (e) {
              console.error(e);
            }
            validator.providerSigningKey = valconsAddress;

            if (consumerSigningKey && consumerSigningKey !== '') {
              validator.consumerSigningKeys[chainId] = consumerSigningKey;
            } else {
              validator.consumerSigningKeys[chainId] = valconsAddress;
            }
            console.log(validator.operator_address + " provider key " + validator.providerSigningKey + " | " + chainId + ": " + validator.consumerSigningKeys[chainId]);
          }
        }
      }

      async function processValidatorSet() {
        validatorSet.forEach(async (validator) => {
          const { address, pub_key, voting_power } = validator;
          const consensusPubkey = pubKeyToValcons(pub_key.value, 'cosmos');
          let validatorData;
          if (chain === 'provider') {
            validatorData = validators.find(
              (v) => v.providerSigningKey === consensusPubkey
            );
          } else {
            validatorData = validators.find(
              (v) => v.consumerSigningKeys[chainId] === consensusPubkey
            );
          }
          if (validatorData) {
            const { operator_address, description } = validatorData;
            validatorPowerGauge
              .labels(chain, chainId, operator_address, consensusPubkey, description.moniker)
              .set(parseInt(voting_power));
          }
        });
      }

      // Execute the functions sequentially
      (async () => {
        await processValidators();
        await processValidatorSet();
      })();

      const valsetHash = generateValsetHash(validatorSet);

      if (chain === 'provider') {
        const exists = await checkValsetHashExists(valsetHash);

        if (!exists) {
          valsetHashGauge.labels(chain, chainId, height, valsetHash).set(1);
          console.log(`[${chainId}] New block height: ${height}, Valset hash: ${valsetHash}`);
          db.run("INSERT INTO valset_hashes (height, hash) VALUES (?, ?)", [height, valsetHash], (error) => {
            if (error) {
              console.error(`Error saving valset hash: ${error}`);
            } else {
              console.log(`Saved valset hash for height ${height}`);
            }
          });
        } else {
          console.log(`[${chainId}] Valset hash for height ${height} already exists`);
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
          db.run("INSERT INTO valset_hashes (height, hash) VALUES (?, ?)", [height, valsetHash], (error) => {
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
          console.log(`[${chainId}] Faulty valset detected at height ${height}, Valset hash: ${valsetHash}`);
        } else {
          console.log(`[${chainId}] Valset hash for height ${height} is valid`);
        }
      }

      return height;
    }
  } catch (error) {
    console.error(`[${chainId}] Error processing new block: ${error.message}`);
  }
  return prevHeight;
}

export {
  getValidators,
  getValidatorSet,
  processNewBlock
};
