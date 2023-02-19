import { Credentials, Hub, Logger, parseAWSExports, StorageHelper } from '@aws-amplify/core';
import {
  AWSS3Provider,
  ResumableUploadConfig,
  S3ProviderPutConfig,
  S3ProviderPutOutput,
  StorageAccessLevel,
  StorageOptions,
  StorageProvider,
  UploadTask,
} from '@aws-amplify/storage';
import { PutObjectCommandInput, S3Client } from '@aws-sdk/client-s3';
import { CancelTokenSource } from 'axios';
import * as events from 'events';
import { StorageChunkManagedUpload } from './StorageChunkManagedUpload';
import {
  autoAdjustClockskewMiddleware,
  autoAdjustClockskewMiddlewareOptions,
  createPrefixMiddleware,
  createS3Client,
  getPrefix,
  prefixMiddlewareOptions,
} from './S3ClientUtils';
import { StorageErrorStrings, UPLOADS_STORAGE_KEY } from './StorageConstants';
import { AWSS3UploadTask, TaskEvents } from '@aws-amplify/storage/lib-esm/providers/AWSS3UploadTask';
import { SEND_UPLOAD_PROGRESS_EVENT } from './axios-http-handler';
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

interface AddTaskInput {
  accessLevel: StorageAccessLevel;
  file: Blob;
  bucket: string;
  emitter: events.EventEmitter;
  key: string;
  s3Client: S3Client;
  params?: PutObjectCommandInput;
}

export class StorageChunkUpload implements StorageProvider {
  // category and provider name
  static category = 'Storage';
  static providerName = 'StorageChunkUpload';

  private _storageConfig: StorageOptions;
  private _awsStorageProvider: AWSS3Provider;
  private _storage: Storage;

