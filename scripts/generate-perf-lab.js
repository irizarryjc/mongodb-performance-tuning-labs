#!/usr/bin/env node
"use strict";

/**
 * Deterministic dataset generator for:
 *   "MongoDB Performance Tuning: A Diagnostic Field Guide"
 *   by Juan C. Irizarry, OCP
 *
 * Dual-runtime script:
 *   1) Node.js (requires `npm install mongodb` for live writes; `--dry-run` works standalone):
 *        export MONGO_URI="mongodb://127.0.0.1:27017"
 *        node scripts/generate-perf-lab.js --db perf_lab --seed 42 --scale 1 --scenario all
 *   2) mongosh (no npm packages required):
 *        LAB_SCENARIO=collscan LAB_SEED=42 mongosh "$MONGO_URI" --file scripts/generate-perf-lab.js
 *      or:
 *        mongosh "$MONGO_URI" --eval \
 *          'globalThis.LAB_ARGS=["--db","perf_lab","--seed","42","--scenario","collscan"]; \
 *           load("scripts/generate-perf-lab.js");'
 *
 * Security note: Never pass plaintext passwords directly on the OS command line.
 * Store credentials in MONGO_URI (exported from a protected file) or use interactive prompts.
 */

const VALID_SCENARIOS = [
  "all",
  "collscan",
  "wrong-index",
  "sort-limit",
  "unbounded-array",
  "cache-pressure",
  "tickets",
  "lookup",
  "repl-lag",
  "hot-shard",
  "connection-storm",
  "thp",
  "capstone",
];

const REGIONS = ["us-east", "us-west", "eu-central", "ap-south"];
const CATEGORIES = [
  "electronics",
  "home-office",
  "networking",
  "storage",
  "accessories",
  "audio",
  "cables",
  "power",
];
const BRANDS = [
  "Northstar",
  "Ridgeway",
  "Clearline",
  "Vektor",
  "Ironwood",
  "Bluepeak",
  "Halcyon",
  "SummitTech",
];
const CHANNELS = ["web", "mobile", "api"];
const EVENT_TYPES = [
  "page_view",
  "cart_add",
  "cart_remove",
  "checkout_start",
  "search",
  "wishlist_add",
];
const WAREHOUSES = ["WH-EAST-1", "WH-WEST-2", "WH-EU-1", "WH-AP-1"];
const BASE_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const BATCH_SIZE = 2000;

function isMongoshRuntime() {
  return (
    typeof db !== "undefined" &&
    db !== null &&
    typeof db.getSiblingDB === "function"
  );
}

