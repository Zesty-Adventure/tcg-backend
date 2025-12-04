import express from "express";
import fs from "fs";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();
app.use(cors());
app.use(bodyParser.json());

const DATA_FILE = "data.json";

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ config: null, viewers: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}


function getWeightedRarity(rarities, cardsByRarity) {
  const valid = rarities.filter(r => {
    const bucket = cardsByRarity[r.name] || [];
    return bucket.length > 0;
  });

  if (!valid.length) return null;

  const N = valid.length;
  const weighted = valid.map((rarity, i) => {
    const rank = i + 1;
    return { rarity, weight: Math.pow(N - rank + 1, 2) };
  });

  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = Math.random() * totalWeight;
  let cumulative = 0;

  for (const w of weighted) {
    cumulative += w.weight;
    if (roll <= cumulative) {
      return w.rarity;
    }
  }

  return weighted[weighted.length - 1].rarity;
}

function pickRandom(arr) {
  if (!arr || !arr.length) return null;
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx];
}

// Simple in-memory rip event tracker so overlays can refresh after a pack is ripped
const lastRipEventByChannel = {};
app.get("/", (req, res) => {
  res.json({ status: "Backend running!" });
});

app.post("/sync-config", (req, res) => {
  const incomingConfig = req.body;
  const data = loadData();

  data.config = incomingConfig;
  saveData(data);

  res.json({ ok: true });
});


// Record that a rip has just completed for this channel
app.post("/rip-event", (req, res) => {
  const { channelId } = req.body;
  if (!channelId) {
    return res.status(400).json({ success: false, error: "Missing channelId" });
  }
  lastRipEventByChannel[channelId] = Date.now();
  res.json({ success: true, at: lastRipEventByChannel[channelId] });
});

// Allow overlays to check when the last rip happened
app.get("/rip-status/:channelId", (req, res) => {
  const { channelId } = req.params;
  const lastRipAt = lastRipEventByChannel[channelId] || 0;
  res.json({ lastRipAt });
});
app.get("/viewer/:channelId/:viewerId", (req, res) => {
  const { channelId, viewerId } = req.params;
  const data = loadData();

  const viewers = data.viewers[channelId] || {};
  const viewer = viewers[viewerId] || { cards: [] };

  res.json(viewer);
});

app.post("/give-card", (req, res) => {
  const { channelId, viewerId, card } = req.body;
  const data = loadData();

  if (!data.viewers[channelId]) data.viewers[channelId] = {};
  if (!data.viewers[channelId][viewerId]) data.viewers[channelId][viewerId] = { cards: [] };

  data.viewers[channelId][viewerId].cards.push(card);
  saveData(data);

  res.json({ ok: true });
});


app.post("/rip-card", (req, res) => {
  try {
    const { channelId, viewerId } = req.body;

    if (!channelId || !viewerId) {
      return res
        .status(400)
        .json({ success: false, error: "Missing channelId or viewerId" });
    }

    const data = loadData();
    const config = data.config;

    if (!config || !config.collections || !config.collections.length) {
      return res
        .status(500)
        .json({ success: false, error: "No collections found in config" });
    }

    // Use the configured default collection
    const defaultId = config.defaultCollectionId;
    const streamerCollection = config.collections.find(
      (col) => col.id === defaultId
    );

    if (!streamerCollection) {
      return res.status(500).json({
        success: false,
        error: "Default collection not found in config",
      });
    }

    const streamerCards = streamerCollection.cards || [];
    const rarities = streamerCollection.rarities || [];

    if (!rarities.length) {
      return res
        .status(500)
        .json({ success: false, error: "No rarities defined" });
    }

    // Group cards by rarity
    const cardsByRarity = {};
    streamerCards.forEach((card) => {
      if (!cardsByRarity[card.rarity]) cardsByRarity[card.rarity] = [];
      cardsByRarity[card.rarity].push(card);
    });

    // Weighted rarity pick
    const selected = getWeightedRarity(rarities, cardsByRarity);
    if (!selected) {
      return res.status(500).json({
        success: false,
        error: "No available cards for any rarity",
      });
    }

    const rarityName = selected.name;
    const cardPool = cardsByRarity[rarityName];
    const selectedCard = pickRandom(cardPool);

    // Ensure viewer exists
    if (!data.viewers[channelId]) data.viewers[channelId] = {};
    if (!data.viewers[channelId][viewerId])
      data.viewers[channelId][viewerId] = { cards: [], totalValue: 0 };

    // Add card to viewer collection
    data.viewers[channelId][viewerId].cards.push(selectedCard);

    // Recalculate total value
    let total = 0;
    data.viewers[channelId][viewerId].cards.forEach((c) => {
      const price = parseFloat(c.price || 0);
      if (!isNaN(price)) total += price;
    });
    data.viewers[channelId][viewerId].totalValue = total;

    saveData(data);

    return res.json({
      success: true,
      rarity: rarityName,
      card: selectedCard,
    });
  } catch (err) {
    console.error("RIP CARD ERROR:", err);
    return res
      .status(500)
      .json({ success: false, error: "Internal backend error" });
  }
});

app.get("/leaderboard/:channelId", (req, res) => {
  const { channelId } = req.params;
  const data = loadData();

  const viewers = data.viewers[channelId] || {};
  const list = [];

  for (const vid of Object.keys(viewers)) {
    const v = viewers[vid];
    const totalValue = v.cards.reduce((sum, c) => {
    const price = parseFloat(c.price || 0);
    return isNaN(price) ? sum : sum + price;
  }, 0);
    list.push({
      viewerId: vid,
      cardCount: v.cards.length,
      totalValue
    });
  }

  list.sort((a, b) => b.totalValue - a.totalValue);

  res.json(list.slice(0, 50));
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log("Backend running at http://localhost:" + PORT);
});
