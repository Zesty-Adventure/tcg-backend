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

app.get("/", (req, res) => {
  return res.json({ status: "Backend running!" });
});

app.post("/sync-config", (req, res) => {
  const incomingConfig = req.body;
  const data = loadData();

  data.config = incomingConfig;
  saveData(data);

  return res.json({ ok: true });
});

app.get("/viewer/:channelId/:viewerId", (req, res) => {
  const { channelId, viewerId } = req.params;
  const data = loadData();

  const viewers = data.viewers[channelId] || {};
  const viewer = viewers[viewerId] || { cards: [] };

  return res.json(viewer);
});

app.post("/give-card", (req, res) => {
  const { channelId, viewerId, card } = req.body;
  const data = loadData();

  if (!data.viewers[channelId]) data.viewers[channelId] = {};
  if (!data.viewers[channelId][viewerId]) data.viewers[channelId][viewerId] = { cards: [] };

  data.viewers[channelId][viewerId].cards.push(card);
  saveData(data);

  return res.json({ ok: true });
});

app.get("/leaderboard/:channelId", (req, res) => {
  const { channelId } = req.params;
  const data = loadData();

  const viewers = data.viewers[channelId] || {};
  const list = [];

  for (const vid of Object.keys(viewers)) {
    const v = viewers[vid];
    const totalValue = v.cards.reduce((sum, c) => sum + (c.price || 0), 0);
    list.push({
      viewerId: vid,
      cardCount: v.cards.length,
      totalValue
    });
  }

  list.sort((a, b) => b.totalValue - a.totalValue);

  return res.json(list.slice(0, 50));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend started on port", PORT));
