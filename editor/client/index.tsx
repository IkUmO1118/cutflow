import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { MobileGate } from "./MobileGate.tsx";
import { ThemeProvider } from "./theme.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root がありません");
createRoot(root).render(
  <ThemeProvider>
    <MobileGate><App /></MobileGate>
  </ThemeProvider>,
);
