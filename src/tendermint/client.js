import fetch from 'node-fetch';

import { TENDERMINT_ADDRESS } from '../config';

async function httpUriCall(method, params) {
  const queryString = params.reduce((paramsString, param) => {
    if (param.key == null || param.value == null) {
      return paramsString;
    }
    const uriEncodedParamValue = encodeURIComponent(param.value);
    if (paramsString !== '') {
      return paramsString + `&${param.key}="${uriEncodedParamValue}"`;
    }
    return paramsString + `${param.key}="${uriEncodedParamValue}"`;
  }, '');

  let uri = `http://${TENDERMINT_ADDRESS}/${method}`;
  if (params.length > 0) {
    uri = uri + `?${queryString}`;
  }

  try {
    const response = await fetch(uri);
    const responseJson = await response.json();
    return responseJson;
  } catch (error) {
    console.error('Cannot connect to tendermint HTTP endpoint', error);
    throw error;
  }
}

export function abciQuery(data) {
  const dataBase64Encoded = Buffer.from(data).toString('base64');
  return httpUriCall('abci_query', [
    {
      key: 'data',
      value: dataBase64Encoded,
    },
  ]);
}

export function broadcastTxCommit(tx) {
  const txBase64Encoded = Buffer.from(tx).toString('base64');
  return httpUriCall('broadcast_tx_commit', [
    {
      key: 'tx',
      value: txBase64Encoded,
    },
  ]);
}

export function status() {
  return httpUriCall('status');
}
