#!/bin/sh
# Runs once, on an empty data volume (docker-entrypoint-initdb.d): the shop gets its own role that owns its
# database but is not a superuser — no COPY … PROGRAM, no reading server files if the app is ever compromised.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -v pw="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE mrak8 LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE mrak8 OWNER mrak8;
SQL
