#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Please install Node.js 18 or newer first."
  exit 1
fi

echo "ST-ClaudeCacheGateway-Continued is starting at http://127.0.0.1:8788"
echo "Upstream defaults to https://api.pioneer.ai"
echo
echo "SillyTavern setup:"
echo "  Base URL: http://127.0.0.1:8788/v1"
echo "  API Key:  your upstream API key"
echo
echo "Keep this terminal open while using SillyTavern."
echo

npm start
