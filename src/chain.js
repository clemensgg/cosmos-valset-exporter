const axios = require('axios');

async function getValidators(providerRestUrl) {
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
          db.run("INSERT INTO valset_hashes (height, hash) VALUES (?, ?)", [height, valsetHash], (error) => {
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

module.exports = {
  getValidators,
  getValidatorSet,
  processNewBlock
};