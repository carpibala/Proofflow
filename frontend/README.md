# ProofFlow local demo

This is a working first slice of the custom JSON editor and documents/events backend. It is a local demonstration, not a production provenance service.

## Run

Use Node.js 24 or newer. The API uses the built-in `node:sqlite` module, which is still marked experimental by Node. From this directory:

```bash
npm ci
npm run dev -- -p 3001 -H 127.0.0.1
```

Open `http://127.0.0.1:3001/`. Bind to the loopback host as shown because this demo has no authentication. The SQLite database is created at `frontend/data/proofflow.sqlite` and ignored by Git. Keep that directory if you want demo data to survive restarts. A browser draft belongs to its exact origin and document ID; switching ports or worktrees does not transfer the server database.

## API

- `POST /api/documents`: creates a UUID document at version 0.
- `GET /api/documents/:documentId`: reads the current JSON, version, status, and freeze time.
- `POST /api/documents/:documentId/events`: saves a `MANUAL_EDIT` or `PASTE` with full `contentJson` after the action. It checks document ID, schema, unique `operationId`, `baseVersion`, and known source IDs. For paste it replays the claimed insert against the prior document. Event and document update share one SQLite transaction. New AI inserts are rejected; historical rows remain readable.
- `GET /api/documents/:documentId/events`: returns ordered saved events with SHA-256 `previousHash` and `eventHash` fields.
- `GET /api/documents/:documentId/verify`: checks the saved event chain, event metadata, versions, and current document against the last event. Returns `valid`, `checkedEvents`, `headHash`, and a failure code/message when invalid.
- `POST /api/documents/:documentId/finalize`: `{ "expectedVersion": 4, "title": "Final title" }` freezes the current version, title, final content hash, event count and head hash in one transaction. A stale version fails with `409`; a repeat returns the same manifest.
- `GET /api/documents/:documentId/bundle`: downloads JSON only after a valid freeze. It rechecks the frozen evidence before export. The package contains `formatVersion`, `kind`, `manifest`, `contentJson`, and every versioned event. It has no signature or public key.

The editor stores `doc > paragraph > text` JSON, generates operation UUIDs, preserves existing source spans on subsequent edits, saves events in FIFO order, and exports a JSON draft. The page offers manual editing and paste, with no bold or AI assistant controls; earlier `AI_INSERT` events remain readable. Its Chinese/English UI preference is stored in this browser and does not translate document content. The **Records** tab reads server-saved events, shows their attributes, supports search/type filtering, and counts all saved changes and saved `PASTE` events. "Paste count" does not claim to detect clipboard copy actions. **View evidence report** first drains pending saves. In the report, **Freeze final version** makes the editor read-only and enables **Download evidence bundle**.

The report displays saved addition/deletion operation counts, pasted-event count, added/deleted character totals, the event history, and the live internal-chain verification result. A failed check produces a red warning and blocks freezing/export. A replacement can count as both an addition and deletion; character totals use UTF-16 lengths. To check a downloaded package without the server, run `npm run verify:bundle -- path/to/proofflow-evidence-....json`. This verifies internal consistency only; a privileged actor can replace an entire unsigned package.

## Show a broken chain to judges

Register an account first. Set `PROOFFLOW_USERNAME` and `PROOFFLOW_PASSWORD` in the terminal to that account (do not commit credentials). The script logs in as that account; log in as the same user in the browser to open the report. From this `frontend` directory while its local dev server is running, prepare an isolated three-event demo document:

```bash
npm run demo:broken-chain -- prepare http://127.0.0.1:3002
```

Open the printed frozen report URL and show the green verification result, addition/deletion/paste counts, and evidence download. Then run the printed `tamper` command with that document ID, for example:

```bash
npm run demo:broken-chain -- tamper <printed-document-id> http://127.0.0.1:3002
```

Press **Verify again** on the same report page. The second record's `previous_hash` in `frontend/data/proofflow.sqlite` no longer matches the first record, so the report shows a prominent red `BROKEN_EVENT_CHAIN` warning. The command accepts only a matching demo document, confirms verification was green before altering one link, and never edits an existing working document. Use the actual port of this worktree's server. Run `prepare` again for a fresh example. This demonstrates detection of a single-record alteration, not protection against a privileged rewrite of the entire database.

The pure `verifyEvidenceChain(evidence, expectedHeadHash?)` function is exported from `lib/proof-format.ts` and can be called without the database or HTTP API. Supplying a head hash obtained from an independent trusted source also checks that anchor. The API currently checks only its own SQLite data; it does not verify a signature or an external anchor. It cannot prove who performed an action, and a full-chain rewrite can still pass internal verification.

## Verify

```bash
npm test
npm run lint
npm run build
```

With the dev server running on port 3001, also run:

```bash
npm run test:auth
npm run test:integration
npm run test:ui
```

The UI test tries installed Microsoft Edge, Google Chrome, then Playwright Chromium. Run `npx playwright-core install chromium` if none is installed. Set `PROOFFLOW_BROWSER_PATH` to a Chromium executable or `PROOFFLOW_TEST_URL` to another local server if needed. It writes desktop/mobile screenshots under ignored `frontend/data/`, relative to this frontend directory even when the test is launched elsewhere.

## Known limits

- Username/password authentication, server-side sessions, document ownership checks and basic authentication throttling are implemented. See [account setup and migration](../docs/authentication.md). Public hosting additionally requires HTTPS, deployment-level rate limits and backups.
- SQLite is a local file; ephemeral/serverless deployments or multiple replicas will lose or split data. Migrate the same transactional contract to the team's shared database before deployment.
- SHA-256 hashes link stored events, but there is no signed or externally anchored head hash. A database administrator can rewrite the full chain. Browser action labels are claims, not proof of a human author.
- The title is browser-local while drafting and saved to the server during freeze. The editor surface is a plain-text textarea with a separate formatted/source preview, not inline WYSIWYG. Manual typing is grouped on punctuation, newline, blur, or about two seconds of inactivity; long sessions still need size limits.
- Conflict recovery across multiple tabs is not implemented. Certificates, digital signatures, public-key verification, and AI features are outside the agreed scope; external anchoring is absent.

The target cross-team contract is in `../docs/backend-contract.md`. Design references checked on GitHub: [ts-event-sourcing](https://github.com/Brenopms/ts-event-sourcing) for idempotency-before-version-check, and [Tiptap's JSON structure](https://github.com/ueberdosis/tiptap-docs/blob/main/src/content/editor/core-concepts/introduction.mdx) for node/mark terminology. No third-party project code was copied into this editor.

For Windows commands and troubleshooting, see the consolidated [run guide](../docs/前端运行说明.md).
