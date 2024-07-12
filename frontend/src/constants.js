export const EVENTS = {
  CONNECTION_SUCCESS: "connection-success",
  DISCONNECT: "disconnect",
  GET_RTP_CAPABILITIES: "getRtpCapabilities",
  ON_RTP_CAPABILITIES: "onRtpCapabilities",
  CREATE_WEBRTC_TRANSPORT: "createWebRtcTransport",
  CREATE_RECV_TRANSPORT: "createRecvRtcTransport",
  ON_WEBRTC_TRANSPORT: "onWebRtcTransport",
  TRANSPORT_CONNECT: "transportConnect",
  TRANSPORT_PRODUCE: "transportProduce",
  TRANSPORT_RECV_CONNECT: "transportRecvConnect",
  CONSUME: "consume",
  CONSUME_CALLBACK: "consume-callback",
  CONSUMER_RESUME: "consumerResume",
};

export const Sleep = async (ms) => {
  await new Promise((resolve) => {
    setTimeout(() => {
      resolve(1);
    }, ms);
  });
};
