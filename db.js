import pg from "pg";

// Saves ProofPay deals in a Postgres database (for example a free Neon database),
// so they survive a restart. The server keeps working on its in-memory Map as before.
// This file only loads the Map at startup and writes changes back.
// If DATABASE_URL is not set, nothing is saved and deals stay in memory only.

const url = process.env.DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30000 }) : null;
if (pool) pool.on("error", (e) => console.error("Database connection error:", e.message));

const KINDS = { reviewFile: "review", finalFile: "final" }; // deal field -> file kind
const lastJson = new Map(); // deal id -> the JSON we last saved
const savedBuf = new Map(); // "id:kind" -> the file bytes we last saved

// The deal without file bytes and without the temporary flags used while an action runs.
function plain(deal) {
  const copy = { ...deal };
  delete copy.busy;
  delete copy.polling;
  for (const field of Object.keys(KINDS)) {
    if (copy[field]) {
      const { data, ...meta } = copy[field];
      copy[field] = meta;
    }
  }
  return copy;
}

export async function loadDeals(deals) {
  if (!pool) {
    console.log("DATABASE_URL is not set: deals are kept in memory only and are lost on restart.");
    return;
  }
  try {
    await pool.query(`create table if not exists deals (
      id text primary key, data jsonb not null, updated_at timestamptz not null default now())`);
    await pool.query(`create table if not exists deal_files (
      deal_id text not null, kind text not null, data bytea not null, primary key (deal_id, kind))`);

    for (const row of (await pool.query("select id, data from deals")).rows) deals.set(row.id, row.data);

    for (const row of (await pool.query("select deal_id, kind, data from deal_files")).rows) {
      const deal = deals.get(row.deal_id);
      const field = Object.keys(KINDS).find((f) => KINDS[f] === row.kind);
      if (deal && deal[field]) {
        deal[field].data = row.data;
        savedBuf.set(`${row.deal_id}:${row.kind}`, row.data);
      }
    }
    for (const [id, deal] of deals) lastJson.set(id, JSON.stringify(plain(deal)));
    console.log(`Database connected. Loaded ${deals.size} saved deal(s).`);
  } catch (e) {
    // Keep the site usable even if the database is down at startup.
    console.error("Could not load deals from the database. Running in memory for now:", e.message);
  }
}

async function doSave(deals) {
  for (const [id, deal] of deals) {
    // Files first, so a saved deal never points at a missing file.
    for (const [field, kind] of Object.entries(KINDS)) {
      const key = `${id}:${kind}`;
      const buf = deal[field]?.data || null;
      if (buf === (savedBuf.get(key) || null)) continue;
      if (buf) {
        await pool.query(
          `insert into deal_files (deal_id, kind, data) values ($1, $2, $3)
           on conflict (deal_id, kind) do update set data = excluded.data`,
          [id, kind, buf]
        );
        savedBuf.set(key, buf);
      } else {
        await pool.query("delete from deal_files where deal_id = $1 and kind = $2", [id, kind]);
        savedBuf.delete(key);
      }
    }
    const json = JSON.stringify(plain(deal));
    if (json === lastJson.get(id)) continue;
    await pool.query(
      `insert into deals (id, data) values ($1, $2::jsonb)
       on conflict (id) do update set data = excluded.data, updated_at = now()`,
      [id, json]
    );
    lastJson.set(id, json);
  }
}

// Saves only what changed. Calls run one after another, and a failed save is retried on the next call.
let chain = Promise.resolve();
export function saveChanged(deals) {
  if (!pool) return Promise.resolve();
  chain = chain.then(() => doSave(deals)).catch((e) => console.error("Could not save deals:", e.message));
  return chain;
}
