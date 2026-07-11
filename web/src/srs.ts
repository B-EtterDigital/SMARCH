import { reportClientError } from "./lib/api";

let installed = false;

export function installClientErrorReporter(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (event) => {
    reportClientError("window.onerror", "fatal", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportClientError("window.unhandledrejection", "fatal", event.reason);
  });
}
