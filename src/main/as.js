import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

import { eventEmitter } from '../mq';

import * as tendermint from '../tendermint/ndid';
import * as mq from '../mq';
import * as utils from '../utils';
import * as config from '../config';
import * as common from '../main/common';
import * as db from '../db';

const privKey = 'AS_PrivateKey';

db.put('blockHeight', '', 0);

let callbackUrl = null;
try {
  callbackUrl = fs.readFileSync(
    path.join(__dirname, '../../as-callback-url.json'),
    'utf8'
  );
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.log(error);
  }
}

export const setCallbackUrl = (url) => {
  callbackUrl = url;
  fs.writeFile(
    path.join(__dirname, '../../as-callback-url.json'),
    url,
    (err) => {
      if (err) {
        console.error('Error writing AS callback url file');
      }
    }
  );
};

export const getCallbackUrl = () => {
  return callbackUrl;
};

async function sendDataToRP(data) {
  let receivers = [];
  let nodeId = data.rp_node_id;
  let { ip, port } = await common.getMsqAddress(nodeId);
  receivers.push({
    ip,
    port,
    ...(await common.getNodePubKey(nodeId)),
  });
  mq.send(receivers, {
    as_id: data.as_id,
    data: data.data,
    request_id: data.request_id,
  });
}

async function signData(data) {
  let nonce = utils.getNonce();
  let dataToBlockchain = {
    as_id: data.as_id,
    request_id: data.request_id,
    signature: data.signature,
  };
  tendermint.transact('SignData', dataToBlockchain, nonce);
}

async function registerServiceDestination(data) {
  let nonce = utils.getNonce();
  let dataToBlockchain = {
    as_id: data.as_id,
    service_id: data.service_id,
    node_id: data.node_id,
  };
  tendermint.transact('RegisterServiceDestination', dataToBlockchain, nonce);
}

async function notifyByCallback(request) {
  if (!callbackUrl) {
    console.error('callbackUrl for AS not set');
    return;
  }
  let data = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ request }),
  });
  let result = await data.json();
  return result.data;
}

async function checkIntegrity(requestId) {
  console.log('checkIntegrity');

  let msgBlockchain = await common.getRequest({ requestId });
  let message = await db.get('mqReceivingQueue', requestId);

  let valid = msgBlockchain.messageHash === utils.hash(message.request_message);
  if (!valid) {
    console.error(
      'Mq and blockchain not matched!!',
      message.request_message,
      msgBlockchain.messageHash
    );
    return false;
  }

  const requestDetail = await tendermint.query('GetRequestDetail', {
    requestId: message.request_id,
  });

  // TODO
  // Verify that (number of consent ≥ min_idp in request).
  // For each consent with matching request ID:
  // Verify the identity proof.
  // Verify the signature.
  // Verify that the message_hash is matching with the request.

  // Get all signature
  let signatures = [];
  requestDetail.responses.forEach((response) => {
    signatures.push(response.signature);
  });

  // Calculate max ial && max aal
  let max_ial = 0;
  let max_aal = 0;
  requestDetail.responses.forEach((response) => {
    if (response.aal > max_aal) max_aal = response.aal;
    else valid = false;
    if (response.ial > max_ial) max_ial = response.ial;
    else valid = false;
  });

  db.del('mqReceivingQueue', requestId);
  return [
    valid,
    {
      signatures,
      max_aal,
      max_ial,
    },
  ];
}

async function handleMessageFromQueue(request) {
  console.log('AS receive message from mq:', request);
  let requestJson = JSON.parse(request);
  await db.put('mqReceivingQueue', requestJson.request_id, requestJson);

  const blockHeight = await db.get('blockHeight', 'blockHeight');
  if (blockHeight < requestJson.height) {
    const requestIdsInTendermintBlock = await db.get('requestIdsInTendermintBlock', requestJson.height);
    if (!requestIdsInTendermintBlock) {
      await db.put('requestIdsInTendermintBlock', requestJson.height, [requestJson.request_id]);
    } else {
      requestIdsInTendermintBlock.push(
        requestJson.request_id
      );
      await db.put('requestIdsInTendermintBlock', requestJson.height, requestIdsInTendermintBlock);
    }
    return;
  }

  let [valid, additionalData] = await checkIntegrity(requestJson.request_id);
  if (valid) {
    // TODO
    // Then callback to AS.
    console.log('Callback to AS', {
      request_id: requestJson.request_id,
      request_params: requestJson.request_params,
      ...additionalData,
    });

    // AS→Platform
    // The AS replies synchronously with the requested data
    let data = await notifyByCallback({
      request_id: requestJson.request_id,
      request_params: requestJson.request_params,
      ...additionalData,
    });

    // When received data
    //let data = 'mock data';
    let as_id = config.asID;
    let signature = await utils.createSignature(data);
    // AS node encrypts the response and sends it back to RP via NSQ.
    sendDataToRP({
      rp_node_id: requestJson.rp_node_id,
      as_id,
      data,
      request_id: requestJson.request_id,
    });

    // AS node adds transaction to blockchain
    signData({ as_id, request_id: requestJson.request_id, signature });
  }
}

export async function handleTendermintNewBlockEvent(error, result) {
  let height = tendermint.getHeightFromTendermintNewBlockEvent(result);

  const blockHeight = await db.get('blockHeight', 'blockHeight');
  if (height !== blockHeight + 1) {
    //TODO handle missing events
  }
  await db.put('blockHeight', 'blockHeight', height);

  //msq arrive before newBlock event
  const requestIdsInTendermintBlock = await db.get('requestIdsInTendermintBlock', height);
  if (requestIdsInTendermintBlock) {
    requestIdsInTendermintBlock.forEach(async function(requestId) {
      let valid = await checkIntegrity(requestId);
      const message = await db.get('mqReceivingQueue', requestId);
      if (valid) notifyByCallback(message);
      await db.del('mqReceivingQueue', requestId);
    });

    db.del('requestIdsInTendermintBlock', height);
  }
}

/*export async function handleABCIAppCallback(requestId, height) {
  console.log('Callback (event) from ABCI app; requestId:', requestId);
  const request = await common.getRequestRequireHeight({ requestId }, height);
  if (request.status === 'completed') {
    blockchainQueue[requestId] = await request;
    checkIntegrity(requestId);
  }
}*/

//===================== Initialize before flow can start =======================

// FIXME: to be removed
export async function init() {
  // In production environment, this should be done with register service process.

  // Wait for blockchain ready
  await common.tendermintReady;

  // TODO
  //register node id, which is substituted with ip,port for demo
  //let node_id = config.mqRegister.ip + ':' + config.mqRegister.port;
  //process.env.nodeId = node_id;
  // Hard code add back statement service for demo
  registerServiceDestination({
    as_id: config.asID,
    service_id: 'bank_statement',
    node_id: config.nodeId,
  });
  common.registerMsqAddress(config.mqRegister);
  /*common.addNodePubKey({
    node_id,
    public_key: 'very_secure_public_key_for_as'
  });*/
}

if (config.role === 'as') {
  eventEmitter.on('message', function(message) {
    handleMessageFromQueue(message);
  });
}
