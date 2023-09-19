import axios from 'axios';
import { interchain_security } from 'interchain-security';
import { initializeDB } from './src/database.mjs';
import { startServer } from './src/server.mjs';
import { processNewBlock } from './src/chain.mjs';

// const providerRpcUrl = process.env.PROVIDER_RPC_URL || 'https://rpc.provider-sentry-01.rs-testnet.polypore.xyz';
// const consumerRpcUrl = process.env.CONSUMER_RPC_URL || 'https://rpc-falcron.pion-1.ntrn.tech';
// const providerRestUrl = process.env.PROVIDER_REST_URL || 'https://rest.provider-sentry-01.rs-testnet.polypore.xyz';
// const consumerRestUrl = process.env.CONSUMER_REST_URL || 'https://rest-falcron.pion-1.ntrn.tech';
const providerRpcUrl = process.env.PROVIDER_RPC_URL || 'https://cosmos-rpc.polkachu.com';
const consumerRpcUrl = process.env.CONSUMER_RPC_URL || 'https://neutron-rpc.polkachu.com';
const providerRestUrl = process.env.PROVIDER_REST_URL || 'https://rest-cosmoshub.ecostake.com';
const consumerRestUrl = process.env.CONSUMER_REST_URL || 'https://rest-neutron.ecostake.com';
const metricsPort = process.env.METRICS_PORT || 3013;

async function main() {
  console.log('starting ics-valset-exporter...')
  initializeDB();

  const icsClient = await interchain_security.ClientFactory.createRPCQueryClient({ rpcEndpoint: providerRpcUrl })
  let consumerChainIds;
  try {
    consumerChainIds = await icsClient.interchain_security.ccv.provider.v1.queryConsumerChains();
  } catch (e) {
    console.error(e);
  }
  console.log('registered consumer chains: ' + JSON.stringify(consumerChainIds))

  const providerChainId = (await axios.get(`${providerRpcUrl}/status`)).data.result.node_info.network;
  const consumerChainId = (await axios.get(`${consumerRpcUrl}/status`)).data.result.node_info.network;

  let providerPrevHeight = 0;
  let consumerPrevHeight = 0;

  async function pollProvider() {
    providerPrevHeight = await processNewBlock('provider', providerRpcUrl, providerChainId, providerPrevHeight, providerRpcUrl, providerRestUrl);
    setTimeout(pollProvider, 600000);
  }

  async function pollConsumer() {
      consumerPrevHeight = await processNewBlock('consumer', consumerRpcUrl, consumerChainId, consumerPrevHeight, providerRpcUrl, providerRestUrl);
      setTimeout(pollConsumer, 600000);
  }

  pollProvider();
  pollConsumer();

  startServer(metricsPort);
}

main().catch(error => {
  console.error("Error in main execution:", error);
  process.exit(1);
});