function createRng(seedInt) {
  let state = (Number(seedInt) >>> 0) || 1;
  return function nextFloat() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function padNum(n, width) {
  return String(n).padStart(width, "0");
}

function makeTextBlob(rng, approxChars) {
  const words = [
    "order", "fulfillment", "package", "carrier", "routing", "verified",
    "invoice", "warehouse", "priority", "tracking", "batch", "checksum",
    "region", "catalog", "inventory", "dispatch", "label", "transit",
  ];
  const parts = [];
  let len = 0;
  while (len < approxChars) {
    const w = words[Math.floor(rng() * words.length)];
    parts.push(w);
    len += w.length + 1;
  }
  return parts.join(" ").slice(0, approxChars);
}

function pickOrderStatus(rng) {
  const r = rng();
  if (r < 0.68) return "shipped";
  if (r < 0.83) return "paid";
  if (r < 0.91) return "pending";
  if (r < 0.97) return "cancelled";
  return "refunded";
}

function pickSkewedCustomer(rng, customerCount) {
  const r = rng();
  if (r < 0.04) return "CUST-00001";
  if (r < 0.25) {
    const hotMax = Math.min(50, Math.max(2, customerCount));
    return "CUST-" + padNum(randInt(rng, 2, hotMax), 5);
  }
  return "CUST-" + padNum(randInt(rng, 1, Math.max(1, customerCount)), 5);
}

function pickSkewedSku(rng, productCount) {
  const r = rng();
  if (r < 0.12) {
    const top5 = Math.min(5, Math.max(1, productCount));
    return "SKU-" + padNum(randInt(rng, 1, top5), 5);
  }
  if (r < 0.35) {
    const top20 = Math.min(20, Math.max(1, productCount));
    return "SKU-" + padNum(randInt(rng, 1, top20), 5);
  }
  return "SKU-" + padNum(randInt(rng, 1, Math.max(1, productCount)), 5);
}

function pickSkewedTenant(rng) {
  if (rng() < 0.55) return "TENANT-HOT";
  return "TENANT-" + padNum(randInt(rng, 2, 50), 3);
}

function printUsage() {
  const lines = [
    "Usage:",
    "  node scripts/generate-perf-lab.js [options]",
    "  LAB_SCENARIO=<name> mongosh \"$MONGO_URI\" --file scripts/generate-perf-lab.js",
    "",
    "Options:",
    "  --uri <uri>         MongoDB URI (default: $MONGO_URI or mongodb://127.0.0.1:27017)",
    "                      Avoid embedding passwords directly on the OS command line.",
    "  --db <name>         Target database name (default: perf_lab)",
    "  --seed <int>        Deterministic PRNG seed (default: 42)",
    "  --scale <float>     Dataset size multiplier, e.g. 0.2, 1, 2 (default: 1)",
    "  --scenario <name>   Scenario to build (default: all). Valid values:",
    "                      " + VALID_SCENARIOS.join(", "),
    "  --reset             Drop existing lab collections before loading",
    "  --reset-only        Drop lab collections and exit without loading",
    "  --dry-run           Compute counts, skew, and indexes without writing to MongoDB",
    "  --help              Show this help text",
  ];
  console.log(lines.join("\n"));
}

function getEnv(name) {
  if (typeof process !== "undefined" && process.env && process.env[name]) {
    return process.env[name];
  }
  return "";
}

function parseOptions(argv) {
  const opts = {
    uri: getEnv("MONGO_URI") || "mongodb://127.0.0.1:27017",
    db: getEnv("LAB_DB") || "perf_lab",
    seed: Number(getEnv("LAB_SEED") || "42"),
    scale: Number(getEnv("LAB_SCALE") || "1"),
    scenario: getEnv("LAB_SCENARIO") || "all",
    reset: getEnv("LAB_RESET") === "1" || getEnv("LAB_RESET") === "true",
    resetOnly: false,
    dryRun: false,
    help: false,
    uriFromCli: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--reset") {
      opts.reset = true;
    } else if (arg === "--reset-only") {
      opts.reset = true;
      opts.resetOnly = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--uri" && i + 1 < argv.length) {
      opts.uri = argv[++i];
      opts.uriFromCli = true;
    } else if (arg === "--db" && i + 1 < argv.length) {
      opts.db = argv[++i];
    } else if (arg === "--seed" && i + 1 < argv.length) {
      opts.seed = Number(argv[++i]);
    } else if (arg === "--scale" && i + 1 < argv.length) {
      opts.scale = Number(argv[++i]);
    } else if (arg === "--scenario" && i + 1 < argv.length) {
      opts.scenario = argv[++i];
    } else {
      throw new Error("Unknown or incomplete argument: " + arg);
    }
  }

  if (!Number.isFinite(opts.seed) || opts.seed < 1) {
    throw new Error("--seed must be a positive integer.");
  }
  if (!Number.isFinite(opts.scale) || opts.scale <= 0) {
    throw new Error("--scale must be a positive number (for example 0.2, 1, or 2).");
  }
  if (!VALID_SCENARIOS.includes(opts.scenario)) {
    throw new Error(
      "Invalid --scenario '" + opts.scenario + "'. Valid: " + VALID_SCENARIOS.join(", ")
    );
  }
  if (opts.uriFromCli && /mongodb(\+srv)?:\/\/[^/\s]+:[^@\s]+@/.test(opts.uri)) {
    console.warn(
      "[WARN] Detected embedded credentials in --uri CLI flag. " +
      "Prefer exporting MONGO_URI from a protected file instead of passing secrets on CLI."
    );
  }
  return opts;
}

