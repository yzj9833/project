import React, { createContext,lazy,Suspense } from "react";
import RefApp from "@/components/ref";
import UseEffectApp from "@/components/InfiniteLoop/useEffect";
import UseIdApp from "@/components/useId";
import EventApp from "@/components/event";
import AsyncApp from "@/components/setState/async";
import PromiseApp from "@/components/setState/promise";
import EmptyComponent from "@/components/EmptyComponent";

import AutomaticApp from "@/components/batching/Automatic";
import ConcurrentApp from "@/components/batching/Concurrent";

// import Counter from "@/components/counter";
const Counter = lazy(() => import("@/components/counter"));

// const TestContext = createContext('test value');
function App() {
  return (
    <div id="app">
      {/* <RefApp /> */}
      {/* <TestContext.Provider value="provided value"> */}
      <Suspense fallback={'loading counter'}><Counter name={1}/></Suspense>
      
      {/* </TestContext.Provider> */}
      {/* <UseEffectApp /> */}
      {/* <UseIdApp /> */}
      {/* <EmptyComponent /> */}
      {/* <EventApp /> */}
      {/* <PromiseApp /> */}
      {/* <AsyncApp /> */}

      {/* <AutomaticApp /> */}
      {/* <ConcurrentApp /> */}
    </div>
  );
}

export default App;
