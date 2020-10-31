# AWS Amplify S3 upload
A custom storage upload plugin for AWS Amplify. Instead of reading file completely in memory, it helps to read file chunk by chunk.
---
The problem with the current Amplify library is that for ReactNative, we have to read the file into blob and which could cause OutOfMemory issue for large files.

Once the complete file is read in Blob, AWSS3Storage plugin in Amplify will choose to use *Managed upload* in case file size is large than 5mb.

Here in the plugin, I have tried to have lazy ready operation when actual upload part is created.

## Usage

Install
```
npm i -s amplify-s3-chunk-upload
```

Configure Storage plugin in App.js (ReactNative)
```js
import { StorageChunkUpload } from 'amplify-s3-chunk-upload';
import { Credentials } from '@aws-amplify/core';



// put following code after Amplify.configure

// Load StorageChunkUpload Plugin
const storagePlugin = new StorageChunkUpload({}, Credentials);
Storage.addPluggable(storagePlugin);
storagePlugin.configure(config);

```

File upload call
```js

// get File stats
const { size } = await RNFS.stat(fileURI);

// here we are simulating an array of bytes
const fileObject = {
  // set the size
  size: size,

  // here we will read file as per bodyStart & bodyEnd, this will avoid reading complete file in the memory.
  slice: (bodyStart, bodyEnd) => {
    // Here in this sample code we are using react-native-fs to read file.
    return RNFS.read(fileURI, bodyEnd - bodyStart, bodyStart, 'base64')
      .then((data) => Buffer.from(data, 'base64'))
      .catch((error) => {
        // Log error if required.
      });
    },
  };

  // Uplad call, for parameters refer to Amplify docs.
  const result = await Storage.put(`Your-file-name.mp4`, fileObject, {
    contentType: 'video/mp4',
    level: 'protected',
    provider: 'StorageChunkUpload',
  });


```