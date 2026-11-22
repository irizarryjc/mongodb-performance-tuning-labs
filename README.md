# Lab Scripts for *MongoDB Performance Tuning: A Diagnostic Field Guide*

Companion lab scripts for *MongoDB Performance Tuning: A Diagnostic Field Guide* by Juan C. Irizarry, OCP.

`scripts/generate-perf-lab.js` is a deterministic dataset generator. It builds the skewed, repeatable collections that Labs L1 through L12 start from, using a fixed seed (`--seed 42`) so every reset and reload produces the same document IDs, status ratios, whale accounts, hot SKUs, and starting indexes.

The book's lab baseline is **MongoDB 8.0**.

> **Safety notice:** Run this script only against an isolated lab instance. Never run `--reset`, `--reset-only`, or data generation against production or shared staging databases.

MongoDB is a trademark of MongoDB, Inc. This project is not affiliated with or endorsed by MongoDB, Inc.

## Prerequisites

- MongoDB 8.0 Community Server, running in an isolated lab (laptop, Linux VM, or modest cloud instance). Do not point this script at production.
- `mongosh`, or Node.js with the official MongoDB driver (`npm install mongodb`).
- Clone or copy this repository so the book commands can use the path `scripts/generate-perf-lab.js`.

## How to run it

The commands below are the ones given in Chapter 2 of the book.

Preview the full baseline plan first with `--dry-run` (no database connection):

```bash
[mongo@<primary_host> ~]$ node scripts/generate-perf-lab.js \
  --dry-run --scenario all --seed 42 --scale 1
```

Load the baseline dataset into `<db_perf_lab>` using `mongosh` (pointing `MONGO_URI` at your lab primary without putting a password on the command line):

```bash
[mongo@<primary_host> ~]$ export MONGO_URI="mongodb://<primary_host>:<port>/<db_perf_lab>"
[mongo@<primary_host> ~]$ LAB_DB=perf_lab LAB_SEED=42 LAB_SCALE=1 \
  LAB_SCENARIO=all LAB_RESET=1 \
  mongosh "$MONGO_URI" --file scripts/generate-perf-lab.js
```

If you prefer Node.js CLI syntax directly:

```bash
[mongo@<primary_host> ~]$ node scripts/generate-perf-lab.js \
  --db perf_lab --seed 42 --scale 1 --reset --scenario all
```

To wipe all seven lab collections without reloading:

```bash
[mongo@<primary_host> ~]$ node scripts/generate-perf-lab.js \
  --db perf_lab --reset-only
```

At `--scale 1`, `--scenario all` inserts roughly 537,000 documents. See `scripts/README.md` for flags, collection schemas, scenario presets for Labs L1–L12, and reset procedures.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
