const express = require("express");
const http = require("http");
const { v4 } = require("uuid");
const path = require("path");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const mediasoup = require("mediasoup");
const { EVENT } = require("./constants");

const sendMessage = async (socket, event, data = {}) => {
  if (socket) {
    await socket.send(JSON.stringify(event, data));
  }
};

const app = express();
// const __dirname = path.resolve();

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const httpServer = http.createServer(app);
httpServer.listen(3000, () => {
  console.log("HTTP server listening on port: " + 3000);
});

const wss = new WebSocketServer({ server: httpServer });

/**
 * Worker
 * |-> Router(s)
 *     |-> Producer Transport(s)
 *         |-> Producer
 *     |-> Consumer Transport(s)
 *         |-> Consumer
 **/
let worker;
let rooms = {}; // { roomName1: { Router, rooms: [ sicketId1, ... ] }, ...}
let peers = {}; // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
let transports = []; // [ { socketId1, roomName1, transport, consumer }, ... ]
let producers = []; // [ { socketId1, roomName1, producer, }, ... ]
let consumers = []; // [ { socketId1, roomName1, consumer, }, ... ]

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", (error) => {
    // This implies something serious happened, so kill the application
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
  });

  return worker;
};

// We create a Worker as soon as our application starts
worker = createWorker();

// This is an Array of RtpCapabilities
// https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtpCodecCapability
// list of media codecs supported by mediasoup ...
// https://github.com/versatica/mediasoup/blob/v3/src/supportedRtpCapabilities.ts
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

const createRoom = async (roomName, socketId) => {
  // worker.createRouter(options)
  // options = { mediaCodecs, appData }
  // mediaCodecs -> defined above
  // appData -> custom application data - we are not supplying any
  // none of the two are required
  let router1;
  let peers = [];
  if (rooms[roomName]) {
    router1 = rooms[roomName].router;
    peers = rooms[roomName].peers || [];
  } else {
    router1 = await worker.createRouter({ mediaCodecs });
  }

  console.log(`Router ID: ${router1.id}`, peers.length);

  rooms[roomName] = {
    router: router1,
    peers: [...peers, socketId],
  };

  return router1;
};

const addTransport = (transport, roomName, consumer) => {
  transports = [
    ...transports,
    { socketId: socket.id, transport, roomName, consumer },
  ];

  peers[socket.id] = {
    ...peers[socket.id],
    transports: [...peers[socket.id].transports, transport.id],
  };
};

const addProducer = (producer, roomName) => {
  producers = [...producers, { socketId: socket.id, producer, roomName }];

  peers[socket.id] = {
    ...peers[socket.id],
    producers: [...peers[socket.id].producers, producer.id],
  };
};

const addConsumer = (consumer, roomName) => {
  // add the consumer to the consumers list
  consumers = [...consumers, { socketId: socket.id, consumer, roomName }];

  // add the consumer id to the peers list
  peers[socket.id] = {
    ...peers[socket.id],
    consumers: [...peers[socket.id].consumers, consumer.id],
  };
};

const informConsumers = (roomName, socketId, id) => {
  console.log(`just joined, id ${id} ${roomName}, ${socketId}`);
  // A new producer just joined
  // let all consumers to consume this producer
  producers.forEach((producerData) => {
    if (
      producerData.socketId !== socketId &&
      producerData.roomName === roomName
    ) {
      const producerSocket = peers[producerData.socketId].socket;
      // use socket to send producer id to producer
      sendMessage(producerSocket, EVENT.NEW_PRODUCER, { producerId: id });
    }
  });
};

const getTransport = (socketId) => {
  const [producerTransport] = transports.filter(
    (transport) => transport.socketId === socketId && !transport.consumer
  );
  return producerTransport.transport;
};

