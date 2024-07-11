import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const useSocket = (url, options = {}) => {
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    const socketInstance = io(url, options);
    setSocket(socketInstance);
    console.log({ socket: socketInstance });

    // Clean up the socket connection when the component unmounts
    return () => {
      socketInstance.disconnect();
    };
  }, []);

  return socket;
};

export default useSocket;
