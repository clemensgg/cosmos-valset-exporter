# cosmos-valset-exporter

`cosmos-valset-exporter` is a Node.js application that exports Cosmos validator set information to Prometheus metrics. The application connects to a Cosmos node via a WebSocket and listens for new block events. When a new block event is received, the application fetches the validator set and the list of active validators and exports this information to Prometheus.

## Installation

Clone the repository and install the dependencies:
```
git clone https://github.com/clemensgg/cosmos-valset-exporter
cd cosmos-valset-exporter
npm install
```

## Configuration

The application can be configured using environment variables:

- `WEBSOCKET_URL`: The URL of the WebSocket to connect to. Default: `wss://rpc.cosmos.directory:443/cosmoshub/websocket`
- `REST_URL`: The URL of the REST API to fetch data from. Default: `https://rest.cosmos.directory:443/cosmoshub`
- `METRICS_PORT`: The port that the metrics server will listen on. Default: `3013`

## Usage

Start the app:
```
npm run exporter
```

The application will connect to the WebSocket and start exporting metrics. Metrics can be viewed at `http://localhost:<METRICS_PORT>/metrics`.

## Metrics

The application exports the following metrics:

- `validator_voting_power`: Voting power of validators
- `validator_set_hash`: Deterministic hash of the validator set
- `validator_power_updates`: Validator power updates

## License

[MIT](LICENSE)