function buildScenarioPlan(scenario, scale) {
  const s = (n) => Math.max(10, Math.round(n * scale));
  const fullCounts = {
    customers: s(10000),
    products: s(5000),
    orders: s(100000),
    order_items: s(250000),
    reviews: s(50000),
    user_events: s(2000),
    shard_demo: s(120000),
  };

  const plan = {
    collections: {},
    indexes: {},
    orderNoteBytes: 120,
    reviewBodyBytes: 220,
    heavyEventUsers: Math.max(5, Math.round(25 * Math.min(scale, 2))),
    heavyUserEventsMin: 4000,
    heavyUserEventsMax: 7500,
    normalUserEventsMax: 28,
    notes: [],
  };

  switch (scenario) {
    case "all":
      plan.collections = Object.assign({}, fullCounts);
      plan.indexes = {
        customers: [[{ email: 1 }, { name: "idx_customers_email", unique: true }]],
        products: [[{ sku: 1 }, { name: "idx_products_sku", unique: true }]],
      };
      plan.notes.push("Full baseline dataset loaded with skewed keys and minimal indexes.");
      break;

    case "collscan":
      plan.collections = {
        customers: s(10000),
        orders: s(100000),
      };
      plan.indexes = {
        customers: [[{ email: 1 }, { name: "idx_customers_email", unique: true }]],
        orders: [],
      };
      plan.notes.push("Lab L1: orders has only _id index; checkout query runs COLLSCAN.");
      break;

    case "wrong-index":
      plan.collections = {
        customers: s(10000),
        orders: s(100000),
      };
      plan.indexes = {
        orders: [
          [{ status: 1 }, { name: "idx_orders_status" }],
          [{ region: 1, createdAt: -1 }, { name: "idx_orders_region_created" }],
          [{ customerId: 1 }, { name: "idx_orders_customer" }],
        ],
      };
      plan.notes.push(
        "Lab L2: orders carries low-selectivity status and decoy region indexes."
      );
      break;

    case "sort-limit":
      plan.collections = {
        orders: s(100000),
      };
      plan.orderNoteBytes = 1800;
      plan.indexes = {
        orders: [
          [{ region: 1 }, { name: "idx_orders_region_only" }],
        ],
      };
      plan.notes.push(
        "Lab L3: padded orders (~1.8 KB notes) without sort index triggers 100 MB sort cap."
      );
      break;

    case "unbounded-array":
      plan.collections = {
        customers: s(5000),
        user_events: s(2000),
      };
      plan.heavyUserEventsMin = 5000;
      plan.heavyUserEventsMax = 9000;
      plan.indexes = {
        user_events: [
          [{ customerId: 1 }, { name: "idx_user_events_customer" }],
        ],
      };
      plan.notes.push(
        "Lab L4: user_events embeds 5,000-9,000 event objects on top heavy users."
      );
      break;

    case "cache-pressure":
      plan.collections = {
        orders: s(120000),
        order_items: s(250000),
        reviews: s(60000),
      };
      plan.orderNoteBytes = 1600;
      plan.reviewBodyBytes = 1400;
      plan.indexes = {
        orders: [
          [{ customerId: 1, createdAt: -1 }, { name: "idx_orders_cust_created" }],
          [{ status: 1, region: 1, totalCents: -1 }, { name: "idx_orders_status_reg_tot" }],
        ],
        order_items: [
          [{ orderId: 1, sku: 1 }, { name: "idx_items_order_sku" }],
          [{ sku: 1, createdAt: -1 }, { name: "idx_items_sku_created" }],
        ],
        reviews: [
          [{ sku: 1, rating: -1, createdAt: -1 }, { name: "idx_reviews_sku_rating" }],
        ],
      };
      plan.notes.push(
        "Lab L5: padded orders/reviews + wide indexes exceed constrained WiredTiger cache."
      );
      break;

    case "tickets":
      plan.collections = {
        products: s(5000),
        orders: s(100000),
        order_items: s(200000),
      };
      plan.orderNoteBytes = 900;
      plan.indexes = {
        products: [[{ sku: 1 }, { name: "idx_products_sku", unique: true }]],
        orders: [[{ customerId: 1, createdAt: -1 }, { name: "idx_orders_cust_created" }]],
        order_items: [],
      };
      plan.notes.push(
        "Lab L6: hot SKUs (SKU-00001..00005) + unindexed order_items stress storage tickets."
      );
      break;

    case "lookup":
      plan.collections = {
        products: s(5000),
        orders: s(60000),
        order_items: s(250000),
      };
      plan.indexes = {
        products: [[{ sku: 1 }, { name: "idx_products_sku", unique: true }]],
        orders: [[{ customerId: 1, createdAt: -1 }, { name: "idx_orders_cust_created" }]],
        order_items: [],
      };
      plan.notes.push(
        "Lab L7: order_items has NO index on orderId or sku for $lookup join diagnosis."
      );
      break;

    case "repl-lag":
      plan.collections = {
        customers: s(10000),
        orders: s(100000),
        reviews: s(50000),
      };
      plan.orderNoteBytes = 1000;
      plan.indexes = {
        orders: [
          [{ customerId: 1, createdAt: -1 }, { name: "idx_orders_cust_created" }],
          [{ region: 1, status: 1 }, { name: "idx_orders_region_status" }],
        ],
        reviews: [],
      };
      plan.notes.push(
        "Lab L8: bulk-write orders baseline + unindexed reviews for secondary lag testing."
      );
      break;

    case "hot-shard":
      plan.collections = {
        shard_demo: s(120000),
      };
      plan.indexes = {
        shard_demo: [
          [{ seqId: 1 }, { name: "idx_shard_demo_seq" }],
          [{ tenantId: 1, createdAt: -1 }, { name: "idx_shard_demo_tenant_created" }],
        ],
      };
      plan.notes.push(
        "Lab L9: shard_demo has monotonic seqId/createdAt and skewed TENANT-HOT (55%)."
      );
      break;

    case "connection-storm":
      plan.collections = {
        customers: s(5000),
        orders: s(25000),
      };
      plan.indexes = {
        customers: [[{ email: 1 }, { name: "idx_customers_email", unique: true }]],
        orders: [
          [{ customerId: 1, status: 1, createdAt: -1 }, { name: "idx_orders_esr" }],
        ],
      };
      plan.notes.push(
        "Lab L10: lightweight indexed dataset to isolate driver pool connection overhead."
      );
      break;

    case "thp":
      plan.collections = {
        orders: s(100000),
        order_items: s(200000),
        reviews: s(50000),
      };
      plan.orderNoteBytes = 900;
      plan.indexes = {
        orders: [
          [{ customerId: 1, status: 1, createdAt: -1 }, { name: "idx_orders_esr" }],
          [{ region: 1, totalCents: -1 }, { name: "idx_orders_region_total" }],
        ],
        order_items: [
          [{ orderId: 1 }, { name: "idx_items_order" }],
          [{ sku: 1, createdAt: -1 }, { name: "idx_items_sku_created" }],
        ],
        reviews: [
          [{ sku: 1, createdAt: -1 }, { name: "idx_reviews_sku_created" }],
        ],
      };
      plan.notes.push(
        "Lab L11: allocation-heavy working set for version-aware Linux THP comparison."
      );
      break;

    case "capstone":
      plan.collections = {
        customers: s(10000),
        products: s(5000),
        orders: s(100000),
        order_items: s(250000),
        reviews: s(50000),
        user_events: s(1000),
      };
      plan.orderNoteBytes = 600;
      plan.indexes = {
        customers: [[{ email: 1 }, { name: "idx_customers_email", unique: true }]],
        products: [[{ sku: 1 }, { name: "idx_products_sku", unique: true }]],
        orders: [
          [{ status: 1 }, { name: "idx_orders_status_poor" }],
          [{ notes: 1 }, { name: "idx_orders_notes_unused" }],
        ],
        order_items: [],
        user_events: [[{ customerId: 1 }, { name: "idx_user_events_customer" }]],
      };
      plan.notes.push(
        "Lab L12 Capstone: poor status index + unused notes index + unindexed order_items + " +
        "bloated user_events decoy."
      );
      break;
  }
  return plan;
}

