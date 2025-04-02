import React, { createContext,lazy,Suspense,useState, useEffect } from "react";

import RefApp from "@/components/ref";
import UseEffectApp from "@/components/InfiniteLoop/useEffect";
import UseIdApp from "@/components/useId";
import EventApp from "@/components/event";
import AsyncApp from "@/components/setState/async";
import PromiseApp from "@/components/setState/promise";
import EmptyComponent from "@/components/EmptyComponent";

import AutomaticApp from "@/components/batching/Automatic";
import ConcurrentApp from "@/components/batching/Concurrent";

import Counter from "@/components/counter";
// const Counter2 = lazy(() => import("@/components/counter"));

// const TestContext = createContext('test value');
function App() {
  const [flag, setFlag] = useState(false);

  return (
    <div id="app">
      {/* <RefApp /> */}
      {/* <TestContext.Provider value="provided value"> */}
      {/* <Suspense fallback={'loading counter'}><Counter2 name={1}/></Suspense> */}
      <div>
      {
        flag&& <div id="C">
          123
        </div>
      }
      </div>
      {
        flag&& <div id="A">
          {
            flag&& < Counter name={1}/>
          }
        </div>
      }
   
      <button onClick={()=>{
        setFlag(true)
      }}>测试</button>
    </div>
  );
}

export default App;
