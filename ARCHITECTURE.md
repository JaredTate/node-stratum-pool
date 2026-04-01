# node-stratum-pool Architecture

## Executive Summary

`node-stratum-pool` is a Node.js module that implements a Stratum mining pool server with daemon RPC integration, job/template lifecycle management, variable difficulty (VarDiff), and optional daemon P2P block notification. The core runtime path is:

1. initialize pool + daemon connectivity,
2. derive coin/network/reward/runtime metadata from RPC,
3. build and broadcast mining jobs to connected miners,
4. validate submitted shares,
5. submit candidate blocks back to daemons and confirm acceptance.

The code is event-driven (`EventEmitter` heavily used), with `pool.js` as the orchestrator and `stratum.js` + `jobManager.js` as the two critical hot paths.

---

## System Overview

### High-level architecture

```text
                    +---------------------------+
                    |       Coin Daemon(s)      |
                    |  RPC: getblocktemplate,   |
                    |  submitblock, getblock... |
                    +------------+--------------+
                                 ^
                                 | JSON-RPC (daemon.js)
                                 |
+------------------+    events   |      +-------------------------+
|  Miners (TCP)    +------------->+-----+     Pool Orchestrator   |
|  Stratum clients |<-------------+     |        (pool.js)        |
+--------+---------+ jobs/diff          +-----+------------+------+
         ^                                  |            |
         | Stratum protocol                 |            |
         | (stratum.js)                     |            |
         |                                  |            |
         |                          +-------v----+ +-----v------+
         |                          | JobManager | | VarDiff     |
         | shares                   |(job/share) | |(retargeting)|
         |                          +-------+----+ +------------+
         |                                  |
         |                          builds/validates
         |                                  |
         |                          +-------v------------------+
         |                          | BlockTemplate + Tx Build |
         |                          | (blockTemplate.js,       |
         |                          |  transactions.js, merkle)|
         |                          +--------------------------+
         |
         +----- optional P2P block notifications (peer.js) -----+
```

### Runtime responsibilities

- **`lib/pool.js`**: startup sequencing, daemon discovery, job polling/updates, share/block event wiring.
- **`lib/stratum.js`**: TCP server, miner session handling, protocol methods (`subscribe`, `authorize`, `submit`, `configure`), ban logic.
- **`lib/jobManager.js`**: current/valid job set, share validation, block candidate assembly.
- **`lib/blockTemplate.js` + `lib/transactions.js` + `lib/merkleTree.js`**: coinbase construction, merkle branch/root, block/header serialization.
- **`lib/daemon.js`**: RPC fan-out to one or many daemon instances.
- **`lib/peer.js`**: optional raw P2P listener for faster block notifications.
- **`lib/varDiff.js`**: adaptive per-miner share difficulty.
- **`lib/algoProperties.js`**: hash algorithm registry and per-algo multipliers/hash functions.

---

## Directory Structure

Validated from repository scan (`find ... -not -path '*/.git/*' -not -path '*/node_modules/*' -type f`):

```text
node-stratum-pool/
├── lib/
│   ├── algoProperties.js
│   ├── blockTemplate.js
│   ├── daemon.js
│   ├── index.js
│   ├── jobManager.js
│   ├── merkleTree.js
│   ├── peer.js
│   ├── pool.js
│   ├── stratum.js
│   ├── stratum_asicboost_debug.js
│   ├── transactions.js
│   ├── util.js
│   └── varDiff.js
├── package.json
├── README.md
├── LICENSE
├── .github/workflows/node.js.yml
├── .circleci/config.yml
├── .travis.yml
├── .gitignore
└── .npmignore
```

---

## Key Components

### 1) Entry and exports
- **`lib/index.js`** loads algorithm globals and exports:
  - `createPool(poolOptions, authorizeFn)`
  - daemon and vardiff modules

### 2) Pool lifecycle orchestration (`lib/pool.js`)
Startup pipeline in `start()`:
1. `SetupVarDiff()`
2. `SetupApi()` (optional external API hook)
3. `SetupDaemonInterface()`
4. `DetectCoinData()` (address validity, reward type, network, protocol version, initial stats)
5. `SetupRecipients()` (fee outputs/scripts)
6. `SetupJobManager()`
7. wait for chain sync (`OnBlockchainSynced()`)
8. first template/job (`GetFirstJob()`)
9. block polling + optional P2P
10. start Stratum server + broadcast first job

### 3) Daemon RPC layer (`lib/daemon.js`)
- Supports multiple daemon backends.
- `cmd()` can stream per-daemon results or return batched results after fan-out.
- `batchCmd()` sends a JSON-RPC array to primary daemon.
- Handles fallback from `getnetworkinfo` to `getinfo` for legacy daemons.

### 4) Stratum server and miner sessions (`lib/stratum.js`)
- `StratumServer`: listens on configured ports and tracks `StratumClient`s.
- `StratumClient` handles protocol methods:
  - `mining.subscribe`
  - `mining.authorize`
  - `mining.submit`
  - `mining.configure` (version-rolling / ASICBoost support)
  - difficulty suggestion + ping/pong
- Supports TCP proxy protocol parsing, connection timeout handling, malformed message rejection, anti-flooding, and banning.

