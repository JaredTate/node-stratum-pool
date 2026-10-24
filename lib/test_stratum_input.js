// Stratum input validation tests (2026-10-24).
//
// Each case sends one client message through a real StratumServer client on a
// fake socket. Malformed input must get an error reply, must not throw (a
// throw in the socket handler kills the pool worker), and must never reach
// the share processor ('submit' event).
//
// Run: node lib/test_stratum_input.js

var assert = require('assert');
var events = require('events');
var stratum = require('./stratum.js');

var VERSION_MASK = '1fffe000';
var GOOD = ['DAddr.rig1', 'job1', '00000001', '6aefdb6a', 'a1b2c3d4'];

function FakeSocket() {
    events.EventEmitter.call(this);
    this.remoteAddress = '192.0.2.1';
    this.localPort = 3008;
    this.writes = [];
    this.destroyed = false;
}
FakeSocket.prototype.__proto__ = events.EventEmitter.prototype;
FakeSocket.prototype.setKeepAlive = function () {};
FakeSocket.prototype.setEncoding = function () {};
FakeSocket.prototype.write = function (d) {
    var self = this;
    d.split('\n').filter(Boolean).forEach(function (l) { self.writes.push(JSON.parse(l)); });
};
FakeSocket.prototype.destroy = function () { this.destroyed = true; };

function connect() {
    var authCalls = [];
    var server = new stratum.Server({
        ports: {},
        banning: { enabled: false },
        coin: { algorithm: 'sha256d', version_mask: '0x' + VERSION_MASK }
    }, function (ip, port, name, pass, cb) {
        authCalls.push(name);
        cb({ error: null, authorized: true, disconnect: false });
    });
    var submits = [];
    server.on('client.connected', function (client) {
        client.on('subscription', function (_, cb) { cb(null, '00000001', 4); });
        client.on('submit', function (params, cb) { submits.push(params); cb(null, true); });
    });
    var socket = new FakeSocket();
    server.handleNewClient(socket);
    return { socket: socket, submits: submits, authCalls: authCalls };
}

// Sends one message. Returns the reply for its id, or 'THREW: ...'.
function send(conn, msg) {
    try {
        conn.socket.emit('data', JSON.stringify(msg) + '\n');
    } catch (e) {
        return 'THREW: ' + e.message;
    }
    for (var i = conn.socket.writes.length - 1; i >= 0; i--) {
        if (conn.socket.writes[i].id === msg.id) return conn.socket.writes[i];
    }
    return null;
}

function ready() {
    var c = connect();
    send(c, { id: 1, method: 'mining.subscribe', params: ['cgminer/4.0'] });
    send(c, { id: 2, method: 'mining.authorize', params: ['DAddr.rig1', 'x'] });
    return c;
}

var cases = 0, failed = 0;
function check(name, fn) {
    cases++;
    try {
        fn();
        console.log('ok - ' + name);
    } catch (e) {
        failed++;
        console.log('not ok - ' + name + '\n    ' + e.message);
    }
}

function expectRejectedSubmit(params, why) {
    var c = ready();
    var reply = send(c, { id: 9, method: 'mining.submit', params: params });
    assert.notEqual(typeof reply, 'string', why + ': handler threw ' + reply);
    assert.ok(reply && reply.error, why + ': expected an error reply');
    assert.equal(c.submits.length, 0, why + ': must not reach the share processor');
}

// --- control: a well-formed share still goes through ---
check('valid submit reaches the share processor', function () {
    var c = ready();
    send(c, { id: 9, method: 'mining.submit', params: GOOD.concat(['00002000']) });
    assert.equal(c.submits.length, 1);
    assert.equal(c.submits[0].versionMask, 0x2000);
});

// --- crashes (uncaught TypeError kills the worker) ---
check('authorize without params does not throw', function () {
    var c = connect();
    var reply = send(c, { id: 2, method: 'mining.authorize' });
    assert.notEqual(typeof reply, 'string', reply);
    assert.equal(reply.result, false);
});
check('authorize with a non-string password does not throw', function () {
    var c = connect();
    var reply = send(c, { id: 2, method: 'mining.authorize', params: ['DAddr.rig1', 123] });
    assert.notEqual(typeof reply, 'string', reply);
});
check('authorize with a non-string worker name is refused before authorizeFn', function () {
    var c = connect();
    var reply = send(c, { id: 2, method: 'mining.authorize', params: [['DAddr'], 'x'] });
    assert.notEqual(typeof reply, 'string', reply);
    assert.equal(reply.result, false);
    assert.equal(c.authCalls.length, 0);
});
check('subscribe with a non-string user agent does not throw', function () {
    var c = connect();
    var reply = send(c, { id: 1, method: 'mining.subscribe', params: [123] });
    assert.notEqual(typeof reply, 'string', reply);
});
check('configure with non-array extensions does not throw', function () {
    var c = connect();
    var reply = send(c, { id: 3, method: 'mining.configure', params: [123, {}] });
    assert.notEqual(typeof reply, 'string', reply);
});
check('submit without params is rejected', function () {
    expectRejectedSubmit(undefined, 'no params');
});
check('submit with a numeric ntime is rejected', function () {
    expectRejectedSubmit(['DAddr.rig1', 'job1', '00000001', 1792800000, 'a1b2c3d4'], 'numeric ntime');
});
check('submit with numeric version bits is rejected', function () {
    expectRejectedSubmit(GOOD.concat([8192]), 'numeric version bits');
});

// --- share duplication: non-hex digits are dropped when the header is built,
// so "..c300", "..c3zz" and "..c3zy" are the same work but distinct dedupe keys ---
check('non-hex nonce is rejected', function () {
    expectRejectedSubmit(['DAddr.rig1', 'job1', '00000001', '6aefdb6a', 'a1b2c3zz'], 'non-hex nonce');
});
check('non-hex extranonce2 is rejected', function () {
    expectRejectedSubmit(['DAddr.rig1', 'job1', '0000zzzz', '6aefdb6a', 'a1b2c3d4'], 'non-hex extranonce2');
});
check('non-hex ntime is rejected', function () {
    expectRejectedSubmit(['DAddr.rig1', 'job1', '00000001', '6aefdbzz', 'a1b2c3d4'], 'non-hex ntime');
});
// Bitwise ops truncate to 32 bits, so 0x100002000 passed the mask check yet
// gave a new dedupe key for the same header.
check('version bits wider than 32 bits are rejected', function () {
    expectRejectedSubmit(GOOD.concat(['100002000']), '33-bit version');
});

// --- credit: the submit name gets the share and later the payout ---
check('submit for a worker this connection never authorized is rejected', function () {
    expectRejectedSubmit(['notanaddress', 'job1', '00000001', '6aefdb6a', 'a1b2c3d4'], 'unauthorized name');
});

console.log('\n' + (cases - failed) + '/' + cases + ' stratum input tests passed.');
process.exit(failed ? 1 : 0);
