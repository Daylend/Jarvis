#!/bin/sh
set -e

# Update the user to match specified UID/GID if provided
if [ -n "$PUID" ] && [ -n "$PGID" ]; then
  echo "Setting up user with UID:GID as $PUID:$PGID"
  groupmod -o -g "$PGID" node
  usermod -o -u "$PUID" node
fi

# Fix owner of application directory and data directories
chown -R node:node /app/dist
chown -R node:node /app/node_modules

# Ensure data directory can be written to
if [ ! -w "/app/data" ]; then
  echo "Warning: /app/data is not writable, attempting to fix permissions"
  mkdir -p /app/data
  chmod -R 777 /app/data
fi

# Ensure logs directory can be written to
if [ ! -w "/app/logs" ]; then
  echo "Warning: /app/logs is not writable, attempting to fix permissions"
  mkdir -p /app/logs
  chmod -R 777 /app/logs
fi

# Set SQLite permissions explicitly
if [ -f "/app/data/database.sqlite" ]; then
  echo "Fixing permissions on existing database file"
  chmod 666 /app/data/database.sqlite
else
  echo "Database file does not exist yet, will be created on first run"
  # Ensure parent directory is writable
  chmod 777 /app/data
fi

# Display logs directory
echo "Logs will be written to $(ls -la /app/logs)"

# Run as node user
echo "Running database setup and starting application as $(id)"
su-exec node npx prisma migrate deploy
su-exec node node dist/deploy-commands.js
exec su-exec node node dist/index.js