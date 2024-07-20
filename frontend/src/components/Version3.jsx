import { useState, useEffect, useRef } from "react";
import * as mediasoupClient from "mediasoup-client";
import useMediaSoup from "../hooks/useMediasoup";
import { Sleep } from "../constants";

const sendMessage = async (socket, event, data = {}) => {
  if (socket) {
    await socket.send(JSON.stringify({ event, data }));
  }
};

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

let device;
let rtpCapabilities;
let producerTransport;
let consumerTransports = [];
let audioProducer;
let videoProducer;
let consumer;
let isProducer = false;
let audioParams;
let videoParams = { params };
let consumingTransports = [];
let producersIds = [];

export const EVENT = {
  CONNECTION_SUCCESS: "connection-success",
  JOIN_ROOM: "join-room",
  JOIN_ROOM_CALLBACK: "join-room-callback",
  CREATE_WEB_RTC_TRANSPORT: "create-web-rtc-transport",
  CREATE_WEB_RTC_TRANSPORT_CALLBACK: "create-web-rtc-transport-callback",
  GET_PRODUCERS: "get-proucers",
  GET_PRODUCERS_CALLBACK: "get-producers-callback",
  TRANSPORT_CONNECT: "transport-connect",
  TRANSPORT_CONNECT_CALLBACK: "transport-connect-callback",
  TRANSPORT_PRODUCE: "transport-produce",
  TRANSPORT_PRODUCE_CALLBACK: "transport-produce-callback",
  TRANSPORT_RECV_CONNECT: "transport-recv-connect",
  CONSUME: "consume",
  CONSUME_CALLBACK: "consume-callback",
  RESUME: "resume",
  WEB_RTC_TRANPORT_CONSUMER_CALLBACK: "web-rtc-consumer-callback",
  PRODUCER_CLOSED: "producer-closed",
  NEW_PRODUCER: "new-producer",
  CONSUMER_RESUME: "consumer-resume",
};

