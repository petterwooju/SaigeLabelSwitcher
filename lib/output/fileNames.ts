const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[ .]|$)/iu;

/**
 * Produce a portable output stem that is accepted by Windows, macOS and the
 * browser download APIs. The byte limit leaves room for an extension and for
 * the SVPA timestamp suffix while remaining comfortably below common 255-byte
 * filename limits.
 */
export function safeOutputStem(value: string, maxUtf8Bytes = 180): string {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 8) {
    throw new RangeError("Output filename byte limit must be a safe integer of at least 8.");
  }
  const sanitized = Array.from(value.normalize("NFC"), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f || '<>:"/\\|?*'.includes(character)
      ? "_"
      : character;
  })
    .join("")
    .replace(/[ .]+$/u, "")
    .trim();
  const portable = WINDOWS_RESERVED_STEM.test(sanitized)
    ? `_${sanitized}`
    : sanitized;
  return truncateUtf8(portable || "SaigeVision_Project", maxUtf8Bytes);
}

function truncateUtf8(value: string, maxUtf8Bytes: number): string {
  if (utf8Size(value) <= maxUtf8Bytes) return value;
  const characters = Array.from(value);
  while (characters.length > 0 && utf8Size(characters.join("")) > maxUtf8Bytes) {
    characters.pop();
  }
  return characters.join("").replace(/[ .]+$/u, "") || "SaigeVision_Project";
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
