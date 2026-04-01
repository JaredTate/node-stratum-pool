# node-stratum-pool Repository Map

Scope: source files under `lib/` plus package entry metadata. Paths validated in `/home/jared/Code/node-stratum-pool` (excluding `.git` and `node_modules`).

### package.json
- Package metadata for `stratum-pool` module (`version 0.2.9`, GPL-2.0).
- Entry point: `main = lib/index.js`.
- Dependencies:
  - `@exodus/bitcoinjs-lib-zcash`
  - `async`
  - `bitcoinjs-lib`
  - `multi-hashing`
- Script: `test` -> `node lib/test.js` (test file not present in current tree scan).

### lib/index.js
- Requires `./algoProperties.js` (initializes global algorithm registry).
- Imports `./pool.js` constructor.
- **Exports:**
  - `exports.daemon = require('./daemon.js')`
  - `exports.varDiff = require('./varDiff.js')`
  - `exports.createPool(poolOptions, authorizeFn)` -> returns `new pool(...)`.

### lib/algoProperties.js
- Defines global baseline difficulty constant:
  - `global.diff1` (BigInt-like numeric literal for PoW target baseline).
- Builds and exports algorithm registry:
  - `module.exports = global.algos = { ... }`.
- **Per-algo entries** provide:
  - `hash(coinConfig?)` factory returning a hashing function.
  - optional `multiplier` for diff normalization.
  - optional `diff` override for specific variants.
- Includes many algorithms (`sha256`, `scrypt`, `x11`, `x16r`, `keccak`, `yespower*`, `lyra*`, etc.).
- Final loop ensures default `multiplier = 1` for all algos without explicit value.

### lib/blockTemplate.js
- **Class/function:** `BlockTemplate(jobId, rpcData, poolAddressScript, extraNoncePlaceholder, reward, txMessages, recipients, network, emitLog, versionMaskConfig)`.
- Private helpers:
  - `getMerkleHashes(steps)`
  - `getTransactionBuffers(txs)`
  - `getVoteData()`
- Instance state:
  - `rpcData`, `jobId`, `target`, `difficulty`
  - reversed hash/header-related fields
  - transaction data, merkle tree/branch, generation tx parts
- **Methods:**
  - `serializeCoinbase(extraNonce1, extraNonce2)`
  - `serializeHeader(merkleRoot, nTime, nonce, versionMask)` (supports ASICBoost version mask)
  - `serializeBlock(header, coinbase)`
  - `registerSubmit(extraNonce1, extraNonce2, nTime, nonce)` (duplicate share prevention)
  - `getOdoKey()`
  - `getJobParams()` (Stratum notify payload)
- **Export:** `module.exports = BlockTemplate`.

### lib/daemon.js
- **Class/function:** `DaemonInterface(daemons, logger)`.
- Private helpers:
  - `init()`
  - `isOnline(callback)`
  - `performHttpRequest(instance, jsonData, callback)`
  - `batchCmd(cmdArray, callback)` (batch RPC against first daemon)
  - `cmd(method, params, callback, streamResults, returnRawData)` (fan-out RPC over all daemons)
- Handles RPC compatibility fallback (`getnetworkinfo` -> `getinfo`).
- Emits daemon status events (`online`, `connectionFailed`, etc.).
- **Public methods assigned on instance:** `init`, `isOnline`, `cmd`, `batchCmd`.
- **Export:** `exports.interface = DaemonInterface`.

### lib/jobManager.js
- Helper constructors:
  - `ExtraNonceCounter(configInstanceId)` with methods `next()`, `size`
  - `JobCounter()` with methods `next()`, `cur()`
- **Class/function:** `JobManager(options)` (`EventEmitter`).
- Core state:
  - `extraNonceCounter`, `extraNoncePlaceholder`, `extraNonce2Size`
  - `currentJob`, `validJobs`
- Internal strategy functions:
  - `coinbaseHasher` selection by algorithm
  - `blockHasher` selection by algorithm/reward mode
  - `getKotoFoundersReward(rpcData, recipients)`
- **Methods:**
  - `updateCurrentJob(rpcData)`
  - `processTemplate(rpcData)` -> returns whether new block template processed
  - `processShare(jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, versionMask, isSoloMining)`
- Emits:
  - `newBlock`, `updatedBlock`, `share`, `log`.
- **Export:** `module.exports = JobManager`.

### lib/merkleTree.js
- **Class/function:** `MerkleTree(data)`.
- Private helpers:
  - `merkleJoin(h1, h2)`
  - `calculateSteps(data)`
- Instance properties:
  - `this.data`
  - `this.steps` (merkle branch steps)
- Prototype method:
  - `withFirst(f)` computes final root from first hash + steps.
- **Export:** `module.exports = MerkleTree`.

### lib/peer.js
- Private utility functions:
  - `fixedLenStringBuffer(s, len)`
  - `commandStringBuffer(s)`
  - `readFlowingBytes(stream, amount, preRead, callback)`
- **Class/function:** `Peer(options)` (`EventEmitter`) for daemon P2P connectivity.
- Internal flow:
  - `Connect()`
  - `SetupMessageParser(client)`
  - `HandleInv(payload)`
  - `HandleMessage(command, payload)`
  - `SendMessage(command, payload)`
  - `SendVersion()`
- Emits:
  - `connected`, `disconnected`, `connectionRejected`, `connectionFailed`, `socketError`, `error`, `blockFound`, plus debug peer message events.
- **Export:** `module.exports = Peer`.

