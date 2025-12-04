import express from "express";
import fs from "fs";
import cors from "cors";
import bodyParser from "body-parser";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ------------------------------
// ENV REQUIREMENTS
// ------------------------------

const REQUIRED_ENV = ["EXTENSION_ID", "CLIENT_ID", "EXTENSION_SECRET", "REFRESH_SECRET"];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
  }
}

// ------------------------------
// JWT SIGNING FOR PUBSUB
// ------------------------------

function makeExtensionJwt(channelId) {
  return jwt.sign(
    {
      exp: Math.floor(Date.now() / 1000) + 30,
      user_id: channelId,
      role: "external",
      channel_id: channelId,
      pubsub_perms: {
        send: ["broadcast"]
      }
    },
    process.env.EXTENSION_SECRET,
    { algorithm: "HS256" }
  );
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
// ROUTES
// ------------------------------

app.get("/", (req, res) => {
  res.json({ status: "Backend running!" });
});

// ------------------------------
// /sync-config
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
    closesAt: ripWindowEndsAt
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
      message: "No rip window open."
    });
  }

  ripParticipants.add(viewerId);

  res.json({
    success: true,
    message: "Viewer added to rip list."
  });
});

// ------------------------------
// CLOSE RIP WINDOW & AWARD PACKS
// ------------------------------

app.post("/resolve-rip-window", (req, res) => {
  const { channelId } = req.body;

  if (!ripWindowOpen) {
    return res.json({
      success: false,
      message: "No rip window open."
    });
  }

  ripWindowOpen = false;

  const winners = [];

  for (const viewerId of ripParticipants) {
    try {
      const result = performRipCard(channelId, viewerId);
      winners.push({
        viewerId,
        rarity: result.rarity,
        card: result.card
      });
    } catch (err) {
      console.error("Error awarding pack:", err);
    }
  }

  ripParticipants.clear();

  res.json({
    success: true,
    winners
  });
});

// ------------------------------
// PUBLIC /rip-card ENDPOINT
// ------------------------------

app.post("/rip-card", (req, res) => {
  try {
    const { channelId, viewerId } = req.body;
    const result = performRipCard(channelId, viewerId);

    res.json({
      success: true,
      rarity: result.rarity,
      card: result.card
    });
  } catch (err) {
    console.error("RIP CARD ERROR:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ------------------------------
// NEW: BROADCAST REFRESH ENDPOINT
// ------------------------------

app.post("/broadcast-refresh", async (req, res) => {
  const secret = req.headers["x-refresh-key"];

  if (secret !== process.env.REFRESH_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { channelId } = req.body;

  if (!channelId) {
    return res.status(400).json({ error: "Missing channelId" });
  }

  const token = makeExtensionJwt(channelId);

  const payload = {
    content_type: "application/json",
    message: JSON.stringify({ refresh: true }),
    targets: ["broadcast"]
  };

  try {
    const result = await fetch(
      `https://api.twitch.tv/extensions/message/${process.env.EXTENSION_ID}/${channelId}`,
      {
        method: "POST",
        headers: {
          "Client-ID": process.env.CLIENT_ID,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      }
    );

    const text = await result.text();
    console.log("PubSub Response:", text);

    return res.json({ ok: true });
  } catch (err) {
    console.error("PubSub error:", err);
    return res.status(500).json({ error: "PubSub failed" });
  }
});

// ------------------------------
// START SERVER
// ------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running at http://localhost:" + PORT);
});
