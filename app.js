import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import mediasoup from "mediasoup";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket"],
});

const PORT = process.env.PORT || 5001;
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || "127.0.0.1";

// Data stores
const peers = {};
const transports = {};
const producers = {};
const consumers = {};
const routers = {};
const usernames = {}; // Map socket.id -> username

let worker;
const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
];

async function createWorker() {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: 20000,
    rtcMaxPort: 20200,
  });
  console.log(`Mediasoup worker created (pid: ${worker.pid})`);
  worker.on("died", () => {
    console.error("Mediasoup worker died, exiting in 2 seconds...");
    setTimeout(() => process.exit(1), 2000);
  });
}

async function getOrCreateRouter(roomName) {
  if (routers[roomName]) return routers[roomName];
  
  const router = await worker.createRouter({ mediaCodecs });
  routers[roomName] = router;
  console.log(`Router created for room: ${roomName}`);
  return router;
}

(async () => {
  await createWorker();
  server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
})();

const nsp = io.of("/mediasoup");

nsp.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);
  peers[socket.id] = {
    socket,
    roomName: null,
    username: null,
    transports: [],
    producers: [],
    consumers: [],
  };

  socket.emit("connection-success", { socketId: socket.id });

  socket.on("joinRoom", async ({ roomName, username }, callback) => {
    try {
      console.log(`${socket.id} (${username}) joining room: ${roomName}`);
      
      // Store username
      peers[socket.id].username = username;
      usernames[socket.id] = username;
      
      const router = await getOrCreateRouter(roomName);
      peers[socket.id].roomName = roomName;

      // Get existing producers with usernames
      const existingProducers = Object.values(producers)
        .filter(p => peers[p.socketId]?.roomName === roomName && p.socketId !== socket.id)
        .map(p => ({
          producerId: p.producer.id,
          username: peers[p.socketId]?.username || p.socketId.substring(0, 8)
        }));

      // Notify room about new user
      Object.values(peers).forEach(peer => {
        if (peer.roomName === roomName && peer.socket.id !== socket.id) {
          peer.socket.emit("user-joined", {
            producerId: socket.id,
            username
          });
        }
      });

      callback({ 
        rtpCapabilities: router.rtpCapabilities, 
        existingProducers 
      });
    } catch (err) {
      console.error("joinRoom error:", err);
      callback({ error: err.message });
    }
  });

  socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
    try {
      const roomName = peers[socket.id].roomName;
      if (!roomName) throw new Error("Peer not joined to any room");

      const router = routers[roomName];
      if (!router) throw new Error("Router not found for room");

      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: "0.0.0.0", announcedIp: ANNOUNCED_IP }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        appData: { consumer },
      });

      transports[transport.id] = { 
        socketId: socket.id, 
        transport,
        consumer: !!consumer,
      };
      peers[socket.id].transports.push(transport.id);

      console.log(`Created ${consumer ? "consumer" : "producer"} transport: ${transport.id}`);

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        }
      });

      transport.on("dtlsstatechange", (state) => {
        if (state === "closed") transport.close();
      });

      transport.on("close", () => {
        console.log(`Transport closed: ${transport.id}`);
        delete transports[transport.id];
      });
    } catch (err) {
      console.error("createWebRtcTransport error:", err);
      callback({ error: err.message });
    }
  });

  socket.on("transport-connect", async ({ dtlsParameters, transportId }, callback) => {
    try {
      console.log(`Connecting transport: ${transportId}`);
      const transportData = transports[transportId];
      if (!transportData) throw new Error("Transport not found");

      await transportData.transport.connect({ dtlsParameters });
      console.log(`Transport connected: ${transportId}`);
      callback({ success: true });
    } catch (err) {
      console.error("transport-connect error:", err);
      callback({ error: err.message });
    }
  });

  socket.on("transport-recv-connect", async ({ dtlsParameters, serverConsumerTransportId }, callback) => {
    try {
      console.log(`Connecting recv transport: ${serverConsumerTransportId}`);
      const transportData = transports[serverConsumerTransportId];
      if (!transportData) throw new Error("Recv transport not found");

      await transportData.transport.connect({ dtlsParameters });
      console.log(`Recv transport connected: ${serverConsumerTransportId}`);
      callback({ success: true });
    } catch (err) {
      console.error("transport-recv-connect error:", err);
      callback({ error: err.message });
    }
  });

  socket.on("transport-produce", async ({ kind, rtpParameters, transportId }, callback) => {
    try {
      console.log(`Producing ${kind} track on transport: ${transportId}`);
      const transportData = transports[transportId];
      if (!transportData) throw new Error("Transport not found");

      const producer = await transportData.transport.produce({ 
        kind, 
        rtpParameters 
      });

      // Initialize camera state (true for video, undefined for audio)
      const cameraOn = kind === 'video' ? true : undefined;

      producers[producer.id] = { 
        socketId: socket.id, 
        producer, 
        kind,
        transportId,
        cameraOn,
        username: peers[socket.id]?.username || socket.id.substring(0, 8)
      };
      peers[socket.id].producers.push(producer.id);

      console.log(`Producer created: ${producer.id} (${kind}) by ${peers[socket.id]?.username}`);

      // Notify other peers in the room
      const roomName = peers[socket.id].roomName;
      Object.values(peers).forEach(peer => {
        if (peer.socket.id !== socket.id && peer.roomName === roomName) {
          peer.socket.emit("new-producer", { 
            producerId: producer.id,
            username: peers[socket.id]?.username
          });
        }
      });

      producer.on("transportclose", () => {
        console.log(`Producer transport closed: ${producer.id}`);
        producer.close();
      });

      producer.on("close", () => {
        console.log(`Producer closed: ${producer.id}`);
        const username = producers[producer.id]?.username;
        delete producers[producer.id];
        
        // Notify peers
        Object.values(peers).forEach(peer => {
          if (peer.roomName === roomName) {
            peer.socket.emit("producer-closed", { 
              remoteProducerId: producer.id,
              username
            });
          }
        });
      });

      callback({ id: producer.id });
    } catch (err) {
      console.error("transport-produce error:", err);
      callback({ error: err.message });
    }
  });

  socket.on("producer-state", ({ producerId, cameraOn }) => {
    if (!producers[producerId]) return;
    
    // Update producer state
    producers[producerId].cameraOn = cameraOn;
    
    // Broadcast to room
    const roomName = peers[socket.id].roomName;
    Object.values(peers).forEach(peer => {
      if (peer.roomName === roomName && peer.socket.id !== socket.id) {
        peer.socket.emit("remote-producer-state", { 
          producerId, 
          cameraOn 
        });
      }
    });
  });

  socket.on("consume", async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId }, callback) => {
    try {
      console.log(`Consuming producer: ${remoteProducerId} on transport: ${serverConsumerTransportId}`);
      const roomName = peers[socket.id].roomName;
      if (!roomName) throw new Error("Peer not in a room");

      const producerData = producers[remoteProducerId];
      if (!producerData) throw new Error("Producer not found");

      const router = routers[roomName];
      if (!router) throw new Error("Router not found");

      if (!router.canConsume({ producerId: remoteProducerId, rtpCapabilities })) {
        throw new Error("Cannot consume - incompatible capabilities");
      }

      const transportData = transports[serverConsumerTransportId];
      if (!transportData) throw new Error("Transport not found");

      const consumer = await transportData.transport.consume({
        producerId: remoteProducerId,
        rtpCapabilities,
        paused: true,
      });

      consumers[consumer.id] = {
        socketId: socket.id,
        consumer,
        producerId: remoteProducerId,
        transportId: serverConsumerTransportId,
      };
      peers[socket.id].consumers.push(consumer.id);

      console.log(`Consumer created: ${consumer.id} for producer: ${remoteProducerId}`);

      consumer.on("transportclose", () => {
        console.log(`Consumer transport closed: ${consumer.id}`);
        consumer.close();
      });

      consumer.on("producerclose", () => {
        console.log(`Producer closed for consumer: ${consumer.id}`);
        consumer.close();
        socket.emit("producer-closed", { 
          remoteProducerId,
          username: producerData.username 
        });
      });

      callback({
        params: {
          id: consumer.id,
          producerId: remoteProducerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          serverConsumerId: consumer.id,
          cameraOn: producerData.cameraOn
        }
      });
    } catch (err) {
      console.error("Consume error:", err);
      callback({ error: err.message });
    }
  });

  socket.on("consumer-resume", async ({ serverConsumerId }, callback) => {
    try {
      console.log(`Resuming consumer: ${serverConsumerId}`);
      const consumerData = consumers[serverConsumerId];
      if (!consumerData) throw new Error("Consumer not found");

      await consumerData.consumer.resume();
      callback({ success: true });
    } catch (err) {
      console.error("consumer-resume error:", err);
      callback({ error: err.message });
    }
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    const peer = peers[socket.id];
    if (!peer) return;
    
    const username = peer.username;
    const roomName = peer.roomName;

    // Cleanup producers
    peer.producers.forEach(producerId => {
      const producer = producers[producerId];
      if (producer) {
        try {
          producer.producer.close();
        } catch (e) {
          console.error("Error closing producer:", e);
        }
        
        // Notify about producer closure
        Object.values(peers).forEach(p => {
          if (p.roomName === roomName && p.socket.id !== socket.id) {
            p.socket.emit("producer-closed", {
              remoteProducerId: producerId,
              username
            });
          }
        });
        
        delete producers[producerId];
      }
    });

    // Cleanup consumers
    peer.consumers.forEach(consumerId => {
      const consumer = consumers[consumerId];
      if (consumer) {
        try {
          consumer.consumer.close();
        } catch (e) {
          console.error("Error closing consumer:", e);
        }
        delete consumers[consumerId];
      }
    });

    // Cleanup transports
    peer.transports.forEach(transportId => {
      const transport = transports[transportId];
      if (transport) {
        try {
          transport.transport.close();
        } catch (e) {
          console.error("Error closing transport:", e);
        }
        delete transports[transportId];
      }
    });

    delete peers[socket.id];
    delete usernames[socket.id];
    
    // Notify room about user leaving
    if (roomName) {
      Object.values(peers).forEach(p => {
        if (p.roomName === roomName) {
          p.socket.emit("producer-closed", {
            remoteProducerId: socket.id,
            username
          });
        }
      });
    }
  });
});