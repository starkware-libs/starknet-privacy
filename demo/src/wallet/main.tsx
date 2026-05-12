import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WalletApp } from "./WalletApp.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletApp />
  </StrictMode>
);
