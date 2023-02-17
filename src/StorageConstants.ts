export const AMPLIFY_SYMBOL = (typeof Symbol !== 'undefined' && typeof Symbol.for === 'function'
  ? Symbol.for('amplify_default')
  : '@@amplify_default') as Symbol;

export const SET_CONTENT_LENGTH_HEADER = 'contentLengthMiddleware';

export const localTestingStorageEndpoint = 'http://localhost:20005';

export const UPLOADS_STORAGE_KEY = '__uploadInProgress';

export enum StorageErrorStrings {
  NO_CREDENTIALS = 'No credentials',
  NO_SRC_KEY = 'source param should be an object with the property "key" with value of type string',
  NO_DEST_KEY = 'destination param should be an object with the property "key" with value of type string',
  INVALID_BLOB = 'Object must be an instance of Blob',
}

export enum AWSS3ProviderMultipartCopierErrors {
  CLEANUP_FAILED = 'Multipart copy clean up failed',
  NO_OBJECT_FOUND = 'Object does not exist',
  INVALID_QUEUESIZE = 'Queue size must be a positive number',
  NO_COPYSOURCE = 'You must specify a copy source',
  MAX_NUM_PARTS_EXCEEDED = 'Only a maximum of 10000 parts are allowed',
}

export enum AWSS3ProviderUploadErrorStrings {
  UPLOAD_PAUSED_MESSAGE = 'paused',
}
