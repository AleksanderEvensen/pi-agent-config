import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

const soundPath = "/System/Library/Sounds/Glass.aiff";

function playDoneSound(): void {
  const child = spawn("afplay", [soundPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async () => {
    playDoneSound();
  });
}
