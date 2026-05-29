#!/bin/bash

set -e
PATH=./node_modules/.bin:$PATH

# //////////////////////////////////////////////////////////////////////////////
# START tasks

start() {
  node dist/index.js
}

dev() {
  echo "Starting development environment with watch mode..."

  set_build_env dev

  rm -rf .dev-harness-cache dist
  mkdir -p .dev-harness-cache

  # NOTE: Use `--watch` to automatically rebuild the project when source files
  # change. The `2>&1` redirects stderr to stdout so that we can capture all
  # output in the same variable.
  vite build --watch > ./.dev-harness-cache/build-output.log 2>&1 &
  BUILD_PID=$!

  sleep 2

  # NOTE: Start the previously build server in watch mode, which will
  # automatically restart the server when the built files change.
  STORAGE_BACKEND=${STORAGE_BACKEND} \
  SRC_DIR=${SRC_DIR} \
  DIST_DIR=${DIST_DIR} \
  node --watch dist/index.js &
  API_PID=$!

  # NOTE: Kill the background processes and clean up the cache directory when
  # the script exits, whether it exits successfully or due to an error.
  cleanup() {
    kill $BUILD_PID 2>/dev/null || true
    kill $API_PID 2>/dev/null || true
    wait $BUILD_PID 2>/dev/null || true
    wait $API_PID 2>/dev/null || true
    rm -rf .dev-harness-cache
  }
  trap cleanup EXIT INT TERM

  # NOTE: Start the development environment with the Vite development server,
  # which will serve our development harness under `tests/e2e` and proxy API
  # requests to our local server.
  VITE_DEV_HARNESS=true vite
}

build() {
  echo "Building..."

  rm -rf dist
  vite build $*
}

format() {
  echo "Running oxfmt..."

  oxfmt --write ./src ./tests ./vite.config.ts $*
}

lint() {
  echo "Running oxlint..."
  # NOTE: Use --fix to auto-fix linting errors
  oxlint ./src ./tests $*
}

typecheck() {
  echo "Running tsc..."
  tsc --noEmit
}

test() {
  if [ "$1" = "-w" ] || [ "$1" = "--watch" ]; then
    echo "Running vitest in watch mode..."
    vitest
    return
  else
    echo "Running vitest..."
    vitest run
  fi
}

validate() {
  typecheck
  lint $*
  test $*
}

clean() {
  rm -rf node_modules dist .vite $*
}

set_build_env() {
  # NOTE: Centralize defaults here so dev, local Docker builds, and deploys
  # resolve the same package metadata while still allowing mode-specific
  # overrides.
  BUILD_ENV=${1:-deploy}

  BUILD_NAME=$(node -p "require('./package.json').name")
  BUILD_VERSION=$(node -p "require('./package.json').version")
  BUILD_REGION=europe-west3
  BUILD_PROJECT=replace-me
  BUILD_REPOSITORY=docker
  BUILD_IMAGE=${BUILD_REGION}-docker.pkg.dev/${BUILD_PROJECT}/${BUILD_REPOSITORY}/${BUILD_NAME}:${BUILD_VERSION}
  BUILD_MEMORY=${BUILD_MEMORY:-512MB}
  BUILD_INSTANCES=${BUILD_INSTANCES:-10}
  STORAGE_BACKEND=${STORAGE_BACKEND:-}
  SRC_DIR=${SRC_DIR:-}
  DIST_DIR=${DIST_DIR:-}
  FILE_DIR=${FILE_DIR:-}

  case "${BUILD_ENV}" in
  dev)
    # NOTE: The local harness reads fixtures from `tests` and writes generated
    # files into the temporary cache directory.
    STORAGE_BACKEND=${STORAGE_BACKEND:-local}
    SRC_DIR=${SRC_DIR:-./tests}
    DIST_DIR=${DIST_DIR:-./.dev-harness-cache}
    ;;
  deploy)
    ;;
  *)
    ;;
  esac
}

deploy() {
  build

  set_build_env

  # NOTE: Publish the version-tagged image first, then deploy that exact image
  # to Cloud Run so the running revision matches the package version.
  gcloud builds submit --tag ${BUILD_IMAGE}
  gcloud run deploy ${BUILD_NAME} \
    --region=${BUILD_REGION} \
    --project=${BUILD_PROJECT} \
    --image=${BUILD_IMAGE} \
    --port=8080 \
    --memory=${BUILD_MEMORY} \
    --max-instances=${BUILD_INSTANCES} \
    --allow-unauthenticated \
    --set-env-vars SRC_DIR=${SRC_DIR},DIST_DIR=${DIST_DIR},FILE_DIR=${FILE_DIR}
}

docker-build() {
  build

  set_build_env

  # NOTE: Mirror the deploy image tag locally so Docker builds match Cloud Run
  # tags.
  docker build -t ${BUILD_IMAGE} .
}

help() {
  set_build_env deploy

  # NOTE: Show the resolved defaults so operators can confirm what `deploy` will
  # use before building or publishing an image.
  echo "Available tasks:"
  echo "  start           Start the server"
  echo "  dev             Start the development environment with watch mode"
  echo "  build           Build the project"
  echo "  format          Format code using oxfmt"
  echo "  lint            Lint code using oxlint"
  echo "  typecheck       Type check using tsc"
  echo "  test            Run tests using vitest (pass -w for watch mode)"
  echo "  validate        Run typecheck, lint, and tests"
  echo "  clean           Clean build artifacts and logs"
  echo "  deploy          Build, tag, and deploy the package version to Cloud Run"
  echo "  docker-build    Build the package version-tagged Docker image locally"
  echo "  help            Show this help message"
  echo ""
  echo "Package metadata:"
  echo "  name            ${BUILD_NAME}"
  echo "  version         ${BUILD_VERSION}"
  echo ""
  echo "Default deploy image:"
  echo "  ${BUILD_IMAGE}"
  echo ""
  echo "Default deploy config:"
  echo "  region          ${BUILD_REGION}"
  echo "  memory          ${BUILD_MEMORY}"
  echo "  max-instances   ${BUILD_INSTANCES}"
}

# END tasks
# //////////////////////////////////////////////////////////////////////////////

${@:-help}
