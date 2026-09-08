import { describe, expect, it } from "vitest";

import { truncateMiddle, truncateText } from "./text";

describe("text truncation", () => {
  it("truncates plain and Chinese text without changing short values", () => {
    expect(truncateText("短文本", 10)).toBe("短文本");
    expect(truncateText("企业智能体操作系统", 4)).toBe("企业智能...");
  });

  it("keeps emoji and combined graphemes intact", () => {
    expect(truncateText("状态✅👩‍💻上线", 4)).toBe("状态✅👩‍💻...");
    expect(truncateText("Cafe\u0301 status", 4)).toBe("Cafe\u0301...");
  });

  it("truncates the middle without splitting multibyte characters", () => {
    expect(truncateMiddle("会话_019f36f6aaab3f6", 5, 6)).toBe("会话_01...aab3f6");
    expect(truncateMiddle("令牌🔐abcdef结束", 4, 2)).toBe("令牌🔐a...结束");
  });
});