  /**
   * Initialize Storage with AWS configurations
   * @param {Object} config - Configuration object for storage
   */
  constructor(config?: StorageOptions) {
    this._awsStorageProvider = new AWSS3Provider(config);
    this._storage = new StorageHelper().getStorage();
    Hub.listen('auth', (data) => {
      const { payload } = data;
      if (payload.event === 'signOut' || payload.event === 'signIn') {
        this._storage.removeItem(UPLOADS_STORAGE_KEY);
      }
    });
    this._storageConfig = config ? config : {};
    logger.debug('Storage Options', this._storageConfig);
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
   * Configure Storage part with aws configuration
   * @param {Object} config - Configuration of the Storage
   * @return {Object} - Current configuration
   */
  public configure(config?): object {
    logger.debug('configure StorageChunkUpload', config);
    if (!config) return this._storageConfig;
    const _config = this._awsStorageProvider.configure(config);
    this._storageConfig = Object.assign({}, this._storageConfig, _config['AWSS3']);
    if (!this._storageConfig.bucket) {
      logger.debug('Do not have bucket yet');
    }
    return this._storageConfig;
  }

  private startResumableUpload(
    addTaskInput: AddTaskInput,
    config: S3ProviderPutConfig & ResumableUploadConfig,
  ): UploadTask {
    const { s3Client, emitter, key, file, params } = addTaskInput;
    const { progressCallback, completeCallback, errorCallback, track = false } = config;
    if (!(file instanceof Blob)) {
      throw new Error(StorageErrorStrings.INVALID_BLOB);
    }

    emitter.on(TaskEvents.UPLOAD_PROGRESS, (event) => {
      if (progressCallback) {
        if (typeof progressCallback === 'function') {
          progressCallback(event);
        } else {
          logger.warn('progressCallback should be a function, not a ' + typeof progressCallback);
        }
      }
    });

    emitter.on(TaskEvents.UPLOAD_COMPLETE, (event) => {
      if (completeCallback) {
        if (typeof completeCallback === 'function') {
          completeCallback(event);
        } else {
          logger.warn('completeCallback should be a function, not a ' + typeof completeCallback);
        }
      }
    });

    emitter.on(TaskEvents.ERROR, (err) => {
      if (errorCallback) {
        if (typeof errorCallback === 'function') {
          errorCallback(err);
        } else {
          logger.warn('errorCallback should be a function, not a ' + typeof errorCallback);
        }
      }
    });

    // we want to keep this function sync so we defer this promise to AWSS3UploadTask to resolve when it's needed
    // when its doing a final check with _listSingleFile function
    const prefixPromise: Promise<string> = Credentials.get().then((credentials: any) => {
      const cred = Credentials.shear(credentials);
      return getPrefix({
        ...config,
        credentials: cred,
      });
    });

    const task = new AWSS3UploadTask({
      s3Client,
      file,
      emitter,
      level: config.level,
      storage: this._storage,
      params,
      prefixPromise,
    });

    dispatchStorageEvent(
      track,
      'upload',
      { method: 'put', result: 'success' },
      null,
      `Upload Task created successfully for ${key}`,
    );

    // automatically start the upload task
    task.resume();

    return task;
  }

  // copy object, optional
  copy?(
    src: { key: string; identityId: string; level: 'public' | 'protected' | 'private' },
    dest: { key: string; level: 'public' | 'protected' | 'private' },
    options?,
  ): Promise<any> {
    return this._awsStorageProvider.copy(src, dest, options);
  }

  // get object/pre-signed url from storage
  get(key: string, options?): Promise<String | Object> {
    return this._awsStorageProvider.get(key, options);
  }

  // remove object
  remove(key: string, options?): Promise<any> {
    return this._awsStorageProvider.remove(key, options);
  }

  // list objects for the path
  list(path, options?): Promise<any> {
    return this._awsStorageProvider.list(path, options);
  }

  // upload storage object
  public put<T extends S3ProviderPutConfig>(
    key: string,
    object: PutObjectCommandInput['Body'],
    config?: T,
  ): S3ProviderPutOutput<T> {
    const opt = Object.assign({}, this._storageConfig, config);
    const { bucket, track, progressCallback, level, resumable } = opt;
    const { contentType, contentDisposition, contentEncoding, cacheControl, expires, metadata, tagging, acl } = opt;
    const { serverSideEncryption, SSECustomerAlgorithm, SSECustomerKey, SSECustomerKeyMD5, SSEKMSKeyId } = opt;
    const type = contentType ? contentType : 'binary/octet-stream';

    const params: PutObjectCommandInput = {
      Bucket: bucket,
      Key: key,
      Body: object,
      ContentType: type,
    };
    if (cacheControl) {
      params.CacheControl = cacheControl;
    }
    if (contentDisposition) {
      params.ContentDisposition = contentDisposition;
    }
    if (contentEncoding) {
      params.ContentEncoding = contentEncoding;
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
    }
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

    const emitter = new events.EventEmitter();
    const uploader = new StorageChunkManagedUpload(params, opt, emitter);

    if (acl) {
      params.ACL = acl;
    }

    if (resumable === true) {
      const s3Client = this._createNewS3Client(opt);
      // we are using aws sdk middleware to inject the prefix to key, this way we don't have to call
      // this._ensureCredentials() which allows us to make this function sync
	  // so we can return non-Promise like UploadTask
      s3Client.middlewareStack.add(createPrefixMiddleware(opt, key), prefixMiddlewareOptions);
      const addTaskInput: AddTaskInput = {
        bucket,
        key,
        s3Client,
        file: object as Blob,
        emitter,
        accessLevel: level,
        params,
      };
      // explicitly asserting the type here as Typescript could not infer that resumable is of type true
      return this.startResumableUpload(
        addTaskInput,
        config as typeof config & { resumable: true },
      ) as S3ProviderPutOutput<T>;
    }

    try {
      if (progressCallback) {
        if (typeof progressCallback === 'function') {
          emitter.on(SEND_UPLOAD_PROGRESS_EVENT, (progress) => {
            progressCallback(progress);
          });
        } else {
          logger.warn('progressCallback should be a function, not a ' + typeof progressCallback);
        }
      }

      return uploader.upload().then((response) => {
        logger.debug('upload result', response);
        dispatchStorageEvent(track, 'upload', { method: 'put', result: 'success' }, null, `Upload success for ${key}`);
        return { key };
      }) as S3ProviderPutOutput<T>;
    } catch (error) {
      logger.warn('error uploading', error);
      dispatchStorageEvent(track, 'upload', { method: 'put', result: 'failed' }, null, `Error uploading ${key}`);
      throw error;
    }
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
  private async _ensureCredentials(): Promise<boolean> {
    try {
      const credentials = await Credentials.get();
      if (!credentials) return false;
      const cred = Credentials.shear(credentials);
      logger.debug('set credentials for storage', cred);
      this._storageConfig.credentials = cred;

      return true;
    } catch (error) {
      logger.warn('ensure credentials error', error);
      return false;
    }
  }

  /**
   * Creates an S3 client with new V3 aws sdk
   */
  private _createNewS3Client(
    config: {
      region?: string;
      cancelTokenSource?: CancelTokenSource;
      dangerouslyConnectToHttpEndpointForTesting?: boolean;
      useAccelerateEndpoint?: boolean;
    },
    emitter?: events.EventEmitter,
  ): S3Client {
    const s3client = createS3Client(config, emitter);
    s3client.middlewareStack.add(autoAdjustClockskewMiddleware(s3client.config), autoAdjustClockskewMiddlewareOptions);
    return s3client;
  }
}
