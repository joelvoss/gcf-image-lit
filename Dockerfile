FROM node:24-bookworm-slim AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN ./Taskfile.sh build

FROM gcr.io/distroless/nodejs24-debian13:nonroot

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

CMD ["dist/index.js"]
