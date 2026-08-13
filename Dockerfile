# TenantGuard — zero-dependency Node app, so no npm install stage needed.
FROM node:22-alpine
# openssl CLI is only needed for the .pfx certificate import feature
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