function* generateCustomers(rng, count) {
  const tiers = ["standard", "standard", "standard", "plus", "enterprise"];
  for (let i = 1; i <= count; i += 1) {
    const id = "CUST-" + padNum(i, 5);
    const createdAt = new Date(BASE_EPOCH_MS - randInt(rng, 1, 1000) * 86400000);
    yield {
      _id: id,
      customerId: id,
      email: "customer" + i + "@example.invalid",
      tier: i <= 50 ? "enterprise" : pick(rng, tiers),
      region: pick(rng, REGIONS),
      isHeavyAccount: i <= 50,
      lifetimeCents: i === 1 ? 48500000 : randInt(rng, 2500, 950000),
      createdAt: createdAt,
    };
  }
}

function* generateProducts(rng, count) {
  for (let i = 1; i <= count; i += 1) {
    const sku = "SKU-" + padNum(i, 5);
    const category = pick(rng, CATEGORIES);
    const brand = pick(rng, BRANDS);
    yield {
      _id: sku,
      sku: sku,
      name: brand + " " + category + " Unit " + i,
      category: category,
      brand: brand,
      priceCents: randInt(rng, 999, 149900),
      stockQty: i <= 5 ? randInt(rng, 2000, 8000) : randInt(rng, 0, 600),
      isHotSku: i <= 20,
      tags: [category, brand.toLowerCase(), i <= 20 ? "featured" : "catalog"],
      updatedAt: new Date(BASE_EPOCH_MS - randInt(rng, 0, 90) * 86400000),
    };
  }
}

