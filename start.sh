#!/bin/sh
# Cloud Run entrypoint.
#
# The Cloud SQL Auth Proxy gives Prisma a plain TCP endpoint at localhost:5432
# inside the container, so DATABASE_URL needs no Unix-socket special casing.
set -e

/cloud-sql-proxy --port 5432 "$INSTANCE_CONNECTION_NAME" &
sleep 3

npm run setup:prod
exec npm run start
