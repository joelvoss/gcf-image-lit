#!/bin/bash

set -e
PATH=./node_modules/.bin:$PATH

# Export environment variables from `.env`
if [ -f .env.local ]
then
  export $(cat .env.local | sed 's/#.*//g' | xargs)
fi

# //////////////////////////////////////////////////////////////////////////////
# START tasks

start() {
  node dist/index.js
}

dev() {
  build

  functions-framework \
    --source=dist \
    --target=handler
}

build() {
  jvdx build --clean --format=cjs --target=node --no-sourcemap $*
}

format() {
  jvdx format $*
}

lint() {
  jvdx lint $*
}

test() {
  jvdx test --testPathPattern=/tests $*
}

validate() {
  lint $*
  test $*
}

clean() {
  jvdx clean $*
}

default() {
  start
}

deploy() {
  build

  gcloud functions deploy ${BUILD_NAME} \
    --region=${BUILD_REGION} \
    --project=${BUILD_PROJECT} \
    --trigger-http \
    --runtime=nodejs16 \
    --entry-point=handler \
    --memory=${BUILD_MEMORY} \
    --max-instances=${BUILD_INSTANCES} \
    --set-env-vars SRC_DIR=${SRC_DIR},DIST_DIR=${DIST_DIR},FILE_DIR=${FILE_DIR}
}

# END tasks
# //////////////////////////////////////////////////////////////////////////////

${@:-default}
