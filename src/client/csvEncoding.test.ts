import { describe, expect, it } from "vitest";

import { decodeCsvBuffer } from "./csvEncoding";

describe("decodeCsvBuffer", () => {
  it("keeps UTF-8 CSV text unchanged", () => {
    const csv = "client_key,name,role,body\nUS-001,登录页布局,se,实现登录页基础布局和表单校验";

    expect(decodeCsvBuffer(toArrayBuffer(new TextEncoder().encode(csv)))).toBe(csv);
  });

  it("decodes GB18030 Chinese CSV exported by desktop spreadsheet apps", () => {
    const csv = decodeCsvBuffer(
      hexToArrayBuffer(
        "636c69656e745f6b65792c6e616d652c726f6c652c626f64790d0a3631372d312cecddb7a2c7b9bbf9b4a1bcbcc4dc2c73652c22bed1bbf72db6d4d4b6bee0c0ebb5a5b8f6c4bfb1ead4ecb3c9b8dfb6eec9cbbaa6a3acb6d4c9faceefc9cbbaa6d3d0bcd3b3c90ab9a5bbf7c1a6ceaab4acd6bbb9a5bbf7b5c432303025a3acb6d4c9faceefd3d0b6eecde2333025bcd3b3c90ac9e4cbd928636f6f6c646f776e29a3ba35660ac9e4b3cca3ba36660a"
      )
    );

    expect(csv).toContain("client_key,name,role,body");
    expect(csv).toContain("燧发枪基础技能");
    expect(csv).toContain("狙击-对远距离单个目标造成高额伤害");
    expect(csv).not.toContain("\uFFFD");
  });
});

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return toArrayBuffer(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
