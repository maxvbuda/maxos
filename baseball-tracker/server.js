const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

function createDefaultGames() {
  const totalGames = 15;

  const startingGames = [
    {
      game: 1,
      maxScore: 20,
      andyScore: 1,
      status: "Completed",
      batting: "N/A",
      ghostRunners: "N/A",
      outs: "N/A",
      winner: "Max",
      seriesWon: ""
    },
    {
      game: 2,
      maxScore: 20,
      andyScore: 0,
      status: "Completed",
      batting: "N/A",
      ghostRunners: "N/A",
      outs: "N/A",
      winner: "Max",
      seriesWon: ""
    },
    {
      game: 3,
      maxScore: 11,
      andyScore: 0,
      status: "Pending",
      batting: "Max",
      ghostRunners: "2nd",
      outs: "0",
      winner: "N/A",
      seriesWon: ""
    }
  ];

  const games = [];

  for (let i = 1; i <= totalGames; i++) {
    const existing = startingGames.find(game => game.game === i);

    if (existing) {
      games.push({ ...existing });
    } else {
      games.push({
        game: i,
        maxScore: "",
        andyScore: "",
        status: "",
        batting: "",
        ghostRunners: "",
        outs: "",
        winner: "",
        seriesWon: ""
      });
    }
  }

  return games;
}

const trackerSchema = new mongoose.Schema({
  name: {
    type: String,
    default: "main",
    unique: true
  },
  games: {
    type: Array,
    default: createDefaultGames
  },
  spentPoints: {
    type: Object,
    default: {
      Max: 0,
      Andy: 0
    }
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const Tracker = mongoose.model("Tracker", trackerSchema);

async function connectDB() {
  if (!MONGODB_URI) {
    console.error("Missing MONGODB_URI environment variable.");
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
}

app.get("/api/tracker", async (req, res) => {
  try {
    let tracker = await Tracker.findOne({ name: "main" });

    if (!tracker) {
      tracker = await Tracker.create({
        name: "main",
        games: createDefaultGames(),
        spentPoints: {
          Max: 0,
          Andy: 0
        },
        updatedAt: new Date()
      });
    }

    res.json({
      games: tracker.games,
      spentPoints: tracker.spentPoints
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to load tracker data."
    });
  }
});

app.post("/api/tracker", async (req, res) => {
  try {
    const { games, spentPoints } = req.body;

    if (!Array.isArray(games)) {
      return res.status(400).json({
        error: "games must be an array."
      });
    }

    const tracker = await Tracker.findOneAndUpdate(
      { name: "main" },
      {
        name: "main",
        games,
        spentPoints: spentPoints || { Max: 0, Andy: 0 },
        updatedAt: new Date()
      },
      {
        new: true,
        upsert: true
      }
    );

    res.json({
      success: true,
      games: tracker.games,
      spentPoints: tracker.spentPoints
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to save tracker data."
    });
  }
});

app.post("/api/reset", async (req, res) => {
  try {
    const resetData = {
      games: createDefaultGames(),
      spentPoints: {
        Max: 0,
        Andy: 0
      }
    };

    const tracker = await Tracker.findOneAndUpdate(
      { name: "main" },
      {
        name: "main",
        ...resetData,
        updatedAt: new Date()
      },
      {
        new: true,
        upsert: true
      }
    );

    res.json({
      success: true,
      games: tracker.games,
      spentPoints: tracker.spentPoints
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to reset tracker data."
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
