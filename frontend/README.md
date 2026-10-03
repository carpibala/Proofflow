# ProofFlow local demo

This is a working first slice of the custom JSON editor and documents/events backend. It is a local demonstration, not a production provenance service.

## Run

Use Node.js 24 or newer. The API uses the built-in `node:sqlite` module, which is still marked experimental by Node. From this directory:

```bash
npm ci
npm run dev -- -p 3001 -H 127.0.0.1
```

Open `http://localhost:3001`. Bind to the loopback host as shown because this demo has no authentication. The SQLite database is created at `frontend/data/proofflow.sqlite` and ignored by Git. Keep that directory if you want demo data to survive restarts.

## API

- `POST /api/documents`: creates a UUID document at version 0 and a server-recorded demo AI response.
- `GET /api/documents/:documentId`: reads the current JSON, version, and demo AI response.
- `POST /api/documents/:documentId/events`: saves a `MANUAL_EDIT`, `PASTE`, or `AI_INSERT` with full `contentJson` after the action. It checks document ID, schema, unique `operationId`, `baseVersion`, and known source IDs. For paste/AI insertion it replays the claimed insert against the prior document. Event and document update share one SQLite transaction.
- `GET /api/documents/:documentId/events`: returns ordered saved events with SHA-256 `previousHash` and `eventHash` fields.

The editor stores `doc > paragraph > text` JSON, generates operation UUIDs, preserves bold/source spans on subsequent edits, saves events in FIFO order, and exports a JSON draft. The AI panel is a **canned example**, not an LLM call. The certificate button is disabled until a real Finalize, signature, and verification flow exists.

## Verify

```bash
npm test
npm run lint
npm run build
```

With the dev server running on port 3001, also run:

```bash
npm run test:integration
npm run test:ui
```

The UI test uses the installed Microsoft Edge by default. Set `PROOFFLOW_BROWSER_PATH` to another Chromium executable or `PROOFFLOW_TEST_URL` to another local server if needed. It writes desktop/mobile screenshots under ignored `frontend/data/`.

## Known limits

- No authentication, ownership checks, rate limiting, or user roles. Anyone who can reach the local server can access any known document ID. Do not deploy this version publicly or store real private work.
- SQLite is a local file; ephemeral/serverless deployments or multiple replicas will lose or split data. Migrate the same transactional contract to the team's shared database before deployment.
- SHA-256 hashes link stored events, but there is no signed or externally anchored head hash. A database administrator can rewrite the full chain. Browser action labels are claims, not proof of a human author.
- The title is currently browser-local after document creation. The editor surface is a plain-text textarea with a separate formatted/source preview, not inline WYSIWYG. Manual typing currently emits one event per input change; long sessions need batching and size limits.
- Conflict recovery across multiple tabs, authentication, finalization, certificate generation, digital signatures, and independent verification are still pending.

The target cross-team contract is in `../docs/backend-contract.md`. Design references checked on GitHub: [ts-event-sourcing](https://github.com/Brenopms/ts-event-sourcing) for idempotency-before-version-check, and [Tiptap's JSON structure](https://github.com/ueberdosis/tiptap-docs/blob/main/src/content/editor/core-concepts/introduction.mdx) for node/mark terminology. No third-party project code was copied into this editor.