function* generateOrders(rng, count, customerCount, noteBytes) {
  for (let i = 1; i <= count; i += 1) {
    const id = "ORD-" + padNum(i, 7);
    const createdAt = new Date(BASE_EPOCH_MS - randInt(rng, 0, 365 * 86400) * 1000);
    const status = pickOrderStatus(rng);
    const itemCount = randInt(rng, 1, 5);
    const totalCents = randInt(rng, 1500, 125000);
    yield {
      _id: id,
      orderId: id,
      customerId: pickSkewedCustomer(rng, customerCount),
      status: status,
      region: pick(rng, REGIONS),
      priority: rng() < 0.15 ? "express" : "standard",
      channel: pick(rng, CHANNELS),
      itemCount: itemCount,
      totalCents: totalCents,
      createdAt: createdAt,
      updatedAt: new Date(createdAt.getTime() + randInt(rng, 60, 172800) * 1000),
      notes: makeTextBlob(rng, noteBytes),
    };
  }
}

function* generateOrderItems(rng, count, orderCount, customerCount, productCount) {
  const safeOrderCount = Math.max(1, orderCount);
  for (let i = 1; i <= count; i += 1) {
    const ordNum = randInt(rng, 1, safeOrderCount);
    const qty = randInt(rng, 1, 4);
    const unitPriceCents = randInt(rng, 999, 45000);
    yield {
      _id: "ITEM-" + padNum(i, 8),
      orderId: "ORD-" + padNum(ordNum, 7),
      customerId: pickSkewedCustomer(rng, customerCount),
      sku: pickSkewedSku(rng, productCount),
      qty: qty,
      unitPriceCents: unitPriceCents,
      lineTotalCents: qty * unitPriceCents,
      warehouse: pick(rng, WAREHOUSES),
      createdAt: new Date(BASE_EPOCH_MS - randInt(rng, 0, 365 * 86400) * 1000),
    };
  }
}

function* generateReviews(rng, count, customerCount, productCount, bodyBytes) {
  for (let i = 1; i <= count; i += 1) {
    yield {
      _id: "REV-" + padNum(i, 7),
      sku: pickSkewedSku(rng, productCount),
      customerId: pickSkewedCustomer(rng, customerCount),
      rating: randInt(rng, 1, 5),
      verifiedPurchase: rng() < 0.82,
      helpfulVotes: randInt(rng, 0, 150),
      title: "Review summary " + i,
      body: makeTextBlob(rng, bodyBytes),
      createdAt: new Date(BASE_EPOCH_MS - randInt(rng, 0, 365 * 86400) * 1000),
    };
  }
}

function* generateUserEvents(rng, count, productCount, plan) {
  for (let i = 1; i <= count; i += 1) {
    const isHeavy = i <= plan.heavyEventUsers;
    const evCount = isHeavy
      ? randInt(rng, plan.heavyUserEventsMin, plan.heavyUserEventsMax)
      : randInt(rng, 10, plan.normalUserEventsMax);
    const events = [];
    let lastTs = new Date(BASE_EPOCH_MS);
    for (let e = 1; e <= evCount; e += 1) {
      lastTs = new Date(BASE_EPOCH_MS - (evCount - e) * 15000);
      events.push({
        seq: e,
        type: pick(rng, EVENT_TYPES),
        sku: pickSkewedSku(rng, productCount),
        latencyMs: randInt(rng, 8, 420),
        ts: lastTs,
        meta: isHeavy ? "session-track-active-web-desktop" : "web",
      });
    }
    yield {
      _id: "USER-" + padNum(i, 5),
      customerId: "CUST-" + padNum(i, 5),
      region: pick(rng, REGIONS),
      isPowerUser: isHeavy,
      eventCount: evCount,
      lastEventAt: lastTs,
      events: events,
    };
  }
}

