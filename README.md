Ethereum Network API stats
==========================

Inspired from https://github.com/cubedro/eth-net-intelligence-api

This backend fetch last block number from api.etherscan.io, api.bscscan.com or any compatible webservice and connects through WebSockets to [eth-netstats](https://github.com/cubedro/eth-netstats) to feed information


## Prerequisite

* An API key from https://etherscan.io/myapikey or https://bscscan.com/myapikey

## Start daemon using docker

```bash
docker run -e API_HOST=api.etherscan.io -e API_KEY=<your_api_key_from_api.etherscan.io> -e WS_SECRET=<your_ethstat_password> -e WS_SERVER=ws://<your_ethstat_server> -ti nuagic/ethapistat:latest
```

