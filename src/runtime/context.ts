import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ResearchSettings } from "../research/research";
import type { createCore } from "./core";
import type { createSweep } from "./sweep";
import type { createSettingsRuntime } from "./settings";
import type { createChiefs } from "./chiefs";
import type { createDelegation } from "./delegation";
import type { createNextAction } from "./nextAction";
import type { createCheckout } from "./checkout";
import type { createCleanup } from "./cleanup";
import type { createCompletion } from "./completion";
import type { createAlerts } from "./alerts";
import type { createForgeWiring } from "./forgeWiring";
import type { createArtifacts } from "./artifacts";
import type { createLifecycle } from "./lifecycle";
import type { createRoster } from "./roster";
import type { createInspect } from "./inspect";
import type { createResearchWiring } from "./researchWiring";
import type { createToolRegistry } from "../tools/register";
import type { createObserve } from "../observe/events";
import type { createCompletionSnapshot } from "../observe/completionSnapshot";
import type { createRetro } from "../observe/retro";

/** Mutable state the plugin closure kept in `let`s and Maps. One object per plugin invocation: read and write it as ctx.state.x, never through a copy. */
export interface State {
  pendingReady: boolean; // set once the state the sweep reads is initialised
  plannerActive: boolean;
  // The cleanupApproved setting, cached so chief_complete never reads settings: false until the first read, which fails closed.
  cleanupActive: boolean;
  // ponytail: cached for wave 2's synchronous configure(); the chief_research gate reads live settings.
  researchActive: ResearchSettings | null;
  rulesCache: Map<string, string>;
  alertDeliveries: Map<string, Promise<boolean>>;
  sweeping: Promise<void> | null;
  sweepAgain: boolean;
  retroing: Promise<void> | null;
  sectionEnsuring: Promise<string> | null;
  chiefStarts: Map<string, Promise<{ threadId: string; created: boolean }>>;
  // ponytail: one delegation at a time, so a second call on the same branch sees the first
  // one's row in the holder check below; per-branch queues if parallel spawns get slow.
  delegating: Promise<unknown>;
  dataDirs: Map<string, string | null>;
  forgeRuns: Promise<unknown>;
}

export const createState = (): State => ({
  pendingReady: false,
  plannerActive: false,
  cleanupActive: false,
  researchActive: null,
  rulesCache: new Map(),
  alertDeliveries: new Map(),
  sweeping: null,
  sweepAgain: false,
  retroing: null,
  sectionEnsuring: null,
  chiefStarts: new Map(),
  delegating: Promise.resolve(),
  dataDirs: new Map(),
  forgeRuns: Promise.resolve(),
});

/** Everything the factories share. Each factory returns its functions into this one object; a function from a later factory is read at call time, so a factory that needs one at construction passes a thunk.
 * An interface with lazily resolved members: an intersection of the factory return types would be circular. */
