const BARCODE_CHAR_PATTERN = /^[il1|!]+$/i;
const MIN_BARCODE_LENGTH = 5;

export type BarcodeIdentity = {
  readonly raw: string;
  readonly fingerprint: string;
  readonly length: number;
};

export function isBarcodeNickname(value: string | undefined): boolean {
  return detectBarcodeIdentity(value) !== null;
}

export function detectBarcodeIdentity(value: string | undefined): BarcodeIdentity | null {
  const normalized = normalizeBarcodeValue(value);

  if (!normalized || normalized.length < MIN_BARCODE_LENGTH || !BARCODE_CHAR_PATTERN.test(normalized)) {
    return null;
  }

  return {
    raw: normalized,
    fingerprint: `barcode:${normalized.length}:${barcodeSkeleton(normalized)}`,
    length: normalized.length
  };
}

export function isExactBarcodeCandidate(queryNickname: string, candidateNickname: string): boolean {
  const query = normalizeBarcodeValue(queryNickname);
  const candidate = normalizeBarcodeValue(candidateNickname);

  if (!query || !candidate || !isBarcodeNickname(query)) {
    return false;
  }

  return query.toLowerCase() === candidate.toLowerCase();
}

function normalizeBarcodeValue(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, "") ?? "";
}

function barcodeSkeleton(value: string): string {
  return value.replace(/[il1|!]/gi, "1");
}
