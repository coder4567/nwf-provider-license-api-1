// server.js (CommonJS)
// Provider License API: serves stored licenses, or proxies a fresh license from LCP.

const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- config (env overrides default) ----
const PORT = process.env.PORT || 8080;
const STORE_DIR = process.env.STORE_DIR || "./licenses";
const LCP_URL = process.env.LCP_URL || "https://lcpserver.onrender.com";
const LCP_ADMIN_USER = process.env.LCP_ADMIN_USER || "admin";
const LCP_ADMIN_PASS = process.env.LCP_ADMIN_PASS || "adminPass!!";
// For “fresh license” proxy when not stored:
const STATIC_USER_KEY_HEX = process.env.STATIC_USER_KEY_HEX || "2ED06766795D58A4F22D511A672F20A6B096D3FE5B56AF3A744678A9A356FD82"; // Secret123
const PROVIDER_ADMIN_TOKEN = process.env.PROVIDER_ADMIN_TOKEN || ""; // set in Render env

async function ensureDir(d) {
  try { await fs.mkdir(d, { recursive: true }); } catch(_) {}
}
ensureDir(STORE_DIR);

// Health
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ---------------- PUBLIC: GET license by id ----------------
// Reading apps (Thorium) will GET this URL.
app.get("/api/v1/licenses/:id", async (req, res) => {
  const id = req.params.id;

  // 1) Try serve a stored license JSON if present
  try {
    const p = path.join(STORE_DIR, `${id}.json`);
    const body = await fs.readFile(p, "utf8");
    res.set("Content-Type", "application/vnd.readium.lcp.license+json");
    res.set("Cache-Control", "no-store");
    return res.status(200).send(body);
  } catch (_) {
    // not stored -> fall through to proxy
  }

  // 2) Proxy a "fresh license" from LCP (requires we can supply user_key hex)
  const partial = {
    encryption: {
      user_key: {
        text_hint: "Your site password",
        hex_value: STATIC_USER_KEY_HEX, // TODO: in prod, look up per license_id
      },
    },
    // Optional: include user fields you want embedded, e.g. email (encrypted by LCP):
    // user: { id: "user-42", email: "reader@example.com", encrypted: ["email"] }
  };

  const auth = Buffer.from(`${LCP_ADMIN_USER}:${LCP_ADMIN_PASS}`).toString("base64");
  let upstream;
  try {
    upstream = await fetch(`${LCP_URL}/licenses/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.readium.lcp.license+json",
      },
      body: JSON.stringify(partial),
    });
  } catch (e) {
    return res.status(502).json({ error: "Upstream fetch failed", detail: String(e) });
  }

  const text = await upstream.text();
  res.set("Content-Type", "application/vnd.readium.lcp.license+json");
  res.set("Cache-Control", "no-store");
  return res.status(upstream.status).send(text);
});

// ---------------- ADMIN: store minted license ----------------
// Call this *when you mint* a license so we can serve it quickly.
// Protect with a simple Bearer token (Render env var: PROVIDER_ADMIN_TOKEN).
app.post("/api/v1/admin/licenses", async (req, res) => {
  const authz = req.get("Authorization") || "";
  if (!PROVIDER_ADMIN_TOKEN || authz !== `Bearer ${PROVIDER_ADMIN_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const lic = req.body;
  if (!lic || !lic.id) {
    return res.status(400).json({ error: "License JSON must include .id" });
  }
  const p = path.join(STORE_DIR, `${lic.id}.json`);
  await ensureDir(STORE_DIR);
  await fs.writeFile(p, JSON.stringify(lic), "utf8");
  return res.status(201).json({ saved: path.basename(p) });
});

app.listen(PORT, () => {
  console.log(`Provider License API on :${PORT}`);
});