export interface Ctx {
  bb: BbPluginApi;
  state: State;
  activeChiefForProject: ReturnType<typeof createCore>["activeChiefForProject"];
  anyCooldown: ReturnType<typeof createCore>["anyCooldown"];
  chiefCountForProject: ReturnType<typeof createCore>["chiefCountForProject"];
  closedTodosForProject: ReturnType<typeof createCore>["closedTodosForProject"];
  cooldownFor: ReturnType<typeof createCore>["cooldownFor"];
  db: ReturnType<typeof createCore>["db"];
  insertTodo: ReturnType<typeof createCore>["insertTodo"];
  chainOwner: ReturnType<typeof createCore>["chainOwner"];
  chainStarted: ReturnType<typeof createCore>["chainStarted"];
  coexists: ReturnType<typeof createCore>["coexists"];
  isDesignWave: ReturnType<typeof createCore>["isDesignWave"];
  isTestWave: ReturnType<typeof createCore>["isTestWave"];
  latestSideWriter: ReturnType<typeof createCore>["latestSideWriter"];
  latestWorker: ReturnType<typeof createCore>["latestWorker"];
  latestChiefForProject: ReturnType<typeof createCore>["latestChiefForProject"];
  ledger: ReturnType<typeof createCore>["ledger"];
  onSpecChain: ReturnType<typeof createCore>["onSpecChain"];
  pendingAlerts: ReturnType<typeof createCore>["pendingAlerts"];
  planWavesFor: ReturnType<typeof createCore>["planWavesFor"];
  plans: ReturnType<typeof createCore>["plans"];
  progress: ReturnType<typeof createCore>["progress"];
  researchModelRow: ReturnType<typeof createCore>["researchModelRow"];
  reviewTargetsFor: ReturnType<typeof createCore>["reviewTargetsFor"];
  reviewerFails: ReturnType<typeof createCore>["reviewerFails"];
  roleModelRow: ReturnType<typeof createCore>["roleModelRow"];
  schedule: ReturnType<typeof createCore>["schedule"];
  settings: ReturnType<typeof createCore>["settings"];
  sideLane: ReturnType<typeof createCore>["sideLane"];
  specWave: ReturnType<typeof createCore>["specWave"];
  specWriters: ReturnType<typeof createCore>["specWriters"];
  store: ReturnType<typeof createCore>["store"];
  taskWriters: ReturnType<typeof createCore>["taskWriters"];
  todoById: ReturnType<typeof createCore>["todoById"];
  todosForProject: ReturnType<typeof createCore>["todosForProject"];
  updateTodo: ReturnType<typeof createCore>["updateTodo"];
  upsertCooldown: ReturnType<typeof createCore>["upsertCooldown"];
  writerPending: ReturnType<typeof createCore>["writerPending"];
  observe: ReturnType<typeof createObserve>["observe"];
  snapshotCompletion: ReturnType<typeof createCompletionSnapshot>["snapshotCompletion"];
  sweep: ReturnType<typeof createSweep>["sweep"];
  toManaged: ReturnType<typeof createSweep>["toManaged"];
  catalogReader: ReturnType<typeof createSettingsRuntime>["catalogReader"];
  chiefForProject: ReturnType<typeof createSettingsRuntime>["chiefForProject"];
  cooldownError: ReturnType<typeof createSettingsRuntime>["cooldownError"];
  defaultHostId: ReturnType<typeof createSettingsRuntime>["defaultHostId"];
  discover: ReturnType<typeof createSettingsRuntime>["discover"];
  ensureSection: ReturnType<typeof createSettingsRuntime>["ensureSection"];
  environmentHostId: ReturnType<typeof createSettingsRuntime>["environmentHostId"];
  execution: ReturnType<typeof createSettingsRuntime>["execution"];
  hostFallback: ReturnType<typeof createSettingsRuntime>["hostFallback"];
  lifecycleOwner: ReturnType<typeof createSettingsRuntime>["lifecycleOwner"];
  owningChief: ReturnType<typeof createSettingsRuntime>["owningChief"];
  plannerEnabled: ReturnType<typeof createSettingsRuntime>["plannerEnabled"];
  projectHostId: ReturnType<typeof createSettingsRuntime>["projectHostId"];
  projectName: ReturnType<typeof createSettingsRuntime>["projectName"];
  projectPath: ReturnType<typeof createSettingsRuntime>["projectPath"];
  readResearchModel: ReturnType<typeof createSettingsRuntime>["readResearchModel"];
  readRoleModel: ReturnType<typeof createSettingsRuntime>["readRoleModel"];
  readRules: ReturnType<typeof createSettingsRuntime>["readRules"];
  researchFrom: ReturnType<typeof createSettingsRuntime>["researchFrom"];
  researchSettings: ReturnType<typeof createSettingsRuntime>["researchSettings"];
  spawnExecution: ReturnType<typeof createSettingsRuntime>["spawnExecution"];
  storedSectionId: ReturnType<typeof createSettingsRuntime>["storedSectionId"];
  usableSelection: ReturnType<typeof createSettingsRuntime>["usableSelection"];
  writeResearchModel: ReturnType<typeof createSettingsRuntime>["writeResearchModel"];
  writeRoleModel: ReturnType<typeof createSettingsRuntime>["writeRoleModel"];
  createChief: ReturnType<typeof createChiefs>["createChief"];
  ensureChief: ReturnType<typeof createChiefs>["ensureChief"];
  handOver: ReturnType<typeof createChiefs>["handOver"];
  handoffSection: ReturnType<typeof createChiefs>["handoffSection"];
  managedSpawn: ReturnType<typeof createChiefs>["managedSpawn"];
  unpinPendingTab: ReturnType<typeof createChiefs>["unpinPendingTab"];
  appendPlanLog: ReturnType<typeof createDelegation>["appendPlanLog"];
  continueThread: ReturnType<typeof createDelegation>["continueThread"];
  delegate: ReturnType<typeof createDelegation>["delegate"];
  planLog: ReturnType<typeof createDelegation>["planLog"];
  stallCapNote: ReturnType<typeof createDelegation>["stallCapNote"];
  startConsult: ReturnType<typeof createDelegation>["startConsult"];
  startPlan: ReturnType<typeof createDelegation>["startPlan"];
  busyRejection: ReturnType<typeof createNextAction>["busyRejection"];
  nextAction: ReturnType<typeof createNextAction>["nextAction"];
  planAdvisors: ReturnType<typeof createNextAction>["planAdvisors"];
  planReviewRefusal: ReturnType<typeof createNextAction>["planReviewRefusal"];
  revisionsOf: ReturnType<typeof createNextAction>["revisionsOf"];
  specFirstLine: ReturnType<typeof createNextAction>["specFirstLine"];
  startBranchReview: ReturnType<typeof createNextAction>["startBranchReview"];
  startReview: ReturnType<typeof createNextAction>["startReview"];
  waitIdleAfterReport: ReturnType<typeof createNextAction>["waitIdleAfterReport"];
  waivedLine: ReturnType<typeof createNextAction>["waivedLine"];
  waveWaitLine: ReturnType<typeof createNextAction>["waveWaitLine"];
  workerReadyNextStep: ReturnType<typeof createNextAction>["workerReadyNextStep"];
  checkoutHostSkip: ReturnType<typeof createCheckout>["checkoutHostSkip"];
  freshenChiefCheckout: ReturnType<typeof createCheckout>["freshenChiefCheckout"];
  reportStamp: ReturnType<typeof createCheckout>["reportStamp"];
  syncChiefCheckout: ReturnType<typeof createCheckout>["syncChiefCheckout"];
  CLEANUP_READ_MS: ReturnType<typeof createCleanup>["CLEANUP_READ_MS"];
  observeCleanup: ReturnType<typeof createCleanup>["observeCleanup"];
  cleanupLine: ReturnType<typeof createCompletion>["cleanupLine"];
  markComplete: ReturnType<typeof createCompletion>["markComplete"];
  readyPullRequest: ReturnType<typeof createCompletion>["readyPullRequest"];
  recordOwnerApproval: ReturnType<typeof createCompletion>["recordOwnerApproval"];
  stopThread: ReturnType<typeof createCompletion>["stopThread"];
  alertChief: ReturnType<typeof createAlerts>["alertChief"];
  alertCoordinator: ReturnType<typeof createAlerts>["alertCoordinator"];
  alertSelf: ReturnType<typeof createAlerts>["alertSelf"];
  insertAlert: ReturnType<typeof createAlerts>["insertAlert"];
  deliverAlert: ReturnType<typeof createAlerts>["deliverAlert"];
  enqueueAlert: ReturnType<typeof createAlerts>["enqueueAlert"];
  recordFailure: ReturnType<typeof createAlerts>["recordFailure"];
  retryAlerts: ReturnType<typeof createAlerts>["retryAlerts"];
  writeAlert: ReturnType<typeof createAlerts>["writeAlert"];
  enqueueBlockedComment: ReturnType<typeof createForgeWiring>["enqueueBlockedComment"];
  enqueueCompletionComment: ReturnType<typeof createForgeWiring>["enqueueCompletionComment"];
  enqueueVerdictComments: ReturnType<typeof createForgeWiring>["enqueueVerdictComments"];
  forgeComments: ReturnType<typeof createForgeWiring>["forgeComments"];
  forgeText: ReturnType<typeof createForgeWiring>["forgeText"];
  trackerSync: ReturnType<typeof createForgeWiring>["trackerSync"];
  readArtifact: ReturnType<typeof createArtifacts>["readArtifact"];
  persistBrief: ReturnType<typeof createArtifacts>["persistBrief"];
  writeArtifact: ReturnType<typeof createArtifacts>["writeArtifact"];
  writePlan: ReturnType<typeof createArtifacts>["writePlan"];
  writeStorageFile: ReturnType<typeof createArtifacts>["writeStorageFile"];
  intake: ReturnType<typeof createLifecycle>["intake"];
  lifecycle: ReturnType<typeof createLifecycle>["lifecycle"];
  managedRow: ReturnType<typeof createLifecycle>["managedRow"];
  reconcile: ReturnType<typeof createLifecycle>["reconcile"];
  reconcileThread: ReturnType<typeof createLifecycle>["reconcileThread"];
  INACTIVE_CHIEF_STATES: ReturnType<typeof createRoster>["INACTIVE_CHIEF_STATES"];
  belongsToChief: ReturnType<typeof createRoster>["belongsToChief"];
  chiefStats: ReturnType<typeof createRoster>["chiefStats"];
  controlledTarget: ReturnType<typeof createRoster>["controlledTarget"];
  controlsThread: ReturnType<typeof createRoster>["controlsThread"];
  isActiveChief: ReturnType<typeof createRoster>["isActiveChief"];
  isCoordinator: ReturnType<typeof createRoster>["isCoordinator"];
  isLinkedChild: ReturnType<typeof createRoster>["isLinkedChild"];
  pendingBlock: ReturnType<typeof createRoster>["pendingBlock"];
  pendingLines: ReturnType<typeof createRoster>["pendingLines"];
  replacesCall: ReturnType<typeof createRoster>["replacesCall"];
  requireChiefCaller: ReturnType<typeof createRoster>["requireChiefCaller"];
  rerouteSteps: ReturnType<typeof createRoster>["rerouteSteps"];
  resolveTarget: ReturnType<typeof createRoster>["resolveTarget"];
  rosterFor: ReturnType<typeof createRoster>["rosterFor"];
  rosterForChief: ReturnType<typeof createRoster>["rosterForChief"];
  rosterRowLines: ReturnType<typeof createRoster>["rosterRowLines"];
  statsText: ReturnType<typeof createRoster>["statsText"];
  taskReviews: ReturnType<typeof createRoster>["taskReviews"];
  todoLine: ReturnType<typeof createRoster>["todoLine"];
  todoLines: ReturnType<typeof createRoster>["todoLines"];
  inspect: ReturnType<typeof createInspect>["inspect"];
  lastOutput: ReturnType<typeof createInspect>["lastOutput"];
  lastProviderError: ReturnType<typeof createInspect>["lastProviderError"];
  noteCooldown: ReturnType<typeof createInspect>["noteCooldown"];
  recordedCommands: ReturnType<typeof createInspect>["recordedCommands"];
  checkUnreported: ReturnType<typeof createResearchWiring>["checkUnreported"];
  research: ReturnType<typeof createResearchWiring>["research"];
  runWorkflowCli: ReturnType<typeof createResearchWiring>["runWorkflowCli"];
  retroTick: ReturnType<typeof createRetro>["retroTick"];
  collectRetroBundle: ReturnType<typeof createRetro>["collectRetroBundle"];
  researchSleep: ReturnType<typeof createResearchWiring>["researchSleep"];
  registerChiefTool: ReturnType<typeof createToolRegistry>["registerChiefTool"];
  touchCallerChief: ReturnType<typeof createToolRegistry>["touchCallerChief"];
}
