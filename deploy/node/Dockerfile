FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run setup:runtimes && npm run check:platforms && npm run build:node

FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DINGBELL_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./
RUN mkdir /data && chown node:node /data
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/dist/node ./dist/node
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/node/server/server.mjs"]
