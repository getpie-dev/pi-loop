import {
  type CreateInput,
  type CreateResult,
  type LoopClock,
  type LoopDispatch,
  type MutationOutcome,
  SessionLoopScheduler,
  type TaskDefinition,
  type UpdateInput,
} from "./scheduler.js";

export interface LoopManagerHost {
  clock: LoopClock;
  dispatch: LoopDispatch;
  saveDefinitions(definitions: TaskDefinition[]): void;
  onChange?: () => void;
  onWarning?: (message: string) => void;
}

export class LoopManager {
  private lastSavedDefinitions: string | null = null;
  private readonly scheduler: SessionLoopScheduler;

  constructor(private readonly host: LoopManagerHost) {
    this.scheduler = new SessionLoopScheduler({
      clock: host.clock,
      dispatch: host.dispatch,
      onChange: host.onChange,
      onWarning: host.onWarning,
      onMutation: (definitions) => this.checkpoint(definitions),
    });
  }

  restore(definitions: unknown[] = [], options: { checkpointRequired?: boolean } = {}): void {
    this.lastSavedDefinitions = null;
    this.scheduler.startSession(definitions);
    if (!options.checkpointRequired)
      this.lastSavedDefinitions = JSON.stringify(this.scheduler.definitions());
  }

  markStarted(): void {
    this.scheduler.markStarted();
  }

  settle(): void {
    this.scheduler.handleSettled();
  }

  dispose(): void {
    this.lastSavedDefinitions = null;
    this.scheduler.dispose();
  }

  create(input: CreateInput): MutationOutcome<CreateResult> {
    return this.scheduler.create(input);
  }

  update(input: UpdateInput): MutationOutcome<CreateResult> {
    return this.scheduler.update(input);
  }

  pause(id: string) {
    return this.scheduler.stop(id);
  }

  resume(id: string): MutationOutcome<CreateResult> {
    return this.scheduler.restart(id);
  }

  remove(id: string) {
    return this.scheduler.delete(id);
  }

  list() {
    return this.scheduler.list();
  }

  private checkpoint(definitions: TaskDefinition[]): string | undefined {
    const serialized = JSON.stringify(definitions);
    if (serialized === this.lastSavedDefinitions) return;
    try {
      this.host.saveDefinitions(definitions);
      this.lastSavedDefinitions = serialized;
    } catch {
      // A failed save must not suppress a later explicit retry of the same definitions.
      this.lastSavedDefinitions = null;
      return "Loop change applied in memory but could not be saved for restart.";
    }
  }
}
