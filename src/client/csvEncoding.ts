const csvEncodingCandidates = ["gb18030", "gbk", "big5", "windows-1252", "iso-8859-1"] as const;

type DecodeCandidate = {
  encoding: string;
  score: number;
  text: string;
};

export async function readCsvFile(file: Blob): Promise<string> {
  return decodeCsvBuffer(await file.arrayBuffer());
}

export function decodeCsvBuffer(buffer: ArrayBuffer): string {
  const utf8Text = decodeText(buffer, "utf-8");

  if (utf8Text && countReplacementCharacters(utf8Text) === 0) {
    return utf8Text;
  }

  const candidates = csvEncodingCandidates
    .map((encoding) => decodeCandidate(buffer, encoding))
    .filter((candidate): candidate is DecodeCandidate => Boolean(candidate));

  if (utf8Text) {
    candidates.push({
      encoding: "utf-8",
      score: scoreDecodedText(utf8Text),
      text: utf8Text
    });
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.text ?? utf8Text ?? new TextDecoder().decode(buffer);
}

function decodeCandidate(buffer: ArrayBuffer, encoding: string): DecodeCandidate | undefined {
  const text = decodeText(buffer, encoding);

  if (!text) {
    return undefined;
  }

  return {
    encoding,
    score: scoreDecodedText(text),
    text
  };
}

function decodeText(buffer: ArrayBuffer, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return undefined;
  }
}

function scoreDecodedText(text: string): number {
  let cjkCharacters = 0;
  let controlCharacters = 0;
  let latinSupplementCharacters = 0;

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;

    if ((codePoint >= 0x3400 && codePoint <= 0x9fff) || (codePoint >= 0xf900 && codePoint <= 0xfaff)) {
      cjkCharacters += 1;
    }

    if (codePoint < 32 && character !== "\n" && character !== "\r" && character !== "\t") {
      controlCharacters += 1;
    }

    if (codePoint >= 0x00c0 && codePoint <= 0x00ff) {
      latinSupplementCharacters += 1;
    }
  }

  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const headerScore = firstLine.includes("client_key") && firstLine.includes("body") ? 500 : 0;
  const delimiterScore = (firstLine.match(/,/g)?.length ?? 0) * 10;

  return (
    headerScore +
    delimiterScore +
    cjkCharacters * 20 -
    countReplacementCharacters(text) * 200 -
    controlCharacters * 50 -
    latinSupplementCharacters * 3
  );
}

function countReplacementCharacters(text: string): number {
  return text.match(/\uFFFD/g)?.length ?? 0;
}
