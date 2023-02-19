/*
 * Copyright 2017-2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance with
 * the License. A copy of the License is located at
 *
 *     http://aws.amazon.com/apache2.0/
 *
 * or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions
 * and limitations under the License.
 */

import { ConsoleLogger as Logger } from '@aws-amplify/core';
import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  CompleteMultipartUploadCommandInput,
  ListPartsCommand,
  AbortMultipartUploadCommand,
  CompletedPart,
  PutObjectRequest,
  PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import {
  AxiosHttpHandlerOptions,
  SEND_DOWNLOAD_PROGRESS_EVENT,
  SEND_UPLOAD_PROGRESS_EVENT,
} from './axios-http-handler';
import * as events from 'events';
import {
  autoAdjustClockskewMiddleware,
  autoAdjustClockskewMiddlewareOptions,
  calculatePartSize,
  createPrefixMiddleware,
  createS3Client,
  DEFAULT_PART_SIZE,
  DEFAULT_QUEUE_SIZE,
  MAX_OBJECT_SIZE,
  prefixMiddlewareOptions,
} from './S3ClientUtils';

const logger = new Logger('AWSS3ProviderManagedUpload');

export declare interface Part {
  bodyPart: any;
  partNumber: number;
  emitter: any;
  etag?: string;
  _lastUploadedBytes: number;
}

export class StorageChunkManagedUpload {
  // Data for current upload
  private body;
  private params: PutObjectCommandInput;
  private opts = null;
  private completedParts: CompletedPart[] = [];
  private s3client: S3Client;
  private uploadId: string | undefined;
  private partSize = DEFAULT_PART_SIZE;

  // Progress reporting
  private bytesUploaded = 0;
  private totalBytesToUpload = 0;
  private emitter: events.EventEmitter | null = null;

  constructor(params: PutObjectCommandInput, opts, emitter: events.EventEmitter) {
    this.params = params;
    this.opts = opts;
    this.emitter = emitter;
    this.s3client = this._createNewS3Client(opts, emitter);
  }

  public async upload() {
    try {
      this.body = this.validateAndSanitizeBody(this.params.Body);
      this.totalBytesToUpload = this.byteLength(this.body);
      if (this.totalBytesToUpload <= DEFAULT_PART_SIZE) {
        // Multipart upload is not required. Upload the sanitized body as is
        this.params.Body = this.body;
        const putObjectCommand = new PutObjectCommand(this.params);
        return this.s3client.send(putObjectCommand);
      } else {
        // Step 1: Determine appropriate part size.
        this.partSize = calculatePartSize(this.totalBytesToUpload);
        // Step 2: Initiate the multi part upload
        this.uploadId = await this.createMultiPartUpload();

        // Step 3: Upload chunks in parallel as requested
        const numberOfPartsToUpload = Math.ceil(this.totalBytesToUpload / this.partSize);

        const parts: Part[] = await this.createParts();
        for (let start = 0; start < numberOfPartsToUpload; start += DEFAULT_QUEUE_SIZE) {
          // Upload as many as `queueSize` parts simultaneously
          await this.uploadParts(this.uploadId!, parts.slice(start, start + DEFAULT_QUEUE_SIZE));
        }

        parts.map((part) => {
          this.removeEventListener(part);
        });

        // Step 3: Finalize the upload such that S3 can recreate the file
        return await this.finishMultiPartUpload(this.uploadId!);
      }
    } catch (error) {
      // if any error is thrown, call cleanup
      await this.cleanup(this.uploadId);
      logger.error('Error. Cancelling the multipart upload.');
      throw error;
    }
  }

