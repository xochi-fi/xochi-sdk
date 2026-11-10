import { createPeerExtensionSdk } from "@zkp2p/sdk";
import { probeCompatibility } from "./probe.mjs";
import { report } from "./compatibility.mjs";

const form = document.querySelector("#probe");
const output = document.querySelector("#result");
const render = (result) => {
  output.textContent = JSON.stringify(result, null, 2);
};
render(await probeCompatibility());

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(form));
  const buttons = form.querySelectorAll("button");
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    render(await probeCompatibility(input));
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
});

document.querySelector("#connect").addEventListener("click", async () => {
  try {
    await createPeerExtensionSdk().requestConnection();
    render(await probeCompatibility());
  } catch {
    render(
      report("onramp", {
        state: "setup_required",
        requirement_codes: ["peer_extension_connection"],
      }),
    );
  }
});
