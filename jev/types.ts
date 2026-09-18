// Ported verbatim from NiazMorshed2007/jev-review (MIT) src/evaluation/types.ts.
// See NOTICE.
import { z } from "zod";

export const metricKeys = [
  "correctness",
  "cognitiveComplexity",
  "readability",
  "modularity",
  "coupling",
  "changeability",
  "abstractionQuality",
  "projectStructure",
  "duplication",
  "maintainability",
  "testQuality",
  "reliability",
  "security",
  "consistency",
  "documentation",
  "performance",
  "scalability",
  "compatibility",
  "observability"
] as const;

export type MetricKey = (typeof metricKeys)[number];

export const severitySchema = z.enum(["low", "medium", "high"]);

export const metricIssueSchema = z
  .object({
    severity: severitySchema,
    description: z.string(),
    location: z.string().optional(),
    suggestion: z.string().optional()
  })
  .strict();

export const metricEvaluationSchema = z
  .object({
    applicable: z.boolean(),
    score: z.number().min(1).max(10).optional(),
    confidence: z.number().min(0).max(1).optional(),
    summary: z.string().optional(),
    issues: z.array(metricIssueSchema).optional()
  })
  .strict()
  .superRefine((metric, context) => {
    if (metric.applicable && (metric.score === undefined || metric.confidence === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Applicable metrics require score and confidence"
      });
    }
    if (!metric.applicable && (metric.score !== undefined || metric.confidence !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Non-applicable metrics cannot include score or confidence"
      });
    }
  });

const metricsShape = Object.fromEntries(
  metricKeys.map((key) => [key, metricEvaluationSchema])
) as Record<MetricKey, typeof metricEvaluationSchema>;

export const comparisonEntrySchema = z
  .object({
    metric: z.enum(metricKeys),
    previousScore: z.number().min(1).max(10),
    currentScore: z.number().min(1).max(10),
    delta: z.number().min(-9).max(9),
    direction: z.enum(["improved", "regressed", "unchanged"])
  })
  .strict();

export const evaluationSchema = z
  .object({
    metrics: z.object(metricsShape).strict(),
    priorities: z.array(
      z
        .object({
          metric: z.enum(metricKeys),
          severity: severitySchema,
          reason: z.string()
        })
        .strict()
    ),
    improvements: z.array(z.string()).optional(),
    regressions: z.array(z.string()).optional(),
    comparison: z.array(comparisonEntrySchema).optional()
  })
  .strict();

export type MetricEvaluation = z.infer<typeof metricEvaluationSchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;
