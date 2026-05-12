#!/bin/sh
set -e

# Download the model if it doesn't exist yet
/app/scripts/download-model.sh

# Start the FastAPI server
exec uvicorn app.main:app --host 0.0.0.0 --port 8765 --workers 1
