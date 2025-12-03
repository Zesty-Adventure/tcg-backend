import tmi from "tmi.js";

// =========================
// CONFIGURE THESE 3 VALUES
// =========================

// 1) Your bot's Twitch username (the account you created)
const BOT_USERNAME = "TCGdisplay";

// 2) Your channel name (where you stream), all lowercase
const CHANNEL_NAME = "zestyadventurebot";

// 3) Your bot token from TwitchTokenGenerator (looks like oauth:xxxx)
//    PASTE YOUR REAL TOKEN BETWEEN THE QUOTES, BUT NEVER SHARE IT PUBLICLY.
const BOT_OAUTH_TOKEN = "oauth:x3bvvjihgngc3zfsfquhczfpk3by7f";

// 4) Your backend URL (for now, local)
const BACKEND_URL = "http://localhost:3000";

// =========================
// INTERNAL STATE
// =========================

let ripWindowActive = false;
let ripParticipants = new Map(); // viewerId -> username

// Create the chat client
const chatClient = new tmi.Client({
  options: { debug: true },
  connection: { reconnect: true, secure: true },
  identity: {
    username: BOT_USERNAME,
    password: BOT_OAUTH_TOKEN
  },
  channels: [ CHANNEL_NAME ]
});

// Connect the bot to Twitch chat
chatClient.connect().catch(console.error);

chatClient.on("connected", (address, port) => {
  console.log(`Bot connected to ${address}:${port} as ${BOT_USERNAME}`);
  console.log(`Joined channel: #${CHANNEL_NAME}`);

  // Start the repeating pack-open cycle
  startRipLoop();
});

// Listen for chat messages
chatClient.on("message", async (channel, userstate, message, self) => {
  if (self) return; // Ignore the bot's own messages

  const username = userstate["display-name"] || userstate["username"];
  const userId = userstate["user-id"];

  console.log(`[CHAT] ${username}: ${message}`);

  // Only react when the rip window is active
  if (!ripWindowActive) return;

  // Check for "!rip" command
  if (message.trim().toLowerCase() === "!rip") {
    if (!userId) return;

    if (ripParticipants.has(userId)) {
      // Already joined this window, ignore duplicates
      return;
    }

    ripParticipants.set(userId, username);
    console.log(`Added ${username} to current rip window.`);
    // Optional: give them feedback in chat
    chatClient.say(
      CHANNEL_NAME,
      `@${username} you're in this pack opening!`
    );
  }
});

// =========================
// RIP WINDOW LOGIC
// =========================

function startRipLoop() {
  // Start the first window immediately
  startRipWindow();

  // Then repeat every 6 minutes
  const SIX_MINUTES = 6 * 60 * 1000;
  setInterval(() => {
    startRipWindow();
  }, SIX_MINUTES);
}

function startRipWindow() {
  ripWindowActive = true;
  ripParticipants = new Map();

  console.log("=== RIP WINDOW OPENED ===");
  chatClient.say(
    CHANNEL_NAME,
    "Time to open a pack! Type !rip in chat within the next 70 seconds!"
  );

  // Close the window after 70 seconds
  const SEVENTY_SECONDS = 70 * 1000;
  setTimeout(async () => {
    ripWindowActive = false;
    console.log("=== RIP WINDOW CLOSED ===");

    if (ripParticipants.size === 0) {
      chatClient.say(
        CHANNEL_NAME,
        "Pack window closed. Nobody ripped a pack this time."
      );
      return;
    }

    // Award cards to everyone who entered
    const winners = [];

    for (const [viewerId, username] of ripParticipants.entries()) {
      try {
        const res = await fetch(`${BACKEND_URL}/rip-card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channelId: CHANNEL_NAME,
            viewerId: viewerId
          })
        });

        const data = await res.json();
        if (data.success) {
          winners.push({
            username,
            rarity: data.rarity,
            card: data.card
          });
          console.log(
            `Awarded ${username} a ${data.rarity} card: ${data.card?.name}`
          );
        } else {
          console.log(`Failed to rip for ${username}:`, data.error);
        }
      } catch (err) {
        console.error(`Error ripping for ${username}:`, err);
      }
    }

    if (winners.length === 0) {
      chatClient.say(
        CHANNEL_NAME,
        "Pack window closed. No packs were successfully opened."
      );
    } else {
      const summary = winners
        .map(w => `${w.username} (${w.rarity})`)
        .join(", ");
      chatClient.say(
        CHANNEL_NAME,
        `Pack window closed! Congratulations: ${summary}`
      );
    }
  }, SEVENTY_SECONDS);
}
