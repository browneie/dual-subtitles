#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Node.js is not installed. Get it from https://nodejs.org"; read -n1 -p "Press any key to close"; exit 1; fi
(sleep 1; open "http://127.0.0.1:7000/") &
node server.js
read -n1 -p "Press any key to close"
