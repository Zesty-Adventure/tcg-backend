import express from "express";
import fs from "fs";
import cors from "cors";
import bodyParser from "body-parser";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ------------------------------
// ENV VARS (Railway)
// ------------------------------
const EXTENSION_ID = process.env.EXTENSION_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const EXTENSION_SECRET = process.env.EXTENSION_SECRET;

if (!EXTENSION_ID || !CLIENT_ID || !EXTENSION_SECRET) {
  console.error("❌ Missing required environment variables.");
  console.error("Required: EXTENSION_ID, CLIENT_ID, EXTENSION_SECRET");
  process.exit(1);
}

// ------------------------------
// DATA FILE
// ------------------------------

const DATA_FILE = "data.json";

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ config: null, viewers: {} }, null, 2)
    );
  }
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ------------------------------
// RIP WINDOW MEMORY
// ------------------------------

let ripWindowOpen = false;
let ripParticipants = new Set();
let ripWindowEndsAt = null;

// ------------------------------
// PACK RIP HELPERS
// ------------------------------

function getWeightedRarity(rarities, cardsByRarity) {
  const valid = rarities.filter((rarity) => {
    const bucket = cardsByRarity[rarity.name] || [];
    return bucket.length > 0;
  });

  if (valid.length === 0) return null;
  const N = valid.length;

  const weightedList = valid.map((rarity, i) => {
    const rank = i + 1;
    return { rarity, weight: (N - rank + 1) ** 2 };
  });

  const totalWeight = weightedList.reduce((sum, w) => sum + w.weight, 0);
  const roll = Math.random() * totalWeight;

  let cumulative = 0;
  for (const w of weightedList) {
    cumulative += w.weight;
    if (roll <= cumulative) return w.rarity;
  }
  return weightedList[weightedList.length - 1].rarity;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ------------------------------
// TRUE RIP-CARD LOGIC (reusable)
// ------------------------------

function performRipCard(channelId, viewerId) {
  const data = loadData();
  const config = data.config;

  if (!config || !config.collections || !config.collections.length) {
    throw new Error("No collections found in config");
  }

  const defaultId = config.defaultCollectionId;
  const streamerCollection = config.collections.find(
    (col) => col.id === defaultId
  );

  if (!streamerCollection) {
    throw new Error("Default collection not found in config");
  }

  const streamerCards = streamerCollection.cards || [];
  const rarities = streamerCollection.rarities || [];

  if (!rarities.length) {
    throw new Error("No rarities defined");
  }

  const cardsByRarity = {};
  streamerCards.forEach((card) => {
    if (!cardsByRarity[card.rarity]) cardsByRarity[card.rarity] = [];
    cardsByRarity[card.rarity].push(card);
  });

  const selected = getWeightedRarity(rarities, cardsByRarity);

  if (!selected) {
    throw new Error("No available cards for any rarity");
  }

  const rarityName = selected.name;
  const cardPool = cardsByRarity[rarityName];
  const selectedCard = pickRandom(cardPool);

  if (!data.viewers[channelId]) data.viewers[channelId] = {};
  if (!data.viewers[channelId][viewerId])
    data.viewers[channelId][viewerId] = { cards: [], totalValue: 0 };

  data.viewers[channelId][viewerId].cards.push(selectedCard);

  let total = 0;
  data.viewers[channelId][viewerId].cards.forEach((c) => {
    const price = parseFloat(c.price || 0);
    if (!isNaN(price)) total += price;
  });
  data.viewers[channelId][viewerId].totalValue = total;

  saveData(data);

  return { rarity: rarityName, card: selectedCard };
}

// ------------------------------
// TWITCH PUBSUB BROADCAST
// ------------------------------

function makeJwt(channelId) {
  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  const payload = {
    exp: Math.floor(Date.now() / 1000) + 60,
    user_id: channelId,
    channel_id: channelId,
    role: "external",
    pubsub_perms: {
      send: ["broadcast"],
    },
  };

  const encode = (data) =>
    Buffer.from(JSON.stringify(data)).toString("base64url");

  const unsigned = encode(header) + "." + encode(payload);

  const signature = crypto
    .createHmac("sha256", Buffer.from(EXTENSION_SECRET, "base64"))
    .update(unsigned)
    .digest("base64url");

  return `${unsigned}.${signature}`;
}

async function sendPubSub(channelId, message) {
  const token = makeJwt(channelId);

  await fetch(
    `https://api.twitch.tv/extensions/message/${channelId}`,
    {
      method: "POST",
      headers: {
        "Client-Id": CLIENT_ID,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content_type: "application/json",
        message: JSON.stringify(message),
        targets: ["broadcast"],
      }),
    }
  );
}

// ------------------------------
// ROUTES
// ------------------------------

app.get("/", (req, res) => {
  res.json({ status: "Backend running!" });
});

// ------------------------------
// SYNC CONFIG
// ------------------------------

app.post("/sync-config", (req, res) => {
  const incomingConfig = req.body;
  const data = loadData();

  data.config = incomingConfig;
  saveData(data);

  res.json({ ok: true });
});

// ------------------------------
// OPEN RIP WINDOW
// ------------------------------

app.post("/start-rip-window", (req, res) => {
  const { durationSeconds } = req.body;

  ripWindowOpen = true;
  ripParticipants = new Set();
  ripWindowEndsAt = Date.now() + durationSeconds * 1000;

  res.json({
    success: true,
    message: "Rip window opened",
    closesAt: ripWindowEndsAt,
  });
});

// ------------------------------
// VIEWER "!rip"
// ------------------------------

app.post("/submit-rip", (req, res) => {
  const { viewerId } = req.body;

  if (!ripWindowOpen) {
    return res.json({
      success: false,
      message: "No rip window open.",
    });
  }

  ripParticipants.add(viewerId);

  res.json({
    success: true,
    message: "Viewer added to rip list.",
  });
});

// ------------------------------
// CLOSE RIP WINDOW & AWARD PACKS
// ------------------------------

app.post("/resolve-rip-window", async (req, res) => {
  const { channelId } = req.body;

  if (!ripWindowOpen) {
    return res.json({
      success: false,
      message: "No rip window open.",
    });
  }

  ripWindowOpen = false;

  const winners = [];

  for (const viewerId of ripParticipants) {
    try {
      const result = performRipCard(channelId, viewerId);

      // 🔥 NEW — Broadcast to extension
      await sendPubSub(channelId, {
        type: "rip-result",
        viewerId,
        rarity: result.rarity,
        card: result.card,
      });

      winners.push({
        viewerId,
        rarity: result.rarity,
        card: result.card,
      });
    } catch (err) {
      console.error("Error awarding pack:", err);
    }
  }

  ripParticipants.clear();

  res.json({
    success: true,
    winners,
  });
});

// ------------------------------
// PUBLIC /rip-card
// ------------------------------

app.post("/rip-card", async (req, res) => {
  try {
    const { channelId, viewerId } = req.body;
    const result = performRipCard(channelId, viewerId);

    // 🔥 NEW — Broadcast
    await sendPubSub(channelId, {
      type: "rip-result",
      viewerId,
      rarity: result.rarity,
      card: result.card,
    });

    res.json({
      success: true,
      rarity: result.rarity,
      card: result.card,
    });
  } catch (err) {
    console.error("RIP CARD ERROR:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ------------------------------
// START SERVER
// ------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running at http://localhost:" + PORT);
});
