const express = require("express");
const path = require("node:path");
const http = require("node:http");
const EventEmitter = require("node:events");
const WebSocketServer = require('ws').Server;
const crypto = require("crypto");

// To generate a certificate for local development with https, you can use
// npx webpack serve --server-type https
// and stop it with ctrl+c, it will generate the file node_modules/.cache/webpack-dev-server/server.pem
// Then to enable https on the node server, uncomment the next lines
// and the webServer line down below.
// const https = require("node:https");
// const fs = require("node:fs");
// const privateKey = fs.readFileSync("node_modules/.cache/webpack-dev-server/server.pem", "utf8");
// const certificate = fs.readFileSync("node_modules/.cache/webpack-dev-server/server.pem", "utf8");
// const credentials = { key: privateKey, cert: certificate };

// Set process name
process.title = "networked-aframe-server";

// Get port or default to 8080
const port = process.env.PORT || 8080;

// Threshold for instancing a room
const maxOccupantsInRoom = 50;

// Setup and configure Express http server.
const app = express();

// Serve the bundle in-memory in development (needs to be before the express.static)
if (process.env.NODE_ENV === "development") {
  const webpackMiddleware = require("webpack-dev-middleware");
  const webpack = require("webpack");
  const config = require("../webpack.config");

  app.use(
    webpackMiddleware(webpack(config), {
      publicPath: "/dist/"
    })
  );
}

// Serve the files from the examples folder
app.use(express.static(path.resolve(__dirname, "..", "examples")));

// Start Express http server
const webServer = http.createServer(app);
// To enable https on the node server, comment the line above and uncomment the line below
// const webServer = https.createServer(credentials, app);
const io = new WebSocketServer({server: webServer});

const rooms = new Map();

function randomBytes() {
  return crypto.randomBytes(16).toString("base64url");
}

io.on("connection", (socket) => {
  socket.id = randomBytes();
  console.log("user connected", socket.id);

  let curRoom = null;

  const eventEmitterIn = new EventEmitter();
  const eventEmitterOut = new EventEmitter();

  socket.on("message", (msg) => {
    const { from, type, data, to, msgType } = JSON.parse(msg);

    switch (type) {
      case 'joinRoom':
      case 'pong': {
        eventEmitterIn.emit(type, {
          from, type, data, to
        });
        break;
      }
      default: {
        eventEmitterOut.emit(msgType, {
          from, type, data, to
        });
        break;
      }
    }
  });

  eventEmitterIn.on("joinRoom", ({ data }) => {
    const { room, clientId } = data;
    socket.id = clientId;

    curRoom = room;
    let roomInfo = rooms.get(room);
    if (!roomInfo) {
      roomInfo = {
        name: room,
        occupants: {},
        occupantsCount: 0
      };
      rooms.set(room, roomInfo);
    }

    if (roomInfo.occupantsCount >= maxOccupantsInRoom) {
      // If room is full, search for spot in other instances
      let availableRoomFound = false;
      const roomPrefix = `${room}--`;
      let numberOfInstances = 1;
      for (const [roomName, roomData] of rooms.entries()) {
        if (roomName.startsWith(roomPrefix)) {
          numberOfInstances++;
          if (roomData.occupantsCount < maxOccupantsInRoom) {
            availableRoomFound = true;
            curRoom = roomName;
            roomInfo = roomData;
            break;
          }
        }
      }

      if (!availableRoomFound) {
        // No available room found, create a new one
        const newRoomNumber = numberOfInstances + 1;
        curRoom = `${roomPrefix}${newRoomNumber}`;
        roomInfo = {
          name: curRoom,
          occupants: {},
          occupantsCount: 0
        };
        rooms.set(curRoom, roomInfo);
      }
    }

    const joinedTime = Date.now();
    roomInfo.occupants[socket.id] = joinedTime;
    roomInfo.occupantsCount++;

    console.log(`${socket.id} joined room ${curRoom}`);

    eventEmitterOut.emit("send", {
      from: "server",
      to: socket.id,
      type: "connectSuccess",
      data: joinedTime,
      msgType: 'send',
    });
    const occupants = roomInfo.occupants;
    eventEmitterOut.emit("broadcast", {
      from: "server",
      type: "occupantsChanged",
      data: { occupants },
      msgType: 'broadcast',
    });
  });

  eventEmitterOut.on("send", ({ data, from, to, type, msgType }) => {
    Array.from(io.clients).find(x => x.id === to)?.send(JSON.stringify({
      data, from, to, type, msgType,
    }));
  });

  eventEmitterOut.on("broadcast", ({ data, from, type, to: msgTo, msgType }) => {
    Array.from(Object.keys(rooms.get(curRoom)?.occupants ?? {})).forEach((to) => {
      if (to === msgTo) {
        return;
      }
      eventEmitterOut.emit("send", {
        data, from, to, type, msgType,
      });
    });
  });

  // setup ping every 5 seconds for 4000 ms lag
  let pingTimeout = null;
  let pingInterval = setInterval(() => {
    eventEmitterOut.emit("send", {
      data: undefined,
      from: 'server',
      to: socket.id,
      type: 'ping',
      msgType: 'send',
    });
    pingTimeout = setTimeout(() => {
      // clean up ping
      clearInterval(pingInterval);
      pingInterval = null;
      pingTimeout = null;
      disconnect();
    }, 4000);
  }, 5000);
  eventEmitterIn.on("pong", () => {
    clearTimeout(pingTimeout);
    pingTimeout = null;
  });

  function disconnect() {
    // clean up ping
    clearInterval(pingInterval);
    pingInterval = null;
    if (pingTimeout) {
      clearTimeout(pingTimeout);
      pingTimeout = null;
    }

    console.log("disconnected: ", socket.id, curRoom);
    const roomInfo = rooms.get(curRoom);
    if (roomInfo) {
      console.log("user disconnected", socket.id);

      delete roomInfo.occupants[socket.id];
      roomInfo.occupantsCount--;
      const occupants = roomInfo.occupants;
      eventEmitterOut.emit("broadcast", {
        from: "server",
        type: "occupantsChanged",
        data: { occupants },
        msgType: 'broadcast',
      });

      if (roomInfo.occupantsCount === 0) {
        console.log("everybody left room");
        rooms.delete(curRoom);
      }
    }

    socket.terminate();
  }

  socket.on("disconnect", disconnect);
});

webServer.listen(port, () => {
  console.log("listening on http://localhost:" + port);
});
