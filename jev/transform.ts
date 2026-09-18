// Ported from NiazMorshed2007/jev-review (MIT) src/evaluation/transform.ts. See NOTICE.
//
// Adaptation 1: "noul" answers become "boolean" answers ({ type: "boolean", probability }).
// Adaptation 2: Jev's own API returns a per-answer `confidence`; experimental_evaluate()
// instead returns `probabilities` (the full distribution). Confidence is derived as
// round(max(probabilities), 2), still clamped by applicabilityCertainty exactly as
// before; when a provider omits probabilities, fall back to applicabilityCertainty alone.
import type { Experimental_EvaluationAnswer as EvaluationAnswer, Experimental_EvaluationQuestion as EvaluationQuestion } from "ai";

import { metricDefinitionByKey, metricDefinitions, type MetricDefinition } from "./metrics";
import { questionId } from "./questions";
import { evaluationSchema, type Evaluation, type MetricEvaluation, type MetricKey } from "./types";

const MEANINGFUL_DELTA = 0.75;

export class JevEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevEvaluationError";
  }
}

type Answers = Record<string, EvaluationAnswer<EvaluationQuestion>>;

export function transform(answers: Answers, previous?: Evaluation): Evaluation {
  const metrics = {} as Record<MetricKey, MetricEvaluation>;

  for (const definition of metricDefinitions) {
    metrics[definition.key] = transformMetric(answers, definition);
  }

  const priorities = metricDefinitions
    .map((definition) => ({ definition, evaluation: metrics[definition.key] }))
    .filter(
      (entry): entry is { definition: MetricDefinition; evaluation: MetricEvaluation & { score: number } } =>
        entry.evaluation.applicable && entry.evaluation.score !== undefined && entry.evaluation.score < 8
    )
    .sort((left, right) => {
      const leftRank = left.evaluation.score - left.definition.priorityWeight * 0.35;
      const rightRank = right.evaluation.score - right.definition.priorityWeight * 0.35;
      return leftRank - rightRank;
    })
    .slice(0, 5)
    .map(({ definition, evaluation }) => ({
      metric: definition.key,
      severity: severityFor(evaluation.score),
      reason: evaluation.issues?.[0]?.description ?? evaluation.summary ?? `${definition.label} remains weak.`
    }));

  const result: Evaluation = { metrics, priorities };
  if (previous !== undefined) addComparison(result, previous);
  return evaluationSchema.parse(result);
}

function transformMetric(answers: Answers, definition: MetricDefinition): MetricEvaluation {
  const applicability = answers[questionId(definition.key, "applicable")];
  const scoreAnswer = answers[questionId(definition.key, "score")];
  const weakness = answers[questionId(definition.key, "weakness")];

  if (applicability?.type !== "boolean") {
    throw new JevEvaluationError(`Jev omitted the applicability decision for ${definition.key}.`);
  }
  if (scoreAnswer?.type !== "score") {
    throw new JevEvaluationError(`Jev omitted the score for ${definition.key}.`);
  }
  if (weakness?.type !== "choice") {
    throw new JevEvaluationError(`Jev omitted the weakness decision for ${definition.key}.`);
  }

  const applicable = applicability.probability >= 0.5;
  if (!applicable) return { applicable: false };

  const score = round(scoreAnswer.score + 1, 1);
  const applicabilityCertainty = 0.5 + Math.abs(applicability.probability - 0.5);
  const scoreCertainty = scoreAnswer.probabilities
    ? Math.max(...Object.values(scoreAnswer.probabilities))
    : applicabilityCertainty;
  const confidence = round(Math.min(scoreCertainty, applicabilityCertainty), 2);
  const summary = `${definition.label} is ${scoreBand(score)} based on the supplied change context.`;
  const selectedWeakness = definition.weaknesses[weakness.choice];
  const hasIssue = score < 8 && weakness.choice !== "no_material_issue" && selectedWeakness !== undefined;

  const evaluation: MetricEvaluation = {
    applicable: true,
    score,
    confidence,
    summary
  };

  if (hasIssue) {
    evaluation.issues = [
      {
        severity: severityFor(score),
        description: selectedWeakness,
        suggestion: definition.suggestion
      }
    ];
  }

  return evaluation;
}

function addComparison(current: Evaluation, previous: Evaluation): void {
  const comparison: NonNullable<Evaluation["comparison"]> = [];
  const improvements: string[] = [];
  const regressions: string[] = [];

  for (const definition of metricDefinitions) {
    const before = previous.metrics[definition.key];
    const after = current.metrics[definition.key];
    if (!before.applicable || !after.applicable || before.score === undefined || after.score === undefined) {
      continue;
    }

    const delta = round(after.score - before.score, 1);
    const direction = delta >= MEANINGFUL_DELTA
      ? "improved"
      : delta <= -MEANINGFUL_DELTA
        ? "regressed"
        : "unchanged";

    comparison.push({
      metric: definition.key,
      previousScore: before.score,
      currentScore: after.score,
      delta,
      direction
    });

    if (direction === "improved") {
      improvements.push(`${definition.label}: ${before.score} → ${after.score}`);
    } else if (direction === "regressed") {
      regressions.push(`${definition.label}: ${before.score} → ${after.score}`);
    }
  }

  current.comparison = comparison;
  current.improvements = improvements;
  current.regressions = regressions;
}

function scoreBand(score: number): string {
  if (score <= 3) return "seriously weak";
  if (score <= 5) return "meaningfully weak";
  if (score <= 7) return "acceptable but improvable";
  if (score < 10) return "strong";
  return "exceptional";
}

function severityFor(score: number): "low" | "medium" | "high" {
  if (score <= 3) return "high";
  if (score <= 5) return "medium";
  return "low";
}

export function getMetricDefinition(key: MetricKey): MetricDefinition {
  const definition = metricDefinitionByKey.get(key);
  if (definition === undefined) throw new Error(`Unknown metric: ${key}`);
  return definition;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
