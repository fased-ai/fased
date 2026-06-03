import { describe, expect, it } from "vitest";
import { splitArgsPreservingQuotes } from "./arg-split.js";

describe("splitArgsPreservingQuotes", () => {
  it("splits on whitespace outside quotes", () => {
    expect(splitArgsPreservingQuotes('/usr/bin/fased gateway start --name "My Bot"')).toEqual([
      "/usr/bin/fased",
      "gateway",
      "start",
      "--name",
      "My Bot",
    ]);
  });

  it("supports systemd-style backslash escaping", () => {
    expect(
      splitArgsPreservingQuotes('fased --name "My \\"Bot\\"" --foo bar', {
        escapeMode: "backslash",
      }),
    ).toEqual(["fased", "--name", 'My "Bot"', "--foo", "bar"]);
  });

  it("supports schtasks-style escaped quotes while preserving other backslashes", () => {
    expect(
      splitArgsPreservingQuotes('fased --path "C:\\\\Program Files\\\\FasedAgent"', {
        escapeMode: "backslash-quote-only",
      }),
    ).toEqual(["fased", "--path", "C:\\\\Program Files\\\\FasedAgent"]);

    expect(
      splitArgsPreservingQuotes('fased --label "My \\"Quoted\\" Name"', {
        escapeMode: "backslash-quote-only",
      }),
    ).toEqual(["fased", "--label", 'My "Quoted" Name']);
  });
});
