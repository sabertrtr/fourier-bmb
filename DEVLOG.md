# Fourier — BMB (Booru-Matrix Bridge) Dev Log

**Project:** Fourier (targeted data aggregation, classification, storage)
**Component:** BMB (Booru-Matrix Bridge)
**Location:** /opt/fourier/bmb/  ·  Repo: sabertrtr/fourier-bmb
**Status:** Core pipeline built, deployed, and verified end to end.

---

## 1. What this is

Fourier BMB connects the Matrix homeserver (Synapse, 41chan.net) to the Danbooru instance
so that images posted in Matrix rooms are automatically mirrored into Danbooru, auto-tagged,
and have their tags written back into the Matrix room as a queryable state event. It runs as
a Matrix application service (appservice), not a bot user logging in with a password.

"Fourier" is the umbrella project; "BMB" is the first component. Component-level identifiers
(bmb, the bot user, the container, the Danbooru account) stay named bmb; project-level
concerns (directory root, appservice id, branding) carry the Fourier name.

---

## 2. Final architecture

A user posts an image in a Matrix room. Synapse stores the media (in R2 via the authenticated
media API) and the appservice pushes the event to the bridge. The bridge then:

1. Downloads the image bytes from Synapse (authenticated media endpoint, using the as_token).
2. POSTs the bytes to Danbooru as a multipart upload.
3. Polls the upload until processing completes.
4. Creates a Danbooru post referencing the processed upload_media_asset.
5. Reads the post's tags back.
6. Writes the tags into the room as a state event (net.41chan.media.tags, keyed by MXC URI).

A future custom Matrix client renders and edits those tags.

Key design decisions:

- No duplicate storage by design. The bridge stores the MXC URI as the link between systems.
  Synapse owns the media (in R2); Danbooru is fed a copy for processing/tagging. Permission
  enforcement stays with Synapse's authenticated media API — possessing an MXC URI does not
  grant access to the bytes.
- Authenticated media confirmed on (enable_authenticated_media: true), so the legacy
  unauthenticated media endpoint is not a leak vector for exposed MXC URIs.
- Tags live in Matrix room state (net.41chan.media.tags), keyed by MXC URI, so they are
  mutable, room-scoped, and readable by any authorized client.

---

## 3. Files

All under /opt/fourier/bmb/:

- index.js — Main bridge: appservice setup, event routing, image pipeline, invite routing,
  admin commands, avatar flow.
- danbooru.js — Danbooru API client: multipart byte upload, poll, create post, read/update tags.
- invites.js — Invite authorization: strike state, audit log, Fibonacci timeouts, power-level
  extraction, rejection messages.
