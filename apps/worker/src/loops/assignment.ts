import { createChatAssignmentControl } from "@twitch-tracker/db";
import { resolvePrimaryBotCredentials } from "../bot-auth.js";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

export const runAssignmentLoop = (context: WorkerContext) => {
  const assignments = createChatAssignmentControl(context.db);

  return startIntervalLoop({
    name: "assignment",
    intervalMs: context.config.ASSIGNMENT_INTERVAL_MS,
    context,
    run: async () => {
      if (!context.config.ENABLE_TWITCH_INGESTION) {
        return { assignmentsDesired: 0, skipped: "ENABLE_TWITCH_INGESTION is false." };
      }

      const bot = await resolvePrimaryBotCredentials(context.db, context.config);
      if (bot.botAccountId == null || bot.login == null) {
        return { assignmentsDesired: 0, skipped: "No enabled bot account is configured." };
      }

      if (bot.accessToken == null) {
        return { assignmentsDesired: 0, skipped: "No valid bot access token is configured.", botLogin: bot.login };
      }

      if (bot.maxJoinedRooms <= 0) {
        return { assignmentsDesired: 0, skipped: "Bot join capacity is 0.", botLogin: bot.login };
      }

      const result = await assignments.reconcile({
        botAccountId: bot.botAccountId,
        capacity: bot.maxJoinedRooms,
        observedAt: new Date()
      });

      return {
        ...result,
        botLogin: bot.login,
        botTokenSource: bot.source
      };
    }
  });
};
