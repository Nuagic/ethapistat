'use strict';

require('./utils/logger.js');

var os = require('os');
var _ = require('lodash');
var pjson = require('./../package.json');
var chalk = require('chalk');
var request = require('sync-request');

var Primus = require('primus'),
	Emitter = require('primus-emit'),
	Latency = require('primus-spark-latency'),
	Socket, socket;

var WS_SECRET = process.env.WS_SECRET || "eth-net-stats-has-a-secret";

var UPDATE_INTERVAL = 400;
var PING_INTERVAL = 3000;
//var url = "https://api.bscscan.com/api?module=block&action=getblockcountdown&blockno=900000000&apikey=U3BEX43JIDGN7FJIKYC21VQFPR7DKXA46B"
//var url = "https://api.etherscan.io/api?module=block&action=getblockcountdown&blockno=900000000&apikey=4BT4EQSY69IKH8EZT9MP1EE91NK4UEF16B"
var url = "https://"+process.env.API_HOST+"/api?module=block&action=getblockcountdown&blockno=900000000&apikey=" + process.env.API_KEY;

Socket = Primus.createSocket({
	transformer: 'websockets',
	pathname: '/api',
	timeout: 120000,
	strategy: 'disconnect,online,timeout',
	reconnect: {
		retries: 30
	},
	plugin: {emitter: Emitter, sparkLatency: Latency}
});

console.info('   ');
console.info('   ', 'NET STATS CLIENT');
console.success('   ', 'v' + pjson.version);
console.info('   ');
console.info('   ');

function Node ()
{
	this.info = {
		name: process.env.API_HOST,
		contact: (process.env.CONTACT_DETAILS || ""),
		coinbase: null,
		node: null,
		net: null,
		protocol: null,
		api: null,
		port: (process.env.LISTENING_PORT || 30303),
		os: os.platform(),
		os_v: os.release(),
		client: pjson.version,
		canUpdateHistory: true,
	};

	this.id = _.camelCase(this.info.name);

	this.stats = {
		active: false,
		mining: false,
		hashrate: 0,
		peers: 0,
		pending: 0,
		gasPrice: 0,
		block: {
			number: 0,
			hash: '?',
			difficulty: 0,
			totalDifficulty: 0,
			transactions: [],
			uncles: []
		},
		syncing: false,
		uptime: 0
	};

	this._lastBlock = 0;
	this._lastStats = JSON.stringify(this.stats);
	this._lastFetch = 0;
	this._lastPending = 0;

	this._tries = 0;
	this._down = 0;
	this._lastSent = 0;
	this._latency = 0;

	this._web3 = false;
	this._socket = false;

	this._latestQueue = null;
	this.pendingFilter = false;
	this.chainFilter = false;
	this.updateInterval = false;
	this.pingInterval = false;
	this.connectionInterval = false;

	this._lastBlockSentAt = 0;
	this._lastChainLog = 0;
	this._lastPendingLog = 0;
	this._chainDebouncer = 0;
	this._chan_min_time = 50;
	this._max_chain_debouncer = 20;
	this._chain_debouncer_cnt = 0;
	this._connection_attempts = 0;
	this._timeOffset = null;

	//this.startWeb3Connection();
	this.init();

	return this;
}

Node.prototype.startSocketConnection = function()
{
	if( !this._socket )
	{
		console.info('wsc', 'Starting socket connection');

		socket = new Socket( process.env.WS_SERVER || 'ws://localhost:3000' );

		this.setupSockets();
	}
}

Node.prototype.setupSockets = function()
{
	var self = this;

	// Setup events
	socket.on('open', function open()
	{
		console.info('wsc', 'The socket connection has been opened.');
		console.info('   ', 'Trying to login');

		socket.emit('hello', {
			id: self.id,
			info: self.info,
			secret: WS_SECRET
		});
	})
	.on('ready', function()
	{
		self._socket = true;
		console.success('wsc', 'The socket connection has been established.');

		self.getStats(true);
	})
	.on('node-pong', function(data)
	{
		var now = _.now();
		var latency = Math.ceil( (now - data.clientTime) / 2 );

		socket.emit('latency', {
			id: self.id,
			latency: latency
		});
	})
	.on('end', function end()
	{
		self._socket = false;
		console.error('wsc', 'Socket connection end received');
	})
	.on('error', function error(err)
	{
		console.error('wsc', 'Socket error:', err);
	})
	.on('timeout', function ()
	{
		self._socket = false;
		console.error('wsc', 'Socket connection timeout');
	})
	.on('close', function ()
	{
		self._socket = false;
		console.error('wsc', 'Socket connection has been closed');
	})
	.on('offline', function ()
	{
		self._socket = false;
		console.error('wsc', 'Network connection is offline');
	})
	.on('online', function ()
	{
		self._socket = true;
		console.info('wsc', 'Network connection is online');
	})
	.on('reconnect', function ()
	{
		console.info('wsc', 'Socket reconnect attempt started');
	})
	.on('reconnect scheduled', function (opts)
	{
		self._socket = false;
		console.warn('wsc', 'Reconnecting in', opts.scheduled, 'ms');
		console.warn('wsc', 'This is attempt', opts.attempt, 'out of', opts.retries);
	})
	.on('reconnected', function (opts)
	{
		self._socket = true;
		console.success('wsc', 'Socket reconnected successfully after', opts.duration, 'ms');

		self.getStats(true);
	})
	.on('reconnect timeout', function (err, opts)
	{
		self._socket = false;
		console.error('wsc', 'Socket reconnect atempt took too long:', err.message);
	})
	.on('reconnect failed', function (err, opts)
	{
		self._socket = false;
		console.error('wsc', 'Socket reconnect failed:', err.message);
	});
}

