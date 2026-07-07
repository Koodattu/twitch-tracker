# PostgreSQL Only Data Store

Status: accepted

The MVP and planned single-server production deployment use PostgreSQL as the
only data store. PostgreSQL owns raw observations, normalized product tables,
aggregates, assignment state, job/run state, API reads, and operational records.

**Considered Options**

- Add ClickHouse for analytics.
- Add TimescaleDB for time-series tables.
- Add Redis for queueing, caching, or ephemeral coordination.
- Use PostgreSQL only and revisit additional stores only after measured need.

**Consequences**

High-volume tables must be designed with PostgreSQL indexing, retention, and
future partitioning in mind. The system should not introduce Redis, ClickHouse,
TimescaleDB, Kafka, NATS, or RabbitMQ until PostgreSQL has a concrete measured
failure mode that justifies the extra operational surface.