### lib/pool.js
- **Class/function:** `pool(options, authorizeFn)` (`EventEmitter`) — top-level orchestrator.
- **Primary public methods:**
  - `start()`
  - `processBlockNotify(blockHash, sourceTrigger)`
  - `relinquishMiners(filterFn, resultCback)`
  - `attachMiners(miners)`
  - `getStratumServer()`
  - `setVarDiff(port, varDiffConfig)`
- Internal startup and runtime functions include:
  - `GetBlockTemplateParameters()`
  - `GetFirstJob(...)`
  - `OutputPoolInfo()`
  - `OnBlockchainSynced(...)`
  - `SetupApi()`
  - `SetupPeer()`
  - `SetupVarDiff()`
  - `SubmitBlock(blockHex, callback)`
  - `SetupRecipients()`
  - `SetupJobManager()`
  - `SetupDaemonInterface(...)`
  - `DetectCoinData(...)`
  - `StartStratumServer(...)`
  - `SetupBlockPolling()`
  - `GetBlockTemplate(callback)`
  - `CheckBlockAccepted(blockHash, callback)`
- Wires events between daemon, job manager, peer, and stratum server.
- **Export:** `module.exports = pool`.

### lib/stratum.js
- Constants/helpers:
  - `isValidHexRegex`
  - `SubscriptionCounter()`
  - `NiceHashAPI` class (`refresh()` promise-based HTTP JSON fetch)
  - NiceHash data initialization/update scheduler (`maybeUpdateNiceHashAPIInformation`)
- **Class/function:** `StratumClient(options)` (`EventEmitter`)
  - Handles miner protocol methods and socket lifecycle.
  - Key handlers:
    - `handleMessage`
    - `handleExtraNonceSubscribe`
    - `handleSubscribe`
    - `handleAuthorize`
    - `handleSubmit`
    - `handleSuggestTarget`
    - `handleSuggestDifficulty`
    - `handleConfigure` (ASICBoost/version-rolling negotiation)
    - `sendJson`, `setupSocket`
  - Public methods:
    - `init()`
    - `getLabel()`
    - `enqueueNextDifficulty(requestedNewDifficulty)`
    - `sendDifficulty(difficulty)`
    - `sendMiningJob(jobParams, odoKey)`
    - `manuallyAuthClient(username, password)`
    - `manuallySetValues(otherClient)`
- **Class/function:** `StratumServer(options, authorizeFn)` (`EventEmitter`)
  - Manages active clients and listening sockets.
  - Key internal helpers: `checkBan`, server init/listeners.
  - Public methods:
    - `handleNewClient(socket)`
    - `broadcastMiningJobs(jobParams, odoKey)`
    - `addBannedIP(ipAddress)`
    - `getStratumClients()`
    - `removeStratumClientBySubId(subscriptionId)`
    - `manuallyAddStratumClient(clientObj)`
- **Exports:**
  - `exports.Server = StratumServer`.

### lib/stratum_asicboost_debug.js
- Standalone debug helper module for ASICBoost instrumentation (not imported by default in current code path).
- Functions:
  - `handleConfigureWithLogging(message)`
  - `handleSubmitWithLogging(message)`
  - `countSetBits(n)`
  - `logConnectionDetails()`
  - `logDisconnectionDetails(reason)`
- **Export:** object containing above functions.

### lib/transactions.js
- Private function:
  - `generateOutputTransactions(poolRecipient, recipients, rpcData, network, poolOptions)`
    - Computes coinbase outputs (pool, recipients, masternode/superblock/payee, witness commitment).
- **Exported function:**
  - `exports.CreateGeneration(rpcData, publicKey, extraNoncePlaceholder, reward, txMessages, recipients, network, poolOptions)`
  - Returns `[p1, p2]` split coinbase transaction around extranonce placeholder.

### lib/util.js
- **Address/key/script helpers:**
  - `addressFromEx`, `getVersionByte`, `pubkeyToScript`, `miningKeyToScript`, `addressToScript`, `kotoAddressToScript`, `getFounderRewardScript`, `getKotoFounderRewardScript`
- **Hash/byte helpers:**
  - `sha256`, `sha256d`, `reverseBuffer`, `reverseHex`, `reverseByteOrder`, `uint256BufferFromHash`, `hexFromReversedBuffer`
- **Serialization helpers:**
  - `varIntBuffer`, `varStringBuffer`, `serializeNumber`, `serializeString`, `packUInt16LE`, `packInt32LE`, `packInt32BE`, `packUInt32LE`, `packUInt32BE`, `packInt64LE`
- **Math/difficulty helpers:**
  - `range`, `shiftMax256Right`, `bufferToCompactBits`, `bignumFromBuffer`, `bignumFromBitsBuffer`, `bignumFromBitsHex`, `convertBitsToBuff`, `getTruncatedDiff`
- **Misc/runtime helpers:**
  - `getReadableHashRateString`
  - `setBlockIdentifier`, `getBlockIdentifier`
  - Koto consensus/subsidy: `setupKotoConsensusParams`, `getKotoBlockSubsidy`

### lib/varDiff.js
- Helper class/function:
  - `RingBuffer(maxSize)` with methods `append`, `avg`, `size`, `clear`
- Helper function:
  - `toFixed(num, len)`
- **Class/function:** `varDiff(port, varDiffOptions)` (`EventEmitter`)
  - Public method `manageClient(client)` tracks share timing and emits diff adjustments.
  - Emits `newDifficulty(client, newDiff)`.
- **Export:** `module.exports = varDiff`.