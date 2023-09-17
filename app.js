const axios = require('axios');
const { initializeDB } = require('./src/database');
const { startServer } = require('./src/server');
const { processNewBlock } = require('./src/chain');

const providerRpcUrl = process.env.PROVIDER_RPC_URL || 'https://rpc.provider-sentry-01.rs-testnet.polypore.xyz';
const consumerRpcUrl = process.env.CONSUMER_RPC_URL || 'https://rpc-falcron.pion-1.ntrn.tech';
const providerRestUrl = process.env.PROVIDER_REST_URL || 'https://rest.provider-sentry-01.rs-testnet.polypore.xyz';
const consumerRestUrl = process.env.CONSUMER_REST_URL || 'https://rest-falcron.pion-1.ntrn.tech';
const metricsPort = process.env.METRICS_PORT || 3013;

async function main() {
  initializeDB();

  const providerChainId = (await axios.get(`${providerRpcUrl}/status`)).data.result.node_info.network;
  const consumerChainId = (await axios.get(`${consumerRpcUrl}/status`)).data.result.node_info.network;

  let providerPrevHeight = 0;
  let consumerPrevHeight = 0;

  async function pollProvider() {
    providerPrevHeight = await processNewBlock('provider', providerRpcUrl, providerRestUrl, providerChainId, providerPrevHeight, providerRestUrl);
    setTimeout(pollProvider, 1500);
  }

  async function pollConsumer() {
      consumerPrevHeight = await processNewBlock('consumer', consumerRpcUrl, consumerRestUrl, consumerChainId, consumerPrevHeight, providerRestUrl);
      setTimeout(pollConsumer, 1500);
  }

  pollProvider();
  pollConsumer();

  startServer(metricsPort, providerRpcUrl, consumerRpcUrl, consumerChainId);
}

main().catch(error => {
  console.error("Error in main execution:", error);
  process.exit(1);
});
