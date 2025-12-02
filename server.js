import express from "express";
import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import fetch from "node-fetch";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------ Helpers ------------------

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function extractTitle($) {
  return $("main h1").first().text().trim() ||
         $("h1").first().text().trim() ||
         $("title").text().trim();
}

function extractLastUpdated($, url = "") {
  // 1. Look for <local-time> tag (most reliable)
  const localTimeEl = $("local-time[datetime]");
  if (localTimeEl.length) {
    const textDate = localTimeEl.text().trim();
    if (textDate.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
      return textDate;
    }

    // Fallback: use datetime attr
    const iso = localTimeEl.attr("datetime");
    if (iso) {
      const date = new Date(iso);
      if (!isNaN(date.getTime())) {
        return date.toLocaleDateString("en-US");
      }
    }
  }

  // 2. Try matching common visible text patterns
  const selectors = [
    ".content-footer p",
    ".content-footer",
    ".main p",
    "main",
    "article",
    "header"
  ];

  for (const sel of selectors) {
    const text = $(sel).text();
    const match = text.match(
      /Last\s*updated[:\s]*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i
    );
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  // 3. Fallback: search entire body text
  const bodyText = $("body").text();
  const looseMatch = bodyText.match(
    /\b([A-Za-z]+\s+\d{1,2},\s+\d{4})\b/
  );
  if (looseMatch && looseMatch[1]) {
    return looseMatch[1].trim();
  }

  console.warn(` No Last Updated date found for: ${url}`);
  return "UNKNOWN";
}

function isSupportedCountryLink($anchor) {
  const text = $anchor.text().trim().toLowerCase();
  const href = ($anchor.attr("href") || "").toLowerCase();

  if (
    text.includes("supported countries") ||
    text.includes("supported regions") ||
    text.includes("supported country") ||
    text.includes("countries/regions") ||
    text.includes("country/region") ||
    href.includes("country-region") ||
    (href.includes("availability") && href.includes("country"))
  ) {
    return true;
  }

  const parentText = $anchor.closest("section, table, div").text().toLowerCase();
  return parentText.includes("supported countries") ||
         parentText.includes("supported regions") ||
         parentText.includes("country/region");
}

function extractSidebarUrls($, baseUrl) {
  const links = new Set();

  const selectors = [
    'nav[data-bi-name="toc"] a[href]',
    'nav[role="navigation"] a[href]',
    "aside a[href]",
  ];

  selectors.forEach((sel) => {
    $(sel).each((_, el) => {
      const $a = $(el);
      const href = $a.attr("href");
      if (!href || href.startsWith("#")) return;

      let abs;
      try {
        abs = new URL(href, baseUrl).toString();
      } catch {
        return;
      }

      if (!abs.startsWith("https://learn.microsoft.com/")) return;
      if (isSupportedCountryLink($a)) return;

      links.add(normalizeUrl(abs));
    });
  });

  return Array.from(links);
}

// ------------------ Scraper ------------------

async function scrapeAll() {
  const urlsPath = path.join(__dirname, "urls.txt");
  if (!fs.existsSync(urlsPath)) {
    throw new Error("urls.txt not found. Place it next to server.js.");
  }

  const rawList = fs.readFileSync(urlsPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const seedUrls = rawList.map(normalizeUrl).filter(Boolean);
  const seedSet = new Set(seedUrls);

  const visited = new Set();
  const queued = new Set(seedUrls);
  const queue = [...seedUrls];

  const seedResults = [];
  const discoveredResults = [];

  console.log("Starting full scrape...");
  console.log(`Loaded ${seedUrls.length} seed URLs from urls.txt`);
  let pageCount = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    pageCount++;
    console.log(`[${pageCount}] Scraping: ${current}`);

    let html;
    try {
      const res = await fetch(current, {
        headers: { "User-Agent": "D365-Scraper/1.0" },
      });
      if (!res.ok) {
        console.warn(`  HTTP ${res.status} for ${current}`);
        continue;
      }
      html = await res.text();
    } catch (err) {
      console.warn(`  Failed to fetch: ${err.message}`);
      continue;
    }

    const $ = cheerio.load(html);
    const title = extractTitle($);
    const lastUpdated = extractLastUpdated($, current);

    console.log(` Extracted date for ${current} → ${lastUpdated}`);

    const record = {
      Title: title,
      URL: current,
      LastUpdated: lastUpdated,
    };

    if (seedSet.has(current)) {
      seedResults.push(record);
      console.log(`  Seed page scraped: ${title}`);
    } else {
      discoveredResults.push(record);
      console.log(`  New page discovered: ${title}`);
    }

    const extraUrls = extractSidebarUrls($, current);
    let added = 0;
    for (const u of extraUrls) {
      const norm = normalizeUrl(u);
      if (!norm || visited.has(norm) || queued.has(norm)) continue;
      queued.add(norm);
      queue.push(norm);
      added++;
    }

    if (added > 0) {
      console.log(`  Found ${added} sidebar links`);
    }
  }

  const allRows = [...seedResults, ...discoveredResults];
  console.log("\nScraping complete.");
  console.log(`Seed pages scraped: ${seedResults.length}`);
  console.log(`New pages discovered: ${discoveredResults.length}`);
  console.log(`Total pages processed: ${allRows.length}`);

  return allRows;
}

// ------------------ CSV ------------------

function toCsv(rows) {
  const header = ["Title", "URL", "LastUpdated"];
  const lines = [header.join(",")];

  for (const row of rows) {
    const esc = (val) => `"${String(val ?? "").replace(/"/g, '""')}"`;
    lines.push([esc(row.Title), esc(row.URL), esc(row.LastUpdated)].join(","));
  }

  return lines.join("\r\n");
}

// ------------------ Routes ------------------

app.get("/", (req, res) => {
  res.send("D365 Scraper is running. Use /scrape-all to start scraping.");
});

app.get("/scrape-all", async (req, res) => {
  try {
    const rows = await scrapeAll();
    const csv = toCsv(rows);

    const today = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="d365_scrape_${today}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("Scraping error:", err);
    res.status(500).send("Scraping failed: " + err.message);
  }
});

// ------------------ Start Server ------------------

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
