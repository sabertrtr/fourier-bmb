const fs = require("fs");
const yaml = require("js-yaml");
const axios = require("axios");
const { Cli, AppServiceRegistration, Bridge } = require("matrix-appservice-bridge");
const { DanbooruClient } = require("./danbooru");
const invites = require("./invites");

const config = yaml.load(fs.readFileSync(require("path").join(__dirname, "config.yaml"), "utf8"));
const danbooru = new DanbooruClient(config.danbooru);

// Load the appservice token from the registration file for authenticated
// media downloads from Synapse.
const _reg = yaml.load(fs.readFileSync(require("path").join(__dirname, "bmb-registration.yaml"), "utf8"));
const AS_TOKEN = _reg.as_token;

const TAG_STATE_TYPE = "net.41chan.media.tags";

// Per-admin pending avatar requests: userId -> expiry epoch ms.
const avatarPending = new Map();
const AVATAR_PENDING_MS = 2 * 60 * 1000;

// Count joined members in a room (used to detect DMs = 2 members).
async function joinedMemberCount(bridge, roomId) {
  try {
    const state = await bridge.getIntent().roomState(roomId);
    return state.filter(
      (e) => e.type === "m.room.member" && e.content.membership === "join"
    ).length;
  } catch (e) {
    return -1; // unknown
  }
}

// True only if the bot user is currently joined to the room. Used to skip
// events from rooms the bot isn't in (e.g. backlog from a previously over-broad
// appservice namespace), so the appservice transaction is ACKed and the stream
// drains instead of wedging on an un-actionable foreign-room event.
async function botIsJoined(bridge, roomId, botUserId) {
  try {
    const state = await bridge.getIntent().roomState(roomId);
    return state.some(
      (e) =>
        e.type === "m.room.member" &&
        e.state_key === botUserId &&
        e.content.membership === "join"
    );
  } catch (e) {
    return false; // can't read state => not a member
  }
}

function isRoomDisabled(roomId) {
  return (config.bridge.disabled_rooms || []).includes(roomId);
}

async function downloadFromSynapse(mxcUrl, asToken) {
  const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid mxc URL: ${mxcUrl}`);
  const [, serverName, mediaId] = match;
  const url = `${config.homeserver.url}/_matrix/client/v1/media/download/${serverName}/${mediaId}`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${asToken}` },
    responseType: "arraybuffer",
    timeout: 30000,
  });
  return {
    buffer: Buffer.from(resp.data),
    contentType: resp.headers["content-type"] || "application/octet-stream",
  };
}

async function handleImageEvent(bridge, event) {
  const roomId = event.room_id;
  const mxcUrl = event.content && event.content.url;
  if (!mxcUrl) return;
  if (isRoomDisabled(roomId)) {
    console.log(`[skip] tagging disabled for room ${roomId}`);
    return;
  }
  console.log(`[image] ${mxcUrl} in ${roomId}`);

  const asToken = AS_TOKEN;
  const { buffer, contentType } = await downloadFromSynapse(mxcUrl, asToken);
  const filename =
    (event.content && event.content.body) || mxcUrl.split("/").pop() || "image";

  const upload = await danbooru.createUploadFromBytes(buffer, filename, contentType);
  const completed = await danbooru.waitForUpload(upload.id);
  const uma = completed.upload_media_assets && completed.upload_media_assets[0];
  const uploadMediaAssetId = uma && uma.id;
  if (!uploadMediaAssetId) throw new Error(`No upload media asset produced for upload ${upload.id}`);

  const post = await danbooru.createPost(uploadMediaAssetId, {
    rating: config.bridge.default_rating,
    source: mxcUrl,
  });
  const fullPost = await danbooru.getPost(post.id);
  const tagString = fullPost.tag_string || "";

  const intent = bridge.getIntent();
  await intent.sendStateEvent(roomId, TAG_STATE_TYPE, mxcUrl, {
    post_id: post.id,
    tags: tagString.split(/\s+/).filter(Boolean),
    rating: config.bridge.default_rating,
    updated_by: "bmb",
    updated_at: Date.now(),
  });
  console.log(`[done] post #${post.id} tagged: ${tagString}`);
}

// Build the deps object handleInvite needs, backed by a bot Intent.
function inviteDeps(bridge) {
  const intent = bridge.getIntent();
  return {
    join: (roomId) => intent.join(roomId),
    leave: (roomId) => intent.leave(roomId),
    readPowerLevels: (roomId) =>
      intent.getStateEvent(roomId, "m.room.power_levels", ""),
    sendDM: async (userId, text) => {
      // Create (or reuse) a direct room with the user, then send.
      const room = await intent.createRoom({
        createAsClient: true,
        options: {
          preset: "trusted_private_chat",
          invite: [userId],
          is_direct: true,
        },
      });
      const roomId = room.room_id || room.roomId;
      await intent.sendText(roomId, text);
    },
  };
}

