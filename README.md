# Qdrant Sync

Sync your Obsidian vault across devices using a self-hosted Qdrant instance instead of Obsidian Sync, iCloud, or a CouchDB setup. Every note also gets embedded, so the same collection doubles as a semantic search index you can query from outside Obsidian.

## What you need

- A Qdrant instance that's reachable from every device you want to sync (a VPS, a home server behind a reverse proxy/tunnel, whatever - it just needs a public URL and API key auth turned on).
- An embedding server that speaks the llama.cpp `/embedding` endpoint, also reachable from every device. Point it at any embedding model you like; 768-dim models are the default assumption but you can change the collection's vector size to match whatever you run.
- A collection created in Qdrant ahead of time, sized to your embedding model's output dimension, cosine distance.

Obsidian Sync, CouchDB, Syncthing - none of that is needed. This plugin talks to Qdrant directly over HTTP or HTTPS from inside Obsidian, so it works on desktop and mobile.

## Install

Search for "Qdrant Sync" in Obsidian's community plugins browser and install it from there.

Alternatively, install manually:

1. Download `main.js` and `manifest.json` from the latest release.
2. Drop them into `<your vault>/.obsidian/plugins/qdrant-sync/`.
3. Enable community plugins in Obsidian, then enable "Qdrant Sync".

## Setup

Open the plugin settings and fill in:

- **Qdrant URL** - your Qdrant instance's address.
- **Qdrant API key** - whatever you set `QDRANT__SERVICE__API_KEY` to on the server.
- **Embedding server URL** - your llama.cpp embedding server's address.
- **Collection name** - defaults to `obsidian_notes`.

Do this on every device you want synced, pointing at the same Qdrant instance and collection. First sync on a new device, run the "Pull changes from Qdrant now" command to pull everything down.

## How sync works, briefly

Last-write-wins by modification time. No conflict resolution beyond that, so if you edit the same note offline on two devices at once, whichever save lands later wins. Fine for a single person across a few devices; not built for real-time collaborative editing.

## License

MIT
