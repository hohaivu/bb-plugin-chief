// Calls Jev through the Vercel AI Gateway instead of TypeSafe's own API. Only
// question construction and answer transform are ported from jev-review; auth
// and transport are the gateway's. See NOTICE.
import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate } from "ai";

import { buildQuestions } from "./questions";
import { transform } from "./transform";
import type { Evaluation } from "./types";

export type JevState = {
  task?: string;
  diff?: string;
  repositoryContext?: string;
  /** Set only when the diff was cut to fit, so the applicability gate can abstain
   * instead of scoring absent code as missing implementation. */
  diffTruncated?: string;
};

export type GatewayOptions = { apiKey: string; model: string; timeoutMs: number };

export async function runEvaluation(
  options: GatewayOptions,
  state: JevState,
  previous?: Evaluation,
): Promise<Evaluation> {
  const { answers } = await evaluate({
    model: createGateway({ apiKey: options.apiKey }).evaluationModel(options.model),
    state,
    questions: buildQuestions(),
    abortSignal: AbortSignal.timeout(options.timeoutMs),
  });
  return transform(answers, previous);
}

/** One cheap boolean question for the settings "Check connection" button — never runs
 * the full 57-question battery just to prove the key and model id work. */
export async function pingGateway(options: GatewayOptions): Promise<void> {
  await evaluate({
    model: createGateway({ apiKey: options.apiKey }).evaluationModel(options.model),
    state: { task: "Connectivity check." },
    questions: {
      ok: {
        type: "boolean",
        instructions: "Answer true to confirm the connection works.",
        criteria: { true: "Always true.", false: "Never selected." },
      },
    },
    abortSignal: AbortSignal.timeout(options.timeoutMs),
  });
}
