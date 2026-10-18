# Chat FreePT v0.8.6 — compiled development build

This directory contains the installable v0.8.6 Chrome extension archive tested in browser fixtures.

- Archive: `chat-freept-v0.8.6-storage-context-fix.zip`
- SHA-256: `0da7a6fe9a0359fec06c42cf06b11e252b44d28785f37bfa0c906ae5987de01a`
- Git blob SHA-1: `3ae7e7ba241db9565100d040cf598aa99112e913`
- Chrome Manifest V3; unzip and load the extracted directory at `chrome://extensions` → **Load unpacked**.

**Important provenance:** This artifact was produced from the separately iterated v0.8.x compiled extension, not by the TypeScript source currently on `dev` (which still identifies as v0.6.2). The accompanying source PR ports the v0.8.6 storage-context crash fix only. Do **not** regard the ZIP as a CI-built release from this repository, claim source parity, or publish it to production until the intervening v0.7.x and v0.8.x features have been ported and tested.

Browser fixture tests passed for the storage fallback, launcher mounting, and reply recovery. Live authenticated Chrome and GitHub Actions verification of this exact ZIP remain outstanding.
