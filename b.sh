#!/usr/bin/env bash
# Package and install the Org Everywhere VS Code extension.
set -euo pipefail
cd "$(dirname "$0")"

npx vsce package
VERSION=$(node -p 'require("./package.json").version')
code --install-extension "vscode-org-everywhere-$VERSION.vsix" --force
