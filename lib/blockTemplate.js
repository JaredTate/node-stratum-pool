var merkleTree = require('./merkleTree.js');
var transactions = require('./transactions.js');
var util = require('./util.js');

/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin
**/
var BlockTemplate = module.exports = function BlockTemplate(jobId, rpcData, poolAddressScript, extraNoncePlaceholder, reward, txMessages, recipients, network, emitLog, versionMaskConfig) {

    // private members
    var submits = [];

    // ASICBoost/BIP310: when version rolling is enabled for this coin, the
    // rolling region of the JOB version must be all zeros. BM13xx-class ASICs
    // replace bits 13-28 wholesale, and common firmware (ESP-Miner/NerdQAxe)
    // reconstructs the hashed version with a bitwise OR that assumes the job's
    // rolled region was zero — any bit the node pre-sets inside the mask (e.g.
    // DigiByte's DigiDollar BIP9 bit 23 in v9.26.x templates) silently corrupts
    // about half of all shares. BIP9 signal bits are never a validity
    // requirement, so stripping them from the job is always consensus-safe;
    // the chip's roll re-sets bit 23 on roughly half the blocks anyway.
    // Coins without version_mask (non-rolling algos) keep the node's version
    // untouched, so their DigiDollar signaling is preserved.
    if (versionMaskConfig) {
        var jobVersionMask = parseInt(String(versionMaskConfig).replace(/^0x/i, ''), 16);
        if (!isNaN(jobVersionMask)) {
            rpcData.version = rpcData.version & ~jobVersionMask;
        }
    }

    function getMerkleHashes(steps){
        emitLog('Merkle steps: ' + JSON.stringify(steps));
        return steps.map(function(step){
            return step.toString('hex');
        });
    }

    function getTransactionBuffers(txs) {
        emitLog('Transactions for merkle root:');
        var txHashes = txs.map(function (tx, index) {
            var hash = tx.txid !== undefined ? tx.txid : tx.hash;
            emitLog(`${index}: ${hash}`);
            return util.uint256BufferFromHash(hash);
        });
        return [null].concat(txHashes);
    }

    function getVoteData() {
        if (!rpcData.masternode_payments) return Buffer.alloc(0);

        return Buffer.concat(
            [util.varIntBuffer(rpcData.votes.length)].concat(
                rpcData.votes.map(function (vt) {
                    return Buffer.from(vt, 'hex');
                })
            )
        );
    }

    // public members
    this.rpcData = rpcData;
    this.jobId = jobId;

    this.target = rpcData.target ?
        BigInt('0x' + rpcData.target) :
        util.bignumFromBitsHex(rpcData.bits);

    this.difficulty = Number((diff1 / Number(this.target)).toFixed(9));

    this.prevHashReversed = util.reverseByteOrder(Buffer.from(rpcData.previousblockhash, 'hex')).toString('hex');
    if (rpcData.finalsaplingroothash) {
        this.finalsaplingroothashReversed = util.reverseByteOrder(Buffer.from(rpcData.finalsaplingroothash, 'hex')).toString('hex');
    }
    if (rpcData.hashstateroot) {
        this.hashstaterootReversed = util.reverseBuffer(Buffer.from(rpcData.hashstateroot, 'hex')).toString('hex');
    }
    if (rpcData.hashutxoroot) {
        this.hashutxorootReversed = util.reverseBuffer(Buffer.from(rpcData.hashutxoroot, 'hex')).toString('hex');
    }
    this.transactionData = Buffer.concat(rpcData.transactions.map(function (tx) {
        return Buffer.from(tx.data, 'hex');
    }));
    this.merkleTree = new merkleTree(getTransactionBuffers(rpcData.transactions));
    this.merkleBranch = getMerkleHashes(this.merkleTree.steps);
    this.generationTransaction = transactions.CreateGeneration(
        rpcData,
        poolAddressScript,
        extraNoncePlaceholder,
        reward,
        txMessages,
        recipients,
        network
    );

    this.serializeCoinbase = function (extraNonce1, extraNonce2) {
        return Buffer.concat([
            this.generationTransaction[0],
            extraNonce1,
            extraNonce2,
            this.generationTransaction[1]
        ]);
    };

    // https://en.bitcoin.it/wiki/Protocol_specification#Block_Headers
    this.serializeHeader = function (merkleRoot, nTime, nonce, versionMask) {
        var headerSize;
        if (rpcData.version == 5 && rpcData.finalsaplingroothash) {
            headerSize = 112;
        } else if (rpcData.hashstateroot && rpcData.hashutxoroot) {
            headerSize = 181;
        } else {
            headerSize = 80;
        }

        var header = Buffer.alloc(headerSize);
        var position = 0;

        /*
        console.log('headerSize:' + headerSize);
        console.log('rpcData.finalsaplingroothash:' + rpcData.finalsaplingroothash);
        console.log('rpcData.hashutxoroot: ' + rpcData.hashutxoroot);
        console.log('rpcData.hashstateroot: ' + rpcData.hashstateroot);
        console.log('nonce:' + nonce);
        console.log('rpcData.bits: ' + rpcData.bits);
        console.log('nTime: ' + nTime);
        console.log('merkleRoot: ' + merkleRoot);
        console.log('rpcData.previousblockhash: ' + rpcData.previousblockhash);
        console.log('rpcData.version: ' + rpcData.version);
        */

        if (rpcData.version == 5 && rpcData.finalsaplingroothash) {
            header.write(rpcData.finalsaplingroothash, position, 32, 'hex');
            position += 32;
        }
        if (rpcData.hashstateroot && rpcData.hashutxoroot) {
            header.write('00ffffffff000000000000000000000000000000000000000000000000000000000000', position, 37, 'hex');
            header.write(rpcData.hashutxoroot, position += 37, 32, 'hex');
            header.write(rpcData.hashstateroot, position += 32, 32, 'hex');
            header.write(nonce, position += 32, 4, 'hex');
        }
        header.write(nonce, position, 4, 'hex');
        header.write(rpcData.bits, position += 4, 4, 'hex');
        header.write(nTime, position += 4, 4, 'hex');
        header.write(merkleRoot, position += 4, 32, 'hex');
        header.write(rpcData.previousblockhash, position += 32, 32, 'hex');
        
        // Apply version mask for ASICBoost if provided
        var finalVersion = rpcData.version;
        if (versionMask && versionMaskConfig) {
            // Remove 0x prefix if present
            var cleanMask = versionMaskConfig.replace(/^0x/i, '');
            var poolMask = parseInt(cleanMask, 16);
            // Combine base version with miner's version bits
            // nVersion = (job_version & ~mask) | (version_bits & mask)
            finalVersion = (rpcData.version & ~poolMask) | (versionMask & poolMask);
        }
        
        header.writeUInt32BE(finalVersion, position + 32);
        return util.reverseBuffer(header);
    };

    this.serializeBlock = function (header, coinbase) {
        return Buffer.concat([
            header,
            util.varIntBuffer(this.rpcData.transactions.length + 1),
            coinbase,
            this.transactionData,
            getVoteData(),
            Buffer.from(reward === 'POS' ? [0] : [])
        ]);
    };

    this.registerSubmit = function (extraNonce1, extraNonce2, nTime, nonce, versionBits) {
        // versionBits participates in uniqueness: with version rolling, two
        // valid shares can legitimately differ only in their rolled version.
        var submission = extraNonce1 + extraNonce2 + nTime + nonce + (versionBits || '');
        if (submits.indexOf(submission) === -1) {
            submits.push(submission);
            return true;
        }
        return false;
    };

    this.getOdoKey = function () {
        if (this.rpcData && this.rpcData.odokey !== undefined) {
            return this.rpcData.odokey;
        }
        return null;
    };

    this.getJobParams = function () {
        if (!this.jobParams) {
            this.jobParams = [
                this.jobId,
                this.prevHashReversed,
                this.generationTransaction[0].toString('hex'),
                this.generationTransaction[1].toString('hex'),
                this.merkleBranch,
                util.packInt32BE(this.rpcData.version).toString('hex'),
                this.rpcData.bits,
                util.packUInt32BE(this.rpcData.curtime).toString('hex'),
                true
            ];
            if (this.finalsaplingroothashReversed) {
                this.jobParams.push(this.finalsaplingroothashReversed);
            }
            if (this.hashstaterootReversed && this.hashutxorootReversed) {
                this.jobParams.push(this.hashstaterootReversed);
                this.jobParams.push(this.hashutxorootReversed);
                this.jobParams.push('0000000000000000000000000000000000000000000000000000000000000000ffffffff00');
            }
        }
        return this.jobParams;
    };
};