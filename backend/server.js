const express = require("express");
const http = require("http");
const { v4 } = require("uuid");
const path = require("path");
const cors = require("cors");
require("dotenv").config();
const { WebSocketServer } = require("ws");
const mediasoup = require("mediasoup");
const { EVENT } = require("./constants");

const sendMessage = async (socket, event, data = {}) => {
  if (socket) {
    await socket.send(JSON.stringify({ event, data }));
  }
};

const app = express();
// const __dirname = path.resolve();

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  return res.json({
    success: true,
    message: "Welcome to the Mediasoup Server",
    AnnouncedIP: process.env.ANNOUNCED_IP,
  });
});

const httpServer = http.createServer(app);
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log("HTTP server listening on port: " + PORT);
  console.log("Announced IP : ", process.env.ANNOUNCED_IP);
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
    rtcMaxPort: 5000,
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

wss.on("connection", async (socket) => {
  socket.id = v4();
  console.log("New connection : ", socket.id);

  setTimeout(() => {
    sendMessage(socket, EVENT.CONNECTION_SUCCESS);
  }, 1000);

  const removeItems = (items, socketId, type) => {
    items.forEach((item) => {
      if (item.socketId === socket.id) {
        item[type].close();
      }
    });
    items = items.filter((item) => item.socketId !== socket.id);

    return items;
  };

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

  socket.on("close", () => {
    console.log("Peer disconnected");
    // do some cleanup
    console.log("peer disconnected");
    consumers = removeItems(consumers, socket.id, "consumer");
    producers = removeItems(producers, socket.id, "producer");
    transports = removeItems(transports, socket.id, "transport");

    if (peers[socket.id]) {
      const { roomName } = peers[socket.id];
      delete peers[socket.id];

      // remove socket from room
      rooms[roomName] = {
        router: rooms[roomName].router,
        peers: rooms[roomName].peers.filter(
          (socketId) => socketId !== socket.id
        ),
      };
    }
  });

  socket.on("message", async (message) => {
    const { event, data } = JSON.parse(message);
    console.log(event);
    switch (event) {
      case EVENT.JOIN_ROOM: {
        const { roomName } = data;
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

        if (data.consumer) {
          sendMessage(socket, EVENT.WEB_RTC_TRANPORT_CONSUMER_CALLBACK, {
            remoteProducerId: data.remoteProducerId,
            params: {
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
            },
          });
        } else {
          sendMessage(socket, EVENT.CREATE_WEB_RTC_TRANSPORT_CALLBACK, {
            params: {
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
            },
          });
        }

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
        sendMessage(socket, EVENT.GET_PRODUCERS_CALLBACK, {
          producerList,
          count: producers.length,
        });
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
        console.log(`DTLS PARAMS: ${dtlsParameters}`);
        const consumerTransport = transports.find(
          (transportData) =>
            transportData.consumer &&
            transportData.transport.id == serverConsumerTransportId
        ).transport;
        await consumerTransport.connect({ dtlsParameters });
        break;
      }

      case EVENT.CONSUME: {
        try {
          const {
            rtpCapabilities,
            remoteProducerId,
            serverConsumerTransportId,
          } = data;
          const { roomName } = peers[socket.id];
          const router = rooms[roomName].router;
          let consumerTransport = transports.find(
            (transportData) =>
              transportData.consumer &&
              transportData.transport.id == serverConsumerTransportId
          ).transport;

          // check if the router can consume the specified producer
          if (
            router.canConsume({
              producerId: remoteProducerId,
              rtpCapabilities,
            })
          ) {
            // transport can now consume and return a consumer
            const consumer = await consumerTransport.consume({
              producerId: remoteProducerId,
              rtpCapabilities,
              paused: true,
            });

            consumer.on("transportclose", () => {
              console.log("transport close from consumer");
            });

            consumer.on("producerclose", () => {
              console.log("producer of consumer closed");
              sendMessage(socket, EVENT.PRODUCER_CLOSED, { remoteProducerId });

              consumerTransport.close([]);
              transports = transports.filter(
                (transportData) =>
                  transportData.transport.id !== consumerTransport.id
              );
              consumer.close();
              consumers = consumers.filter(
                (consumerData) => consumerData.consumer.id !== consumer.id
              );
            });

            addConsumer(consumer, roomName);

            // from the consumer extract the following params
            // to send back to the Client
            const params = {
              id: consumer.id,
              producerId: remoteProducerId,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
              serverConsumerId: consumer.id,
            };

            // send the parameters to the client
            sendMessage(socket, EVENT.CONSUME_CALLBACK, { params });
          }
        } catch (error) {
          console.log(error.message);
          sendMessage(socket, EVENT.CONSUME_CALLBACK, {
            params: { error: error },
          });
        }

        break;
      }

      case EVENT.CONSUMER_RESUME: {
        const { serverConsumerId } = data;
        const consumerData = consumers.find(
          (consumerData) => consumerData.consumer.id === serverConsumerId
        );
        if (!consumerData) {
          console.error(`Consumer with id ${serverConsumerId} not found`);
          return;
        }
        const { consumer } = consumerData;

        try {
          await consumer.resume();
          console.log("id : ", consumerData.consumer.id);
          console.log(`Consumer ${serverConsumerId} resumed successfully`);
        } catch (error) {
          console.error(`Error resuming consumer ${serverConsumerId}`, error);
        }
        break;
      }
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
            // ip: "127.0.0.1",
            ip: "0.0.0.0",
            announcedIp: process.env.ANNOUNCED_IP,
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
