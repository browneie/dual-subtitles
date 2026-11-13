#!/usr/bin/env bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then
  echo "Node.js is not installed. Install it with your package manager (e.g. sudo apt install nodejs) or from https://nodejs.org"
  read -n1 -p "Press any key to close"; exit 1
fi
(sleep 1; xdg-open "http://127.0.0.1:7000/" >/dev/null 2>&1 || echo "Open http://127.0.0.1:7000/ in your browser") &
node server.js
read -n1 -p "Press any key to close"
