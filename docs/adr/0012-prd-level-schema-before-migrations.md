# PRD-Level Schema Before Migrations

Status: accepted

Before implementation, the PRD must define the initial database table groups,
core relationships, primary identifiers, and retention class for each group.
Final Drizzle migration details are deferred until implementation, where exact
columns, constraints, and indexes can be refined against the first ingestion
code.

**Consequences**

The first schema plan must include at least identity, stream tracking,
bot/account capacity, raw event ledger, chat, structured channel events,
aggregates, auth/product access, and operations tables. Implementation should
avoid inventing unrelated tables outside that plan unless a concrete Twitch
payload or product requirement demands it.
