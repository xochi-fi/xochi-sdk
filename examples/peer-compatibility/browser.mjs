import { createPeerExtensionSdk } from "@zkp2p/sdk";
import { probeCompatibility } from "./probe.mjs";
import { report } from "./compatibility.mjs";

const form = document.querySelector("#probe");
const output = document.querySelector("#result");
const buttons = form.querySelectorAll("button");
let latest = 0;
// Only the newest probe renders, so the slow startup probe cannot overwrite a later result.
const show = async (result) => {
  const id = ++latest;
  const value = await result;
  if (id === latest) output.textContent = JSON.stringify(value, null, 2);
};

// Attach before any await. An unhandled submit is a native GET that puts the wallet
// address and amount in the page URL.
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(form));
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    await show(probeCompatibility(input));
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
});

document.querySelector("#connect").addEventListener("click", async () => {
  try {
    await createPeerExtensionSdk().requestConnection();
    await show(probeCompatibility());
  } catch {
    await show(
      report("onramp", {
        state: "setup_required",
        requirement_codes: ["peer_extension_connection"],
      }),
    );
  }
});

// index.html ships the submit button disabled so nothing submits before the listener exists.
buttons.forEach((button) => {
  button.disabled = false;
});
await show(probeCompatibility());
