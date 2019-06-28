/*!
 * Copyright (c) 2019 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

import {CapabilityDelegation} from 'ocapld';
import {ControllerKey} from 'web-kms-client';
import {DataHubClient} from 'secure-data-hub-client';
import jsigs from 'jsonld-signatures';
import uuid from 'uuid-random';
import DataHubClientCache from './DataHubClientCache.js';
import {generateDid, storeDidDocument} from './did.js';

const {SECURITY_CONTEXT_V2_URL, sign, suites} = jsigs;
const {Ed25519Signature2018} = suites;

export default class ProfileManager {
  /**
   * Creates a new instance of a ProfileManager and attaches it to the given
   * session instance. This ProfileManager will track changes to the given
   * session, creating and/or caching account and profile data hubs as needed.
   *
   * @param {Object} options - The options to use.
   * @param {Object} options.session - A `bedrock-web-session` session instance.
   * @param {string} options.kmsModule - The KMS module to use to generate keys.
   * @param {string} options.kmsBaseUrl - The base URL for the KMS service,
   *   used to generate keys.
   *
   * @returns {ProfileManager} - The new instance.
   */
  constructor({kmsModule, kmsBaseUrl}) {
    if(typeof kmsModule !== 'string') {
      throw new TypeError('"kmsModule" must be a string.');
    }
    if(typeof kmsBaseUrl !== 'string') {
      throw new TypeError('"kmsBaseUrl" must be a string.');
    }
    this.session = null;
    this.accountId = null;
    this.controllerKey = null;
    this.dataHubCache = new DataHubClientCache();
    this.kmsModule = kmsModule;
    this.kmsBaseUrl = kmsBaseUrl;
  }

  /**
   * Attaches this instance to the given session. This ProfileManager will
   * track changes to the given session, creating and/or caching account and
   * profile data hubs as needed.
   *
   * @param {Object} options - The options to use.
   * @param {Object} options.session - A `bedrock-web-session` session instance.
   *
   * @returns {Promise} - Resolves once the operation completes.
   */
  async setSession({session}) {
    if(this.session) {
      throw new Error('Already attached to a session.');
    }
    this.session = session;
    this.removeListener = session.on(
      'change', event => this._sessionChanged(event));
    // emulate initial session change event
    await this._sessionChanged({newData: session.data});
  }

  async getAccountDataHub() {
    return this.dataHubCache.get('primary');
  }

  async getProfileDataHub({profileId}) {
    const id = `profile.${profileId}`;
    let dataHub = await this.dataHubCache.get(id);
    if(dataHub) {
      return dataHub;
    }

    const accountDataHub = await this.getAccountDataHub();
    const {controllerKey: invocationSigner} = this;
    const [doc] = await accountDataHub.find({
      equals: {'content.id': profileId},
      invocationSigner
    });
    if(!doc) {
      // no such profile stored with the given account
      return null;
    }

    // get the profile data hub
    const {content: profile} = doc;
    // TODO: pass `capability` for accessing profile datahub config
    const config = await DataHubClient.getConfig({id: profile.dataHub});
    const [kek, hmac] = await Promise.all([
      // TODO: pass `capability` for invoking kek and hmac operations
      this.controllerKey.getKek({id: config.kek.id, type: config.kek.type}),
      this.controllerKey.getHmac({id: config.hmac.id, type: config.hmac.type})
    ]);
    dataHub = new DataHubClient({id: config.id, kek, hmac});
    await this.dataHubCache.set(id, dataHub);
    return dataHub;
  }

  async createProfile({type, content}) {
    // generate a DID for the profile
    const {did, keyPair} = await generateDid();

    // TODO: support making the profile data hub controlled by the profile
    // instead

    // get primary data hub and create an account controlled data hub for
    // the new profile
    const [accountDataHub, profileDataHub] = await Promise.all([
      this.getAccountDataHub(),
      this._createDataHub()
    ]);

    // insert a profile document into the primary data hub
    let profileType = 'Profile';
    if(type) {
      profileType = [profileType, type];
    }
    const doc = {
      id: uuid(),
      content: {
        ...content,
        id: did,
        type: profileType,
        // TODO: might need this to be the specific document -- or a zcap
        dataHub: profileDataHub.id
      }
    };
    const {controllerKey: invocationSigner} = this;
    await accountDataHub.insert({doc, invocationSigner});

    // cache the profile data hub and store the unregistered DID document in it
    await this.dataHubCache.set(`profile.${did}`, profileDataHub);
    await storeDidDocument(
      {dataHub: profileDataHub, keyPair, invocationSigner});

    return doc;
  }

  // TODO: implement adding an existing profile to an account

  async getProfile({profileId}) {
    const dataHub = await this.getAccountDataHub();
    if(!dataHub) {
      return null;
    }
    const {controllerKey: invocationSigner} = this;
    const [doc = null] = await dataHub.find({
      equals: {'content.id': profileId},
      invocationSigner
    });
    return doc;
  }

  async getProfiles() {
    const dataHub = await this.getAccountDataHub();
    if(!dataHub) {
      return [];
    }
    const {controllerKey: invocationSigner} = this;
    return dataHub.find({
      equals: {'content.type': 'Profile'},
      invocationSigner
    });
  }

  async delegateCapability({profileId, request}) {
    const {invocationTarget, invoker, referenceId, allowedAction, caveat} =
      request;
    if(!(invocationTarget && typeof invocationTarget === 'object' &&
      invocationTarget.type)) {
      throw new TypeError(
        '"invocationTarget" must be an object that includes a "type".');
    }

    const dataHub = await this.getProfileDataHub({profileId});

    // TODO: to reduce correlation between the account and multiple profiles,
    // consider generating a unique controller key per profile DID, but consider
    // the additional overhead for password replacement
    const {controllerKey: signer} = this;

    let zcap = {
      '@context': SECURITY_CONTEXT_V2_URL,
      // TODO: use 128-bit random multibase encoded value instead of uuid
      id: 'urn:zcap:' + uuid(),
      invoker
    };
    if(referenceId) {
      zcap.referenceId = referenceId;
    }
    if(allowedAction) {
      zcap.allowedAction = allowedAction;
    }
    if(caveat) {
      zcap.caveat = caveat;
    }
    const {id: target, type: targetType} = invocationTarget;
    if(targetType === 'Ed25519VerificationKey2018') {
      if(!target) {
        throw new TypeError(
          '"invocationTarget.id" must be set for Web KMS capabilities.');
      }
      // TODO: fetch `target` from a key mapping document in the profile's
      // data hub to get public key ID to set as `referenceId`
      zcap.invocationTarget = {
        id: target,
        type: targetType,
        // TODO: put public key ID here
        //referenceId:
      };
      zcap.parentCapability = target;
      zcap = await _delegate({zcap, signer});

      // TODO: enable zcap via KmsClient
      // await kmsClient.enableCapability(
      //   {capabilityToEnable: zcap, invocationSigner: signer});
    } else if(targetType === 'urn:datahub:document') {
      zcap.invocationTarget = {
        id: target,
        type: targetType
      };

      if(!target) {
        // TODO: use 128-bit random multibase encoded value instead of uuid
        zcap.invocationTarget.id = `${dataHub.id}/documents/${uuid()}`;
      }
      zcap.parentCapability = zcap.invocationTarget.id;
      zcap = await _delegate({zcap, signer});

      // enable zcap via dataHub client
      await dataHub.enableCapability(
        {capabilityToEnable: zcap, invocationSigner: signer});
    } else {
      throw new Error(`Unsupported invocation target type "${targetType}".`);
    }
    return zcap;
  }

  async _sessionChanged({authentication, newData}) {
    const newAccountId = (newData.account || {}).id || null;

    // clear cache
    if(this.accountId && this.accountId !== newAccountId) {
      await ControllerKey.clearCache({handle: this.accountId});
      await this.dataHubCache.clear();
    }

    // update state
    this.accountId = newAccountId;
    this.controllerKey = null;

    if(!(authentication || newData.account)) {
      // no account in session, return
      return;
    }

    // cache account controller key
    const {secret} = (authentication || {});
    this.controllerKey = await (secret ?
      ControllerKey.fromSecret({secret, handle: this.accountId}) :
      ControllerKey.fromCache({handle: this.accountId}));
    if(this.controllerKey === null) {
      // could not load from cache and no `secret`, so cannot load data hub
      return;
    }

    // ensure the account's primary data hub exists and cache it
    const dataHub = await this._ensureDataHub();
    await this.dataHubCache.set('primary', dataHub);
  }

  async _createDataHub({referenceId} = {}) {
    // create KEK and HMAC keys for data hub config
    const {controllerKey, kmsModule} = this;
    const kekId = this._generateKmsKeyId();
    const hmacId = this._generateKmsKeyId();
    const [kek, hmac] = await Promise.all([
      controllerKey.generateKey({id: kekId, type: 'kek', kmsModule}),
      controllerKey.generateKey({id: hmacId, type: 'hmac', kmsModule})
    ]);

    // create data hub
    let config = {
      sequence: 0,
      controller: controllerKey.handle,
      // TODO: add `invoker` and `delegator` using controllerKey.id *or*, if
      // this is a profile's data hub, the profile ID
      invoker: controllerKey.id,
      delegator: controllerKey.id,
      kek: {id: kek.id, type: kek.type},
      hmac: {id: hmac.id, type: hmac.type}
    };
    if(referenceId) {
      config.referenceId = referenceId;
    }
    config = await DataHubClient.createDataHub({config});
    return new DataHubClient({id: config.id, kek, hmac});
  }

  async _ensureDataHub() {
    const {controllerKey} = this;
    const config = await DataHubClient.findConfig(
      {controller: controllerKey.handle, referenceId: 'primary'});
    if(config === null) {
      return await this._createDataHub({referenceId: 'primary'});
    }
    const [kek, hmac] = await Promise.all([
      controllerKey.getKek({id: config.kek.id, type: config.kek.type}),
      controllerKey.getHmac({id: config.hmac.id, type: config.hmac.type})
    ]);
    return new DataHubClient({id: config.id, kek, hmac});
  }

  _generateKmsKeyId() {
    return `${this.kmsBaseUrl}/${uuid()}`;
  }
}

async function _delegate({zcap, signer}) {
  // attach capability delegation proof
  return sign(zcap, {
    // TODO: map `signer.type` to signature suite
    suite: new Ed25519Signature2018({
      signer,
      verificationMethod: signer.id
    }),
    purpose: new CapabilityDelegation({
      capabilityChain: [zcap.parentCapability]
    }),
    compactProof: false
  });
}
