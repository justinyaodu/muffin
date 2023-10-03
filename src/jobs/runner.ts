import { App } from "@slack/bolt";

import { cacheProvider } from "../services/config-cache";
import { IntervalTimer } from "../util/timer";

import { allJobs } from "./jobs";

class JobRunner {
  private reloadPending = false;

  private constructor(
    private app: App,
    public timer: IntervalTimer,
  ) {}

  static async create(app: App): Promise<JobRunner> {
    const timer = await JobRunner.getTimer(app);
    const runner = new JobRunner(app, timer);
    cacheProvider.addObserver(runner);
    return runner;
  }

  private async reload() {
    this.timer = await JobRunner.getTimer(this.app);
  }

  private static async getTimer(app: App): Promise<IntervalTimer> {
    const config = (await cacheProvider.get(app)).config;
    const intervalMs = config.periodicJobIntervalSec * 1000;

    // Round down to the preceding multiple of intervalMs. This ensures that,
    // if the interval is one hour (for example), the intervals are aligned to
    // the start of every hour.
    const startMs = Math.floor(Date.now() / intervalMs) * intervalMs;

    return new IntervalTimer(intervalMs, startMs);
  }

  async run(): Promise<void> {
    console.log(`running scheduled jobs: ${new Date().toISOString()}`);

    for (const cls of allJobs) {
      const job = new cls(this.app);
      console.log(`running job: ${cls.description}`);

      let result;
      try {
        result = await job.run();
      } catch (e) {
        console.error(e);
        console.log("(err)");
        continue;
      }

      if (result.ok) {
        console.log(result.value);
        console.log("(ok)");
      } else {
        console.log(result.error);
        console.log("(err)");
      }
    }

    if (this.reloadPending) {
      await this.reload();
      this.reloadPending = false;
    }
  }

  onConfigCacheReload() {
    this.reloadPending = true;
  }
}

export { JobRunner };