Node.prototype.emit = function(message, payload)
{
	if(this._socket)
	{
		try {
			socket.emit(message, payload);
			console.stats('wsc', 'Socket emited message:', chalk.reset.cyan(message));
			// console.success('wsc', payload);
		}
		catch (err) {
			console.error('wsc', 'Socket emit error:', err);
		}
	}
}

Node.prototype.formatBlock = function (block)
{
	if( !_.isNull(block) && !_.isUndefined(block) && !_.isUndefined(block.number) && block.number >= 0 && !_.isUndefined(block.difficulty) && !_.isUndefined(block.totalDifficulty) )
	{
		block.difficulty = block.difficulty.toString(10);
		block.totalDifficulty = block.totalDifficulty.toString(10);

		if( !_.isUndefined(block.logsBloom) )
		{
			delete block.logsBloom;
		}

		return block;
	}

	return false;
}

Node.prototype.getStats = function(forced)
{
	var self = this;
	var now = _.now();
	var lastFetchAgo = now - this._lastFetch;
	this._lastFetch = now;

	if (this._socket)
		this._lastStats = JSON.stringify(this.stats);

  if (lastFetchAgo >= UPDATE_INTERVAL || forced === true)
  {
    console.stats('==>', 'Getting stats')
    console.stats('   ', 'last update:', chalk.reset.cyan(lastFetchAgo));
    console.stats('   ', 'forced:', chalk.reset.cyan(forced === true));

    self._tries++;


    self.stats.active = true;
    self.stats.peers = 5;
    self.stats.mining = false;
    self.stats.hashrate = 0;
    self.stats.gasPrice = '';

    var info = JSON.parse(request('GET', url).getBody('utf8'));

    self.sendStatsUpdate(forced);
    this.emit('block', {
      id: this.id,
      block: {
        number: info.result.CurrentBlock,
        difficulty: '2',
        extraData: '',
        gasLimit: 0,
        gasUsed: 0,
        hash: '',
        miner: '',
        mixHash: '',
        nonce: '',
        parentHash: '',
        receiptsRoot: '',
        sha3Uncles: '',
        size: 0,
        stateRoot: '',
        timestamp: 0,
        totalDifficulty: '0',
        transactions: [
        ],
        transactionsRoot: '',
        uncles: []
      }
    });
  }
}

Node.prototype.changed = function ()
{
	var changed = ! _.isEqual( this._lastStats, JSON.stringify(this.stats) );

	return changed;
}

Node.prototype.prepareStats = function ()
{
	return {
		id: this.id,
		stats: {
			active: this.stats.active,
			syncing: this.stats.syncing,
			mining: this.stats.mining,
			hashrate: this.stats.hashrate,
			peers: this.stats.peers,
			gasPrice: this.stats.gasPrice,
			uptime: this.stats.uptime
		}
	};
}

Node.prototype.sendStatsUpdate = function (force)
{
	if( this.changed() || force ) {
		console.stats("wsc", "Sending", chalk.reset.blue((force ? "forced" : "changed")), chalk.bold.white("update"));
		var stats = this.prepareStats();
		console.info(stats);
		this.emit('stats', stats);
		// this.emit('stats', this.prepareStats());
	}
}

Node.prototype.ping = function()
{
	this._latency = _.now();
	socket.emit('node-ping', {
		id: this.id,
		clientTime: _.now()
	});
};

Node.prototype.setWatches = function()
{
	var self = this;

	//this.setFilters();

	this.updateInterval = setInterval( function(){
		self.getStats();
	}, UPDATE_INTERVAL);

	if( !this.pingInterval )
	{
		this.pingInterval = setInterval( function(){
			self.ping();
		}, PING_INTERVAL);
	}
}

Node.prototype.init = function()
{
	// Start socket connection
	this.startSocketConnection();

	// Set filters
	this.setWatches();
}

Node.prototype.stop = function()
{
	if(this._socket)
		socket.end();

	if(this.updateInterval)
		clearInterval(this.updateInterval);

	if(this.pingInterval)
		clearInterval(this.pingInterval);
}

module.exports = Node;
