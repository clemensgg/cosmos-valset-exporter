import express from 'express';
import { register } from 'prom-client';
import {
    validatorPowerGauge,
    valsetHashGauge,
    validatorPowerUpdatesGauge,
    faultyValsetsGauge,
    getLastValueOfGauge,
    filterGaugeDataByChainId
} from './metrics.mjs';

function startServer(metricsPort) {
    const app = express();
    app.use(express.json());

    app.get('/metrics', async (req, res) => {
        res.setHeader('Content-Type', register.contentType);
        res.send(await register.metrics());
    });

    app.post('/fetch', (req, res) => {
      const type = req.body.type;
      const chain_id = req.body.chain_id;
  
      if (!type || (type === 'consumer' && !chain_id)) {
        return res.status(400).send("Bad Request: Missing required parameter: chain_id");
      }
  
      if (type === 'provider') {
          const data = {
              validator_voting_power: getLastValueOfGauge(validatorPowerGauge),
              validator_set_hash: getLastValueOfGauge(valsetHashGauge),
              validator_power_updates: getLastValueOfGauge(validatorPowerUpdatesGauge),
              faulty_valsets: getLastValueOfGauge(faultyValsetsGauge)
          };
          res.json(data);
      } else if (type === 'consumer' && chain_id) {
          // Filter the data based on the provided chain_id
          const filteredData = {
              validator_voting_power: filterGaugeDataByChainId(validatorPowerGauge, chain_id),
              validator_set_hash: filterGaugeDataByChainId(valsetHashGauge, chain_id),
              validator_power_updates: filterGaugeDataByChainId(validatorPowerUpdatesGauge, chain_id),
              faulty_valsets: filterGaugeDataByChainId(faultyValsetsGauge, chain_id)
          };
          res.json(filteredData);
      } else {
          res.status(400).send('Invalid request parameters');
      }
    });

    app.listen(metricsPort, () => {
        console.log(`Server listening on port ${metricsPort}`);
    });
}

export {
    startServer
};