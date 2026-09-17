import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

const soundPath = "/System/Library/Sounds/Glass.aiff";

function playDoneSound(): void {
  const child = spawn("afplay", [soundPath], {
    detached: true,
    stdio: "ignore",
  });

  child.on("error", () => {});
  child.unref();
}

export default function (pi: ExtensionAPI) {
  if (process.platform !== "darwin") {
    return;
  }

  pi.on("agent_end", async () => {
    playDoneSound();
  });
}
