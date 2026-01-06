const http = require('http');
const WebSocket = require('ws');

const State = {
  NONE: 'NONE',
  HOSTING: 'HOSTING',
  PENDING: 'PENDING',
  CONNECTING: 'CONNECTING',
  COMPLETED: 'COMPLETED'
};

class ICE_WebSocketSignalingServer {
  constructor(port, host = '0.0.0.0') {
    this.port = port;
    this.host = host;
    this.connections = [];
    this.nextId = 0;
    this.httpServer = null;
    this.wss = null;
  }

  start() {
    this.httpServer = http.createServer((req, res) => {
      console.log(`[SignalingServer] HTTP ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
      
      const isWebSocketUpgrade = req.headers.upgrade && 
                                 req.headers.upgrade.toLowerCase() === 'websocket';
      
      if (isWebSocketUpgrade) {
        console.log(`[SignalingServer] WebSocket upgrade request detected - letting ws handle it`);
        return;
      }
      
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ICE WebSocket Signaling Server Running\n');
      } else if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ICE WebSocket Signaling Server\nConnect via WebSocket to use signaling.\n');
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.wss = new WebSocket.Server({ 
      server: this.httpServer,
      verifyClient: (info) => {
        console.log(`[SignalingServer] WebSocket upgrade request from ${info.req.socket.remoteAddress}`);
        return true;
      }
    });

    this.wss.on('connection', (ws, req) => {
      const clientIp = req.socket.remoteAddress;
      const clientPath = req.url;
      console.log(`[SignalingServer] WebSocket connection established from ${clientIp} to path ${clientPath}`);
      this.addPeer(ws, clientIp);
    });

    this.wss.on('error', (err) => {
      console.error('[SignalingServer] WebSocket server error:', err);
    });

    this.httpServer.listen(this.port, this.host, () => {
      console.log(`[SignalingServer] WebSocket server listening on ws://${this.host}:${this.port}`);
      console.log(`[SignalingServer] HTTP health check available at http://${this.host}:${this.port}/health`);
      console.log(`[SignalingServer] Ready to accept WebSocket connections`);
    });

    this.httpServer.on('error', (err) => {
      console.error('[SignalingServer] Server error:', err);
    });
  }

  stop() {
    if (this.wss) {
      this.wss.close();
    }
    if (this.httpServer) {
      this.httpServer.close();
      console.log('[SignalingServer] Server stopped');
    }
  }

  addPeer(ws, clientIp) {
    const peer = {
      ws,
      id: this.nextId++,
      state: State.NONE,
      addressString: '',
      otherId: 0,
      clientIp
    };

    peer.otherId = peer.id;
    this.connections.push(peer);

    console.log(`[SignalingServer] Peer ${peer.id} connected from ${clientIp}`);

    ws.on('message', (data) => {
      this.handleMessage(peer, data);
    });

    ws.on('close', () => {
      console.log(`[SignalingServer] Peer ${peer.id} disconnected`);
      this.removePeer(peer.id);
    });

    ws.on('error', (err) => {
      console.error(`[SignalingServer] WebSocket error for peer ${peer.id}:`, err.message);
      this.removePeer(peer.id);
    });
  }

  handleMessage(peer, data) {
    const message = data.toString().trim();
    
    if (message.length > 0) {
      this.processMessage(peer, message);
    }
  }

  processMessage(peer, message) {
    if (message.startsWith('ECHO:')) {
      const echoData = message.substring(5);
      console.log(`[SignalingServer] peer ${peer.id} echo request with ${echoData.length} bytes`);
      this.sendMessage(peer, message);
      return;
    }

    if (message.startsWith('HOSTING:')) {
      const address = message.substring(8);
      peer.state = State.HOSTING;
      peer.addressString = address;
      console.log(`[SignalingServer] peer ${peer.id} wants to host: ${peer.addressString}`);
      this.tryInitMatch(peer);
      return;
    }

    if (message.startsWith('CONNECT:')) {
      const address = message.substring(8);
      peer.state = State.PENDING;
      peer.addressString = address;
      console.log(`[SignalingServer] peer ${peer.id} wants to connect to: ${peer.addressString}`);
      this.tryInitMatch(peer);
      return;
    }

    if (message.startsWith('POST_SDP:')) {
      const sdpData = message.substring(9);
      console.log(`[SignalingServer] received SDP from peer ${peer.id} with ${sdpData.length} bytes`);
      if (peer.state === State.HOSTING || peer.state === State.CONNECTING) {
        this.relayMsg(peer, message);
      }
      return;
    }

    if (message.startsWith('SUCCESS:')) {
      console.log(`[SignalingServer] peer ${peer.id} reports successful connection!`);
      if (peer.state === State.CONNECTING) {
        peer.state = State.COMPLETED;
      } else if (peer.state === State.HOSTING) {
        peer.otherId = peer.id;
        this.tryInitMatch(peer);
      }
      return;
    }
  }

  tryFindPeer(id) {
    return this.connections.find(peer => peer.id === id);
  }

  tryInitMatch(srcPeer) {
    let matchingState = State.NONE;

    if (srcPeer.state === State.HOSTING) {
      if (srcPeer.otherId !== srcPeer.id) {
        console.log(`[SignalingServer] host ${srcPeer.id} not ready to match atm`);
        return;
      }
      matchingState = State.PENDING;
    } else if (srcPeer.state === State.PENDING) {
      matchingState = State.HOSTING;
    } else {
      return;
    }

    for (const peer of this.connections) {
      if (peer.ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (peer.state === matchingState && peer.addressString === srcPeer.addressString) {
        const hostPeer = srcPeer.state === State.HOSTING ? srcPeer : peer;
        const joinPeer = srcPeer.state === State.HOSTING ? peer : srcPeer;

        console.log(`[SignalingServer] match found between host ${hostPeer.id} and peer ${joinPeer.id} at ${peer.addressString}`);

        joinPeer.state = State.CONNECTING;
        this.sendMessage(hostPeer, 'GET_SDP:');
        hostPeer.otherId = joinPeer.id;
        joinPeer.otherId = hostPeer.id;

        break;
      }
    }

    this.maybeCleanUp();
  }

  relayMsg(srcPeer, message) {
    if (srcPeer.state === State.HOSTING) {
      for (const peer of this.connections) {
        if (peer.otherId === srcPeer.id && 
            srcPeer.otherId === peer.id && 
            peer.state === State.CONNECTING) {
          this.sendMessage(peer, message);
          console.log(`[SignalingServer] relaying msg from host ${srcPeer.id} to peer ${peer.id} with ${message.length} total bytes`);
        }
      }
    } else if (srcPeer.state === State.CONNECTING) {
      for (const peer of this.connections) {
        if (peer.otherId === srcPeer.id && 
            srcPeer.otherId === peer.id && 
            peer.state === State.HOSTING) {
          this.sendMessage(peer, message);
          console.log(`[SignalingServer] relaying msg from peer ${srcPeer.id} to host ${peer.id} with ${message.length} bytes`);
        }
      }
    }
  }

  sendMessage(peer, message) {
    try {
      if (peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(message);
      }
    } catch (err) {
      console.error(`[SignalingServer] Failed to send message to peer ${peer.id}:`, err.message);
    }
  }

  removePeer(id) {
    const index = this.connections.findIndex(peer => peer.id === id);
    if (index !== -1) {
      this.connections.splice(index, 1);
    }
  }

  maybeCleanUp() {
    if (this.connections.length < 32) {
      return;
    }

    const originalCount = this.connections.length;

    this.connections = this.connections.filter((peer) => {
      if (peer.ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      if (peer.state !== State.HOSTING && peer.id + 64 < this.nextId) {
        try {
          peer.ws.close();
        } catch (e) {}
        return false;
      }

      return true;
    });

    console.log(`[SignalingServer] cleans up: ${this.connections.length} active peers remaining from ${originalCount} peers.`);
  }
}

const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

const server = new ICE_WebSocketSignalingServer(PORT, HOST);
server.start();

process.on('SIGINT', () => {
  console.log('\n[SignalingServer] Shutting down...');
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[SignalingServer] Shutting down...');
  server.stop();
  process.exit(0);
});
