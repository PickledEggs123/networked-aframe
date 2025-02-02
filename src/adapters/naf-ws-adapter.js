/* global NAF */

class AdapterMessageEvent extends Event {
  constructor(msgType, packet) {
    super(msgType);
    this.msgType = msgType;
    this.packet = packet;
  }
}

function random() {
  return (Math.random() + 1).toString(36).substring(7);
}

/**
 * WebSocket Adapter (WebSocket)
 * networked-scene: serverURL needs to be ws://localhost:8080 when running locally
 */
class WSAdapter {
  constructor() {
    this.app = 'default';
    this.room = 'default';
    this.occupantListener = null;
    this.myRoomJoinTime = null;
    this.myId = null;
    this.packet = {
      from: undefined,
      to: undefined,
      type: undefined,
      data: undefined,
      msgType: undefined,
    };

    this.occupants = {}; // id -> joinTimestamp
    this.connectedClients = [];

    this.serverTimeRequests = 0;
    this.timeOffsets = [];
    this.avgTimeOffset = 0;

    this.eventEmitter = new EventTarget();
  }

  setServerUrl(wsUrl) {
    this.wsUrl = wsUrl;
  }

  setApp(appName) {
    this.app = appName;
  }

  setRoom(roomName) {
    this.room = roomName;
  }

  setWebRtcOptions(options) {
    // No WebRTC support
  }

  setServerConnectListeners(successListener, failureListener) {
    this.connectSuccess = successListener;
    this.connectFailure = failureListener;
  }

  setRoomOccupantListener(occupantListener) {
    this.occupantListener = occupantListener;
  }

  setDataChannelListeners(openListener, closedListener, messageListener) {
    this.openListener = openListener;
    this.closedListener = closedListener;
    this.messageListener = messageListener;
  }

  connect() {
    const self = this;

    this.updateTimeOffset().then(() => {
      if (!self.wsUrl || self.wsUrl === '/') {
        if (location.protocol === 'https:') {
          self.wsUrl = 'wss://' + location.host;
        } else {
          self.wsUrl = 'ws://' + location.host;
        }
      }

      NAF.log.write('Attempting to connect to ws');
      const socket = (self.socket = new WebSocket(self.wsUrl));
      socket.id = random();

      socket.addEventListener('open', () => {
        if (NAF.clientId) {
          // The server restarted quickly and we got a new socket without
          // getting in the error handler.
          self.onDisconnect();
        }
        NAF.log.write('User connected', socket.id);
        self.myId = socket.id;
        self.joinRoom();
      });

      self.eventEmitter.addEventListener('connectSuccess', (event) => {
        const { joinedTime } = event.packet.data;

        self.myRoomJoinTime = joinedTime;
        NAF.log.write('Successfully joined room', self.room, 'at server time', joinedTime);

        self.connectSuccess(self.myId);
      });

      socket.addEventListener('error', (err) => {
        console.error('Socket connection failure', err);
        this.onDisconnect();
      });

      self.eventEmitter.addEventListener('occupantsChanged', (event) => {
        const { occupants } = event.packet.data;
        NAF.log.write('occupants changed', event.packet.data);
        self.receivedOccupants(occupants);
      });

      function receiveData(packet) {
        const { msgType, type, from, data } = packet;

        if (!msgType) {
          self.messageListener(from, type, data);
        } else {
          self.eventEmitter.dispatchEvent(new AdapterMessageEvent(msgType, packet));
        }
      }

      function handleIncomingMessage(event) {
        const packet = event.packet;
        const from = packet.from;
        const type = packet.type;
        const data = packet.data;
        switch (type) {
          case 'connectSuccess':
          case 'occupantsChanged': {
            self.eventEmitter.dispatchEvent(new AdapterMessageEvent(type, event.packet));
            break;
          }
          case 'ping': {
            self.sendData('server', 'pong', undefined);
            break;
          }
          default: {
            self.messageListener(from, type, data);
            break;
          }
        }
      }
      self.eventEmitter.addEventListener('send', handleIncomingMessage);
      self.eventEmitter.addEventListener('broadcast', handleIncomingMessage);

      socket.addEventListener("message", (msg) => {
        const { from, to, type, data, msgType } = JSON.parse(msg.data);
        this.packet.from = from;
        this.packet.to = to;
        this.packet.type = type;
        this.packet.data = data;
        this.packet.msgType = msgType;
        receiveData(this.packet);
      });
    });
  }

