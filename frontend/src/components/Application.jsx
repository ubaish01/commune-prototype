import React, { useState, useEffect, useRef } from "react";
import * as mediasoupClient from "mediasoup-client";
import { EVENTS } from "../constants";
import useSocket from "../hooks/useSocket";
import useMediaSoup from "../hooks/useMediasoup";

let params = {
  // mediasoup params
  encodings: [
    {
      rid: "r0",
      maxBitrate: 100000,
      scalabilityMode: "S1T3",
    },
    {
      rid: "r1",
      maxBitrate: 300000,
      scalabilityMode: "S1T3",
    },
    {
      rid: "r2",
      maxBitrate: 900000,
      scalabilityMode: "S1T3",
    },
  ],
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
  codecOptions: {
    videoGoogleStartBitrate: 1000,
  },
};

let device,
  producer,
  consumer,
  producerTransport,
  consumerTransport,
  isProducer,
  rtpCapabilities;

function Application() {
  // const [device, setDevice] = useState(null);
  const { socket } = useMediaSoup();
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const handleOnWebrtcTransport = (data) => {
    const { params } = data;

    if (params?.error) {
      console.log(params?.error);
      return;
    }

    console.log("On webRtc Transport");

    // Create a new WebRTC Transport to send media based on the server's producer transport params
    producerTransport = device.createSendTransport(params);

    // Handle the 'connect' event
    producerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          // Signal local DTLS parameters to the server side transport
          await socket.send(
            JSON.stringify({
              event: EVENTS.TRANSPORT_CONNECT,
              data: { dtlsParameters },
            })
          );

          // Tell the transport that parameters were transmitted
          callback();
        } catch (error) {
          errback(error);
        }
      }
    );

    console.log("Handelling produce event");

    // Handle the 'produce' event
    producerTransport.on("produce", async (parameters, callback, errback) => {
      console.log(parameters);

      try {
        // Tell the server to create a Producer with the following parameters and produce
        await socket.send(
          JSON.stringify({
            event: EVENTS.TRANSPORT_PRODUCE,
            data: {
              kind: parameters.kind,
              rtpParameters: parameters.rtpParameters,
              appData: parameters.appData,
            },
          })
        );

        // Handle server response
        socket.onmessage = (message) => {
          const { event, data } = JSON.parse(message.data);
          if (event === EVENTS.TRANSPORT_PRODUCE) {
            console.log("On transport produce");
            callback({ id: data.id });
          } else {
            errback(new Error("Unexpected response"));
          }
        };
        console.log("Calling connect send transport");
      } catch (error) {
        console.log(error);
        errback(error);
      }
    });

    connectSendTransport();
  };

  const handleRecvTransport = ({ params }) => {
    console.log("Inside recv transport");

    // The server sends back params needed
    // to create Send Transport on the client side
    if (params.error) {
      console.log(params.error);
      return;
    }

    console.log(params);

    // creates a new WebRTC Transport to receive media
    // based on server's consumer transport params
    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-createRecvTransport
    consumerTransport = device.createRecvTransport(params);

    // https://mediasoup.org/documentation/v3/communication-between-client-and-server/#producing-media
    // this event is raised when a first call to transport.produce() is made
    // see connectRecvTransport() below
    consumerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          // Signal local DTLS parameters to the server side transport
          // see server's socket.on('transport-recv-connect', ...)
          await socket.send(
            JSON.stringify({
              event: EVENTS.TRANSPORT_RECV_CONNECT,
              data: { dtlsParameters },
            })
          );

          // Tell the transport that parameters were transmitted.
          callback();
        } catch (error) {
          // Tell the transport that something was wrong
          errback(error);
        }
      }
    );
    connectRecvTransport();
  };

  const handleConsumeCallback = async ({ params }) => {
    console.log("Inside consume callback");
    if (params.error) {
      console.log("Cannot Consume");
      return;
    }

    console.log(params);
    // then consume with the local consumer transport
    // which creates a consumer
    consumer = await consumerTransport.consume({
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters,
    });

    // destructure and retrieve the video track from the producer
    const { track, audioTrack } = consumer;
    console.log({ track, audioTrack });
    remoteVideoRef.current.srcObject = new MediaStream([track]);

    // the server consumer started with media paused
    // so we need to inform the server to resume
    socket.send(JSON.stringify({ event: EVENTS.CONSUMER_RESUME }));
  };

  // ACTIONS 1-7

  // STEP 1
  const getLocalStream = async () => {
    console.log("Working");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: {
            min: 640,
            max: 1920,
          },
          height: {
            min: 400,
            max: 1080,
          },
        },
      });
      streamSuccess(stream);
    } catch (error) {
      console.log(error.message);
    }
  };

  const streamSuccess = async (stream) => {
    if (localVideoRef?.current) {
      localVideoRef.current.srcObject = stream;
    }
    const track = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];
    // console.log({ audioTrack, track });
    params = {
      track,
      audioTrack,
      ...params,
    };
    goConnect(true);
  };

  const goConnect = (producerOrConsumer) => {
    isProducer = producerOrConsumer;
    device === undefined ? getRtpCapabilities() : goCreateTransport();
  };

  // STEP 2 Get Router's RTP capabilities

  const getRtpCapabilities = () => {
    socket.send(
      JSON.stringify({
        event: EVENTS.GET_RTP_CAPABILITIES,
      })
    );
  };

  //STEP 3 Create a devce
  const createDevice = async () => {
    try {
      device = new mediasoupClient.Device();

      // https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-load
      // Loads the device with RTP capabilities of the Router (server side)
      await device.load({
        // see getRtpCapabilities() below
        routerRtpCapabilities: rtpCapabilities,
      });
      console.log("RTP Capabilities", device.rtpCapabilities);
      goCreateTransport();
    } catch (error) {
      console.log(error);
      if (error.name === "UnsupportedError")
        console.warn("browser not supported");
    }
  };

  const goCreateTransport = () => {
    isProducer ? createSendTransport() : createRecvTransport();
  };

  // STEP 4 Create send Transport
  const createSendTransport = () => {
    // Assuming ws is your WebSocket instance
    socket.send(
      JSON.stringify({
        event: EVENTS.CREATE_WEBRTC_TRANSPORT,
        data: { sender: true },
      })
    );
  };

  // STEP 5
  const connectSendTransport = async () => {
    // we now call produce() to instruct the producer transport
    // to send media to the Router
    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-produce
    // this action will trigger the 'connect' and 'produce' events above
    producer = await producerTransport.produce(params);

    producer.on("trackended", () => {
      console.log("track ended");

      // close video track
    });

    producer.on("transportclose", () => {
      console.log("transport ended");

      // close video track
    });
  };

  // STEP 6
  const createRecvTransport = async () => {
    // see server's socket.on('consume', sender?, ...)
    // this is a call from Consumer, so sender = false
    await socket.send(
      JSON.stringify({
        event: EVENTS.CREATE_WEBRTC_TRANSPORT,
        data: { sender: false },
      })
    );
  };

  // STEP 7
  const connectRecvTransport = async () => {
    // for consumer, we need to tell the server first
    // to create a consumer based on the rtpCapabilities and consume
    // if the router can consume, it will send back a set of params as below
    await socket.send(
      JSON.stringify({
        event: EVENTS.CONSUME,
        data: { rtpCapabilities: device.rtpCapabilities },
      })
    );
  };

  const goConsume = () => {
    goConnect(false);
  };

  useEffect(() => {
    if (!socket) return;
    socket.onmessage = async (message) => {
      const { event, data } = JSON.parse(message.data);

      console.log("Event triggered : ", event);

      switch (event) {
        case EVENTS.ON_RTP_CAPABILITIES:
          rtpCapabilities = data.rtpCapabilities;
          createDevice();
          break;

        case EVENTS.ON_WEBRTC_TRANSPORT:
          handleOnWebrtcTransport(data);
          break;

        case EVENTS.CREATE_RECV_TRANSPORT:
          handleRecvTransport(data);
          break;

        case EVENTS.CONSUME_CALLBACK:
          handleConsumeCallback(data);

        default:
          break;
      }
    };
  }, [socket]);

  return (
    <div className="bg-[#1A2C38] h-screen w-full flex items-center justify-center flex-col">
      <div className="flex items-center gap-4">
        <div className="text-white font-bold">
          LOCAL STREAM
          <video
            ref={localVideoRef}
            autoPlay
            muted
            src=""
            className="w-[30rem] bg-black rounded-md border border-amber-400"
          />
        </div>

        <div className="text-white font-bold">
          REMOTE STREAM
          <video
            ref={remoteVideoRef}
            autoPlay
            src=""
            className="w-[30rem] bg-black rounded-md border border-amber-400"
          />
        </div>
      </div>

      <div className=" gap-2  w-full lg:px-60 md:px-32 sm:12 grid md:grid-cols-12 sm:grid-cols-9 grid-cols-6">
        <button
          onClick={getLocalStream}
          className="bg-black col-span-3 active:scale-95 transition-all mt-4 text-white px-4 py-2 rounded-md"
        >
          Produce
        </button>
        <button
          onClick={goConsume}
          className="bg-black col-span-3 active:scale-95 transition-all mt-4 text-white px-4 py-2 rounded-md"
        >
          Consume
        </button>
      </div>
    </div>
  );
}

export default Application;
