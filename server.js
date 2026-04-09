const express = require("express");
const path = require("path");
const { searchListings } = require("./src/scraper");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/search", async (req, res) => {
  const location = String(req.body?.location || "").trim();

  if (!location) {
    return res.status(400).json({ error: "구/동을 입력해 주세요." });
  }

  try {
    const result = await searchListings(location);
    return res.json(result);
  } catch (error) {
    console.error("Search failed:", error);
    return res.status(500).json({
      error: "검색 중 오류가 발생했습니다.",
      detail: error.message,
    });
  }
});

app.listen(port, () => {
  console.log(`LH search app listening on http://localhost:${port}`);
});
