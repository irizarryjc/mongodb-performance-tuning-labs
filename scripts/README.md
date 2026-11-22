# Lab Dataset Generator (`generate-perf-lab.js`)

Deterministic dataset generator for *MongoDB Performance Tuning: A Diagnostic Field Guide*
by Juan C. Irizarry, OCP.

Companion repository: `https://github.com/irizarryjc/mongodb-performance-tuning-labs`

This script creates skewed, repeatable test collections in `<db_perf_lab>` (default:
`perf_lab`) to reproduce Labs L1 through L12. It runs in **Node.js** (with the official
`mongodb` driver) or directly inside **`mongosh`** with zero extra npm dependencies.

> **Safety notice:** Run this script only against an isolated lab instance. Never run
> `--reset` or load generation against production or shared staging databases.

## Quick Start

### Option A: Run with `mongosh` (No `npm install` Required)

Export your lab connection string from a protected environment file or connect to a local
auth-disabled lab instance, then pass options through `LAB_*` environment variables:

```bash
export MONGO_URI="mongodb://<primary_host>:<port>/<db_perf_lab>"
LAB_DB=perf_lab LAB_SEED=42 LAB_SCALE=1 LAB_SCENARIO=all LAB_RESET=1 \
  mongosh "$MONGO_URI" --file scripts/generate-perf-lab.js
```

You can also pass flag arrays through `--eval` and `load()`:

```bash
mongosh "$MONGO_URI" --eval \
  'globalThis.LAB_ARGS=["--db","perf_lab","--seed","42","--reset","--scenario","collscan"]; \
   load("scripts/generate-perf-lab.js");'
```

If your lab enables authentication, omit the password from the URI and let `mongosh`
prompt interactively:

```bash
LAB_SCENARIO=collscan LAB_RESET=1 \
  mongosh "mongodb://<primary_host>:<port>/<db_perf_lab>" \
    --username app_user --authenticationDatabase admin --password \
    --file scripts/generate-perf-lab.js
```

### Option B: Run with Node.js

Install the official MongoDB Node.js driver once in a working directory, then invoke the
script with standard CLI flags:

```bash
npm install mongodb
export MONGO_URI="mongodb://<primary_host>:<port>"
node scripts/generate-perf-lab.js --db perf_lab --seed 42 --scale 1 --reset --scenario all
```

### Dry Run (Preview Plan Without Connecting)

Verify counts, sample document sizes, and indexes without touching MongoDB:

```bash
node scripts/generate-perf-lab.js --dry-run --scenario all --seed 42 --scale 1
```

## Command-Line Flags and Environment Variables

| Flag | `mongosh` Env Var | Default | Description |
|---|---|---|---|
| `--uri <uri>` | `MONGO_URI` | `mongodb://127.0.0.1:27017` | Target MongoDB URI (prefer `MONGO_URI` env var; never pass plaintext passwords on CLI). |
| `--db <name>` | `LAB_DB` | `perf_lab` | Target database name (`<db_perf_lab>`). |
| `--seed <int>` | `LAB_SEED` | `42` | Positive integer seed for the deterministic PRNG. |
| `--scale <float>` | `LAB_SCALE` | `1` | Document count multiplier (`0.2` smoke test, `1` default, `2`–`3` heavy cache pressure). |
| `--scenario <name>` | `LAB_SCENARIO` | `all` | Scenario preset to build (see table below). |
| `--reset` | `LAB_RESET=1` | `false` | Drops all seven lab collections before loading the requested scenario. |
| `--reset-only` | None | `false` | Drops all seven lab collections and exits without inserting data. |
| `--dry-run` | None | `false` | Prints planned collections, counts, sample doc sizes, and indexes without connecting. |
| `--help` | None | None | Prints CLI usage and exits. |

## Collections and Deliberate Skew (`--scale 1`)

