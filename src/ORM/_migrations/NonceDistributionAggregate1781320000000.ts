import { MigrationInterface, QueryRunner } from 'typeorm';

export class NonceDistributionAggregate1781320000000 implements MigrationInterface {
    public name = 'NonceDistributionAggregate1781320000000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE MATERIALIZED VIEW IF NOT EXISTS "nonce_distribution_hourly"
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket(INTERVAL '1 hour', "acceptedAt") AS "bucketTime",
                ('x'||substring("nonce", 1, 2))::bit(8)::int AS "nonceBucket",
                COUNT(*) AS "shareCount",
                MAX("submissionDifficulty") AS "maxDifficulty",
                COUNT(*) FILTER (WHERE "isBlockCandidate") AS "blockCandidateCount"
            FROM "accepted_share_entity"
            GROUP BY "bucketTime", "nonceBucket"
            WITH NO DATA
        `);

        await queryRunner.query(`
            SELECT add_continuous_aggregate_policy(
                'nonce_distribution_hourly',
                start_offset => INTERVAL '8 days',
                end_offset => INTERVAL '1 minute',
                schedule_interval => INTERVAL '1 minute',
                if_not_exists => TRUE
            )
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_nonce_distribution_hourly_bucket"
            ON "nonce_distribution_hourly" ("nonceBucket", "bucketTime" DESC)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_nonce_distribution_hourly_bucket"`);
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS "nonce_distribution_hourly"`);
    }
}
