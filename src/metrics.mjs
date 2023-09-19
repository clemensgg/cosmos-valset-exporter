import { Gauge } from 'prom-client';

const validatorPowerGauge = new Gauge({
    name: 'validator_voting_power',
    help: 'Voting power of validators',
    labelNames: ['ics_type', 'chain_id', 'operator_address', 'consensus_pubkey', 'moniker'],
});

const valsetHashGauge = new Gauge({
    name: 'validator_set_hash',
    help: 'deterministic hash of the validator set',
    labelNames: ['ics_type', 'chain_id', 'height', 'valset_hash'],
});

const validatorPowerUpdatesGauge = new Gauge({
    name: 'validator_power_updates',
    help: 'Validator power updates',
    labelNames: ['ics_type', 'chain_id', 'height', 'operator_address', 'consensus_pubkey', 'moniker'],
});

const faultyValsetsGauge = new Gauge({
    name: 'faulty_valsets',
    help: 'Faulty valsets found on the consumer chain',
    labelNames: ['chain_id', 'consumer_height', 'valset_hash'],
});

function getLastValueOfGauge(gauge) {
    const metricData = gauge.get();
    const lastValues = {};
    if (metricData && metricData.values) {
        metricData.values.forEach(valueItem => {
            const labelString = Object.values(valueItem.labels).join('_');
            lastValues[labelString] = valueItem.value;
        });
    }
    return lastValues;
}

function filterGaugeDataByChainId(gauge, chainId) {
    const allData = getLastValueOfGauge(gauge);
    return Object.entries(allData)
        .filter(([key]) => key.includes(chainId))
        .reduce((obj, [key, value]) => {
            obj[key] = value;
            return obj;
        }, {});
}

export {
    validatorPowerGauge,
    valsetHashGauge,
    validatorPowerUpdatesGauge,
    faultyValsetsGauge,
    getLastValueOfGauge,
    filterGaugeDataByChainId
};