import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sniff } from "../../src/transcribe/sniff";
import { durations, fixtureBytes } from "./fixtures";

const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));

describe("sniff", () => {
  it("never throws, whatever the bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const kind = sniff(bytes);
        expect([null, "mp3", "isobmff", "wav", "flac", "ogg"]).toContain(kind);
      }),
    );
  });

  it("names every media fixture by its magic bytes, not its extension", async () => {
    const expected: Record<string, string> = {
      mp3: "mp3",
      m4a: "isobmff",
      mp4: "isobmff",
      wav: "wav",
      flac: "flac",
      ogg: "ogg",
      opus: "ogg",
    };
    const names = Object.keys(await durations());
    expect(names).toHaveLength(20);
    expect(new Set(names.map((name) => name.split(".").at(-1)))).toEqual(
      new Set(Object.keys(expected)),
    );
    for (const name of names) {
      const kind = sniff((await fixtureBytes(name)).subarray(0, 64));
      if (name === "webm-renamed.mp3") expect(kind, name).toBeNull();
      else expect(kind, name).toBe(expected[name.split(".").at(-1) ?? ""]);
    }
  });

  it("recognizes the headers on their own", () => {
    expect(sniff(Uint8Array.from(ascii("ID3\u0004\u0000")))).toBe("mp3");
    expect(sniff(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3");
    expect(sniff(Uint8Array.from([0, 0, 0, 0x18, ...ascii("ftypisom")]))).toBe("isobmff");
    expect(sniff(Uint8Array.from([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVE")]))).toBe("wav");
    expect(sniff(Uint8Array.from([...ascii("RF64"), 1, 2, 3, 4, ...ascii("WAVE")]))).toBe("wav");
    expect(sniff(Uint8Array.from([...ascii("BW64"), 1, 2, 3, 4, ...ascii("WAVE")]))).toBe("wav");
    expect(sniff(Uint8Array.from(ascii("fLaC")))).toBe("flac");
    expect(sniff(Uint8Array.from(ascii("OggS")))).toBe("ogg");
  });

  it("refuses short, empty and look-alike input", () => {
    expect(sniff(new Uint8Array())).toBeNull();
    expect(sniff(Uint8Array.from([0xff]))).toBeNull();
    expect(sniff(Uint8Array.from([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("AVI ")]))).toBeNull();
    expect(sniff(Uint8Array.from([0xff, 0xf1, 0x50, 0x80]))).toBeNull();
    expect(sniff(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it("needs RIFF, RF64 or BW64 in front of WAVE", () => {
    expect(sniff(Uint8Array.from([...ascii("ABCD"), 1, 2, 3, 4, ...ascii("WAVE")]))).toBeNull();
    expect(sniff(Uint8Array.from([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAV")]))).toBeNull();
  });

  it("needs a brand after ftyp", () => {
    expect(sniff(Uint8Array.from([0, 0, 0, 0x18, ...ascii("ftypiso")]))).toBeNull();
    expect(sniff(Uint8Array.from([0, 0, 0, 0x18, ...ascii("ftyp")]))).toBeNull();
  });

  it.each([
    [0x00, 0xfb],
    [0xfe, 0xfb],
    [0xff, 0x1a],
    [0xff, 0xfd],
    [0xff, 0xfe],
  ])("refuses %s/%s, which is not a Layer III frame sync", (a, b) => {
    expect(sniff(Uint8Array.from([a, b, 0x90, 0x00]))).toBeNull();
  });
});
