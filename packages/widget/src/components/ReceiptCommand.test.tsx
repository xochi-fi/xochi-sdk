// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReceiptCommand } from "./ReceiptCommand.js";
import { WAIT } from "../test/waitBudget.js";

const COMMAND = "xochi-recipient receipt xi_shielded_receipt";
const writeText = vi.fn((_text: string) => Promise.resolve());

beforeEach(() => {
  writeText.mockReset();
  writeText.mockImplementation(() => Promise.resolve());
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

describe("ReceiptCommand", () => {
  // The receipt runs where the recipient's keys are, with the setup `enroll`
  // used; the line says so rather than implying the bare command runs alone.
  it("names where to run the command and what it needs", () => {
    render(<ReceiptCommand command={COMMAND} />);
    expect(document.querySelector(".expanded-receipt__text")?.textContent).toBe(
      `On the recipient's machine, run ${COMMAND} with the same options and XOCHI_JWT you used for enroll.`,
    );
  });

  it("copies only the command and announces it", async () => {
    render(<ReceiptCommand command={COMMAND} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy receipt command" }));

    expect(
      await screen.findByRole("button", { name: "Copied receipt command" }, WAIT),
    ).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(COMMAND);
    expect(screen.getByRole("status").textContent).toBe("Receipt command copied");
  });

  it("says so on a refused clipboard and selects the command to copy by hand", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    render(<ReceiptCommand command={COMMAND} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy receipt command" }));

    expect(
      await screen.findByText(
        "Copy did not work. The text is selected, press Cmd+C to copy it.",
        undefined,
        WAIT,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Copy did not work. The text is selected, press Cmd+C to copy it.",
    );
    expect(window.getSelection()?.toString()).toBe(COMMAND);
    expect(screen.queryByRole("button", { name: "Copied receipt command" })).toBeNull();
  });
});
