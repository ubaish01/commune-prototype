const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const mediasoup = require("mediasoup");
const { EVENT } = require("./constants");

const app = express();
// const __dirname = path.resolve();

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
app.use("/sfu", express.static(path.join(__dirname, "public")));

const httpServer = http.createServer(app);
httpServer.listen(3000, () => {
  console.log("HTTP server listening on port: " + 3000);
});

const wss = new WebSocketServer({ server: httpServer });

let worker;
let router;
let producerTransport;
let consumerTransport;
let producer;
let consumer;

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", (error) => {
    console.error("mediasoup worker has died", error);
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
};

worker = createWorker();

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

wss.on("connection", async (ws) => {
  console.log("New connection");

  ws.on("close", () => {
    console.log("Peer disconnected");
  });

  router = await worker.createRouter({ mediaCodecs });

  ws.on("message", async (message) => {
    const { event, data } = JSON.parse(message);
    console.log(event);
    switch (event) {
      case EVENT.GET_RTP_CAPABILITIES:
        console.log("Getting rtp capabilities");
        const rtpCapabilities = router.rtpCapabilities;
        ws.send(
          JSON.stringify({
            event: EVENT.ON_RTP_CAPABILITIES,
            data: { rtpCapabilities },
          })
        );
        break;

      case EVENT.CREATE_WEBRTC_TRANSPORT:
        const transport = await createWebRtcTransport();
        ws.send(
          JSON.stringify({
            event: EVENT.ON_WEBRTC_TRANSPORT,
            data: { param: transport },
          })
        );
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

        console.log("Producer ID: ", producer.id, producer.kind);

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

          ws.send(JSON.stringify({ event: EVENT.CONSUME, data: { params } }));
        }
        break;

      case EVENT.CONSUMER_RESUME:
        await consumer.resume();
        break;
    }
  });
});

const createWebRtcTransport = async () => {
  try {
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

    let transport = await router.createWebRtcTransport(webRtcTransport_options);
    console.log(`Transport id: ${transport.id}`);

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    transport.on("close", () => {
      console.log("Transport closed");
    });

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  } catch (error) {
    console.log(error);
  }
};