// Handle the !resetstrikes admin command. DM-only: requires sender in the
// admin list AND a two-member room (bot + admin).
async function handleResetCommand(bridge, event) {
  const body = event.content && event.content.body;
  if (!body || !body.startsWith("!resetstrikes")) return false;

  const sender = event.sender;
  if (!(config.bridge.strike_reset_admins || []).includes(sender)) {
    invites.audit({ kind: "reset_denied_not_admin", sender });
    return true;
  }

  const intent = bridge.getIntent();
  // Confirm this is a DM: exactly two members.
  let memberCount = 0;
  try {
    const state = await intent.roomState(event.room_id);
    memberCount = state.filter(
      (e) => e.type === "m.room.member" && e.content.membership === "join"
    ).length;
  } catch (e) {
    memberCount = 0;
  }
  if (memberCount !== 2) {
    invites.audit({ kind: "reset_denied_not_dm", sender, room: event.room_id });
    return true;
  }

  const target = body.split(/\s+/)[1];
  if (!target) {
    await intent.sendText(event.room_id, "Usage: !resetstrikes @user:domain");
    return true;
  }

  const state = invites.loadStrikes();
  const had = state[target] ? state[target].strikes : 0;
  delete state[target];
  invites.saveStrikes(state);
  invites.audit({ kind: "strikes_reset", admin: sender, target, cleared: had });
  await intent.sendText(
    event.room_id,
    `Cleared ${had} strike${had === 1 ? "" : "s"} for ${target}.`
  );
  return true;
}

// Handle avatar-setting flow in a DM from an admin.
// Returns true if the event was consumed by this handler.
async function handleAvatarFlow(bridge, event) {
  const sender = event.sender;
  const roomId = event.room_id;
  const isAdmin = (config.bridge.strike_reset_admins || []).includes(sender);
  if (!isAdmin) return false;

  const intent = bridge.getIntent();
  const content = event.content || {};

  // The !setavatar command (text message)
  if (content.msgtype === "m.text" && content.body && content.body.trim() === "!setavatar") {
    if ((await joinedMemberCount(bridge, roomId)) !== 2) return false; // DM only
    avatarPending.set(sender, Date.now() + AVATAR_PENDING_MS);
    await intent.sendText(roomId, "Send me an image and I'll use it as my avatar (within 2 minutes).");
    return true;
  }

  // A following image, if this admin has a live pending request in a DM
  if (content.msgtype === "m.image") {
    const expiry = avatarPending.get(sender);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      avatarPending.delete(sender);
      return false;
    }
    if ((await joinedMemberCount(bridge, roomId)) !== 2) return false;
    const mxc = content.url;
    if (!mxc) return false;
    avatarPending.delete(sender);
    try {
      await intent.setAvatarUrl(mxc);
      await intent.sendText(roomId, "Avatar updated.");
    } catch (e) {
      await intent.sendText(roomId, "Failed to set avatar: " + e.message);
    }
    return true; // consumed — do not tag
  }

  return false;
}

new Cli({
  registrationPath: "bmb-registration.yaml",
  generateRegistration: function (reg, callback) {
    reg.setId("fourier-bmb");
    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(AppServiceRegistration.generateToken());
    reg.setSenderLocalpart("bmb");
    reg.addRegexPattern("users", "@.*", false);
    callback(reg);
  },
  run: function (port) {
    const bridge = new Bridge({
      homeserverUrl: config.homeserver.url,
      domain: config.homeserver.domain,
      registration: "bmb-registration.yaml",
      controller: {
        onUserQuery: function () {
          return {};
        },
        onEvent: async function (request) {
          const event = request.getData();
          // The robot wanted me to erase this, but I think it's funny, so I'm leaving it here
          const botUserId = `@${config.homeserver.domain ? "bmb" : "bmb"}:${config.homeserver.domain}`;

          try {
            // Invite directed at the bot
            if (
              event.type === "m.room.member" &&
              event.content &&
              event.content.membership === "invite" &&
              event.state_key === botUserId
            ) {
              const verdict = await invites.handleInvite(event, inviteDeps(bridge), config);
              console.log(`[invite] ${event.sender} -> ${event.room_id}: ${verdict}`);
              return;
            }

            // Skip any non-invite event from a room the bot isn't joined to.
            // This ACKs (drains) backlog left over from a previously over-broad
            // appservice namespace, and is correct defense-in-depth: the bridge
            // only ever acts in rooms it was invited into and joined.
            if (!(await botIsJoined(bridge, event.room_id, botUserId))) {
              return;
            }

            if (event.type === "m.room.message" && event.content) {
              // Admin reset command (DM only)
              if (await handleResetCommand(bridge, event)) return;
              // Avatar-setting flow (admin DM) — checked before tagging
              if (await handleAvatarFlow(bridge, event)) return;
              // Image tagging
              if (event.content.msgtype === "m.image") {
                // DM policy: skip tagging in 2-member rooms unless tag_in_dms is on
                if (!config.bridge.tag_in_dms) {
                  const members = await joinedMemberCount(bridge, event.room_id);
                  if (members === 2) {
                    console.log(`[skip] DM tagging disabled, room ${event.room_id}`);
                    return;
                  }
                }
                await handleImageEvent(bridge, event);
              }
            }
          } catch (err) {
            console.error(`[error] onEvent:`, err.message);
          }
        },
      },
    });
    console.log(`fourier-bmb listening on port ${port}`);
    bridge.run(port).then(async () => {
      try {
        await bridge.getIntent().ensureRegistered();
        console.log("[startup] bot user @bmb ensured/registered");
        await bridge.getIntent().setDisplayName("Fourier");
        console.log("[startup] display name set to Fourier");
      } catch (e) {
        console.error("[startup] failed to register bot user:", e.message);
      }
    });
  },
}).run();
