#!/usr/bin/env bash
# Hosted macOS runners ship with a locked default keychain. keytar's
# SecKeychainAddGenericPassword call would block forever waiting for a
# GUI permission dialog. Create + unlock + default a throwaway
# keychain so keytar can write/read without prompts.
set -euo pipefail

security create-keychain -p '' browserless-ci.keychain
security default-keychain -s browserless-ci.keychain
security unlock-keychain -p '' browserless-ci.keychain
security set-keychain-settings -lut 7200 browserless-ci.keychain