### 5) Job and share processing (`lib/jobManager.js`)
- Generates unique extranonce and job IDs.
- Maintains `currentJob` and `validJobs`.
- `processTemplate()` detects new blocks by previous hash/height.
- `processShare()` validates input, reconstructs coinbase/header, hashes share, checks difficulty, detects block candidates, emits detailed share metadata.

### 6) Block/transaction assembly
- **`lib/blockTemplate.js`**: transforms RPC template into serialized mining job/block material.
- **`lib/transactions.js`**: builds coinbase tx split around extranonce placeholder; handles special outputs (masternode/superblock/payee/founders/witness commitment).
- **`lib/merkleTree.js`**: computes merkle steps for Stratum branch transmission and final root derivation.

### 7) Utility and algorithm abstraction
- **`lib/algoProperties.js`**: binds algo names to `multi-hashing` calls and multipliers.
- **`lib/util.js`**: cryptographic helpers, serialization, address/script conversion (`bitcoinjs-lib` + Zcash lib), compact bits math, Koto subsidy helpers.
- **`lib/varDiff.js`**: ring-buffer based retarget mechanism around `targetTime`/variance bounds.

### 8) Optional P2P block notification (`lib/peer.js`)
- Opens raw peer connection to daemon p2p port.
- Handles version/verack + inv parsing.
- Emits `blockFound` to trigger pool template refresh.

---

## Data Flow

### A) Startup / initialization
1. `createPool()` returns `pool` instance.
2. `pool.start()` validates algorithm and config.
3. Daemon connectivity checked (`daemon.init()` -> `online`).
4. RPC introspection determines:
   - reward model (`POW`/`POS`)
   - mainnet/testnet object
   - protocol version and stats
   - block submission RPC mode (`submitblock` vs `getblocktemplate submit`)

### B) Job generation / broadcast
1. Pool calls `getblocktemplate`.
2. `JobManager.processTemplate()` creates `BlockTemplate` when new block is detected.
3. Stratum broadcasts `mining.notify` with job params to all clients.
4. VarDiff may queue/send difficulty updates before next job.

### C) Share submission path
1. Miner sends `mining.submit`.
2. Stratum validates auth/subscription/session formatting.
3. `JobManager.processShare()`:
   - validates extranonce/time/nonce/job existence/duplicate submit,
   - reconstructs coinbase,
   - computes merkle root + header,
   - hashes header with configured PoW algorithm,
   - compares against share target and network target.
4. Emits pool `share` event with validity and block candidate details.

### D) Block candidate acceptance
1. If share meets network target, serialize full block hex.
2. Submit via detected RPC command.
3. Confirm with `getblock` lookup.
4. Emit final share/block result and refresh template.

---

## Configuration and Deployment

## Runtime configuration surface (from code + README)
- `coin` (algorithm, network params, optional ASICBoost `version_mask`, optional Koto settings)
- `address` / dynamic address acquisition (`false`)
- `rewardRecipients` (fee outputs)
- `ports` (base diff and optional `varDiff` per port)
- `daemons[]` (host, port, user, password, optional maxSockets)
- `p2p` (enable, host, port, disableTransactions)
- `banning` (enable/time/thresholds)
- `blockRefreshInterval`
- `jobRebroadcastTimeout`
- `connectionTimeout`
- `tcpProxyProtocol`
- `emitInvalidBlockHashes`

## Deployment notes
- Module package (`main: lib/index.js`) designed to be embedded by a higher-level pool app (e.g., NOMP-style integration).
- Requires reachable daemon RPC and valid payout address semantics (especially strict for POS/pubkey requirement).
- Multi-daemon support provides redundancy in polling/submission.

---

## Technical Decisions and Tradeoffs

1. **Event-driven core architecture**
   - Pros: loose coupling between networking, job lifecycle, and share processing.
   - Tradeoff: async event chains can complicate failure tracing.

2. **Global algorithm registry (`global.algos`, `global.diff1`)**
   - Pros: simple cross-module access, low call overhead.
   - Tradeoff: implicit dependency and global state coupling.

3. **Template polling + optional P2P notifications**
   - Pros: robust fallback if P2P disabled/broken; P2P can improve new-block latency.
   - Tradeoff: polling interval tuning impacts daemon load vs responsiveness.

4. **Multi-daemon fan-out for RPC commands**
   - Pros: redundancy and better resilience against node failures.
   - Tradeoff: inconsistent daemon states can create noisy edge cases.

5. **Per-port VarDiff and NiceHash-aware behavior**
   - Pros: adapts miner share cadence and supports rental hash sources.
   - Tradeoff: extra complexity in per-client state and diff transitions.

6. **ASICBoost/version-rolling handling in protocol path**
   - Pros: explicit mask validation and extension negotiation support.
   - Tradeoff: mask misconfiguration can silently reject otherwise good shares.

7. **Coin-specific branching (Koto, Dash-style payees, witness commitments)**
   - Pros: broad real-world coin compatibility.
   - Tradeoff: protocol/coin conditionals increase maintenance surface.

---

## Path Validation Notes

All files and paths referenced in this document were validated against on-disk repo contents under:

`/home/jared/Code/node-stratum-pool`

with `.git` and `node_modules` excluded from scan.