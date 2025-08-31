// ASIC Boost Debug Logging Enhancement for stratum.js
// Add these logging points to stratum.js to debug ASIC boost issues

// Enhanced handleConfigure logging
function handleConfigureWithLogging(message) {
    console.log('\n[ASICBOOST DEBUG] mining.configure received:');
    console.log('  Client: ' + _this.remoteAddress + ' (' + (_this.workerName || 'unauthorized') + ')');
    console.log('  Request params:', JSON.stringify(message.params));
    
    if (message.params && message.params[0]) {
        var extensions = message.params[0];
        var hasVersionRolling = extensions.includes('version-rolling');
        console.log('  Version-rolling requested:', hasVersionRolling);
        
        if (message.params[1] && message.params[1]['version-rolling.mask']) {
            console.log('  Client requested mask:', message.params[1]['version-rolling.mask']);
        }
        if (message.params[1] && message.params[1]['version-rolling.min-bit-count']) {
            console.log('  Client min-bit-count:', message.params[1]['version-rolling.min-bit-count']);
        }
    }
    
    if (options.coin.version_mask) {
        console.log('  Pool configured mask:', options.coin.version_mask);
        var maskInt = parseInt(options.coin.version_mask, 16);
        console.log('  Pool mask binary:', maskInt.toString(2).padStart(32, '0'));
        console.log('  Pool mask allows bits:', countSetBits(maskInt), 'bits for rolling');
        
        // Check if mask is valid
        if (!isValidHexRegex.test(options.coin.version_mask)) {
            console.log('  WARNING: Pool mask is not valid hex!');
        }
        
        // Check for common mask values
        if (options.coin.version_mask === '0x1fffe000') {
            console.log('  Pool using standard BIP320 mask (16 bits)');
        } else if (options.coin.version_mask === '0x1fffe0000') {
            console.log('  WARNING: Pool mask has extra zero! Should be 0x1fffe000');
        }
    } else {
        console.log('  WARNING: No version_mask configured in coin config!');
    }
    
    // Original function logic here...
}

// Enhanced handleSubmit logging
function handleSubmitWithLogging(message) {
    console.log('\n[ASICBOOST DEBUG] mining.submit received:');
    console.log('  Worker:', _this.workerName);
    console.log('  Params count:', message.params.length);
    
    if (message.params.length > 5) {
        console.log('  Version bits provided:', message.params[5]);
        
        if (options.coin.version_mask) {
            var clientVersionMask = parseInt(message.params[5], 16);
            var poolVersionMask = parseInt(options.coin.version_mask, 16);
            
            console.log('  Client version mask:', '0x' + clientVersionMask.toString(16));
            console.log('  Pool version mask:', options.coin.version_mask);
            
            // Check mask compatibility
            var invalidBits = (~poolVersionMask) & clientVersionMask;
            if (invalidBits !== 0) {
                console.log('  ERROR: Client used invalid bits!');
                console.log('  Invalid bits:', '0x' + invalidBits.toString(16));
                console.log('  Binary comparison:');
                console.log('    Pool allows: ', poolVersionMask.toString(2).padStart(32, '0'));
                console.log('    Client used: ', clientVersionMask.toString(2).padStart(32, '0'));
                console.log('    Invalid bits:', invalidBits.toString(2).padStart(32, '0'));
            } else {
                console.log('  Version mask validation: PASSED');
            }
        }
    } else {
        console.log('  No version bits in submission (non-ASICBOOST miner)');
    }
    
    // Original function logic here...
}

// Helper function to count set bits
function countSetBits(n) {
    var count = 0;
    while (n) {
        count += n & 1;
        n >>= 1;
    }
    return count;
}

// Connection/disconnection logging
function logConnectionDetails() {
    console.log('\n[ASICBOOST DEBUG] Client connection:');
    console.log('  IP:', _this.remoteAddress);
    console.log('  Time:', new Date().toISOString());
    console.log('  Socket state:', _this.socket.readyState);
}

function logDisconnectionDetails(reason) {
    console.log('\n[ASICBOOST DEBUG] Client disconnection:');
    console.log('  Worker:', _this.workerName || 'unauthorized');
    console.log('  IP:', _this.remoteAddress);
    console.log('  Reason:', reason);
    console.log('  Time:', new Date().toISOString());
    console.log('  Session duration:', (Date.now() - _this.connectionTime) / 1000, 'seconds');
    console.log('  Shares submitted:', _this.shares ? (_this.shares.valid + _this.shares.invalid) : 0);
    if (_this.lastVersionMask) {
        console.log('  Last version mask used:', _this.lastVersionMask);
    }
}

module.exports = {
    handleConfigureWithLogging,
    handleSubmitWithLogging,
    logConnectionDetails,
    logDisconnectionDetails,
    countSetBits
};