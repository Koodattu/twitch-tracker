import { createChatAssignmentControl } from "@twitch-tracker/db";
import { resolveBotCredentialsPool } from "../bot-auth.js";
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

      const bots = await resolveBotCredentialsPool(context.db, context.config);
      if (bots.length === 0) {
        return { assignmentsDesired: 0, skipped: "No enabled bot account is configured." };
      }

      const result = await assignments.reconcilePool({
        accounts: bots.map((bot) => ({
          botAccountId: bot.botAccountId,
          capacity: bot.accessToken == null ? 0 : bot.maxJoinedRooms
        })),
        observedAt: new Date()
      });
      const resultByAccount = new Map(result.accounts.map((account) => [account.botAccountId, account]));
      const usableBots = bots.filter((bot) => bot.accessToken != null && bot.maxJoinedRooms > 0);

      return {
        assignmentsDesired: result.assignmentsDesired,
        retiredAssignments: result.retiredAssignments,
        topViewerCount: result.topViewerCount,
        enabledBotAccounts: bots.length,
        usableBotAccounts: usableBots.length,
        totalJoinCapacity: usableBots.reduce((sum, bot) => sum + bot.maxJoinedRooms, 0),
        accounts: bots.map((bot) => ({
          botLogin: bot.login,
          botTokenSource: bot.source,
          configuredCapacity: bot.maxJoinedRooms,
          effectiveCapacity: bot.accessToken == null ? 0 : bot.maxJoinedRooms,
          assignmentsDesired: resultByAccount.get(bot.botAccountId)?.assignmentsDesired ?? 0,
          retiredAssignments: resultByAccount.get(bot.botAccountId)?.retiredAssignments ?? 0
        }))
      };
    }
  });
};