  private async createParts(): Promise<Part[]> {
    try {
      const parts: Part[] = [];
      for (let bodyStart = 0; bodyStart < this.totalBytesToUpload; ) {
        const bodyEnd = Math.min(bodyStart + this.partSize, this.totalBytesToUpload);
        parts.push({
          bodyPart: await Promise.resolve(this.body.slice(bodyStart, bodyEnd)),
          partNumber: parts.length + 1,
          emitter: new events.EventEmitter(),
          _lastUploadedBytes: 0,
        });
        bodyStart += this.partSize;
      }
      return parts;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  private async createMultiPartUpload() {
    try {
      const createMultiPartUploadCommand = new CreateMultipartUploadCommand(this.params);
      const response = await this.s3client.send(createMultiPartUploadCommand);
      logger.debug(response.UploadId);
      return response.UploadId;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  /**
   * @private Not to be extended outside of tests
   * @VisibleFotTesting
   */
  protected async uploadParts(uploadId: string, parts: Part[]) {
    try {
      const allResults = await Promise.all(
        parts.map(async (part) => {
          this.setupEventListener(part);
          const options: AxiosHttpHandlerOptions = { emitter: part.emitter };
          const { Key, Bucket, SSECustomerAlgorithm, SSECustomerKey, SSECustomerKeyMD5 } = this.params;
          const res = await this.s3client.send(
            new UploadPartCommand({
              PartNumber: part.partNumber,
              Body: part.bodyPart,
              UploadId: uploadId,
              Key,
              Bucket,
              ...(SSECustomerAlgorithm && { SSECustomerAlgorithm }),
              ...(SSECustomerKey && { SSECustomerKey }),
              ...(SSECustomerKeyMD5 && { SSECustomerKeyMD5 }),
            }),
            options,
          );
          return res;
        }),
      );
      // The order of resolved promises is the same as input promise order.
      for (let i = 0; i < allResults.length; i++) {
        this.completedParts.push({
          PartNumber: parts[i].partNumber,
          ETag: allResults[i].ETag,
        });
      }
    } catch (error) {
      logger.error('Error happened while uploading a part. Cancelling the multipart upload');
      throw error;
    }
  }

  private async finishMultiPartUpload(uploadId: string) {
    const input: CompleteMultipartUploadCommandInput = {
      Bucket: this.params.Bucket,
      Key: this.params.Key,
      UploadId: uploadId,
      MultipartUpload: { Parts: this.completedParts },
    };
    const completeUploadCommand = new CompleteMultipartUploadCommand(input);
    try {
      const data = await this.s3client.send(completeUploadCommand);
      return data.Key;
    } catch (error) {
      logger.error('Error happened while finishing the upload.');
      throw error;
    }
  }

  private async cleanup(uploadId: string | undefined) {
    // Reset this's state
    this.body = null;
    this.completedParts = [];
    this.bytesUploaded = 0;
    this.totalBytesToUpload = 0;

    if (!uploadId) {
      // This is a single part upload;
      return;
    }

    const input = {
      Bucket: this.params.Bucket,
      Key: this.params.Key,
      UploadId: uploadId,
    };

    await this.s3client.send(new AbortMultipartUploadCommand(input));

    // verify that all parts are removed.
    const data = await this.s3client.send(new ListPartsCommand(input));

    if (data && data.Parts && data.Parts.length > 0) {
      throw new Error('Multipart upload clean up failed.');
    }
  }

  private removeEventListener(part: Part) {
    part.emitter.removeAllListeners(SEND_UPLOAD_PROGRESS_EVENT);
    part.emitter.removeAllListeners(SEND_DOWNLOAD_PROGRESS_EVENT);
  }

  private setupEventListener(part: Part) {
    part.emitter.on(SEND_UPLOAD_PROGRESS_EVENT, (progress) => {
      this.progressChanged(part.partNumber, progress.loaded - part._lastUploadedBytes);
      part._lastUploadedBytes = progress.loaded;
    });
  }

  private progressChanged(partNumber: number, incrementalUpdate: number) {
    this.bytesUploaded += incrementalUpdate;
    this.emitter.emit(SEND_UPLOAD_PROGRESS_EVENT, {
      loaded: this.bytesUploaded,
      total: this.totalBytesToUpload,
      part: partNumber,
      key: this.params.Key,
    });
  }

  private byteLength(input: any) {
    if (input === null || input === undefined) return 0;
    if (typeof input.byteLength === 'number') {
      return input.byteLength;
    } else if (typeof input.length === 'number') {
      return input.length;
    } else if (typeof input.size === 'number') {
      return input.size;
    } else if (typeof input.path === 'string') {
      /* NodeJs Support
			return require('fs').lstatSync(input.path).size;
			*/
    } else {
      throw new Error('Cannot determine length of ' + input);
    }
  }

  private validateAndSanitizeBody(body: any): any {
    const sanitizedBody = this.isGenericObject(body) ? JSON.stringify(body) : body;
    /* TODO: streams and files for nodejs 
		if (
			typeof body.path === 'string' &&
			require('fs').lstatSync(body.path).size > 0
		) {
			sanitizedBody = body;
		} */
    if (this.byteLength(sanitizedBody) > MAX_OBJECT_SIZE) {
      throw new Error(`File size bigger than S3 Object limit of 5TB, got ${this.totalBytesToUpload} Bytes`);
    }
    return sanitizedBody;
  }

  private isGenericObject(body: any): body is Object {
    if (body !== null && typeof body === 'object') {
      try {
        return !(this.byteLength(body) >= 0);
      } catch (error) {
        // If we cannot determine the length of the body, consider it
        // as a generic object and upload a stringified version of it
        return true;
      }
    }
    return false;
  }

  protected _createNewS3Client(config, emitter?: events.EventEmitter) {
    const s3client = createS3Client(config, emitter);
    s3client.middlewareStack.add(createPrefixMiddleware(this.opts, this.params.Key), prefixMiddlewareOptions);
    s3client.middlewareStack.add(autoAdjustClockskewMiddleware(s3client.config), autoAdjustClockskewMiddlewareOptions);
    return s3client;
  }
}
