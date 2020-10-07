import { Hub, Logger, Parser, CredentialsClass } from '@aws-amplify/core';
import { AWSS3Provider, StorageProvider } from '@aws-amplify/storage';
import * as events from 'events';
import { StorageChunkManagedUpload } from './StorageChunkManagedUpload';
const logger = new Logger('StorageChunkUpload');

const AMPLIFY_SYMBOL = (typeof Symbol !== 'undefined' && typeof Symbol.for === 'function'
  ? Symbol.for('amplify_default')
  : '@@amplify_default') as Symbol;

const dispatchStorageEvent = (track: boolean, event: string, attrs: any, metrics: any, message: string) => {
  if (track) {
    const data = { attrs };
    if (metrics) {
      data['metrics'] = metrics;
    }
    Hub.dispatch(
      'storage',
      {
        event,
        data,
        message,
      },
      'Storage',
      AMPLIFY_SYMBOL,
    );
  }
};

export class StorageChunkUpload extends AWSS3Provider {
  // category and provider name
  static category = 'Storage';
  static providerName = 'StorageChunkUpload';

  private _storageConfig;

  constructor(config, private credentials: CredentialsClass) {
    super(config);
    this._storageConfig = config ? config : {};
    logger.debug('Storage Options', this._storageConfig);
  }
  /**
   * Configure Storage part with aws configuration
   * @param {Object} config - Configuration of the Storage
   * @return {Object} - Current configuration
   */
  public configure(config?): object {
    logger.debug('configure Storage', config);
    if (!config) return this._storageConfig;
    const amplifyConfig = Parser.parseMobilehubConfig(config);
    this._storageConfig = Object.assign({}, this._storageConfig, amplifyConfig.Storage['AWSS3']);
    if (!this._storageConfig.bucket) {
      logger.debug('Do not have bucket yet');
    }
    return this._storageConfig;
  }

  // upload storage object
  public async put(key: string, object, config?): Promise<Object> {
    const credentialsOK = await this._ensureCredentials();
    if (!credentialsOK) {
      return Promise.reject('No credentials');
    }

    const opt = Object.assign({}, this._storageConfig, config);
    const { bucket, track, progressCallback } = opt;
    const { contentType, contentDisposition, cacheControl, expires, metadata, tagging, acl } = opt;
    const { serverSideEncryption, SSECustomerAlgorithm, SSECustomerKey, SSECustomerKeyMD5, SSEKMSKeyId } = opt;
    const type = contentType ? contentType : 'binary/octet-stream';

    const prefix = this._getPrefix(opt);
    const final_key = prefix + key;
    logger.debug('put ' + key + ' to ' + final_key);

    const params: any = {
      Bucket: bucket,
      Key: final_key,
      Body: object,
      ContentType: type,
    };
    if (cacheControl) {
      params.CacheControl = cacheControl;
    }
    if (contentDisposition) {
      params.ContentDisposition = contentDisposition;
    }
    if (expires) {
      params.Expires = expires;
    }
    if (metadata) {
      params.Metadata = metadata;
    }
    if (tagging) {
      params.Tagging = tagging;
    }
    if (serverSideEncryption) {
      params.ServerSideEncryption = serverSideEncryption;
      if (SSECustomerAlgorithm) {
        params.SSECustomerAlgorithm = SSECustomerAlgorithm;
      }
      if (SSECustomerKey) {
        params.SSECustomerKey = SSECustomerKey;
      }
      if (SSECustomerKeyMD5) {
        params.SSECustomerKeyMD5 = SSECustomerKeyMD5;
      }
      if (SSEKMSKeyId) {
        params.SSEKMSKeyId = SSEKMSKeyId;
      }
    }

    const emitter = new events.EventEmitter();
    const uploader = new StorageChunkManagedUpload(params, this.credentials, opt, emitter);

    if (acl) {
      params.ACL = acl;
    }

    try {
      emitter.on('sendProgress', (progress) => {
        if (progressCallback) {
          if (typeof progressCallback === 'function') {
            progressCallback(progress);
          } else {
            logger.warn('progressCallback should be a function, not a ' + typeof progressCallback);
          }
        }
      });

      const response = await uploader.upload();

      logger.debug('upload result', response);
      dispatchStorageEvent(track, 'upload', { method: 'put', result: 'success' }, null, `Upload success for ${key}`);
      return {
        key,
      };
    } catch (error) {
      logger.warn('error uploading', error);
      dispatchStorageEvent(track, 'upload', { method: 'put', result: 'failed' }, null, `Error uploading ${key}`);
      throw error;
    }
  }

  // return 'Storage';
  getCategory(): string {
    return StorageChunkUpload.category;
  }

  // return the name of you provider
  getProviderName(): string {
    return StorageChunkUpload.providerName;
  }

  /**
   * @private
   */
  private _getPrefix(config) {
    const { credentials, level } = config;

    const customPrefix = config.customPrefix || {};
    const identityId = config.identityId || credentials.identityId;
    const privatePath = (customPrefix.private !== undefined ? customPrefix.private : 'private/') + identityId + '/';
    const protectedPath =
      (customPrefix.protected !== undefined ? customPrefix.protected : 'protected/') + identityId + '/';
    const publicPath = customPrefix.public !== undefined ? customPrefix.public : 'public/';

    switch (level) {
      case 'private':
        return privatePath;
      case 'protected':
        return protectedPath;
      default:
        return publicPath;
    }
  }

  /**
   * @private
   */
  _ensureCredentials() {
    return this.credentials
      .get()
      .then((credentials) => {
        if (!credentials) return false;
        const cred = this.credentials.shear(credentials);
        logger.debug('set credentials for storage', cred);
        this._storageConfig.credentials = cred;

        return true;
      })
      .catch((error) => {
        logger.warn('ensure credentials error', error);
        return false;
      });
  }
}
