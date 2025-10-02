import * as mediasoup from 'mediasoup';

let router;
const peers = new Map();
const globalProducers = new Map(); // producerId → { producer, socketId }

export async function initMediasoup() {
  const worker = await mediasoup.createWorker();
  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {},
      },
    ],
  });
  console.log('Mediasoup router initialized');
}

export function handleSocket(socket) {
  peers.set(socket.id, {});

  socket.on('disconnect', () => {
    peers.delete(socket.id);
    for (const [id, entry] of globalProducers.entries()) {
      if (entry.socketId === socket.id) globalProducers.delete(id);
    }
    console.log(`Client disconnected: ${socket.id}`);
  });

  socket.on('getRouterRtpCapabilities', (_, callback) => {
    callback(router.rtpCapabilities);
  });

  socket.on('createWebRtcTransport', async ({ sender }, callback) => {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: null }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });

    const peer = peers.get(socket.id);
    if (sender) {
      peer.producerTransport = transport;
    } else {
      peer.consumerTransport = transport;
    }

    callback({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    });
  });

  socket.on('connectTransport', async ({ dtlsParameters, sender }) => {
    const peer = peers.get(socket.id);
    const transport = sender ? peer.producerTransport : peer.consumerTransport;
    if (!transport || transport.connected) return;

    await transport.connect({ dtlsParameters });
    transport.connected = true;
    console.log(`Transport connected [sender: ${sender}]`);
  });

  socket.on('produce', async ({ kind, rtpParameters }, callback) => {
    const peer = peers.get(socket.id);
    const producer = await peer.producerTransport.produce({ kind, rtpParameters });
    peer.producer = producer;
    globalProducers.set(producer.id, { producer, socketId: socket.id });
    callback({ id: producer.id });
  });

  socket.on('consume', async ({ rtpCapabilities }, callback) => {
    const peer = peers.get(socket.id);
    const consumerTransport = peer.consumerTransport;
    const consumers = [];

    for (const [producerId, entry] of globalProducers.entries()) {
      if (entry.socketId === socket.id) continue;
      if (!router.canConsume({ producerId, rtpCapabilities })) continue;

      const consumer = await consumerTransport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });

      consumers.push({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    }

    callback(consumers);
  });
}