function* generateShardDemo(rng, count) {
  for (let i = 1; i <= count; i += 1) {
    const ts = new Date(BASE_EPOCH_MS + i * 250);
    yield {
      _id: "SHARD-" + padNum(i, 8),
      seqId: i,
      tenantId: pickSkewedTenant(rng),
      region: pick(rng, REGIONS),
      eventType: pick(rng, EVENT_TYPES),
      amountCents: randInt(rng, 500, 90000),
      createdAt: ts,
      payload: makeTextBlob(rng, 140),
    };
  }
}

function makeGeneratorForCollection(name, rng, counts, plan) {
  const custCount = counts.customers || 10000;
  const prodCount = counts.products || 5000;
  const ordCount = counts.orders || 100000;
  switch (name) {
    case "customers":
      return generateCustomers(rng, counts.customers);
    case "products":
      return generateProducts(rng, counts.products);
    case "orders":
      return generateOrders(rng, counts.orders, custCount, plan.orderNoteBytes);
    case "order_items":
      return generateOrderItems(rng, counts.order_items, ordCount, custCount, prodCount);
    case "reviews":
      return generateReviews(rng, counts.reviews, custCount, prodCount, plan.reviewBodyBytes);
    case "user_events":
      return generateUserEvents(rng, counts.user_events, prodCount, plan);
    case "shard_demo":
      return generateShardDemo(rng, counts.shard_demo);
    default:
      throw new Error("Unsupported collection: " + name);
  }
}

function getAllLabCollections() {
  return [
    "customers",
    "products",
    "orders",
    "order_items",
    "reviews",
    "user_events",
    "shard_demo",
  ];
}

function runDryRun(opts, plan) {
  console.log("=== DRY RUN (no database connection) ===");
  console.log("Database : " + opts.db);
  console.log("Scenario : " + opts.scenario);
  console.log("Seed     : " + opts.seed);
  console.log("Scale    : " + opts.scale);
  console.log("Reset    : " + String(opts.reset));
  for (const note of plan.notes) {
    console.log("Note     : " + note);
  }
  console.log("");

  if (opts.resetOnly) {
    console.log("Would drop collections: " + getAllLabCollections().join(", "));
    return;
  }

  const rng = createRng(opts.seed);
  for (const collName of Object.keys(plan.collections)) {
    const targetCount = plan.collections[collName];
    const gen = makeGeneratorForCollection(collName, rng, plan.collections, plan);
    const firstDoc = gen.next().value;
    const sampleSize = Buffer.byteLength(JSON.stringify(firstDoc), "utf8");
    const idxList = (plan.indexes[collName] || []).map((x) => x[1].name);
    console.log(
      "- " + collName + ": " + targetCount + " docs (sample doc ~" + sampleSize +
      " B, first _id=" + firstDoc._id + ", indexes=" +
      (idxList.length ? idxList.join(",") : "_id only") + ")"
    );
  }
}