const Version3 = ({ roomName }) => {
  const { socket } = useMediaSoup();

  // SOCKET ACTIONS

  const joinRoom = () => {
    sendMessage(socket, EVENT.JOIN_ROOM, { roomName });
  };

  const streamSuccess = (stream) => {
    localVideo.srcObject = stream;

    // audioParams = { track: stream.getAudioTracks()[0], ...audioParams };
    videoParams = { track: stream.getVideoTracks()[0], ...videoParams };

    joinRoom();
  };

  const getLocalStream = () => {
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
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
      })
      .then(streamSuccess)
      .catch((error) => {
        console.error(error.message);
      });
  };

  const createSendTransport = () => {
    // see server's socket.on('createWebRtcTransport', sender?, ...)
    // this is a call from Producer, so sender = true
    sendMessage(socket, EVENT.CREATE_WEB_RTC_TRANSPORT, { consumer: false });
  };

  const createDevice = async () => {
    try {
      device = new mediasoupClient.Device();

      // https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-load
      // Loads the device with RTP capabilities of the Router (server side)
      await device.load({
        // see getRtpCapabilities() below
        routerRtpCapabilities: rtpCapabilities,
      });

      //   console.log("Device RTP Capabilities", device.rtpCapabilities);

      // once the device loads, create transport
      createSendTransport();
    } catch (error) {
      console.error(error);
      if (error.name === "UnsupportedError")
        console.warn("browser not supported");
    }
  };

  const getProducers = () => {
    sendMessage(socket, EVENT.GET_PRODUCERS);
  };

  const handleOnWebrtcTransportConsumer = ({ params, remoteProducerId }) => {
    // The server sends back params needed
    // to create Send Transport on the client side
    console.log("WEB_RTC_TRANPORT_CONSUMER_CALLBACK");
    if (params.error) {
      console.error(params.error);
      return;
    }
    //   console.log(`PARAMS... ${params}`);

    let consumerTransport;
    try {
      consumerTransport = device.createRecvTransport(params);
    } catch (error) {
      // exceptions:
      // {InvalidStateError} if not loaded
      // {TypeError} if wrong arguments.
      console.error(error);
      return;
    }

    consumerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          // Signal local DTLS parameters to the server side transport
          // see server's socket.on('transport-recv-connect', ...)
          await sendMessage(socket, EVENT.TRANSPORT_RECV_CONNECT, {
            dtlsParameters,
            serverConsumerTransportId: params.id,
          });

          // Tell the transport that parameters were transmitted.
          callback();
        } catch (error) {
          // Tell the transport that something was wrong
          errback(error);
        }
      }
    );

    connectRecvTransport(consumerTransport, remoteProducerId, params.id);
  };

  const signalNewConsumerTransport = async (remoteProducerId) => {
    //check if we are already consuming the remoteProducerId
    // console.log(`${index + 1} : ${remoteProducerId}`);
    if (consumingTransports.includes(remoteProducerId)) return;
    consumingTransports.push(remoteProducerId);

    await sendMessage(socket, EVENT.CREATE_WEB_RTC_TRANSPORT, {
      consumer: true,
      remoteProducerId,
    });
  };

  const connectRecvTransport = async (
    consumerTransport,
    remoteProducerId,
    serverConsumerTransportId
  ) => {
    // for consumer, we need to tell the server first
    // to create a consumer based on the rtpCapabilities and consume
    // if the router can consume, it will send back a set of params as below
    console.log("Send Consume");
    await sendMessage(socket, EVENT.CONSUME, {
      rtpCapabilities: device.rtpCapabilities,
      remoteProducerId,
      serverConsumerTransportId,
    });

    const consumeCallback = async ({ params }) => {
      if (params.error) {
        // console.log("Cannot Consume");
        return;
      }

      //   console.log(`Consumer Params ${params}`);
      // then consume with the local consumer transport
      // which creates a consumer
      const consumer = await consumerTransport.consume({
        id: params.id,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
      });

      consumerTransports = [
        ...consumerTransports,
        {
          consumerTransport,
          serverConsumerTransportId: params.id,
          producerId: remoteProducerId,
          consumer,
        },
      ];

      // create a new div element for the new consumer media
      // and append to the video container
      const newElem = document.createElement("div");
      newElem.setAttribute("id", `td-${remoteProducerId}`);
      newElem.setAttribute(
        "class",
        "remoteVideo border  rounded-md overflow-hidden md:col-span-2 col-span-3"
      );
      newElem.innerHTML =
        '<video id="' + remoteProducerId + '" autoPlay class="video" ></video>';
      videoContainer.appendChild(newElem);

      // destructure and retrieve the video track from the producer
      const { track } = consumer;
      const videoElement = document.getElementById(remoteProducerId);
      console.log({ track });
      console.log(videoElement);
      videoElement.srcObject = new MediaStream([track]);

      // the server consumer started with media paused
      // so we need to inform the server to resume
      console.log("Send Consumer Resume, id : ", remoteProducerId);
      sendMessage(socket, EVENT.CONSUMER_RESUME, {
        serverConsumerId: params.serverConsumerId,
      });

      // Log to check if the video element is set up correctly
      videoElement.onloadedmetadata = () => {
        console.log(`Video element ${remoteProducerId} loaded metadata`);
        videoElement
          .play()
          .then(() => {
            console.log(`Video element ${remoteProducerId} is playing`);
          })
          .catch((err) => {
            console.error(
              `Error playing video element ${remoteProducerId}`,
              err
            );
          });
      };

      // Log to check if the video element is set up correctly
      videoElement.onloadedmetadata = () => {
        console.log(`Video element ${remoteProducerId} loaded metadata`);
        videoElement
          .play()
          .then(() => {
            console.log(`Video element ${remoteProducerId} is playing`);
          })
          .catch((err) => {
            console.error(
              `Error playing video element ${remoteProducerId}`,
              err
            );
          });
      };

      // Log when the track is muted or ended
      track.onmute = () => {
        console.warn(`Track for ${remoteProducerId} is muted`);
      };

      track.onunmute = () => {
        console.log(`Track for ${remoteProducerId} is unmuted`);
      };

      track.onended = () => {
        console.error(`Track for ${remoteProducerId} has ended`);
      };
    };

    socket.onmessage = (message) => {
      const { event, data } = JSON.parse(message.data);
      if (event === EVENT.CONSUME_CALLBACK) consumeCallback(data);
      else manageSocketEvents(event, data);
    };
  };

  // SOCKET EVENTS HANDLERS
  const handleConnectionSuccess = (data) => {
    // console.log("Connection success");
    getLocalStream();
  };

  const handleJoinRoom = (data) => {
    rtpCapabilities = data.rtpCapabilities;
    createDevice();
  };

  const connectSendTransport = async () => {
    // we now call produce() to instruct the producer transport
    // to send media to the Router
    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-produce
    // this action will trigger the 'connect' and 'produce' events above

    // audioProducer = await producerTransport.produce(audioParams);
    videoProducer = await producerTransport.produce(videoParams);

    // audioProducer.on("trackended", () => {
    //   console.log("audio track ended");

    //   // close audio track
    // });

    // audioProducer.on("transportclose", () => {
    //   console.log("audio transport ended");

    //   // close audio track
    // });

    videoProducer.on("trackended", () => {
      //   console.log("video track ended");
      // close video track
    });

    videoProducer.on("transportclose", () => {
      //   console.log("video transport ended");
      // close video track
    });
  };

  const handleGetProducers = async ({ producerList }) => {
    producersIds = producerList;
    // for each of the producer create a consumer
    // producerIds.forEach(id => signalNewConsumerTransport(id))
    for (let i = 0; i < producerList.length; i++) {
      const id = producerList[i];
      console.log("Executed : ", i);
      await signalNewConsumerTransport(id);
      await Sleep(100); // Pause for 5 seconds
    }
  };

  const handleCreateSendTransport = (data) => {
    const { params } = data;

    if (params?.error) {
      //   console.log(params?.error);
      return;
    }

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
              event: EVENT.TRANSPORT_CONNECT,
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
      //   console.log(parameters);

      try {
        // Tell the server to create a Producer with the following parameters and produce
        await socket.send(
          JSON.stringify({
            event: EVENT.TRANSPORT_PRODUCE,
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
          console.log("Event triggered : ", event);
          if (event === EVENT.TRANSPORT_PRODUCE_CALLBACK) {
            console.log("On transport produce");
            callback({ id: data.id });
            if (data.producersExist) getProducers();
          } else {
            manageSocketEvents(event, data);
          }
        };
        console.log("Calling connect send transport");
      } catch (error) {
        console.error(error);
        errback(error);
      }
    });

    connectSendTransport();
  };

  const handleProducerClosed = ({ remoteProducerId }) => {
    // server notification is received when a producer is closed
    // we need to close the client-side consumer and associated transport
    const producerToClose = consumerTransports.find(
      (transportData) => transportData.producerId === remoteProducerId
    );
    producerToClose.consumerTransport.close();
    producerToClose.consumer.close();

    // remove the consumer transport from the list
    consumerTransports = consumerTransports.filter(
      (transportData) => transportData.producerId !== remoteProducerId
    );

    // remove the video div element
    videoContainer.removeChild(
      document.getElementById(`td-${remoteProducerId}`)
    );
  };

  // server informs the client of a new producer just joined
  const handleNewProducer = ({ producerId }) => {
    console.log("new producer : ", producerId);
    signalNewConsumerTransport(producerId);
  };

  const manageSocketEvents = (event, data) => {
    switch (event) {
      case EVENT.CONNECTION_SUCCESS:
        handleConnectionSuccess();
        break;

      case EVENT.JOIN_ROOM_CALLBACK:
        handleJoinRoom(data);
        break;

      case EVENT.CREATE_WEB_RTC_TRANSPORT_CALLBACK:
        handleCreateSendTransport(data);
        break;

      case EVENT.GET_PRODUCERS_CALLBACK:
        handleGetProducers(data);
        break;

      case EVENT.PRODUCER_CLOSED:
        handleProducerClosed(data);
        break;

      case EVENT.NEW_PRODUCER:
        handleNewProducer(data);
        break;

      case EVENT.WEB_RTC_TRANPORT_CONSUMER_CALLBACK:
        handleOnWebrtcTransportConsumer(data);
        break;

      default:
        console.error("Unhandeled socket event");
        console.log({ event, data });
        break;
    }
  };

  const HandleSocketEvents = () => {
    if (!socket) return;
    socket.onmessage = async (message) => {
      const { event, data } = JSON.parse(message.data);
      console.log("Event triggered : ", event);
      manageSocketEvents(event, data);
    };
  };

  useEffect(() => {
    HandleSocketEvents();
  }, [socket]);

  return (
    <div className="flex items-center justify-center p-8">
      <div id="video">
        <div className="remoteColumn ">
          <div className="grid grid-cols-6 gap-4" id="videoContainer">
            <div className="md:col-span-2 col-span-3 relative border-2 border-purple-500 rounded-md overflow-hidden">
              <div className="absolute top-1 left-2">you*</div>
              <video id="localVideo" autoPlay className="video" muted></video>
            </div>
          </div>
        </div>
        <table>
          <tbody>
            <tr>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Version3;
