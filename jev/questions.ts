// Ported from NiazMorshed2007/jev-review (MIT) src/evaluation/questions.ts. See NOTICE.
//
// Adaptation 1: jev-review's own API speaks a "noul" question type; the AI SDK's
// experimental_evaluate() speaks choice | score | boolean instead. A boolean
// question with `probability` is the same semantics as noul, differently spelled.
import type { Experimental_EvaluationQuestion as EvaluationQuestion } from "ai";

import { metricDefinitions } from "./metrics";

export const SCORE_LEVELS = [
  "1 — Serious, fundamental problems; unsafe or substantially unfit.",
  "2 — Severe problems dominate; major rework is required.",
  "3 — Serious weaknesses; important behavior or design is unreliable.",
  "4 — Meaningful weaknesses materially impede quality.",
  "5 — Several consequential weaknesses remain.",
  "6 — Acceptable baseline, but notable improvement is warranted.",
  "7 — Sound overall with limited, concrete weaknesses.",
  "8 — Strong; only minor meaningful improvements are available.",
  "9 — Very strong and well fitted to its context.",
  "10 — Exceptional; little meaningful improvement is available. Use rarely."
] as const;

export function questionId(metricKey: string, kind: "applicable" | "score" | "weakness"): string {
  return `${metricKey}_${kind}`;
}

export function buildQuestions(): Record<string, EvaluationQuestion> {
  const questions: Record<string, EvaluationQuestion> = {};

  for (const definition of metricDefinitions) {
    const applicabilityInstruction = definition.conditional
      ? `Is ${definition.label} actually relevant and assessable from the supplied software-change state? Answer yes only when the state contains concrete evidence that this dimension matters; do not invent concerns. ${definition.guidance}`
      : `Does the supplied software-change state contain enough relevant evidence to assess ${definition.label}? Answer no when the context is too thin for a defensible score. ${definition.guidance}`;

    questions[questionId(definition.key, "applicable")] = {
      type: "boolean",
      instructions: applicabilityInstruction,
      criteria: {
        true: "This dimension is relevant and the supplied state supports a defensible assessment.",
        false: "This dimension is irrelevant here or the supplied state is insufficient to assess it."
      }
    };

    questions[questionId(definition.key, "score")] = {
      type: "score",
      instructions: `Rate ${definition.label} for the implementation in the supplied software-change state. Evaluate consequences in context, not simplistic size or style rules. ${definition.guidance}`,
      criteria: [...SCORE_LEVELS]
    };

    questions[questionId(definition.key, "weakness")] = {
      type: "choice",
      instructions: `Identify the single most consequential ${definition.label} weakness evidenced by the supplied software-change state. Choose no_material_issue when no listed concern is justified. Do not speculate beyond the state.`,
      criteria: definition.weaknesses
    };
  }

  return questions;
}
