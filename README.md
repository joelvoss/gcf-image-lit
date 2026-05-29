# gcf-image-lit

Automatically optimize images stored in Cloud Storage that are requested
through this Cloud Run service.

For optimal performance, put the Cloud Run service behind a CDN for an extra
layer of caching on top of the basic `max-age` caching.

## Requirements

- Node v24+
- gcloud SDK

## Development

(1) Install dependencies

```bash
$ npm i
```

(2) Run initial validation

```bash
$ ./Taskfile.sh validate
```

Available taskfile commands:

```bash
$ ./Taskfile.sh help
```

The taskfile provides these tasks:

- `./Taskfile.sh start` starts the built service
- `./Taskfile.sh dev` runs the local dev harness and service in watch mode
- `./Taskfile.sh build` builds the project into `dist/`
- `./Taskfile.sh format` formats source and test files with `oxfmt`
- `./Taskfile.sh lint` lints source and test files with `oxlint`
- `./Taskfile.sh typecheck` runs `tsc --noEmit`
- `./Taskfile.sh test` runs the Vitest suite
- `./Taskfile.sh test --watch` or `./Taskfile.sh test -w` runs Vitest in watch mode
- `./Taskfile.sh validate` runs typecheck, lint, and tests
- `./Taskfile.sh clean` removes build artifacts and dependencies
- `./Taskfile.sh deploy` builds and deploys the current package version to Cloud Run
- `./Taskfile.sh docker-build` builds the version-tagged Docker image locally

## Local Dev Harness

Run the local development harness:

```bash
$ ./Taskfile.sh dev
```

Then open `http://127.0.0.1:8787` in a browser.

This runs two local processes:

- the real service on `http://127.0.0.1:8080`
- a Vite harness on `http://127.0.0.1:8787`

The harness serves the demo page, exposes files from `tests/fixtures`, proxies
`/optimize` to the service, and writes optimized output into `./.dev-harness-cache/`.

The service runs with `node --watch`, so server restarts happen automatically
after rebuilds.

The `dev` task uses local defaults from `set_build_env dev`:

- `STORAGE_BACKEND=local`
- `SRC_DIR=./tests`
- `DIST_DIR=./.dev-harness-cache`

## Local Service

Run the Cloud Run service locally from the built artifact:

```bash
$ ./Taskfile.sh build
$ ./Taskfile.sh start
```

The service listens on `http://127.0.0.1:8080` by default and respects `PORT`.

## Environment variables

| Variable Name | Required | Description                                                               |
| ------------- | -------- | ------------------------------------------------------------------------- |
| SRC_DIR       | ✅       | Cloud Storage source directory from where the original images are fetched |
| DIST_DIR      | ✅       | Cloud Storage destination directory where the optimized images are stored |
| FILE_DIR      |          | Directory prefix for files written to Cloud Storage                       |

## Deployment

The deploy and Docker build tasks derive `BUILD_NAME` and `BUILD_VERSION` from
`package.json`. By default, the image URI is derived as:

```text
${BUILD_REGION}-docker.pkg.dev/${BUILD_PROJECT}/${BUILD_REPOSITORY}/${BUILD_NAME}:${BUILD_VERSION}
```

The taskfile uses `set_build_env <build-env>` to resolve shared configuration
for different contexts. The current built-in contexts are `deploy` and `dev`.

Deploy-oriented defaults come from `set_build_env deploy`:

- `BUILD_REGION=europe-west3`
- `BUILD_PROJECT=replace-me`
- `BUILD_REPOSITORY=docker`
- `BUILD_MEMORY=512MB`
- `BUILD_INSTANCES=10`

(1) Authenticate with GCP

```bash
$ gcloud auth login
```

(2) Build a container image and deploy

```bash
$ ./Taskfile.sh deploy
```

Override deploy-time values by exporting environment variables before running
the task:

```bash
$ BUILD_PROJECT=<gcp-project> BUILD_MEMORY=<memory> BUILD_INSTANCES=<count> ./Taskfile.sh deploy
```

To build the image locally with Docker instead:

```bash
$ ./Taskfile.sh docker-build
```

Or manually:

```bash
$ gcloud builds submit --tag ${BUILD_IMAGE}

$ gcloud run deploy ${BUILD_NAME} \
    --region=${BUILD_REGION} \
    --project=${BUILD_PROJECT} \
    --image=${BUILD_IMAGE} \
    --port=8080 \
    --memory=${BUILD_MEMORY} \
    --max-instances=${BUILD_INSTANCES} \
    --allow-unauthenticated \
    --set-env-vars SRC_DIR=${SRC_DIR},DIST_DIR=${DIST_DIR},FILE_DIR=${FILE_DIR}
```

> See [the official documentation][gcloud-deploy] for all available options.

[gcloud-deploy]: https://cloud.google.com/sdk/gcloud/reference/run/deploy
