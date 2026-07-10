import { MigrationInterface, QueryRunner } from 'typeorm';

export class NonceStrikes1781321000000 implements MigrationInterface {
    public name = 'NonceStrikes1781321000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "nonce_strike" (
                "id" bigserial PRIMARY KEY,
                "nonce" varchar(8) NOT NULL,
                "submissionDifficulty" numeric NOT NULL,
                "acceptedAt" timestamptz NOT NULL,
                "blockHeight" bigint,
                "isBlockCandidate" boolean NOT NULL DEFAULT false,
                "blockSubmissionResult" text,
                "address" varchar(128),
                "clientName" varchar(256),
                "createdAt" timestamptz NOT NULL DEFAULT NOW()
            )
        `);

        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_nonce_strike_accepted_nonce"
            ON "nonce_strike" ("acceptedAt", "nonce")
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_nonce_strike_best"
            ON "nonce_strike" ("submissionDifficulty" DESC, "acceptedAt" DESC)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_nonce_strike_best"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_nonce_strike_accepted_nonce"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "nonce_strike"`);
    }
}
