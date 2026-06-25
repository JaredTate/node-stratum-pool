var assert = require('assert');
var pool = require('./pool.js');
var transactions = require('./transactions.js');

function buildCoinbase(rpcData) {
    var poolScript = Buffer.from('76a914000000000000000000000000000000000000000088ac', 'hex');
    var extraNoncePlaceholder = Buffer.from('00000000', 'hex');
    var generation = transactions.CreateGeneration(
        rpcData,
        poolScript,
        extraNoncePlaceholder,
        'POW',
        false,
        [],
        null,
        {}
    );

    return Buffer.concat([generation[0], extraNoncePlaceholder, generation[1]]).toString('hex');
}

function readVarInt(buffer, offset) {
    var first = buffer[offset];

    if (first < 0xfd) {
        return {
            value: first,
            offset: offset + 1
        };
    }

    if (first === 0xfd) {
        return {
            value: buffer.readUInt16LE(offset + 1),
            offset: offset + 3
        };
    }

    if (first === 0xfe) {
        return {
            value: buffer.readUInt32LE(offset + 1),
            offset: offset + 5
        };
    }

    return {
        value: Number(buffer.readBigUInt64LE(offset + 1)),
        offset: offset + 9
    };
}

function readInt64LE(buffer, offset) {
    return Number(buffer.readBigInt64LE(offset));
}

function parseCoinbaseOutputs(coinbaseHex) {
    var buffer = Buffer.from(coinbaseHex, 'hex');
    var offset = 4;
    var inputCount = readVarInt(buffer, offset);

    offset = inputCount.offset;
    assert.strictEqual(inputCount.value, 1, 'test coinbase should have one input');

    offset += 32;
    offset += 4;

    var scriptSigLength = readVarInt(buffer, offset);
    offset = scriptSigLength.offset + scriptSigLength.value;
    offset += 4;

    var outputCount = readVarInt(buffer, offset);
    offset = outputCount.offset;

    var outputs = [];
    for (var i = 0; i < outputCount.value; i++) {
        var value = readInt64LE(buffer, offset);
        offset += 8;

        var scriptLength = readVarInt(buffer, offset);
        offset = scriptLength.offset;

        outputs.push({
            value: value,
            script: buffer.slice(offset, offset + scriptLength.value).toString('hex')
        });

        offset += scriptLength.value;
    }

    return outputs;
}

function templateRules(coinOptions) {
    var params = pool.GetBlockTemplateParameters({
        coin: Object.assign({
            algorithm: 'sha256'
        }, coinOptions || {})
    });

    return params[0].rules;
}

function testDigiDollarGetBlockTemplateRules() {
    assert.deepStrictEqual(
        templateRules({ digidollar: true }),
        ['segwit', 'digidollar-oracle'],
        'DigiDollar coins must request the oracle GBT rule'
    );

    assert.deepStrictEqual(
        templateRules({ digidollar: false }),
        ['segwit'],
        'non-DigiDollar coins must not request the oracle GBT rule'
    );

    assert.deepStrictEqual(
        templateRules({ digidollar: 'true' }),
        ['segwit'],
        'only strict boolean digidollar=true should request the oracle GBT rule'
    );

    assert.deepStrictEqual(
        templateRules({}),
        ['segwit'],
        'missing DigiDollar config must keep the default GBT rules'
    );
}

function testDigiDollarGetBlockTemplateRulesWithAlgoParameter() {
    var params = pool.GetBlockTemplateParameters({
        coin: {
            algorithm: 'sha256',
            digidollar: true,
            passAlgorithm: true
        }
    });

    assert.deepStrictEqual(
        params[0].rules,
        ['segwit', 'digidollar-oracle'],
        'DigiDollar GBT rules must be preserved when passAlgorithm is enabled'
    );
    assert.strictEqual(params[1], 'sha256');
}

function testDigiDollarGetBlockTemplateRulesWithAlgoKey() {
    var params = pool.GetBlockTemplateParameters({
        coin: {
            algorithm: 'sha256',
            digidollar: true,
            passAlgorithmKey: 'odo'
        }
    });

    assert.deepStrictEqual(
        params[0].rules,
        ['segwit', 'digidollar-oracle'],
        'DigiDollar GBT rules must be preserved when passAlgorithmKey is enabled'
    );
    assert.strictEqual(params[0].algo, 'odo');
}

function testDigiDollarOracleCommitmentOutput() {
    var oracleCommitment = '6abf0301020304050607';
    var witnessCommitment = '6a24aa21a9ed' + '11'.repeat(32);
    var coinbaseHex = buildCoinbase({
        height: 2000,
        coinbasevalue: 100000000,
        curtime: 1700000000,
        default_oracle_commitment: oracleCommitment,
        default_witness_commitment: witnessCommitment
    });
    var outputs = parseCoinbaseOutputs(coinbaseHex);
    var oracleOutputs = outputs.filter(function (output) {
        return output.script === oracleCommitment;
    });
    var witnessOutputs = outputs.filter(function (output) {
        return output.script === witnessCommitment;
    });

    assert(
        coinbaseHex.includes(oracleCommitment),
        'coinbase must preserve default_oracle_commitment for DigiDollar blocks'
    );
    assert(
        coinbaseHex.includes(witnessCommitment),
        'coinbase must preserve default_witness_commitment'
    );
    assert.strictEqual(outputs.length, 3, 'coinbase output count must include pool, witness, and oracle outputs');
    assert.strictEqual(oracleOutputs.length, 1, 'coinbase must include exactly one oracle commitment output');
    assert.strictEqual(oracleOutputs[0].value, 0, 'oracle commitment output must have zero DGB value');
    assert.strictEqual(witnessOutputs.length, 1, 'coinbase must include exactly one witness commitment output');
    assert.strictEqual(witnessOutputs[0].value, 0, 'witness commitment output must have zero DGB value');
}

function testNoOracleCommitmentWhenAbsent() {
    var coinbaseHex = buildCoinbase({
        height: 2000,
        coinbasevalue: 100000000,
        curtime: 1700000000,
        default_witness_commitment: '6a24aa21a9ed' + '22'.repeat(32)
    });
    var outputs = parseCoinbaseOutputs(coinbaseHex);

    assert(
        !coinbaseHex.includes('6abf03'),
        'coinbase must not invent an oracle commitment when GBT did not provide one'
    );
    assert.strictEqual(outputs.length, 2, 'coinbase output count must not reserve an absent oracle output');
}

testDigiDollarGetBlockTemplateRules();
testDigiDollarGetBlockTemplateRulesWithAlgoParameter();
testDigiDollarGetBlockTemplateRulesWithAlgoKey();
testDigiDollarOracleCommitmentOutput();
testNoOracleCommitmentWhenAbsent();

console.log('node-stratum-pool tests passed');
