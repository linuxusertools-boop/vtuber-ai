import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

// Error di luar React (CDN gagal, promise tak tertangani, dst.) tidak boleh mengganggu pengguna.
window.addEventListener("error", (e) => {
  console.warn("[YUKI] error:", e.message);
  e.preventDefault();
});
window.addEventListener("unhandledrejection", (e) => {
  console.warn("[YUKI] unhandled rejection:", e.reason);
  e.preventDefault();
});

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
}