| Collection | Baseline Docs | Key Fields | Deliberate Skew Built In |
|---|---:|---|---|
| `customers` | 10,000 | `_id`, `customerId`, `email`, `tier`, `region`, `isHeavyAccount`, `lifetimeCents`, `createdAt` | `CUST-00001` through `CUST-00050` are heavy enterprise accounts. |
| `products` | 5,000 | `_id`, `sku`, `name`, `category`, `brand`, `priceCents`, `stockQty`, `isHotSku`, `tags`, `updatedAt` | `SKU-00001` through `SKU-00020` are flagged as hot catalog items. |
| `orders` | 100,000 | `_id`, `orderId`, `customerId`, `status`, `region`, `priority`, `channel`, `itemCount`, `totalCents`, `createdAt`, `updatedAt`, `notes` | `CUST-00001` owns ~4% of orders; top 50 own ~25%; `status="shipped"` is 68%, `pending` is 8%. |
| `order_items` | 250,000 | `_id`, `orderId`, `customerId`, `sku`, `qty`, `unitPriceCents`, `lineTotalCents`, `warehouse`, `createdAt` | Top 5 SKUs take ~12% of line items; top 20 SKUs take ~35%. |
| `reviews` | 50,000 | `_id`, `sku`, `customerId`, `rating`, `verifiedPurchase`, `helpfulVotes`, `title`, `body`, `createdAt` | Skewed toward hot SKUs and heavy accounts; `body` size expands in `cache-pressure`. |
| `user_events` | 2,000 | `_id`, `customerId`, `region`, `isPowerUser`, `eventCount`, `lastEventAt`, `events[]` | Top 25 users (`USER-00001`..`USER-00025`) embed 4,000–7,500 events in `--scenario all`, and 5,000–9,000 in `--scenario unbounded-array` (~0.8–1.5 MB/doc). |
| `shard_demo` | 120,000 | `_id`, `seqId`, `tenantId`, `region`, `eventType`, `amountCents`, `createdAt`, `payload` | Monotonic `seqId` and `createdAt`; `TENANT-HOT` owns ~55% of rows. |

## Scenario Presets (Labs L1–L12)

| Scenario | Lab | Chapter | Starting State Built |
|---|---|---|---|
| `all` | Baseline | Ch. 2 | All 7 collections loaded with minimal indexes (`customers.email`, `products.sku`). |
| `collscan` | L1 | Ch. 4 | `customers` + `orders` (`_id` index only) so checkout queries run `COLLSCAN`. |
| `wrong-index` | L2 | Ch. 4 | `orders` with `idx_orders_status`, `idx_orders_region_created`, `idx_orders_customer`. |
| `sort-limit` | L3 | Ch. 7 | `orders` padded with ~1.8 KB `notes` and only `idx_orders_region_only` (triggers 100 MB sort cap). |
| `unbounded-array` | L4 | Ch. 6 | `user_events` with 5,000–9,000 embedded events on top 25 power users. |
| `cache-pressure` | L5 | Ch. 8 | Padded `orders`/`reviews`, `order_items`, and wide indexes exceeding tight WiredTiger cache. |
| `tickets` | L6 | Ch. 8 | Hot SKUs in `products` + `orders` + unindexed `order_items` for concurrency contention. |
| `lookup` | L7 | Ch. 7 | `products`, `orders`, and `order_items` with NO index on `order_items.orderId` or `sku`. |
| `repl-lag` | L8 | Ch. 10 | Padded `orders` + unindexed `reviews` for write-burst and secondary-read lag labs. |
| `hot-shard` | L9 | Ch. 10 | `shard_demo` with monotonic `seqId`/`createdAt` and `TENANT-HOT` (55% skew). |
| `connection-storm` | L10 | Ch. 9 | Lightweight indexed `customers` and `orders` to isolate connection-pool overhead. |
| `thp` | L11 | Ch. 11 | Multi-index working set across `orders`, `order_items`, `reviews` for Linux THP testing. |
| `capstone` | L12 | Ch. 12 | Mixed clues: poor `status` index, unused `notes` index, unindexed `order_items`, bloated `user_events`. |

## Resetting the Lab

To wipe all seven collections before loading a different scenario, include `--reset`:

```bash
node scripts/generate-perf-lab.js --db perf_lab --seed 42 --reset --scenario lookup
```

To wipe all lab collections without loading new data:

```bash
node scripts/generate-perf-lab.js --db perf_lab --reset-only
```

Or drop the lab database directly inside `mongosh`:

```javascript
use perf_lab
db.dropDatabase()
```

## Runtime and Resource Expectations (`--scale 1`)

- **Full load (`--scenario all`):** ~537,000 documents across 7 collections; roughly 280–360 MB
  uncompressed data (~100–160 MB on disk under WiredTiger snappy compression, plus indexes).
- **Load duration:** roughly 30 to 90 seconds on a 4-vCPU SSD host or laptop container.
- **Smaller hosts:** pass `--scale 0.25` for fast smoke runs; pass `--scale 2` or `--scale 3`
  when testing cache eviction in Chapter 8 on hosts with larger RAM allocations.
