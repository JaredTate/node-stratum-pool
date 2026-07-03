// Version-rolling (ASICBoost/BIP310) job hygiene tests.
//
// DigiByte v9.26.x sets BIP9 bit 23 (DigiDollar) in the GBT version — INSIDE
// the version-rolling window (bits 13-28, mask 0x1fffe000). BM13xx-class
// hardware replaces that whole field with an internal counter and common
// firmware reconstructs with a bitwise OR that assumes the job's rolled
// region was zero, so a pre-set in-mask bit silently corrupts ~half of all
// shares. These tests pin the fix:
//   1. rolling-enabled jobs go out with the rolled region all zeros
//   2. non-rolling coins keep the node's version untouched (bit 23 intact)
//   3. the header merge reconstructs exactly what the chip hashed
//   4. duplicate-share detection distinguishes shares by version bits
//
// Run: node lib/test_versionroll.js

var assert = require('assert');
// algoProperties.js needs native multi-hashing bindings; these tests only
// need the diff1 global it would define (NOMP style).
global.diff1 = 0x00000000ffff0000000000000000000000000000000000000000000000000000;
var BlockTemplate = require('./blockTemplate.js');
var util = require('./util.js');

function makeRpcData(version) {
    return {
        version: version,
        previousblockhash: '75517370e11e82b748010eaa9edc3bef157dc596631621c5a43ff8b72024e591',
        bits: '1a0adb60',
        curtime: 0x6a47d229,
        height: 23785000,
        coinbasevalue: 39928004583,
        transactions: []
    };
}

function makeJob(version, versionMaskConfig) {
    return new BlockTemplate(
        '1',
        makeRpcData(version),
        Buffer.from('76a914000000000000000000000000000000000000000088ac', 'hex'),
        Buffer.from('00000000', 'hex'),
        'POW',
        false,
        [],
        null,
        function () {},
        versionMaskConfig
    );
}

// --- 1. Rolling-enabled job: rolled region (incl. DigiDollar bit 23) stripped
var shaJob = makeJob(0x20800202, '1fffe000');
var notifyVersion = shaJob.getJobParams()[5];
assert.strictEqual(notifyVersion, '20000202',
    'sha256d job version must have the rolling region zeroed (got ' + notifyVersion + ')');

// --- 2. Non-rolling coin (no version_mask): bit 23 preserved for signaling
var skeinJob = makeJob(0x20800602, undefined);
assert.strictEqual(skeinJob.getJobParams()[5], '20800602',
    'non-rolling algos must keep the DigiDollar signal bit');

// --- 3. Header merge reconstructs the chip's version exactly
// Real NerdQAxe example: job 20000202, submitted version_bits 03fe2000,
// chip hashed 23FE2202.
var merkleRoot = '00'.repeat(32);
var header = util.reverseBuffer(
    shaJob.serializeHeader(merkleRoot, '6a47d229', '19250940', 0x03fe2000)
);
assert.strictEqual(header.readUInt32BE(76) >>> 0, 0x23fe2202,
    'header version must equal (job & ~mask) | (bits & mask)');

// Non-rolling submit on the same job (no version bits) keeps the job version.
var headerPlain = util.reverseBuffer(
    shaJob.serializeHeader(merkleRoot, '6a47d229', '19250940', undefined)
);
assert.strictEqual(headerPlain.readUInt32BE(76) >>> 0, 0x20000202,
    'plain submit must use the stripped job version');

// --- 4. Duplicate detection must include the rolled version bits
assert.strictEqual(shaJob.registerSubmit('ab', '0001bf55', '6a47d229', '19250940', '03fe2000'), true,
    'first share accepted');
assert.strictEqual(shaJob.registerSubmit('ab', '0001bf55', '6a47d229', '19250940', '00034000'), true,
    'same nonce with different version bits is a DIFFERENT share, not a duplicate');
assert.strictEqual(shaJob.registerSubmit('ab', '0001bf55', '6a47d229', '19250940', '03fe2000'), false,
    'identical share including version bits is a duplicate');

console.log('version-rolling job hygiene: all tests passed');
