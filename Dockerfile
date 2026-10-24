FROM node:22-alpine
RUN apk add --no-cache openssl curl

# Cloud SQL Auth Proxy: gives Prisma a plain TCP endpoint at localhost:5432.
# linux.amd64 matches the architecture Cloud Build produces; a local arm64
# `docker build` needs --platform linux/amd64.
ARG CLOUD_SQL_PROXY_VERSION=v2.14.1
RUN curl -sSLo /cloud-sql-proxy \
      "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/${CLOUD_SQL_PROXY_VERSION}/cloud-sql-proxy.linux.amd64" \
    && chmod +x /cloud-sql-proxy

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Production runs on PostgreSQL; SQLite stays the local-dev datasource. The
# SQLite migrations cannot run on Postgres, so the schema is created by
# `prisma db push` at startup instead.
RUN cp prisma/schema.prod.prisma prisma/schema.prisma \
    && rm -rf prisma/migrations \
    && npx prisma generate

RUN npm run build

CMD ["sh", "start.sh"]
