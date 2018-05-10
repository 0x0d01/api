import * as tendermint from '../tendermint/ndid';
import TendermintWsClient from '../tendermint/wsClient';
import * as rp from './rp';
import * as idp from './idp';
import * as as from './as';
import * as utils from '../utils';
import { role, nodeId } from '../config';

export let syncing = null;
export let latestBlockHeight = null;

// FIXME: To be removed when init() in main/rp.js, main/idp.js, main/as.js, and devInitKey.js are removed.
export const tendermintReady = (async () => {
  for (;;) {
    if (syncing === false) return;
    // if (latestBlockHeight > 2) return;
    await utils.wait(1000);
  }
})();

const tendermintWsClient = new TendermintWsClient();

async function pollStatusUtilSynced() {
  for (;;) {
    if (syncing == null || syncing === true) {
      tendermintWsClient.getStatus('statusUtilSynced');
      await utils.wait(1000);
    } else {
      break;
    }
  }
}

tendermintWsClient.on('connected', () => {
  console.log('Waiting for tendermint to finish syncing blockchain');
  pollStatusUtilSynced();
});

tendermintWsClient.on('statusUtilSynced', (error, result) => {
  syncing = result.syncing;
  if (syncing === false) {
    console.log('Tendermint blockchain synced');
  }
});

tendermintWsClient.on('newBlock#event', (error, result) => {
  latestBlockHeight = result.data.data.block.header.height;

  let handleTendermintNewBlockEvent;
  if (role === 'rp') {
    handleTendermintNewBlockEvent = rp.handleTendermintNewBlockEvent;
  } else if (role === 'idp') {
    handleTendermintNewBlockEvent = idp.handleTendermintNewBlockEvent;
  } else if (role === 'as') {
    handleTendermintNewBlockEvent = as.handleTendermintNewBlockEvent;
  }

  if (handleTendermintNewBlockEvent) {
    handleTendermintNewBlockEvent(error, result);
  }
});

/*
  data = { requestId }
*/
export async function getRequest(data) {
  return await tendermint.query('GetRequest', data);
}

/*export async function getRequestRequireHeight(data, requireHeight) {
  let currentHeight,request;
  do {
    let [ _request, _currentHeight ] = await utils.queryChain('GetRequest', data, true);
    currentHeight = _currentHeight;
    request = _request;
    //sleep
    await new Promise(resolve => { setTimeout(resolve,1000); });
  }
  while(currentHeight < requireHeight + 2); //magic number...
  return request;
}*/

/*
  data = { node_id, public_key }
*/
export async function addNodePubKey(data) {
  let result = await tendermint.transact(
    'AddNodePublicKey',
    data,
    utils.getNonce()
  );
  return result;
}

/*
  node_id
*/
export async function getNodePubKey(node_id) {
  return await tendermint.query('GetNodePublicKey', { node_id });
}

export async function getMsqAddress(node_id) {
  return await tendermint.query('GetMsqAddress', { node_id });
}

export async function registerMsqAddress({ip, port}) {
  return await tendermint.transact('RegisterMsqAddress', {
    ip,
    port,
    node_id: nodeId
  }, utils.getNonce());
}
