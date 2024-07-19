import { useState } from "react";
import "./App.css";
import Application from "./components/Application";
import Version3 from "./components/Version3";

function App() {
  const roomName = window.location.pathname.split("/")[1];

  // return <Application />;
  return roomName ? (
    <Version3 roomName={roomName} />
  ) : (
    <div className=" p-8 flex items-center flex-col h-screen gap-8 justify-center">
      <div className="text-5xl">No Room Selected</div>
      <a
        href="/room1"
        className="rounded-md px-8 py-2 bg-black active:scale-95  "
      >
        Go to a random room
      </a>
    </div>
  );
}

export default App;