wss.on("connection", async (socket) => {
  socket.id = v4();
  console.log("New connection : ", socket.id);

  sendMessage(socket, EVENT.CONNECTION_SUCCESS);

  const removeItems = (items, socketId, type) => {
    items.forEach((item) => {
      if (item.socketId === socket.id) {
        item[type].close();
      }
    });
    items = items.filter((item) => item.socketId !== socket.id);

    return items;
  };

  socket.on("close", () => {
    console.log("Peer disconnected");
    // do some cleanup
    console.log("peer disconnected");
    consumers = removeItems(consumers, socket.id, "consumer");
    producers = removeItems(producers, socket.id, "producer");
    transports = removeItems(transports, socket.id, "transport");

    const { roomName } = peers[socket.id];
    delete peers[socket.id];

    // remove socket from room
    rooms[roomName] = {
      router: rooms[roomName].router,
      peers: rooms[roomName].peers.filter((socketId) => socketId !== socket.id),
    };
  });

  socket.on("message", async (message) => {
    const { event, data } = JSON.parse(message);
    console.log(event);
    switch (event) {
      case EVENT.JOIN_ROOM: {
        const router1 = await createRoom(roomName, socket.id);

        peers[socket.id] = {
          socket,
          roomName, // Name for the Router this Peer joined
          transports: [],
          producers: [],
          consumers: [],
          peerDetails: {
            name: "",
            isAdmin: false, // Is this Peer the Admin?
          },
        };

        // get Router RTP Capabilities
        const rtpCapabilities = router1.rtpCapabilities;

        // call callback from the client and send back the rtpCapabilities
        sendMessage(socket, EVENT.JOIN_ROOM_CALLBACK, { rtpCapabilities });
        break;
      }

      case EVENT.CREATE_WEB_RTC_TRANSPORT: {
        // get Room Name from Peer's properties
        const roomName = peers[socket.id].roomName;

        // get Router (Room) object this peer is in based on RoomName
        const router = rooms[roomName].router;

        const transport = await createWebRtcTransport(router);
        sendMessage(socket, EVENT.CREATE_WEB_RTC_TRANSPORT_CALLBACK, {
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          },
        });

        // add transport to Peer's properties
        addTransport(transport, roomName, data.consumer);

        break;
      }

      case EVENT.GET_PRODUCERS: {
        //return all producer transports
        const { roomName } = peers[socket.id];

        let producerList = [];
        producers.forEach((producerData) => {
          if (
            producerData.socketId !== socket.id &&
            producerData.roomName === roomName
          ) {
            producerList = [...producerList, producerData.producer.id];
          }
        });

        // return the producer list back to the client
        sendMessage(socket, EVENT.GET_PRODUCERS_CALLBACK);
        break;
      }

      // see client's TRANSTPORT_CONNECT
      case EVENT.TRANSPORT_CONNECT: {
        const { dtlsParameters } = data;
        console.log("DTLS PARAMS... ", { dtlsParameters });

        getTransport(socket.id).connect({ dtlsParameters });
        break;
      }

      // see client's socket.send('TRANSPORT_PRODUCE', ...)
      case EVENT.TRANSPORT_PRODUCE: {
        const { kind, rtpParameters, appData } = data;
        // call produce based on the prameters from the client
        const producer = await getTransport(socket.id).produce({
          kind,
          rtpParameters,
        });

        // add producer to the producers array
        const { roomName } = peers[socket.id];

        addProducer(producer, roomName);

        informConsumers(roomName, socket.id, producer.id);

        console.log("Producer ID: ", producer.id, producer.kind);

        producer.on("transportclose", () => {
          console.log("transport for this producer closed ");
          producer.close();
        });

        // Send back to the client the Producer's id
        sendMessage(socket, EVENT.TRANSPORT_PRODUCE_CALLBACK, {
          id: producer.id,
          producersExist: producers.length > 1 ? true : false,
        });
        break;
      }

      case EVENT.TRANSPORT_RECV_CONNECT: {
        const { dtlsParameters, serverConsumerTransportId } = data;

        break;
      }

      case EVENT.CONSUME: {
        const { rtpCapabilities, remoteProducerId, serverConsumerTransportId } =
          data;

        break;
      }

      case EVENT.CONSUMER_RESUME: {
        const { serverConsumerId } = data;

        break;
      }

      // PREVIOUS CODE BELOW

      case EVENT.GET_RTP_CAPABILITIES:
        if (!router) router = await worker.createRouter({ mediaCodecs });
        console.log("Getting rtp capabilities");
        const rtpCapabilities = router.rtpCapabilities;
        ws.send(
          JSON.stringify({
            event: EVENT.ON_RTP_CAPABILITIES,
            data: { rtpCapabilities },
          })
        );
        break;

      case EVENT.CREATE_WEB_RTC_TRANSPORT:
        const transport = await createWebRtcTransport();
        if (data.sender) {
          producerTransport = transport;
          ws.send(
            JSON.stringify({
              event: EVENT.ON_WEBRTC_TRANSPORT,
              data: {
                params: {
                  id: transport.id,
                  iceParameters: transport.iceParameters,
                  iceCandidates: transport.iceCandidates,
                  dtlsParameters: transport.dtlsParameters,
                },
              },
            })
          );
        } else {
          consumerTransport = transport;
          ws.send(
            JSON.stringify({
              event: EVENT.CREATE_RECV_TRANSPORT,
              data: {
                params: {
                  id: transport.id,
                  iceParameters: transport.iceParameters,
                  iceCandidates: transport.iceCandidates,
                  dtlsParameters: transport.dtlsParameters,
                },
              },
            })
          );
        }

        break;

      case EVENT.TRANSPORT_CONNECT:
        await producerTransport.connect({
          dtlsParameters: data.dtlsParameters,
        });
        break;

      case EVENT.TRANSPORT_PRODUCE:
        producer = await producerTransport.produce({
          kind: data.kind,
          rtpParameters: data.rtpParameters,
        });

        producer.on("transportclose", () => {
          console.log("Transport for this producer closed ");
          producer.close();
        });

        ws.send(
          JSON.stringify({
            event: EVENT.TRANSPORT_PRODUCE,
            data: { id: producer.id },
          })
        );
        break;

      case EVENT.TRANSPORT_RECV_CONNECT:
        await consumerTransport.connect({
          dtlsParameters: data.dtlsParameters,
        });
        break;

      case EVENT.CONSUME:
        if (
          router.canConsume({
            producerId: producer.id,
            rtpCapabilities: data.rtpCapabilities,
          })
        ) {
          consumer = await consumerTransport.consume({
            producerId: producer.id,
            rtpCapabilities: data.rtpCapabilities,
            paused: true,
          });

          consumer.on("transportclose", () => {
            console.log("Transport close from consumer");
          });

          consumer.on("producerclose", () => {
            console.log("Producer of consumer closed");
          });

          const params = {
            id: consumer.id,
            producerId: producer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          };

          ws.send(
            JSON.stringify({ event: EVENT.CONSUME_CALLBACK, data: { params } })
          );
        }
        break;

      case EVENT.CONSUMER_RESUME:
        console.log("consume resume");
        await consumer.resume();
        break;

      // PREVIOUS CODE ABOVE
    }
  });
});

const createWebRtcTransport = async (router) => {
  return new Promise(async (resolve, reject) => {
    try {
      // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
      const webRtcTransport_options = {
        listenIps: [
          {
            ip: "0.0.0.0",
            announcedIp: "127.0.0.1",
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      };

      // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
      let transport = await router.createWebRtcTransport(
        webRtcTransport_options
      );
      console.log(`transport id: ${transport.id}`);

      transport.on("dtlsstatechange", (dtlsState) => {
        if (dtlsState === "closed") {
          transport.close();
        }
      });

      transport.on("close", () => {
        console.log("transport closed");
      });

      resolve(transport);
    } catch (error) {
      reject(error);
    }
  });
};
