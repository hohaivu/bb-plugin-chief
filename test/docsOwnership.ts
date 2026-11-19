/** A skipReview that could not read the branch history says so in the tool reply. A transcript line, dropped from head only. */
export const dropSkippedNote = (text: string) => text.split("\n").filter((line) => !/^docs\/ check skipped: .+; skipReview proceeded without it\.$/.test(line)).join("\n");