- config.yaml — Settings, Danbooru credentials, admin list, power-level thresholds, DM toggle.
- bmb-registration.yaml — Appservice registration (also copied into Synapse's data dir).
- Dockerfile — Node 20 image build.
- docker-compose.yaml — Runs as container bmb on synapse_default and danbooru_default networks.
- strikes.json (runtime) — persistent per-user strike counts.
- audit.log (runtime) — JSONL audit trail of invite decisions.

---

## 4. Invite authorization model

The bot only operates in rooms it is invited to, and self-polices who may invite it.

- Anyone may attempt to invite the bot. The bot reads only the room's m.room.power_levels
  event to decide — nothing else — preserving privacy.
- Required power level to invite: 100 (configurable via invite_power_level).
- Fast path: the bot reads the inviter's power level from the invite's stripped state
  (invite_room_state), which Synapse includes by default, and decides without joining. So
  rejected invites touch no room data at all.
- Fallback: if stripped state lacks power levels, the bot joins, reads power-levels state,
  then leaves if the inviter is under threshold (join-then-verify).
- Race protection: a per-user in-flight lock drops concurrent duplicate invites; the cooldown
  check-and-set is synchronous before any await, so a flood cannot force multiple joins.

### Strike system

- Timeout for strike N = the Nth Fibonacci number, in minutes (1, 1, 2, 3, 5, 8, ...), uncapped.
- Attempts during an active cooldown are ignored (logged, not counted).
- Strikes do not decay. A successful authorized invite clears the active cooldown but preserves
  the strike count, so a chronically-failing user resumes climbing.
- Rejection messages tell the user the current cooldown and the next one, and whether the bot
  "left" (join-then-verify) or "isn't joining" (fast path).
- Admin reset: an admin in strike_reset_admins sends !resetstrikes @user:domain in a DM to the
  bot. DM-only (verified by 2-member room).

All invite decisions are appended to audit.log as JSONL for later abuse analysis.

---

## 5. Tagging pipeline notes

- The bot must be power level 50 in a room to write the net.41chan.media.tags state event
  (Matrix state_default). Current approach: the inviting admin grants the bot PL 50 on invite.
- Auto-created posts use a default rating of q (questionable) — the most conservative sensible
  default for arbitrary uploads; correct later via tag editing.
- Danbooru's autotagger (danbooru-autotagger-1, reachable as autotagger:5000) runs automatically
  during Danbooru's own upload processing — the bridge does not call it directly.
- Posts created by the bmb Danbooru account (Builder level) land as is_pending: true (moderation
  queue). Worth revisiting if auto-approval is desired.

### Danbooru API specifics (this fork)

- Upload is a multipart POST to /uploads.json with field upload[files][0]. Supplying file bytes
  (not a source URL) makes Danbooru process synchronously.
- Post creation: POST /posts.json with upload_media_asset_id at the top level (the
  upload_media_assets[0].id, NOT the media_asset_id), and post: { rating, tag_string, source }
  nested. Getting this wrong returns a 404 (RecordNotFound in PostsController#create).
- rating is mandatory; a post cannot be created without one.

---

## 6. DM handling

- DM tagging is off by default (tag_in_dms: false): images in 2-member rooms are not fed to
  Danbooru. Toggle to true to tag DMs.
- Avatar setting via DM: an admin sends !setavatar in a DM, then posts an image within 2 minutes;
  the bot points its avatar at that image's MXC URI. The pending request expires after 2 minutes.
  Avatar images are never tagged regardless of the DM-tagging toggle. (Element has no reliable
  image-caption field, so the flow is command-then-image.)
- Display name is set to Fourier on startup.

---

## 7. Deployment specifics / gotchas encountered

- Node version: the container runs Node 20, not 24. matrix-appservice-bridge depends on nedb,
  which calls the removed util.isDate and crashes on Node 22+. Node 20 is the practical ceiling
  while that dependency remains.
- Cross-project Docker networking: the bridge is its own compose project but attaches to
  synapse_default and danbooru_default as external networks. container_name: bmb is mandatory so
  Synapse can resolve http://bmb:8009 from the registration.
- MTU: synapse_default uses MTU 1300, danbooru_default uses 1500. The bridge has one interface
  per network and each connection negotiates its own MSS, so the mismatch is benign here.
- Appservice user provisioning: the bot user @bmb had to be explicitly registered via the
  appservice /register endpoint (m.login.application_service with the as_token) before invites
  worked — ensureRegistered() reported success from cache without writing a user row, causing
  profile lookups to 404.
- Image storage permissions: Danbooru's /images bind mount (/mnt/storage/danbooru-images) was
  root-owned; the container runs as uid 1000, so it could not write variant directories. Fixed
  with chown -R 1000:1000. Note uid 1000 on the host is the user's dev account, so that account co-owns the
  directory (benign on a single-admin host).
- Config path inside container: index.js loads config.yaml via path.join(__dirname, ...), not an
  absolute host path, so it resolves to /app inside the container.

---

## 8. Operational reference

Project location: /opt/fourier/bmb

Rebuild + restart the bridge:
  docker compose up -d --build

Follow logs:
  docker compose logs -f --tail 20

Restart Synapse (needed when the registration changes):
  cd /opt/synapse && docker compose restart synapse

- Appservice id: fourier-bmb
- Bot user: @bmb:41chan.net (display name "Fourier")
- Danbooru bot account: bmb (user id 4, Builder level)
- Tag state event type: net.41chan.media.tags (state key = image MXC URI)
- Bridge listens on port 8009 (internal to the Docker networks; not published to host)

---

## 9. What's next / deferred

1. Reverse tag sync (Matrix -> Danbooru). Only the forward path is built. Editing the Matrix
   state event does not yet push back to Danbooru. danbooru.js already has updateTags() with
   old_tag_string concurrency handling ready for this.
2. Tag-edit permissions. Intended model: power level >= 25 may edit tags. Threshold exists in
   config (tag_edit_power_level: 25) but enforcement lives in the not-yet-built Matrix client.
3. Per-room tagging disable flag. disabled_rooms exists in config and is honored, but there is
   no command to manage it yet.
4. is_pending posts. Builder-level uploads queue for moderation. Decide whether the bridge
   account should auto-approve.
5. Secret rotation. The Danbooru API key for bmb appeared in setup history; rotate it once
   convenient.
6. Future Fourier components. The /opt/fourier/<component>/ structure is set up for additional
   components (e.g. fourier-auth, fourier-dmb). Decide whether future components are independent
   appservices or modules within one appservice.

---

Development log for the Fourier BMB build.
