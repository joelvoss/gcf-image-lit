# gcf-image-lit

Automatically optimize images stored in Cloud Storage that are requested
through this Cloud Function.

For optimal performance, put the Cloud Function behind a CDN for an extra
layer of caching on top of the basic `max-age` caching.

## Requirements

- Node v16+
- gcloud SDK

## Development

(1) Install dependencies

```bash
$ npm i
# or
$ yarn
```

(2) Run initial validation

```bash
$ ./Taskfile.sh validate
```

(3) Test your function locally using the
[`@google-cloud/functions-framework`][functions-framework].

```bash
$ ./Taskfile.sh dev
```

> See [`./Taskfile.sh`](./Taskfile.sh) for more tasks to help you develop.

## Environment variables

| Variable Name | Required | Description                                                               |
| ------------- | -------- | ------------------------------------------------------------------------- |
| SRC_DIR       | ✅       | Cloud Storage source directory from where the original images are fetched |
| DIST_DIR      | ✅       | Cloud Storage destination directory where the optimized images are stored |
| FILE_DIR      |          | Directory prefix for files written to Cloud Storage                       |

## Deployment

(1) Authenticate with GCP

```bash
$ gcloud auth login
```

(2) Build and deploy

```bash
$ ./Taskfile.sh build

$ gcloud functions deploy ${BUILD_NAME} \
    --region=${BUILD_REGION} \
    --project=${BUILD_PROJECT} \
    --trigger-http \
    --runtime=nodejs12 \
    --entry-point=handler \
    --memory=${BUILD_MEMORY} \
    --max-instances=${BUILD_INSTANCES} \
    --set-env-vars SRC_DIR=${SRC_DIR},DIST_DIR=${DIST_DIR},FILE_DIR=${FILE_DIR}
```

> See [the official documentation][gcloud-deploy] for all available options.

---

_This project was set up by @jvdx/core_

[functions-framework]: https://github.com/GoogleCloudPlatform/functions-framework-nodejs
[gcloud-deploy]: https://cloud.google.com/sdk/gcloud/reference/functions/deploy
