import { useState } from "react";
import "./App.css";
import Application from "./components/Application";
import Version3 from "./components/Version3";

function App() {
  const [count, setCount] = useState(0);

  // return <Application />;
  return <Version3 />;
}

export default App;
