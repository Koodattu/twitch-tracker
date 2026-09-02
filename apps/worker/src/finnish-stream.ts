export const finnishStreamMatchReasons = ["language", "tag", "manual"] as const;
export type FinnishStreamMatchReason = (typeof finnishStreamMatchReasons)[number];

const finnishTags = new Set(["suomi", "finnish"]);

export const getFinnishStreamMatchReason = (input: {
  language: string | null | undefined;
  tags: string[] | null | undefined;
  manuallyPinned: boolean;
}): FinnishStreamMatchReason | null => {
  if (normalize(input.language) === "fi") {
    return "language";
  }
  if (input.tags?.some((tag) => finnishTags.has(normalize(tag))) ?? false) {
    return "tag";
  }
  return input.manuallyPinned ? "manual" : null;
};

const normalize = (value: string | null | undefined) => value?.normalize("NFKC").trim().toLowerCase() ?? "";
