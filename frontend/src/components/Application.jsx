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

function Application() {
  const [device, setDevice] = useState(null);
  const [rtpCapabilities, setRtpCapabilities] = useState(null);
  const { socket } = useMediaSoup();
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const handleOnWebrtcTransport = (data) => {
    const { params } = data;
    console.log(params);
    if (params?.error) {
      console.log(params?.error);
      return;
    }

    console.log(params);

    // Create a new WebRTC Transport to send media based on the server's producer transport params
    const newProducerTransport = device.createSendTransport(params);

    // Handle the 'connect' event
    newProducerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          // Signal local DTLS parameters to the server side transport
          socket.send(
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

    // Handle the 'produce' event
    newProducerTransport.on(
      "produce",
      async (parameters, callback, errback) => {
        console.log(parameters);

        try {
          // Tell the server to create a Producer with the following parameters and produce
          socket.send(
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
              callback({ id: data.id });
            } else {
              errback(new Error("Unexpected response"));
            }
          };
        } catch (error) {
          errback(error);
        }
      }
    );
  };

  // ACTIONS 1-7

  // STEP 1
  const getLocalStream = async () => {
    console.log("Working");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
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
    params = {
      track,
      ...params,
    };
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
      const newDevice = new mediasoupClient.Device();

      // https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-load
      // Loads the device with RTP capabilities of the Router (server side)
      await newDevice.load({
        // see getRtpCapabilities() below
        routerRtpCapabilities: rtpCapabilities,
      });
      setDevice(newDevice);
      console.log("RTP Capabilities", newDevice.rtpCapabilities);
    } catch (error) {
      console.log(error);
      if (error.name === "UnsupportedError")
        console.warn("browser not supported");
    }
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

  useEffect(() => {
    if (!socket) return;
    socket.onmessage = async (message) => {
      const { event, data } = JSON.parse(message.data);

      console.log({ event, data });
      switch (event) {
        case EVENTS.ON_RTP_CAPABILITIES:
          setRtpCapabilities(data.rtpCapabilities);
          break;

        case EVENTS.ON_WEBRTC_TRANSPORT:
          handleOnWebrtcTransport(data);
          break;

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
            src=""
            className="w-[30rem] bg-black rounded-md border border-amber-400"
          />
        </div>
      </div>

      <div className=" gap-2  w-full px-60 grid grid-cols-12">
        <button
          onClick={getLocalStream}
          className="bg-black col-span-3 active:scale-95 transition-all mt-4 text-white px-4 py-2 rounded-md"
        >
          1. Get Local stream
        </button>
        <button
          onClick={getRtpCapabilities}
          className="bg-black col-span-3 active:scale-95 transition-all mt-4 text-white px-4 py-2 rounded-md"
        >
          2. Get rtpCapabilities
        </button>
        <button
          onClick={createDevice}
          className="bg-black col-span-3 active:scale-95 transition-all mt-4 text-white px-4 py-2 rounded-md"
        >
          3. Create Device
        </button>
        <button
          onClick={createSendTransport}
          className="bg-black col-span-3 active:scale-95 transition-all mt-4 text-white px-4 py-2 rounded-md"
        >
          4. Create send transport
        </button>
        <button
          onClick={() => {}}
          className="bg-black col-span-3 active:scale-95 transition-all mt-4 text-white px-4 py-2 rounded-md"
        >
          5. Connect send transport and produce
        </button>
        <button
          onClick={() => {}}
          className="bg-black col-span-3 active:scale-95 transition-all mt-4 text-white px-4 py-2 rounded-md"
        >
          6. Create recv transport
        </button>
        <button
          onClick={() => {}}
          className="bg-black col-span-3 active:scale-95 transition-all mt-4 text-white px-4 py-2 rounded-md"
        >
          7. Connect recv transport and consume
        </button>
      </div>
    </div>
  );
}

export default Application;