function runInMongosh(opts, plan) {
  const targetDb = db.getSiblingDB(opts.db);
  console.log(
    "[mongosh] Target db=" + opts.db + " scenario=" + opts.scenario +
    " seed=" + opts.seed + " scale=" + opts.scale
  );

  if (opts.reset) {
    for (const collName of getAllLabCollections()) {
      targetDb.getCollection(collName).drop();
    }
    console.log("[mongosh] Dropped existing lab collections.");
    if (opts.resetOnly) return;
  }

  const rng = createRng(opts.seed);
  for (const collName of Object.keys(plan.collections)) {
    const coll = targetDb.getCollection(collName);
    const total = plan.collections[collName];
    const batchLimit = collName === "user_events" ? 50 : BATCH_SIZE;
    const gen = makeGeneratorForCollection(collName, rng, plan.collections, plan);
    let batch = [];
    let inserted = 0;

    for (const doc of gen) {
      batch.push(doc);
      if (batch.length >= batchLimit) {
        coll.insertMany(batch, { ordered: false });
        inserted += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      coll.insertMany(batch, { ordered: false });
      inserted += batch.length;
    }

    const idxSpecs = plan.indexes[collName] || [];
    for (const spec of idxSpecs) {
      coll.createIndex(spec[0], spec[1]);
    }
    console.log(
      "[mongosh] Loaded " + collName + ": " + inserted + "/" + total +
      " docs, extra indexes=" + idxSpecs.length
    );
  }
  for (const note of plan.notes) {
    console.log("[info] " + note);
  }
}

async function runInNode(opts, plan) {
  let mongodb;
  try {
    mongodb = require("mongodb");
  } catch (err) {
    console.error("The Node.js 'mongodb' driver is not installed in this folder.");
    console.error("Install it with: npm install mongodb");
    console.error(
      "Or run directly inside mongosh with zero npm dependencies:\n" +
      "  LAB_SCENARIO=" + opts.scenario + " LAB_SEED=" + opts.seed +
      " mongosh \"$MONGO_URI\" --file scripts/generate-perf-lab.js"
    );
    process.exitCode = 1;
    return;
  }

  const client = new mongodb.MongoClient(opts.uri);
  const started = Date.now();
  try {
    await client.connect();
    const targetDb = client.db(opts.db);
    console.log(
      "[node] Connected. Target db=" + opts.db + " scenario=" + opts.scenario +
      " seed=" + opts.seed + " scale=" + opts.scale
    );

    if (opts.reset) {
      const existing = await targetDb.listCollections({}, { nameOnly: true }).toArray();
      const existingSet = new Set(existing.map((c) => c.name));
      for (const collName of getAllLabCollections()) {
        if (existingSet.has(collName)) {
          await targetDb.collection(collName).drop();
        }
      }
      console.log("[node] Dropped existing lab collections.");
      if (opts.resetOnly) return;
    }

    const rng = createRng(opts.seed);
    for (const collName of Object.keys(plan.collections)) {
      const coll = targetDb.collection(collName);
      const total = plan.collections[collName];
      const batchLimit = collName === "user_events" ? 50 : BATCH_SIZE;
      const gen = makeGeneratorForCollection(collName, rng, plan.collections, plan);
      let batch = [];
      let inserted = 0;

      for (const doc of gen) {
        batch.push(doc);
        if (batch.length >= batchLimit) {
          await coll.insertMany(batch, { ordered: false });
          inserted += batch.length;
          batch = [];
        }
      }
      if (batch.length > 0) {
        await coll.insertMany(batch, { ordered: false });
        inserted += batch.length;
      }

      const idxSpecs = plan.indexes[collName] || [];
      for (const spec of idxSpecs) {
        await coll.createIndex(spec[0], spec[1]);
      }
      console.log(
        "[node] Loaded " + collName + ": " + inserted + "/" + total +
        " docs, extra indexes=" + idxSpecs.length
      );
    }

    const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
    console.log("[node] Completed in " + elapsedSec + "s.");
    for (const note of plan.notes) {
      console.log("[info] " + note);
    }
  } finally {
    await client.close();
  }
}

function main() {
  let argv = [];
  if (isMongoshRuntime()) {
    argv = Array.isArray(globalThis.LAB_ARGS) ? globalThis.LAB_ARGS : [];
  } else if (typeof process !== "undefined" && Array.isArray(process.argv)) {
    argv = process.argv.slice(2);
  }

  let opts;
  try {
    opts = parseOptions(argv);
  } catch (err) {
    console.error("Error: " + err.message);
    printUsage();
    if (!isMongoshRuntime() && typeof process !== "undefined") {
      process.exitCode = 1;
    }
    return;
  }

  if (opts.help) {
    printUsage();
    return;
  }

  const plan = buildScenarioPlan(opts.scenario, opts.scale);

  if (opts.dryRun) {
    runDryRun(opts, plan);
    return;
  }

  if (isMongoshRuntime()) {
    runInMongosh(opts, plan);
    return;
  }

  runInNode(opts, plan).catch((err) => {
    console.error("[node] Generator failed: " + err.message);
    process.exitCode = 1;
  });
}

main();
