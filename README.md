# AWS Amplify S3 upload
A custom storage upload plugin for AWS Amplify. Instead of reading file completely in memory, it helps to read file chunk by chunk.
---
Currently while using Amplify library to upload a to AWS S3 we have to read that file into memory and which could cause OutOfMemory issues while uploading large files in ReactNative. There is no support to read the file in small chunks.

The Amplify Storage plugin supports Managed upload. It will divide the file into small chunks and upload them in batches.

The Amplify library supports custom plugins, using which we can connect with services other than AWS or add a wrapper to AWS services.

To support the uploading of large files using Amplify, I have used the same mechanism as a custom plugin.

NPM Library [amplify-s3-chunk-upload](https://www.npmjs.com/package/amplify-s3-chunk-upload)

---
## Usage
### Install
```
npm i -s amplify-s3-chunk-upload
```

### Configure Storage plugin in App.js (ReactNative)
```js
import { StorageChunkUpload } from 'amplify-s3-chunk-upload';
import { Credentials } from '@aws-amplify/core';



// put following code after Amplify.configure

// Load StorageChunkUpload Plugin
const storagePlugin = new StorageChunkUpload({}, Credentials);
Storage.addPluggable(storagePlugin);
storagePlugin.configure(config);

```

### File upload call
```js

// get File stats
const { size } = await RNFS.stat(fileURI);

// here we are simulating an array of bytes
const fileObject = {
  // set the size
  size: size,

  // here we will read file as per bodyStart & bodyEnd, this will avoid reading complete file in the memory.
  slice: (bodyStart, bodyEnd) => {
    // Here in this sample code, we are using react-native-fs to read files.
    return RNFS.read(fileURI, bodyEnd - bodyStart, bodyStart, 'base64')
      .then((data) => Buffer.from(data, 'base64'))
      .catch((error) => {
        // Log error if required.
      });
    },
  };

  // Upload call, for parameters, refer to Amplify docs.
  const result = await Storage.put(`Your-file-name.mp4`, fileObject, {
    contentType: 'video/mp4',
    level: 'protected',
    provider: 'StorageChunkUpload',
  });


```

Since we are making standard `Storage.put` call and the underlying code also uses the same Amplify Library code, you can pass all other parameters such as `progressCallback` etc.