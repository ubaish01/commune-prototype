import { useState } from "react";
import "./App.css";
import Application from "./components/Application";

function App() {
  const [count, setCount] = useState(0);

  return <Application />;
}

export default App;