  joinRoom() {
    NAF.log.write('Joining room', this.room);
    this.packet.from = this.myId;
    this.packet.to = undefined;
    this.packet.type = 'joinRoom';
    this.packet.data = { room: this.room, clientId: this.socket.id };
    this.packet.msgType = 'joinedRoom';
    this.sendData(this.packet.to, this.packet.type, this.packet.data);
  }

  receivedOccupants(occupants) {
    delete occupants[this.myId];
    this.occupants = occupants;
    this.occupantListener(occupants);
  }

  shouldStartConnectionTo(client) {
    return true;
  }

  startStreamConnection(remoteId) {
    this.connectedClients.push(remoteId);
    this.openListener(remoteId);
  }

  closeStreamConnection(clientId) {
    this.connectedClients = this.connectedClients.filter((c) => c !== clientId);
    this.closedListener(clientId);
  }

  getConnectStatus(clientId) {
    const connected = this.connectedClients.indexOf(clientId) !== -1;

    if (connected) {
      return NAF.adapters.IS_CONNECTED;
    } else {
      return NAF.adapters.NOT_CONNECTED;
    }
  }

  sendData(to, type, data) {
    this.sendDataGuaranteed(to, type, data);
  }

  sendDataGuaranteed(to, type, data) {
    this.packet.from = this.myId;
    this.packet.to = to;
    this.packet.type = type;
    this.packet.data = data;
    this.packet.msgType = 'send';

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(this.packet));
    } else {
      NAF.log.warn('WebSocket not created yet');
    }
  }

  broadcastData(type, data) {
    this.broadcastDataGuaranteed(type, data);
  }

  broadcastDataGuaranteed(type, data) {
    this.packet.from = this.myId;
    this.packet.to = undefined;
    this.packet.type = type;
    this.packet.data = data;
    this.packet.msgType = 'broadcast';

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(this.packet));
    } else {
      NAF.log.warn('WebSocket not created yet');
    }
  }

  getMediaStream(clientId) {
    return Promise.reject('Interface method not implemented: getMediaStream');
  }

  updateTimeOffset() {
    const clientSentTime = Date.now() + this.avgTimeOffset;

    return fetch(document.location.href, { method: 'HEAD', cache: 'no-cache' }).then((res) => {
      const precision = 1000;
      const serverReceivedTime = new Date(res.headers.get('Date')).getTime() + precision / 2;
      const clientReceivedTime = Date.now();
      const serverTime = serverReceivedTime + (clientReceivedTime - clientSentTime) / 2;
      const timeOffset = serverTime - clientReceivedTime;

      this.serverTimeRequests++;

      if (this.serverTimeRequests <= 10) {
        this.timeOffsets.push(timeOffset);
      } else {
        this.timeOffsets[this.serverTimeRequests % 10] = timeOffset;
      }

      this.avgTimeOffset = this.timeOffsets.reduce((acc, offset) => (acc += offset), 0) / this.timeOffsets.length;

      if (this.serverTimeRequests > 10) {
        setTimeout(() => this.updateTimeOffset(), 5 * 60 * 1000); // Sync clock every 5 minutes.
      } else {
        this.updateTimeOffset();
      }
    });
  }

  getServerTime() {
    return Date.now() + this.avgTimeOffset;
  }

  onDisconnect() {
    if (NAF.clientId === '') return;
    // Properly remove connected clients and remote entities
    this.receivedOccupants({});
    // For entities I'm the creator, reset to empty owner and register
    // again the onConnected callback to send my entities to all
    // the participants upon reconnect.
    for (const entity of Object.values(NAF.entities.entities)) {
      if (entity.components.networked.data.creator === NAF.clientId) {
        // The creator and owner will be set to the new NAF.clientId upon reconnect
        entity.setAttribute('networked', { owner: '', creator: '' });
        document.body.addEventListener('connected', entity.components.networked.onConnected, false);
      }
    }
    NAF.clientId = '';
  }

  disconnect() {
    this.socket.terminate();
    this.onDisconnect();
  }

}

module.exports = WSAdapter;
