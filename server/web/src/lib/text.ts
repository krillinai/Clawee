const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

const invisibleInputCharacters = /[\u200B-\u200D\u2060\uFEFF]/g;
const inputBoundary = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

export function trimInput(value: string) {
  return value.replace(inputBoundary, "");
}

export function cleanInputIdentifier(value: string) {
  return trimInput(value.replace(invisibleInputCharacters, ""));
}

export function truncateText(value: string, maxLength: number, suffix = "...") {
  if (maxLength <= 0) return "";

  const parts = graphemes(value);
  if (parts.length <= maxLength) {
    return value;
  }

  return `${parts.slice(0, maxLength).join("")}${suffix}`;
}

export function truncateMiddle(value: string, headLength: number, tailLength: number, separator = "...") {
  const parts = graphemes(value);
  if (parts.length <= headLength + tailLength + separator.length) {
    return value;
  }

  return `${parts.slice(0, headLength).join("")}${separator}${parts.slice(-tailLength).join("")}`;
}

function graphemes(value: string) {
  if (segmenter) {
    return Array.from(segmenter.segment(value), (segment) => segment.segment);
  }

  return Array.from(value);
}
